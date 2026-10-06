import { AttributionSchema, type Commit, CommitSchema, RepoSchema } from '@code-trust/shared';
import {
  attributionFixtures,
  commitFixtures,
  newRepoFixture,
  REPO_ID,
  repoFixture,
  SHA,
  survivalCurveFixture,
  survivalMetricFixture,
  survivalObservationFixtures,
} from '@code-trust/shared/fixtures';
import { type CompiledQuery, Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from './database.ts';
import { createPgDb } from './pg.ts';
import {
  type AttributionKey,
  deleteAttributionsExcept,
  deleteCommitsExcept,
  deleteRepo,
  deleteSurvivalObservations,
  deleteSurvivalObservationsExcept,
  getRepo,
  listAttributions,
  listCommits,
  listRepos,
  listSurvivalMetrics,
  listSurvivalObservations,
  type SurvivalObservationKey,
  setRepoHead,
  upsertAttributions,
  upsertCommits,
  upsertRepo,
  upsertSurvivalObservations,
  upsertSurvivalRollup,
} from './queries.ts';
import { createTestDatabase, repoHeadFixture, seedFixtures, type TestDatabase, testDatabaseUrl } from './testing.ts';
import { installNeonShim, type NeonShim } from './testing-neon.ts';

test('createPgDb refuses a schema name it would have to quote', () => {
  expect(() => createPgDb('postgres://localhost/x', { schema: 'public; drop table repos' })).toThrow(/schema name/);
});

describe.skipIf(testDatabaseUrl === null)('queries', () => {
  let scratch: TestDatabase;

  beforeAll(async () => {
    scratch = await createTestDatabase();
  });

  afterAll(async () => {
    await scratch?.destroy();
  });

  beforeEach(async () => {
    for (const repo of await listRepos(scratch.db)) await deleteRepo(scratch.db, repo.id);
  });

  describe('repos', () => {
    test('a new repo round-trips with no head', async () => {
      await upsertRepo(scratch.db, newRepoFixture);
      const stored = await getRepo(scratch.db, REPO_ID);
      expect(stored).toEqual(newRepoFixture);
      expect(RepoSchema.parse(stored)).toEqual(newRepoFixture);
    });

    test('an analyzed repo round-trips with its head and last activity', async () => {
      await upsertRepo(scratch.db, newRepoFixture);
      expect(await setRepoHead(scratch.db, REPO_ID, repoHeadFixture)).toBe(true);
      const stored = await getRepo(scratch.db, REPO_ID);
      expect(stored).toEqual(repoFixture);
      expect(stored?.headCommittedAt).toBe(repoFixture.headCommittedAt);
    });

    test('upsertRepo creates a repo with no head, even when handed one', async () => {
      await upsertRepo(scratch.db, repoFixture);
      expect(await getRepo(scratch.db, REPO_ID)).toEqual(newRepoFixture);
    });

    test('a rename updates the row, since the GitHub id is the key, and keeps the head', async () => {
      await seedFixtures(scratch.db);
      await upsertRepo(scratch.db, { ...newRepoFixture, name: 'renamed', installationId: null });
      expect(await listRepos(scratch.db)).toEqual([{ ...repoFixture, name: 'renamed', installationId: null }]);
    });

    test('a new analysis that dies before its last write leaves the old head and its metrics', async () => {
      await seedFixtures(scratch.db);
      const metrics = await listSurvivalMetrics(scratch.db, REPO_ID);
      // The first writes of the next job, and then nothing: no setRepoHead.
      await upsertRepo(scratch.db, newRepoFixture);
      await upsertCommits(scratch.db, commitFixtures);
      expect(await getRepo(scratch.db, REPO_ID)).toEqual(repoFixture);
      expect(await listSurvivalMetrics(scratch.db, REPO_ID)).toEqual(metrics);
    });

    test('setRepoHead moves the head, and reports a repo that does not exist', async () => {
      await seedFixtures(scratch.db);
      const next = { ...repoHeadFixture, headSha: '9'.repeat(40), observedAt: '2026-10-02T00:00:00.000Z' };
      expect(await setRepoHead(scratch.db, REPO_ID, next)).toBe(true);
      expect(await getRepo(scratch.db, REPO_ID)).toEqual({ ...repoFixture, ...next });
      expect(await setRepoHead(scratch.db, 404, next)).toBe(false);
    });

    test('a missing repo is null', async () => {
      expect(await getRepo(scratch.db, 404)).toBeNull();
    });

    test('repos list by owner, then name', async () => {
      await upsertRepo(scratch.db, { ...newRepoFixture, id: 3, owner: 'zeta', name: 'a' });
      await upsertRepo(scratch.db, { ...newRepoFixture, id: 2, owner: 'alpha', name: 'b' });
      await upsertRepo(scratch.db, { ...newRepoFixture, id: 1, owner: 'alpha', name: 'a' });
      expect((await listRepos(scratch.db)).map((repo) => repo.id)).toEqual([1, 2, 3]);
    });

    test('a repo that breaks the contract is refused before it reaches the table', async () => {
      await expect(upsertRepo(scratch.db, { ...newRepoFixture, owner: 'octo/org' })).rejects.toThrow(/GitHub owner/);
      expect(await getRepo(scratch.db, REPO_ID)).toBeNull();
      await upsertRepo(scratch.db, newRepoFixture);
      await expect(setRepoHead(scratch.db, REPO_ID, { ...repoHeadFixture, headSha: 'main' })).rejects.toThrow(
        /40 lowercase hex/,
      );
      expect(await getRepo(scratch.db, REPO_ID)).toEqual(newRepoFixture);
    });
  });

  describe('commits and attributions', () => {
    beforeEach(async () => {
      await seedFixtures(scratch.db);
    });

    test('commits come back equal to what was written, and valid', async () => {
      const stored = await listCommits(scratch.db, REPO_ID);
      for (const commit of stored) expect(CommitSchema.parse(commit)).toEqual(commit);
      expect(stored).toEqual([...commitFixtures].sort((a, b) => a.landedAt.localeCompare(b.landedAt)));
    });

    test('attributions come back equal to what was written, and valid', async () => {
      const stored = await listAttributions(scratch.db, REPO_ID);
      for (const attribution of stored) expect(AttributionSchema.parse(attribution)).toEqual(attribution);
      expect(stored).toEqual([...attributionFixtures].sort((a, b) => a.commitSha.localeCompare(b.commitSha)));
    });

    test('reclassifying a commit rewrites the commit and nothing else', async () => {
      const observations = await listSurvivalObservations(scratch.db, REPO_ID);
      const [first] = commitFixtures;
      if (!first) throw new Error('fixtures missing');
      await upsertCommits(scratch.db, [{ ...first, cohort: 'human' }]);
      expect((await listCommits(scratch.db, REPO_ID)).find((commit) => commit.sha === first.sha)?.cohort).toBe('human');
      expect(await listSurvivalObservations(scratch.db, REPO_ID)).toEqual(observations);
      expect(await listSurvivalObservations(scratch.db, REPO_ID, 'ai')).toHaveLength(1);
    });
  });

  describe('writes', () => {
    test('empty lists are no-ops', async () => {
      await upsertCommits(scratch.db, []);
      await upsertAttributions(scratch.db, []);
      await upsertSurvivalObservations(scratch.db, []);
      await deleteSurvivalObservations(scratch.db, REPO_ID, []);
    });

    test('a list longer than one batch is written whole', async () => {
      await upsertRepo(scratch.db, newRepoFixture);
      const [template] = commitFixtures;
      if (!template) throw new Error('fixtures missing');
      const many: Commit[] = Array.from({ length: 2500 }, (_, i) => ({
        ...template,
        sha: i.toString(16).padStart(40, '0'),
      }));
      await upsertCommits(scratch.db, many);
      expect(await listCommits(scratch.db, REPO_ID)).toHaveLength(2500);
    });

    test('running the whole write sequence twice changes nothing', async () => {
      await seedFixtures(scratch.db);
      const snapshot = async () => ({
        repos: await listRepos(scratch.db),
        commits: await listCommits(scratch.db, REPO_ID),
        attributions: await listAttributions(scratch.db, REPO_ID),
        observations: await listSurvivalObservations(scratch.db, REPO_ID),
      });
      const before = await snapshot();
      await seedFixtures(scratch.db);
      expect(await snapshot()).toEqual(before);
    });

    // Neon's HTTP driver has no interactive transactions, and the Lambda lanes will use it.
    test('every write works on a database that cannot open a transaction', async () => {
      const forbidden = new Set<PropertyKey>(['transaction', 'startTransaction', 'connection']);
      const noTransactions = new Proxy(scratch.db, {
        get(target, property) {
          if (forbidden.has(property)) throw new Error(`a query called db.${String(property)}()`);
          const value: unknown = Reflect.get(target, property, target);
          // Kysely keeps its state in private fields, which only resolve on the real instance.
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as Kysely<Database>;

      await seedFixtures(noTransactions);
      await deleteSurvivalObservations(noTransactions, REPO_ID, [{ introducedBy: SHA.aiRecent, removedBy: null }]);
      await deleteCommitsExcept(noTransactions, REPO_ID, [SHA.aiOld]);
      await deleteAttributionsExcept(noTransactions, REPO_ID, []);
      await deleteSurvivalObservationsExcept(noTransactions, REPO_ID, []);
      await upsertSurvivalRollup(noTransactions, {
        metric: survivalMetricFixture,
        points: survivalCurveFixture.points,
      });
      expect(await deleteRepo(noTransactions, REPO_ID)).toBe(true);
      expect(() => noTransactions.transaction()).toThrow(/db\.transaction/);
      expect(survivalObservationFixtures.length).toBeGreaterThan(0);
    });
  });
});

describe.skipIf(testDatabaseUrl === null)('prunes', () => {
  const OTHER_ID = REPO_ID + 1;
  let scratch: TestDatabase;
  let shim: NeonShim;
  let neonDb: Kysely<Database>;
  // node-postgres with a query log, so the tests can count bind parameters per statement.
  let loggedPg: Kysely<Database>;
  const pgStatements: CompiledQuery[] = [];

  beforeAll(async () => {
    scratch = await createTestDatabase();
    shim = installNeonShim();
    neonDb = shim.connect({ schema: scratch.schema }).db;
    loggedPg = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: testDatabaseUrl ?? '', options: `-c search_path=${scratch.schema}` }),
      }),
      log: (event) => {
        if (event.level === 'query') pgStatements.push(event.query);
      },
    });
  });

  afterAll(async () => {
    await loggedPg?.destroy();
    await shim?.close();
    await scratch?.destroy();
  });

  // The fixtures, and a second repo with the same commits, which no prune of REPO_ID may touch.
  beforeEach(async () => {
    for (const repo of await listRepos(scratch.db)) await deleteRepo(scratch.db, repo.id);
    await seedFixtures(scratch.db);
    const other = <T extends { repoId: number }>(rows: T[]) => rows.map((row) => ({ ...row, repoId: OTHER_ID }));
    await upsertRepo(scratch.db, { ...newRepoFixture, id: OTHER_ID, name: 'other' });
    await upsertCommits(scratch.db, other(commitFixtures));
    await upsertAttributions(scratch.db, other(attributionFixtures));
    await upsertSurvivalObservations(scratch.db, other(survivalObservationFixtures));
  });

  const stored = async (repoId: number) => ({
    commits: (await listCommits(scratch.db, repoId)).map((c) => c.sha).sort(),
    attributions: (await listAttributions(scratch.db, repoId))
      .map((a) => `${a.commitSha[0]} ${a.signal} ${a.tool}`)
      .sort(),
    observations: (await listSurvivalObservations(scratch.db, repoId))
      .map((o) => `${o.introducedBy[0]}-${o.removedBy?.[0] ?? 'alive'}`)
      .sort(),
  });

  const dialects = {
    'node-postgres': () => ({ db: loggedPg, binds: () => pgStatements.map((query) => query.parameters.length) }),
    neon: () => ({ db: neonDb, binds: () => shim.requests.map((request) => request.params.length) }),
  };

  describe.each(Object.keys(dialects) as (keyof typeof dialects)[])('through %s', (dialect) => {
    const handle = () => dialects[dialect]();

    test('deleteCommitsExcept keeps exactly the listed commits and removes the rest with their attributions and observations', async () => {
      const otherBefore = await stored(OTHER_ID);
      const removed = await deleteCommitsExcept(handle().db, REPO_ID, [SHA.aiOld, SHA.aiRecent, SHA.removerOne]);
      expect(removed).toBe(2);
      expect(await stored(REPO_ID)).toEqual({
        commits: [SHA.aiOld, SHA.aiRecent, SHA.removerOne],
        attributions: ['a co_author_trailer claude', 'b co_author_trailer claude'],
        observations: ['a-alive', 'a-c', 'b-alive'],
      });
      expect(await stored(OTHER_ID)).toEqual(otherBefore);
    });

    test("deleteCommitsExcept with an empty list removes all of the repo's commits", async () => {
      const otherBefore = await stored(OTHER_ID);
      expect(await deleteCommitsExcept(handle().db, REPO_ID, [])).toBe(commitFixtures.length);
      expect(await stored(REPO_ID)).toEqual({ commits: [], attributions: [], observations: [] });
      expect(await getRepo(scratch.db, REPO_ID)).toEqual(repoFixture);
      expect(await stored(OTHER_ID)).toEqual(otherBefore);
    });

    test('deleteAttributionsExcept keeps exactly the listed keys and removes the others of a kept commit', async () => {
      const otherBefore = await stored(OTHER_ID);
      const keep: AttributionKey[] = [
        { commitSha: SHA.aiOld, signal: 'co_author_trailer', tool: 'claude' },
        { commitSha: SHA.agent, signal: 'author_identity', tool: 'copilot' },
        // The same commit under another signal is a different key.
        { commitSha: SHA.aiRecent, signal: 'author_identity', tool: 'claude' },
      ];
      expect(await deleteAttributionsExcept(handle().db, REPO_ID, keep)).toBe(1);
      const after = await stored(REPO_ID);
      expect(after.attributions).toEqual(['a co_author_trailer claude', 'e author_identity copilot']);
      expect(after.commits).toHaveLength(commitFixtures.length);
      expect(await stored(OTHER_ID)).toEqual(otherBefore);
    });

    test('deleteSurvivalObservationsExcept keeps exactly the listed keys, an alive group next to a removed group of the same commit', async () => {
      const otherBefore = await stored(OTHER_ID);
      const keep: SurvivalObservationKey[] = [
        { introducedBy: SHA.aiOld, removedBy: SHA.removerOne },
        { introducedBy: SHA.aiOld, removedBy: null },
        // Not stored, and it must not keep the alive group of the same commit.
        { introducedBy: SHA.aiRecent, removedBy: SHA.removerOne },
      ];
      expect(await deleteSurvivalObservationsExcept(handle().db, REPO_ID, keep)).toBe(2);
      expect((await stored(REPO_ID)).observations).toEqual(['a-alive', 'a-c']);
      expect(await stored(OTHER_ID)).toEqual(otherBefore);
    });

    test('a 5000-key keep list is one statement with a fixed number of binds', async () => {
      const fake = (i: number) => (i + 1).toString(16).padStart(40, '0');
      const shas = [...commitFixtures.map((c) => c.sha), ...Array.from({ length: 4995 }, (_, i) => fake(i))];
      const attributionKeys: AttributionKey[] = [
        ...attributionFixtures,
        ...Array.from({ length: 4997 }, (_, i) => ({
          commitSha: fake(i),
          signal: 'co_author_trailer' as const,
          tool: 'claude',
        })),
      ];
      const observationKeys: SurvivalObservationKey[] = [
        ...survivalObservationFixtures,
        ...Array.from({ length: 4996 }, (_, i) => ({
          introducedBy: fake(i),
          removedBy: i % 2 === 0 ? null : fake(i + 1),
        })),
      ];
      expect([shas.length, attributionKeys.length, observationKeys.length]).toEqual([5000, 5000, 5000]);

      const { db, binds } = handle();
      const before = await stored(REPO_ID);
      const start = binds().length;
      expect(await deleteCommitsExcept(db, REPO_ID, shas)).toBe(0);
      expect(await deleteAttributionsExcept(db, REPO_ID, attributionKeys)).toBe(0);
      expect(await deleteSurvivalObservationsExcept(db, REPO_ID, observationKeys)).toBe(0);
      // repo id plus one array per key column.
      expect(binds().slice(start)).toEqual([2, 4, 3]);
      expect(await stored(REPO_ID)).toEqual(before);
    });
  });
});
