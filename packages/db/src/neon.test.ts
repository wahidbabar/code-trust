import {
  REPO_ID,
  repoFixture,
  survivalCurveFixture,
  survivalMetricFixture,
  youngSurvivalCurveFixture,
  youngSurvivalMetricFixture,
} from '@code-trust/shared/fixtures';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from './database.ts';
import { INVALID_DATABASE_URL } from './database-url.ts';
import { createNeonDb } from './neon.ts';
import {
  deleteRepo,
  getRepo,
  getSurvivalCurves,
  listAttributions,
  listCommits,
  listRepos,
  listSurvivalMetrics,
  listSurvivalObservations,
  setRepoHead,
} from './queries.ts';
import { createTestDatabase, repoHeadFixture, seedFixtures, type TestDatabase, testDatabaseUrl } from './testing.ts';
import { installNeonShim, type NeonShim } from './testing-neon.ts';

test('createNeonDb refuses a malformed URL without echoing it', () => {
  const create = () => createNeonDb('postgres://u:s3cret-pw@[bad', { queryTimeoutMs: 1000 });
  expect(create).toThrow(INVALID_DATABASE_URL);
  expect(create).not.toThrow(/s3cret-pw/);
});

test('createNeonDb refuses a timeout that is not a positive whole number', () => {
  for (const queryTimeoutMs of [0, -1, 1.5, Number.NaN]) {
    expect(() => createNeonDb('postgres://u:p@example.invalid/db', { queryTimeoutMs })).toThrow(/queryTimeoutMs/);
  }
});

describe.skipIf(testDatabaseUrl === null)('the Neon dialect against real Postgres', () => {
  let scratch: TestDatabase;
  let shim: NeonShim;
  let neonDb: Kysely<Database>;

  beforeAll(async () => {
    scratch = await createTestDatabase();
    shim = installNeonShim();
    neonDb = shim.connect({ schema: scratch.schema }).db;
  });

  afterAll(async () => {
    await shim?.close();
    await scratch?.destroy();
  });

  beforeEach(async () => {
    for (const repo of await listRepos(scratch.db)) await deleteRepo(scratch.db, repo.id);
  });

  const readAll = async (db: Kysely<Database>) => ({
    repos: await listRepos(db),
    repo: await getRepo(db, REPO_ID),
    commits: await listCommits(db, REPO_ID),
    attributions: await listAttributions(db, REPO_ID),
    observations: await listSurvivalObservations(db, REPO_ID),
    aiObservations: await listSurvivalObservations(db, REPO_ID, 'ai'),
    metrics: await listSurvivalMetrics(db, REPO_ID),
    curves: await getSurvivalCurves(db, REPO_ID),
  });

  test('seedFixtures through Neon reads back exactly as node-postgres reads it', async () => {
    await seedFixtures(neonDb);
    const viaNeon = await readAll(neonDb);
    expect(viaNeon).toEqual(await readAll(scratch.db));
    // The same ISO strings and numeric ids the fixtures were written with.
    expect(viaNeon.repo).toEqual(repoFixture);
    expect(typeof viaNeon.repo?.id).toBe('number');
    expect(typeof viaNeon.repo?.installationId).toBe('number');
    expect(viaNeon.metrics).toEqual([survivalMetricFixture, youngSurvivalMetricFixture]);
    expect(viaNeon.curves).toEqual([survivalCurveFixture, youngSurvivalCurveFixture]);
    expect(viaNeon.observations.length).toBeGreaterThan(0);
  });

  test('setRepoHead and deleteRepo return true for an existing repo and false for a missing one through Neon', async () => {
    await seedFixtures(neonDb);
    expect(await setRepoHead(neonDb, REPO_ID, repoHeadFixture)).toBe(true);
    expect(await setRepoHead(neonDb, 404, repoHeadFixture)).toBe(false);
    expect(await deleteRepo(neonDb, REPO_ID)).toBe(true);
    expect(await deleteRepo(neonDb, REPO_ID)).toBe(false);
    expect(await getRepo(scratch.db, REPO_ID)).toBeNull();
  });

  test('a constraint violation comes back as a Postgres error with its code', async () => {
    await expect(setRepoHead(neonDb, REPO_ID, repoHeadFixture)).resolves.toBe(false);
    await expect(
      neonDb.insertInto('repos').values({ id: -1, owner: 'o', name: 'n', default_branch: 'main' }).execute(),
    ).rejects.toMatchObject({ code: '23514', constraint: 'repos_id_check' });
  });

  test('an interactive transaction is refused with a clear error', async () => {
    await expect(neonDb.transaction().execute(async () => {})).rejects.toThrow(/no interactive transactions/);
  });

  test('a URL with sslmode=verify-full is accepted and reaches the server unchanged', async () => {
    const handle = shim.connect({ schema: scratch.schema, search: '?sslmode=verify-full' });
    expect(await listRepos(handle.db)).toEqual([]);
    const sent = shim.requests.filter((request) => request.host === handle.host);
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]?.connectionString ?? '').searchParams.get('sslmode')).toBe('verify-full');
  });

  describe('per-query timeout', () => {
    test('a query that never gets an answer fails after queryTimeoutMs', async () => {
      const { db } = shim.connectHanging({ queryTimeoutMs: 500 });
      const started = performance.now();
      const error = await listRepos(db).then(
        () => null,
        (reason: unknown) => reason,
      );
      const elapsed = performance.now() - started;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 500 ms/);
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
    });

    // A signal made once per handle would expire 500 ms after the first query started, in the
    // middle of the second.
    test('every query gets its own timeout: two 300 ms queries under a 500 ms timeout both succeed', async () => {
      const { db } = shim.connect({ schema: scratch.schema, queryTimeoutMs: 500, delayMs: 300 });
      expect(await listRepos(db)).toEqual([]);
      expect(await listRepos(db)).toEqual([]);
    });
  });
});
