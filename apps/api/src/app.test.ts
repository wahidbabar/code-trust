import 'reflect-metadata';
import { type Db, deleteRepo, listRepos, setRepoHead, upsertRepo, upsertSurvivalRollup } from '@code-trust/db';
import { createPgDb } from '@code-trust/db/pg';
import {
  createTestDatabase,
  repoHeadFixture,
  seedFixtures,
  type TestDatabase,
  testDatabaseUrl,
} from '@code-trust/db/testing';
import { ListReposResponseSchema, RepoSummaryResponseSchema, SurvivalCurveResponseSchema } from '@code-trust/shared';
import {
  apiRepoFixture,
  INSTALLATION_ID,
  newApiRepoFixture,
  newRepoFixture,
  REPO_ID,
  repoSummaryResponseFixture,
  survivalCurveFixture,
  survivalCurveResponseFixture,
  survivalMetricFixture,
  youngSurvivalCurveFixture,
} from '@code-trust/shared/fixtures';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from './index.ts';
import { ReposController } from './repos.controller.ts';
import { ReposService } from './repos.service.ts';

const repoRoutes = (repoId: number | string) => [`/repos/${repoId}`, `/repos/${repoId}/survival-curve`];

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

  test.each(BAD_REPO_IDS.flatMap((repoId) => repoRoutes(repoId)))(
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
      ...repoRoutes(REPO_ID).flatMap((path) => writes.map((method) => [method, path] as const)),
    ] as const;
    for (const [method, path] of calls) {
      const res = await request(app.getHttpServer())[method](path).send({ id: 1 });
      expect([404, 405], `${method} ${path}`).toContain(res.status);
    }
  });
});

describe.skipIf(testDatabaseUrl === null)('against the database', () => {
  let scratch: TestDatabase;
  let app: INestApplication;
  const get = (path: string) => request(app.getHttpServer()).get(path);

  // A second repo the App was just installed on. Its id is above the seeded one and its name sorts
  // first, so only listRepos' order (owner, name, id) puts it ahead.
  const OTHER_ID = REPO_ID + 1;
  const otherRepo = { ...newRepoFixture, id: OTHER_ID, name: 'a-new-repo' };
  const otherApiRepo = { ...newApiRepoFixture, id: OTHER_ID, name: 'a-new-repo' };

  beforeAll(async () => {
    scratch = await createTestDatabase();
    app = await createApp(scratch.db, { logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await scratch?.destroy();
  });

  beforeEach(async () => {
    for (const repo of await listRepos(scratch.db)) await deleteRepo(scratch.db, repo.id);
    await seedFixtures(scratch.db);
  });

  test('GET /repos lists the seeded repo, then a never-analyzed one in listRepos order with null head fields', async () => {
    expect((await get('/repos')).body).toEqual({ repos: [apiRepoFixture] });

    await upsertRepo(scratch.db, otherRepo);
    const res = await get('/repos');
    expect(res.body).toEqual({ repos: [otherApiRepo, apiRepoFixture] });
    expect(res.body.repos[0]).toMatchObject({ headSha: null, headCommittedAt: null, observedAt: null });
    const inListReposOrder = (await listRepos(scratch.db)).map(({ installationId: _, ...repo }) => repo);
    expect(res.body.repos).toEqual(inListReposOrder);
  });

  test('GET /repos/1296269 returns the fixture summary', async () => {
    const res = await get('/repos/1296269');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(repoSummaryResponseFixture);
  });

  test('GET /repos/1296269/survival-curve returns the fixture curves', async () => {
    const res = await get('/repos/1296269/survival-curve');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...survivalCurveResponseFixture,
      curves: [survivalCurveFixture, youngSurvivalCurveFixture],
    });
  });

  test('every 200 body passes its shared schema and no response mentions installationId', async () => {
    await upsertRepo(scratch.db, otherRepo);
    const schemas = [
      ['/repos', ListReposResponseSchema],
      ['/repos/1296269', RepoSummaryResponseSchema],
      ['/repos/1296269/survival-curve', SurvivalCurveResponseSchema],
      [`/repos/${OTHER_ID}`, RepoSummaryResponseSchema],
    ] as const;
    for (const [path, schema] of schemas) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      // Equal after parsing, so the body carries no key the schema would strip.
      expect(schema.parse(res.body), path).toEqual(res.body);
    }

    const paths = [
      '/health',
      ...schemas.map(([path]) => path),
      `/repos/${OTHER_ID}/survival-curve`,
      '/repos/abc',
      '/repos/42',
    ];
    for (const path of paths) {
      const res = await get(path);
      expect(res.text, path).not.toContain('installationId');
      expect(res.text, path).not.toContain(String(INSTALLATION_ID));
    }
  });

  test('a never-analyzed repo has metrics: [] and its survival curve is a 404', async () => {
    await upsertRepo(scratch.db, otherRepo);
    // Its first analysis is in flight: a rollup is written, the head is not set yet.
    await upsertSurvivalRollup(scratch.db, {
      metric: { ...survivalMetricFixture, repoId: OTHER_ID },
      points: survivalCurveFixture.points,
    });

    const summary = await get(`/repos/${OTHER_ID}`);
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({ repo: otherApiRepo, metrics: [] });

    const curve = await get(`/repos/${OTHER_ID}/survival-curve`);
    expect(curve.status).toBe(404);
    expect(curve.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: `No analyzed repo with id ${OTHER_ID}`,
    });
  });

  test('a rollup under another head is left out of metrics and curves (rule 2)', async () => {
    const newHead = { ...repoHeadFixture, headSha: '9'.repeat(40) };
    await setRepoHead(scratch.db, REPO_ID, newHead);

    const summary = await get('/repos/1296269');
    expect(summary.body).toEqual({ repo: { ...apiRepoFixture, ...newHead }, metrics: [] });
    const curve = await get('/repos/1296269/survival-curve');
    expect(curve.status).toBe(200);
    expect(curve.body).toEqual({ ...survivalCurveResponseFixture, headSha: newHead.headSha, curves: [] });

    // One cohort rewritten under the new head comes back; the other stays out.
    const aiMetric = { ...survivalMetricFixture, headSha: newHead.headSha };
    await upsertSurvivalRollup(scratch.db, { metric: aiMetric, points: survivalCurveFixture.points });
    expect((await get('/repos/1296269')).body.metrics).toEqual([aiMetric]);
    expect((await get('/repos/1296269/survival-curve')).body.curves).toEqual([survivalCurveFixture]);
  });

  test('an unknown repoId returns 404 on both repo routes', async () => {
    for (const path of repoRoutes(42)) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.body.error, path).toBe('Not Found');
    }
  });

  test('a failing database returns 500 with no SQL, stack or URL, and /health still returns 200', async () => {
    const url = testDatabaseUrl;
    if (url === null) throw new Error('unreachable: the suite skips without a database');
    const dead = createPgDb(url, { schema: scratch.schema });
    // destroy() does nothing on a handle that never ran a query, so run one first.
    await listRepos(dead);
    await dead.destroy();
    const deadApp = await createApp(dead, { logger: false });
    try {
      for (const path of ['/repos', ...repoRoutes(REPO_ID)]) {
        const res = await request(deadApp.getHttpServer()).get(path);
        expect(res.status, path).toBe(500);
        expect(res.body, path).toEqual({ statusCode: 500, message: 'Internal server error' });
        expect(res.text, path).not.toMatch(/select|postgres:\/\/|\bat\s/i);
        expect(res.text, path).not.toContain(new URL(url).host);
      }
      const health = await request(deadApp.getHttpServer()).get('/health');
      expect(health.status).toBe(200);
    } finally {
      await deadApp.close();
    }
  });
});
