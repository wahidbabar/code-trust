import 'reflect-metadata';
import type { Db } from '@code-trust/db';
import { createPgDb } from '@code-trust/db/pg';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from './index.ts';
import { ReposController } from './repos.controller.ts';
import { ReposService } from './repos.service.ts';

const REPO_ROUTES = ['/repos/1296269', '/repos/1296269/survival-curve'];
const routeFor = (repoId: string) => [`/repos/${repoId}`, `/repos/${repoId}/survival-curve`];

const BAD_REPO_IDS = ['0', '-1', '1.5', 'abc', (BigInt(Number.MAX_SAFE_INTEGER) + 2n).toString()];

// These cases never reach the database, so they run without one: the handle points at a closed
// port, and a route that queried it by mistake would answer 500 and fail the test.
describe('without a database', () => {
  let db: Db;
  let app: INestApplication;

  beforeAll(async () => {
    db = createPgDb('postgres://127.0.0.1:1/none');
    app = await createApp(db, { logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  test('constructor parameters are wired by explicit @Inject, not by metadata', () => {
    // Nothing in this run emits design:paramtypes, so Nest has only the @Inject tokens to go on.
    // Without them it injects undefined and still boots, which is why the properties are checked.
    expect(Reflect.getMetadata('design:paramtypes', ReposController)).toBeUndefined();
    expect(Reflect.getMetadata('design:paramtypes', ReposService)).toBeUndefined();
    const service = app.get(ReposService);
    expect(service).toBeInstanceOf(ReposService);
    expect(Reflect.get(app.get(ReposController), 'repos')).toBe(service);
    expect(Reflect.get(service, 'db')).toBe(db);
  });

  test('GET /health answers without touching the database', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test.each(BAD_REPO_IDS.flatMap((repoId) => routeFor(repoId)))(
    'repoId of 0, -1, 1.5, abc and past MAX_SAFE_INTEGER returns 400 on both repo routes: %s',
    async (path) => {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'repoId must be a GitHub numeric id: a positive integer',
      });
    },
  );

  test('POST /repos and an unknown path return 404 or 405, never 200', async () => {
    const writes = ['post', 'put', 'patch', 'delete', 'options'] as const;
    const calls = [
      ['post', '/repos'],
      ['get', '/nope'],
      ['get', '/repos/1296269/nope'],
      ...REPO_ROUTES.flatMap((path) => writes.map((method) => [method, path] as const)),
    ] as const;
    for (const [method, path] of calls) {
      const res = await request(app.getHttpServer())[method](path).send({ id: 1 });
      expect([404, 405], `${method} ${path}`).toContain(res.status);
    }
  });
});
