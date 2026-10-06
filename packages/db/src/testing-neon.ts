// Test support: runs the Neon dialect against real Postgres, with no Neon project.
//
// The Neon driver's fetch hook (`neonConfig.fetchFunction`) is global, so the shim installs one
// fetch for the whole test file and routes each request by the host in its connection string. Every
// handle it makes gets its own fake host under example.invalid, and an unknown host throws: the
// shim never forwards a request anywhere.
//
// The shim answers the driver's SQL-over-HTTP requests the way Neon does: it runs the query through
// node-postgres with type parsing off and rows as arrays, and returns the raw text with each field's
// type id. The driver then parses every value with its own type parsers, which is the part that can
// differ from node-postgres. neon.ts never imports this file.
import { setTimeout as sleep } from 'node:timers/promises';
import { neonConfig } from '@neondatabase/serverless';
import type { Kysely } from 'kysely';
import { type CustomTypesConfig, DatabaseError, Pool } from 'pg';
import type { Database } from './database.ts';
import { createNeonDb } from './neon.ts';
import { testDatabaseUrl } from './testing.ts';

/** One SQL-over-HTTP request as the driver sent it. */
export interface NeonShimRequest {
  host: string;
  connectionString: string;
  query: string;
  params: (string | null)[];
}

export interface NeonShimHandle {
  db: Kysely<Database>;
  /** The handle's connection string, with the shim's fake host. */
  url: string;
  host: string;
}

export interface NeonShimConnectOptions {
  /** The scratch schema the queries run in. */
  schema: string;
  /** Defaults to 5 seconds. */
  queryTimeoutMs?: number;
  /** Waits this long before running each query, giving up early when the request is aborted. */
  delayMs?: number;
  user?: string;
  password?: string;
  /** Appended to the URL as is, such as `?sslmode=verify-full`. */
  search?: string;
}

export interface NeonShim {
  /** A Neon handle whose queries run on Postgres in `schema`. */
  connect(options: NeonShimConnectOptions): NeonShimHandle;
  /** A Neon handle whose requests never get an answer, though they still honour their abort signal. */
  connectHanging(options: { queryTimeoutMs: number }): NeonShimHandle;
  /** Every request so far, oldest first. */
  readonly requests: NeonShimRequest[];
  /** Restores the driver's fetch hook and closes the Postgres pools. */
  close(): Promise<void>;
}

type Route = { kind: 'postgres'; pool: Pool; delayMs: number } | { kind: 'hang' };

// Type parsing off: each value comes back as Postgres's text output, as Neon sends it. The cast is
// needed because pg types getTypeParser with overloads that one plain function cannot satisfy.
const RAW_TEXT = { getTypeParser: () => (value: string) => value } as unknown as CustomTypesConfig;

// The error fields the driver copies from a 400 response onto its NeonDbError.
const ERROR_FIELDS = [
  'severity',
  'code',
  'detail',
  'hint',
  'position',
  'internalPosition',
  'internalQuery',
  'where',
  'schema',
  'table',
  'column',
  'dataType',
  'constraint',
  'file',
  'line',
  'routine',
] as const;

let installed = false;

export function installNeonShim(databaseUrl: string | null = testDatabaseUrl): NeonShim {
  if (databaseUrl === null) throw new Error('No test database. Guard the suite with testDatabaseUrl.');
  if (installed) throw new Error('A Neon shim is already installed in this test file. Close it first.');
  installed = true;

  const routes = new Map<string, Route>();
  const pools = new Map<string, Pool>();
  const requests: NeonShimRequest[] = [];
  let hosts = 0;

  const poolFor = (schema: string): Pool => {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`"${schema}" is not a usable schema name.`);
    let pool = pools.get(schema);
    if (!pool) {
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
      pools.set(schema, pool);
    }
    return pool;
  };

  const handle = (route: Route, queryTimeoutMs: number, options: Partial<NeonShimConnectOptions> = {}) => {
    hosts += 1;
    const host = `h${hosts}.shim.example.invalid`;
    routes.set(host, route);
    const user = options.user ?? 'shim-user';
    const password = options.password ?? 'shim-password';
    const url = `postgres://${user}:${password}@${host}/neondb${options.search ?? ''}`;
    return { db: createNeonDb(url, { queryTimeoutMs }), url, host };
  };

  const shimFetch = async (_endpoint: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const connectionString = headers.get('Neon-Connection-String');
    if (connectionString === null) throw new Error('Neon shim: the request has no Neon-Connection-String header.');
    const host = new URL(connectionString).hostname;
    const route = routes.get(host);
    if (route === undefined) throw new Error(`Neon shim: no route for ${host}. The shim never forwards a request.`);
    // The response below is rows of text in arrays; any other mode would need another shape.
    if (
      init.method !== 'POST' ||
      headers.get('Neon-Raw-Text-Output') !== 'true' ||
      headers.get('Neon-Array-Mode') !== 'true'
    ) {
      throw new Error('Neon shim: expected a POST with Neon-Raw-Text-Output and Neon-Array-Mode set to true.');
    }
    const body: unknown = JSON.parse(String(init.body));
    if (!isSingleQuery(body)) {
      throw new Error('Neon shim: expected one {query, params} body. Batches (transactions) are not used here.');
    }
    requests.push({ host, connectionString, query: body.query, params: body.params });

    const signal = init.signal ?? undefined;
    if (route.kind === 'hang') return never(signal);
    if (route.delayMs > 0) await sleep(route.delayMs, undefined, { signal });
    signal?.throwIfAborted();

    try {
      // The driver has already turned every parameter into Postgres text (or null), so they pass to
      // pg untouched: pg's own value preparation leaves strings and null as they are.
      const result = await route.pool.query({
        text: body.query,
        values: body.params,
        rowMode: 'array',
        types: RAW_TEXT,
      });
      return Response.json({
        command: result.command,
        rowCount: result.rowCount,
        rows: result.rows,
        fields: result.fields.map((field) => ({
          name: field.name,
          tableID: field.tableID,
          columnID: field.columnID,
          dataTypeID: field.dataTypeID,
          dataTypeSize: field.dataTypeSize,
          dataTypeModifier: field.dataTypeModifier,
          format: field.format,
        })),
        rowAsArray: true,
      });
    } catch (error) {
      if (!(error instanceof DatabaseError)) throw error;
      const fields: Record<string, unknown> = { message: error.message };
      for (const key of ERROR_FIELDS) fields[key] = error[key];
      return Response.json(fields, { status: 400 });
    }
  };

  const previousFetch: unknown = neonConfig.fetchFunction;
  neonConfig.fetchFunction = shimFetch;

  return {
    connect: (options) =>
      handle(
        { kind: 'postgres', pool: poolFor(options.schema), delayMs: options.delayMs ?? 0 },
        options.queryTimeoutMs ?? 5000,
        options,
      ),
    connectHanging: ({ queryTimeoutMs }) => handle({ kind: 'hang' }, queryTimeoutMs),
    requests,
    close: async () => {
      neonConfig.fetchFunction = previousFetch;
      installed = false;
      await Promise.all([...pools.values()].map((pool) => pool.end()));
    },
  };
}

function isSingleQuery(body: unknown): body is { query: string; params: (string | null)[] } {
  if (typeof body !== 'object' || body === null) return false;
  const { query, params } = body as { query?: unknown; params?: unknown };
  return (
    typeof query === 'string' &&
    Array.isArray(params) &&
    params.every((param) => typeof param === 'string' || param === null)
  );
}

// Like a fetch to a server that never answers: settles only when the request is aborted.
function never(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
