import type { Database, Db } from '@code-trust/db';
import { createPgDb } from '@code-trust/db/pg';
import { createTestDatabase, seedFixtures, type TestDatabase, testDatabaseUrl } from '@code-trust/db/testing';
import { installNeonShim, type NeonShim } from '@code-trust/db/testing-neon';
import {
  repoSummaryResponseFixture,
  survivalCurveFixture,
  survivalCurveResponseFixture,
  youngSurvivalCurveFixture,
} from '@code-trust/shared/fixtures';
import type { INestApplication } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createApp } from './app.ts';
import { createHandler, type FunctionUrlHandler, type FunctionUrlResult } from './handler.ts';
import { type FunctionUrlEventOptions, functionUrlEvent } from './testing.ts';

const DASHBOARD_ORIGIN = 'https://wahidbabar.github.io';
const INTERNAL_SERVER_ERROR = { statusCode: 500, message: 'Internal server error' };
const SURVIVAL_CURVE_BODY = {
  ...survivalCurveResponseFixture,
  curves: [survivalCurveFixture, youngSurvivalCurveFixture],
};

const get = (path: string, options: FunctionUrlEventOptions = {}) => functionUrlEvent('GET', path, options);

function bodyOf(result: FunctionUrlResult): unknown {
  return JSON.parse(result.body ?? '');
}

function corsHeadersOf(result: FunctionUrlResult): string[] {
  return Object.keys(result.headers ?? {}).filter((name) => /^access-control-/i.test(name));
}

// These cases never reach the database: the handle points at a closed port, and a route that
// queried it by mistake would answer 500 and fail the test.
describe('without a database', () => {
  let deadDb: Db;

  beforeAll(() => {
    deadDb = createPgDb('postgres://127.0.0.1:1/none');
  });

  afterAll(async () => {
    await deadDb?.destroy();
  });

  test('the URL loader runs once across invocations, also when two cold requests race', async () => {
    const loadDatabaseUrl = vi.fn(async () => 'postgres://u:p@example.invalid/db');
    const connect = vi.fn(() => deadDb);
    const handler = createHandler({ loadDatabaseUrl, connect, logger: false });

    const cold = await Promise.all([handler(get('/health')), handler(get('/health'))]);
    const warm = [await handler(get('/health')), await handler(get('/health')), await handler(get('/health'))];
    for (const result of [...cold, ...warm]) {
      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ status: 'ok' });
    }
    expect(loadDatabaseUrl).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test('a loader that fails once gives that request a bare 500 and the next request succeeds', async () => {
    const loadDatabaseUrl = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('could not read postgres://u:s3cret-pw@leak.example.invalid/db'))
      .mockResolvedValue('postgres://u:p@example.invalid/db');
    const handler = createHandler({ loadDatabaseUrl, connect: () => deadDb, logger: false });

    const failed = await handler(get('/health'));
    expect(failed.statusCode).toBe(500);
    expect(bodyOf(failed)).toEqual(INTERNAL_SERVER_ERROR);
    expect(JSON.stringify(failed)).not.toMatch(/s3cret-pw|postgres:\/\/|leak\.example/);

    const next = await handler(get('/health'));
    expect(next.statusCode).toBe(200);
    expect(bodyOf(next)).toEqual({ status: 'ok' });
    expect(loadDatabaseUrl).toHaveBeenCalledTimes(2);

    // The good start is kept from here on.
    expect((await handler(get('/health'))).statusCode).toBe(200);
    expect(loadDatabaseUrl).toHaveBeenCalledTimes(2);
  });

  test('a malformed URL through the default Neon connect is a bare 500, and the next URL is used', async () => {
    const loadDatabaseUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('postgres://u:s3cret-pw@db.example.invalid:port/db')
      .mockResolvedValue('postgres://u:p@example.invalid/db');
    // No connect: createNeonDb with the API's timeout, as on Lambda. /health makes no query.
    const handler = createHandler({ loadDatabaseUrl, logger: false });

    const failed = await handler(get('/health'));
    expect(failed.statusCode).toBe(500);
    expect(bodyOf(failed)).toEqual(INTERNAL_SERVER_ERROR);
    expect(JSON.stringify(failed)).not.toContain('s3cret-pw');

    const next = await handler(get('/health'));
    expect(next.statusCode).toBe(200);
    expect(loadDatabaseUrl).toHaveBeenCalledTimes(2);
  });

  test('a failed start is logged by name and message, and the response says nothing of it', async () => {
    const logged: string[] = [];
    const logger = { log() {}, warn() {}, error: (message: string) => logged.push(message) };
    const handler = createHandler({
      loadDatabaseUrl: async () => {
        throw Object.assign(new Error('Parameter /code-trust/database-url not found.'), { name: 'ParameterNotFound' });
      },
      connect: () => deadDb,
      logger,
    });

    const failed = await handler(get('/health'));
    expect(bodyOf(failed)).toEqual(INTERNAL_SERVER_ERROR);
    expect(logged).toEqual([
      'The API failed to start: ParameterNotFound: Parameter /code-trust/database-url not found.',
    ]);
  });
});

describe.skipIf(testDatabaseUrl === null)('against the database', () => {
  let scratch: TestDatabase;
  let counted: Db;
  let app: INestApplication;
  let handler: FunctionUrlHandler;
  // Every SQL statement the handler's handle runs. Kysely's log hook fires once per query, on
  // success ('query') and on failure ('error') alike.
  const queries: string[] = [];

  const viaSupertest = (method: 'get' | 'post' | 'put' | 'delete', path: string) =>
    request(app.getHttpServer())[method](path);

  beforeAll(async () => {
    scratch = await createTestDatabase();
    await seedFixtures(scratch.db);
    const url = testDatabaseUrl;
    if (url === null) throw new Error('unreachable: the suite skips without a database');
    // createPgDb takes no log option, so this is its pool with a log hook added.
    counted = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: url, options: `-c search_path=${scratch.schema}` }),
      }),
      log: (event) => {
        queries.push(event.query.sql);
      },
    });
    handler = createHandler({
      loadDatabaseUrl: async () => 'postgres://unused.example.invalid/db',
      connect: () => counted,
      logger: false,
    });
    app = await createApp(scratch.db, { logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await counted?.destroy();
    await scratch?.destroy();
  });

  test("GET /repos/1296269 and /repos/1296269/survival-curve through the handler equal the fixtures and supertest's answers", async () => {
    const cases = [
      ['/repos/1296269', repoSummaryResponseFixture],
      ['/repos/1296269/survival-curve', SURVIVAL_CURVE_BODY],
    ] as const;
    for (const [path, fixture] of cases) {
      const result = await handler(get(path));
      expect(result.statusCode, path).toBe(200);
      expect(result.headers?.['content-type'], path).toMatch(/^application\/json/);
      expect(result.isBase64Encoded, path).toBe(false);
      expect(bodyOf(result), path).toEqual(fixture);

      const res = await viaSupertest('get', path);
      expect(res.status, path).toBe(200);
      expect(bodyOf(result), path).toEqual(res.body);
    }
  });

  test('a query string, a base64 JSON body and a POST answer as through supertest', async () => {
    const json = { 'content-type': 'application/json' };
    const base64Body = Buffer.from(JSON.stringify({ id: 1 })).toString('base64');
    const cases = [
      // The query arrives in rawQueryString. A mapper that dropped the '?' would route
      // /repos/1296269cohort=ai..., which the repoId pipe answers with 400.
      [
        get('/repos/1296269', { rawQueryString: 'cohort=ai&x=%2F' }),
        () => viaSupertest('get', '/repos/1296269?cohort=ai&x=%2F'),
      ],
      [get('/repos', { rawQueryString: 'page=2' }), () => viaSupertest('get', '/repos?page=2')],
      // Nest's JSON body parser runs before routing: decoded, this is a 404 like supertest's;
      // left encoded, the parser would answer 400.
      [
        functionUrlEvent('POST', '/repos', { headers: json, body: base64Body, isBase64Encoded: true }),
        () => viaSupertest('post', '/repos').send({ id: 1 }),
      ],
      [
        functionUrlEvent('POST', '/repos/1296269', { headers: json, body: '{"id":1}' }),
        () => viaSupertest('post', '/repos/1296269').send({ id: 1 }),
      ],
      [functionUrlEvent('PUT', '/repos/1296269'), () => viaSupertest('put', '/repos/1296269')],
      [functionUrlEvent('DELETE', '/repos/1296269'), () => viaSupertest('delete', '/repos/1296269')],
      [get('/nope'), () => viaSupertest('get', '/nope')],
    ] as const;

    // Each supertest request is made only when it runs: supertest closes the shared server after
    // each one, so requests made up front would find it closed.
    for (const [event, expected] of cases) {
      const label = `${event.requestContext.http.method} ${event.rawPath}?${event.rawQueryString}`;
      const result = await handler(event);
      const res = await expected();
      expect(result.statusCode, label).toBe(res.status);
      expect(bodyOf(result), label).toEqual(res.body);
      if (event.requestContext.http.method === 'GET' && event.rawPath !== '/nope') {
        expect(result.statusCode, label).toBe(200);
      } else {
        expect([404, 405], label).toContain(result.statusCode);
      }
    }
    expect(bodyOf(await handler(cases[0][0]))).toEqual(repoSummaryResponseFixture);

    // Both cases above can tell a broken mapping from a working one.
    expect((await handler(get('/repos/1296269cohort=ai&x=%2F'))).statusCode).toBe(400);
    const undecoded = functionUrlEvent('POST', '/repos', { headers: json, body: base64Body, isBase64Encoded: false });
    expect((await handler(undecoded)).statusCode).toBe(400);
  });

  test('queries per request: /health 0, /repos 1, /repos/:id at most 2, the curve at most 3', async () => {
    const counts = new Map<string, number>();
    for (const path of ['/health', '/repos', '/repos/1296269', '/repos/1296269/survival-curve']) {
      queries.length = 0;
      const result = await handler(get(path));
      expect(result.statusCode, path).toBe(200);
      counts.set(path, queries.length);
    }
    expect(counts.get('/health')).toBe(0);
    // Exactly 1, which also proves the hook counts: with no count at all, every bound below would pass.
    expect(counts.get('/repos')).toBe(1);
    expect(counts.get('/repos/1296269')).toBeGreaterThanOrEqual(1);
    expect(counts.get('/repos/1296269')).toBeLessThanOrEqual(2);
    expect(counts.get('/repos/1296269/survival-curve')).toBeGreaterThanOrEqual(1);
    expect(counts.get('/repos/1296269/survival-curve')).toBeLessThanOrEqual(3);
  });

  test('no response carries a CORS header of its own', async () => {
    const origin = { origin: DASHBOARD_ORIGIN };
    const failing = createHandler({
      loadDatabaseUrl: async () => {
        throw new Error('no URL today');
      },
      logger: false,
    });
    const results = [
      ['GET /health', await handler(get('/health', { headers: origin }))],
      ['GET /repos', await handler(get('/repos', { headers: origin }))],
      ['GET /repos/1296269', await handler(get('/repos/1296269', { headers: origin }))],
      ['GET /repos/abc', await handler(get('/repos/abc', { headers: origin }))],
      ['GET /nope', await handler(get('/nope', { headers: origin }))],
      [
        'OPTIONS /repos',
        await handler(
          functionUrlEvent('OPTIONS', '/repos', { headers: { ...origin, 'access-control-request-method': 'GET' } }),
        ),
      ],
      ['a failed start', await failing(get('/repos', { headers: origin }))],
    ] as const;
    expect(results.map(([label, result]) => [label, result.statusCode])).toEqual([
      ['GET /health', 200],
      ['GET /repos', 200],
      ['GET /repos/1296269', 200],
      ['GET /repos/abc', 400],
      ['GET /nope', 404],
      ['OPTIONS /repos', 404],
      ['a failed start', 500],
    ]);
    for (const [label, result] of results) {
      expect(corsHeadersOf(result), label).toEqual([]);
    }
  });

  describe('through the Neon dialect', () => {
    let shim: NeonShim;

    beforeAll(() => {
      shim = installNeonShim();
    });

    afterAll(async () => {
      await shim?.close();
    });

    test('the default connect serves /repos/1296269 through the Neon dialect', async () => {
      const neon = shim.connect({ schema: scratch.schema });
      // No connect: the handler builds its own handle with createNeonDb, as on Lambda.
      const neonHandler = createHandler({ loadDatabaseUrl: async () => neon.url, logger: false });

      const result = await neonHandler(get('/repos/1296269'));
      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(repoSummaryResponseFixture);
      expect(shim.requests.filter((r) => r.host === neon.host)).toHaveLength(2);

      const curve = await neonHandler(get('/repos/1296269/survival-curve'));
      expect(bodyOf(curve)).toEqual(SURVIVAL_CURVE_BODY);
    });
  });
});
