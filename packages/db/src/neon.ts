// The Neon dialect for Lambda: Neon's serverless driver over HTTP, one HTTPS request per query.
// There is no connection to keep alive, close per invocation or leak across a freeze, and no
// interactive transactions, which the query module never uses (every write is one statement).
//
// Written here rather than taken from kysely-neon, because kysely-neon calls the driver with fixed
// options, and each query needs its own fetch signal so a hung request fails instead of running
// until Lambda kills the function.
import { type NeonQueryFunction, neon } from '@neondatabase/serverless';
import {
  type AbortableOperationOptions,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';
import type { Database } from './database.ts';
import { parseDatabaseUrl } from './database-url.ts';

export interface NeonOptions {
  /** Each query fails after this long. About 30 seconds for the worker, 5 for the API. */
  queryTimeoutMs: number;
}

export function createNeonDb(connectionString: string, options: NeonOptions): Kysely<Database> {
  const { queryTimeoutMs } = options;
  if (!Number.isInteger(queryTimeoutMs) || queryTimeoutMs <= 0) {
    throw new Error(`queryTimeoutMs must be a positive whole number of milliseconds, not ${queryTimeoutMs}.`);
  }
  // The driver's own invalid-URL error quotes the connection string, password and all.
  parseDatabaseUrl(connectionString);
  const sql = neon(connectionString, { fullResults: true });
  return new Kysely<Database>({ dialect: new NeonHttpDialect(new NeonHttpConnection(sql, queryTimeoutMs)) });
}

class NeonHttpDialect implements Dialect {
  readonly #connection: NeonHttpConnection;

  constructor(connection: NeonHttpConnection) {
    this.#connection = connection;
  }

  createAdapter() {
    return new PostgresAdapter();
  }

  createDriver(): Driver {
    return new NeonHttpDriver(this.#connection);
  }

  createIntrospector(db: Kysely<unknown>) {
    return new PostgresIntrospector(db);
  }

  createQueryCompiler() {
    return new PostgresQueryCompiler();
  }
}

const NO_TRANSACTIONS =
  'Neon over HTTP has no interactive transactions. Every write in @code-trust/db is one statement and needs none.';

// One stateless connection serves every query: each one is its own HTTPS request.
class NeonHttpDriver implements Driver {
  readonly #connection: NeonHttpConnection;

  constructor(connection: NeonHttpConnection) {
    this.#connection = connection;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.#connection;
  }

  async beginTransaction(): Promise<void> {
    throw new Error(NO_TRANSACTIONS);
  }

  async commitTransaction(): Promise<void> {
    throw new Error(NO_TRANSACTIONS);
  }

  async rollbackTransaction(): Promise<void> {
    throw new Error(NO_TRANSACTIONS);
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

const COMMANDS_WITH_AFFECTED_ROWS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

class NeonHttpConnection implements DatabaseConnection {
  readonly #sql: NeonQueryFunction<false, true>;
  readonly #queryTimeoutMs: number;

  constructor(sql: NeonQueryFunction<false, true>, queryTimeoutMs: number) {
    this.#sql = sql;
    this.#queryTimeoutMs = queryTimeoutMs;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery, options?: AbortableOperationOptions): Promise<QueryResult<R>> {
    // Made here, per query: AbortSignal.timeout starts counting when it is created, so one made
    // up front would expire for every query after the first timeout period.
    const timeout = AbortSignal.timeout(this.#queryTimeoutMs);
    const signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      const result = await this.#sql.query(compiledQuery.sql, [...compiledQuery.parameters], {
        arrayMode: false,
        fullResults: true,
        fetchOptions: { signal },
      });
      const rows = result.rows as R[];
      return COMMANDS_WITH_AFFECTED_ROWS.has(result.command)
        ? { rows, numAffectedRows: BigInt(result.rowCount ?? 0) }
        : { rows };
    } catch (error) {
      if (timeout.aborted) {
        throw new Error(`Neon query timed out after ${this.#queryTimeoutMs} ms.`, { cause: error });
      }
      throw error;
    }
  }

  // biome-ignore lint/correctness/useYield: streaming is unsupported, so this only throws.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Neon over HTTP does not stream query results.');
  }
}
