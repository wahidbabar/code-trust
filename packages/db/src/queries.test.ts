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
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from './database.ts';
import { createPgDb } from './pg.ts';
import {
  deleteRepo,
  deleteSurvivalObservations,
  getRepo,
  listAttributions,
  listCommits,
  listRepos,
  listSurvivalObservations,
  upsertAttributions,
  upsertCommits,
  upsertRepo,
  upsertSurvivalObservations,
  upsertSurvivalRollup,
} from './queries.ts';
import { createTestDatabase, seedFixtures, type TestDatabase, testDatabaseUrl } from './testing.ts';

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
      await upsertRepo(scratch.db, repoFixture);
      const stored = await getRepo(scratch.db, REPO_ID);
      expect(stored).toEqual(repoFixture);
      expect(stored?.headCommittedAt).toBe(repoFixture.headCommittedAt);
    });

    test('a rename updates the row, since the GitHub id is the key', async () => {
      await upsertRepo(scratch.db, repoFixture);
      await upsertRepo(scratch.db, { ...repoFixture, name: 'renamed', installationId: null });
      expect(await listRepos(scratch.db)).toEqual([{ ...repoFixture, name: 'renamed', installationId: null }]);
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
      await expect(upsertRepo(scratch.db, { ...repoFixture, headCommittedAt: null })).rejects.toThrow(/set together/);
      expect(await getRepo(scratch.db, REPO_ID)).toBeNull();
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
