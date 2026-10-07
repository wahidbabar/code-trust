import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '@code-trust/db/testing';
import type { RepoRef } from '@code-trust/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createGitRunner, type GitRunner } from './git.ts';
import { type JobDeps, type LogEntry, runJob } from './job.ts';
import {
  analyzeJob,
  buildHistory,
  CREDENTIALS_STDERR,
  deleteJob,
  detailsOf,
  expectedAnalysis,
  expectedRows,
  type FailTarget,
  failingGit,
  failOn,
  InjectedFailure,
  loggedDb,
  makeTempDir,
  NOT_FOUND_STDERR,
  NOTHING_STORED,
  removeTempDirs,
  snapshot,
  spyGit,
  statementOf,
  TestClock,
  TestRepo,
  writeStaleRows,
} from './testing.ts';

const git = createGitRunner();

let nextRepoId = 1000;
function newRepo(name = 'hello'): RepoRef {
  nextRepoId += 1;
  return { id: nextRepoId, owner: 'octo-org', name: `${name}-${nextRepoId}` };
}

describe.skipIf(testDatabaseUrl === null)('runJob', { timeout: 60_000 }, () => {
  let database: TestDatabase;
  const clock = new TestClock();
  const logs: LogEntry[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.destroy();
    removeTempDirs();
  });

  function deps(origin: TestRepo, overrides: Partial<JobDeps> = {}): JobDeps {
    return {
      db: database.db,
      now: clock.now,
      workRoot: makeTempDir('code-trust-work-'),
      git,
      cloneUrl: () => origin.url,
      log: (entry) => logs.push(entry),
      ...overrides,
    };
  }

  /** The rows a clean analysis of the origin's tip at the clock's current time would write. */
  async function clean(origin: TestRepo, repo: RepoRef) {
    return expectedRows(await expectedAnalysis(origin, repo.id, clock.iso()), detailsOf(repo));
  }

  describe('analyze', () => {
    test('an analyze job stores exactly what analyzeRepo returns for the same commit and observedAt', async () => {
      const origin = TestRepo.create();
      buildHistory(origin, 12);
      const repo = newRepo();
      clock.advance();

      const outcome = await runJob(analyzeJob(repo, 'push'), deps(origin));

      expect(outcome).toMatchObject({ outcome: 'analyzed', headSha: origin.head(), commitCount: 12 });
      const stored = await snapshot(database.db, repo.id);
      expect(stored).toEqual(await clean(origin, repo));
      expect(stored.repo).toMatchObject({ headSha: origin.head(), observedAt: clock.iso(), defaultBranch: 'main' });
      // The history has all three cohorts, and the two measured ones have curves.
      expect(new Set(stored.commits.map((commit) => commit.cohort))).toEqual(new Set(['ai', 'human', 'automation']));
      expect(stored.metrics.map((metric) => metric.cohort)).toEqual(['ai', 'human']);
      expect(stored.attributions.length).toBeGreaterThan(0);
    });

    test('a second push job with no new commits is skipped: no clone, no row changed', async () => {
      const origin = TestRepo.create();
      buildHistory(origin, 6);
      const repo = newRepo();
      clock.advance();
      await runJob(analyzeJob(repo, 'push'), deps(origin));
      const before = await snapshot(database.db, repo.id);

      clock.advance();
      const spy = spyGit(git);
      const outcome = await runJob(analyzeJob(repo, 'push'), deps(origin, { git: spy.git }));

      expect(outcome).toEqual({
        outcome: 'skipped',
        skip: 'head-unchanged',
        headSha: origin.head(),
        commitCount: 0,
        statementCount: 1,
      });
      expect(spy.commands()).toEqual(['ls-remote']);
      expect(await snapshot(database.db, repo.id)).toEqual(before);
    });

    test('a backfill job with no new commits clones and matches a clean run at the new observedAt', async () => {
      const origin = TestRepo.create();
      buildHistory(origin, 6);
      const repo = newRepo();
      clock.advance();
      await runJob(analyzeJob(repo, 'push'), deps(origin));
      const first = await snapshot(database.db, repo.id);

      clock.advance();
      const spy = spyGit(git);
      const outcome = await runJob(analyzeJob(repo, 'backfill'), deps(origin, { git: spy.git }));

      expect(outcome).toMatchObject({ outcome: 'analyzed', headSha: origin.head() });
      expect(spy.commands()).toEqual(['ls-remote', 'clone']);
      const stored = await snapshot(database.db, repo.id);
      expect(stored).toEqual(await clean(origin, repo));
      expect(stored.repo?.observedAt).toBe(clock.iso());
      expect(stored.repo?.observedAt).not.toBe(first.repo?.observedAt);
    });

    test('new commits move the head and the rows equal the new analysis', async () => {
      const origin = TestRepo.create();
      buildHistory(origin, 5);
      const repo = newRepo();
      clock.advance();
      await runJob(analyzeJob(repo, 'push'), deps(origin));
      const oldHead = origin.head();

      buildHistory(origin, 3, 'g');
      clock.advance();
      const outcome = await runJob(analyzeJob(repo, 'push'), deps(origin));

      expect(outcome).toMatchObject({ outcome: 'analyzed', headSha: origin.head(), commitCount: 8 });
      expect(origin.head()).not.toBe(oldHead);
      expect(await snapshot(database.db, repo.id)).toEqual(await clean(origin, repo));
    });

    test('a force-push that drops commits removes them and their observations', async () => {
      const origin = TestRepo.create();
      const shas = buildHistory(origin, 8);
      const repo = newRepo();
      clock.advance();
      await runJob(analyzeJob(repo, 'push'), deps(origin));
      const dropped = new Set(shas.slice(5));
      const before = await snapshot(database.db, repo.id);
      expect(before.commits.filter((commit) => dropped.has(commit.sha))).toHaveLength(3);
      expect(before.observations.some((o) => dropped.has(o.introducedBy))).toBe(true);
      expect(before.attributions.some((a) => dropped.has(a.commitSha))).toBe(false);

      // Back to the sixth commit, then new work on top. Commit 4 (AI) and 1 and 2 (human) stay,
      // so both measured cohorts keep lines and a rollup each.
      origin.resetHard(shas[4] as string);
      buildHistory(origin, 3, 'g');
      clock.advance();
      const outcome = await runJob(analyzeJob(repo, 'push'), deps(origin));

      expect(outcome).toMatchObject({ outcome: 'analyzed', headSha: origin.head() });
      const stored = await snapshot(database.db, repo.id);
      expect(stored.commits.filter((commit) => dropped.has(commit.sha))).toEqual([]);
      expect(stored.observations.filter((o) => dropped.has(o.introducedBy) || dropped.has(o.removedBy ?? ''))).toEqual(
        [],
      );
      expect(stored).toEqual(await clean(origin, repo));
    });

    test('a backfill removes attributions and observation groups the new analysis no longer has', async () => {
      const origin = TestRepo.create();
      const shas = buildHistory(origin, 6);
      const repo = newRepo();
      clock.advance();
      await runJob(analyzeJob(repo, 'push'), deps(origin));
      // As an older analyzer might have left them, on commits the repo still has.
      await writeStaleRows(database.db, repo.id, shas[1] as string, shas[2] as string);
      const stale = await snapshot(database.db, repo.id);
      expect(stale.attributions.filter((a) => a.tool === 'copilot')).toHaveLength(1);
      expect(stale.observations.filter((o) => o.introducedBy === shas[1] && o.removedBy === shas[2])).toHaveLength(1);

      clock.advance();
      await runJob(analyzeJob(repo, 'backfill'), deps(origin));

      expect(await snapshot(database.db, repo.id)).toEqual(await clean(origin, repo));
    });

    test('a job whose headSha is older than the remote tip analyzes the tip', async () => {
      const origin = TestRepo.create();
      const shas = buildHistory(origin, 4);
      const repo = newRepo();
      clock.advance();

      const outcome = await runJob(analyzeJob(repo, 'push', shas[0]), deps(origin));

      expect(outcome).toMatchObject({ outcome: 'analyzed', headSha: shas[3] });
      expect((await snapshot(database.db, repo.id)).repo?.headSha).toBe(shas[3]);
    });

    test('an empty repository is skipped with no clone and no write', async () => {
      const origin = TestRepo.create();
      const repo = newRepo();
      const spy = spyGit(git);

      const outcome = await runJob(analyzeJob(repo, 'backfill'), deps(origin, { git: spy.git }));

      expect(outcome).toEqual({ outcome: 'skipped', skip: 'empty', headSha: null, commitCount: 0, statementCount: 0 });
      expect(spy.commands()).toEqual(['ls-remote']);
      expect(await snapshot(database.db, repo.id)).toEqual(NOTHING_STORED);
    });

    test('logs one line per job with its ids, reason, outcome and counts, a failed one too', async () => {
      const origin = TestRepo.create();
      buildHistory(origin, 4);
      const repo = newRepo();
      const analyzed = analyzeJob(repo, 'backfill');
      const failed = analyzeJob(repo, 'backfill');
      const removed = deleteJob(repo);
      const lines: LogEntry[] = [];
      const log = (entry: LogEntry) => lines.push(entry);

      await runJob(analyzed, deps(origin, { log }));
      await expect(runJob(failed, deps(origin, { db: failOn(database.db, 'setRepoHead').db, log }))).rejects.toThrow();
      await runJob(removed, deps(origin, { log }));

      const ids = (job: { jobId: string; deliveryId: string }) => ({ jobId: job.jobId, deliveryId: job.deliveryId });
      expect(lines).toEqual([
        {
          ...ids(analyzed),
          repoId: repo.id,
          type: 'analyze',
          reason: 'backfill',
          outcome: 'analyzed',
          durationMs: 0,
          commitCount: 4,
          statementCount: 10,
          headSha: origin.head(),
        },
        {
          ...ids(failed),
          repoId: repo.id,
          type: 'analyze',
          reason: 'backfill',
          outcome: 'failed',
          durationMs: 0,
          commitCount: 4,
          // Everything up to setRepoHead ran; the failed statement was never sent.
          statementCount: 9,
          error: 'InjectedFailure: setRepoHead failed on purpose',
        },
        {
          ...ids(removed),
          repoId: repo.id,
          type: 'delete_repo',
          reason: 'privatized',
          outcome: 'deleted',
          durationMs: 0,
          commitCount: 0,
          statementCount: 1,
          existed: true,
        },
      ]);
    });
  });

  describe('a database that fails midway', () => {
    const targets: [FailTarget, string][] = [
      ['deleteCommitsExcept', 'deleteCommitsExcept'],
      ['deleteAttributionsExcept', 'deleteAttributionsExcept'],
      ['deleteSurvivalObservationsExcept', 'deleteSurvivalObservationsExcept'],
      ['upsertSurvivalRollup', 'the rollup write'],
      ['setRepoHead', 'setRepoHead'],
    ];

    test.each(targets)(
      'a database that fails on %s (%s): the job throws, the head stays, and a rerun converges',
      async (target) => {
        // A force-push and rows an older analyzer left, between the first job and the failing one,
        // so the rerun has stale rows for each of the three prunes.
        const origin = TestRepo.create();
        const shas = buildHistory(origin, 8);
        const repo = newRepo();
        clock.advance();
        await runJob(analyzeJob(repo, 'push'), deps(origin));
        await writeStaleRows(database.db, repo.id, shas[1] as string, shas[2] as string);
        const previousHead = origin.head();
        origin.resetHard(shas[4] as string);
        buildHistory(origin, 3, 'g');

        clock.advance();
        const failing = failOn(database.db, target);
        const workRoot = makeTempDir('code-trust-work-');
        await expect(runJob(analyzeJob(repo, 'push'), deps(origin, { db: failing.db, workRoot }))).rejects.toThrow(
          InjectedFailure,
        );
        expect(failing.fired).toBe(true);
        expect((await snapshot(database.db, repo.id)).repo?.headSha).toBe(previousHead);
        expect(readdirSync(workRoot)).toEqual([]);

        clock.advance();
        const rerun = await runJob(analyzeJob(repo, 'push'), deps(origin));
        expect(rerun).toMatchObject({ outcome: 'analyzed', headSha: origin.head() });
        expect(await snapshot(database.db, repo.id)).toEqual(await clean(origin, repo));
      },
    );
  });

  describe('unavailable', () => {
    test('ls-remote reporting Repository not found is unavailable: no writes, no deletes', async () => {
      const origin = TestRepo.create();
      buildHistory(origin, 4);
      const repo = newRepo();
      clock.advance();
      await runJob(analyzeJob(repo, 'push'), deps(origin));
      const before = await snapshot(database.db, repo.id);
      expect(before.commits).toHaveLength(4);

      clock.advance();
      const fake = failingGit(git, 'ls-remote', NOT_FOUND_STDERR);
      const outcome = await runJob(analyzeJob(repo, 'backfill'), deps(origin, { git: fake.git }));

      expect(outcome).toEqual({ outcome: 'unavailable', stage: 'ls-remote', commitCount: 0, statementCount: 0 });
      expect(fake.commands()).toEqual(['ls-remote']);
      expect(await snapshot(database.db, repo.id)).toEqual(before);
    });

    test('a clone that needs credentials is unavailable and writes nothing', async () => {
      const origin = TestRepo.create();
      buildHistory(origin, 2);
      const repo = newRepo();
      const workRoot = makeTempDir('code-trust-work-');
      const fake = failingGit(git, 'clone', CREDENTIALS_STDERR);

      const outcome = await runJob(analyzeJob(repo, 'backfill'), deps(origin, { git: fake.git, workRoot }));

      expect(outcome).toEqual({ outcome: 'unavailable', stage: 'clone', commitCount: 0, statementCount: 0 });
      expect(await snapshot(database.db, repo.id)).toEqual(NOTHING_STORED);
      expect(readdirSync(workRoot)).toEqual([]);
    });
  });

  describe('the work root', () => {
    test('a directory a killed job left is gone before the next job runs git', async () => {
      const origin = TestRepo.create();
      buildHistory(origin, 2);
      const workRoot = makeTempDir('code-trust-work-');
      mkdirSync(join(workRoot, 'clone-killed', '.git', 'objects'), { recursive: true });
      writeFileSync(join(workRoot, 'clone-killed', '.git', 'objects', 'pack.tmp'), 'half a pack');
      writeFileSync(join(workRoot, 'stray'), '');
      const seen: string[][] = [];
      const spy = spyGit(git, () => {
        seen.push(readdirSync(workRoot));
        return undefined;
      });

      await runJob(analyzeJob(newRepo(), 'backfill'), deps(origin, { git: spy.git, workRoot }));

      expect(seen[0]).toEqual([]);
      expect(readdirSync(workRoot)).toEqual([]);
    });

    test('a work root that does not exist yet is created', async () => {
      const origin = TestRepo.create();
      buildHistory(origin, 2);
      const workRoot = join(makeTempDir('code-trust-work-'), 'work');

      await runJob(analyzeJob(newRepo(), 'backfill'), deps(origin, { workRoot }));

      expect(readdirSync(workRoot)).toEqual([]);
    });

    test.each(['successful', 'skipped', 'failed'])('the work root is empty after a %s job', async (kind) => {
      const origin = TestRepo.create();
      buildHistory(origin, 3);
      const repo = newRepo();
      clock.advance();
      if (kind === 'skipped') await runJob(analyzeJob(repo, 'push'), deps(origin));
      const workRoot = makeTempDir('code-trust-work-');
      const db = kind === 'failed' ? failOn(database.db, 'setRepoHead').db : database.db;

      const run = runJob(analyzeJob(repo, 'push'), deps(origin, { db, workRoot }));

      if (kind === 'failed') await expect(run).rejects.toThrow(InjectedFailure);
      else await expect(run).resolves.toMatchObject({ outcome: kind === 'skipped' ? 'skipped' : 'analyzed' });
      expect(readdirSync(workRoot)).toEqual([]);
    });
  });

  describe('delete_repo', () => {
    test('a delete job removes the repo and all its rows', async () => {
      const origin = TestRepo.create();
      buildHistory(origin, 4);
      const repo = newRepo();
      await runJob(analyzeJob(repo, 'push'), deps(origin));
      expect((await snapshot(database.db, repo.id)).commits).toHaveLength(4);

      const outcome = await runJob(deleteJob(repo), deps(origin));

      expect(outcome).toEqual({ outcome: 'deleted', existed: true, commitCount: 0, statementCount: 1 });
      expect(await snapshot(database.db, repo.id)).toEqual(NOTHING_STORED);
    });

    test('a delete of an unknown repo succeeds', async () => {
      const outcome = await runJob(deleteJob(newRepo()), deps(TestRepo.create()));
      expect(outcome).toEqual({ outcome: 'deleted', existed: false, commitCount: 0, statementCount: 1 });
    });

    test("another repo's rows are untouched", async () => {
      const origin = TestRepo.create();
      buildHistory(origin, 4);
      const gone = newRepo();
      const kept = newRepo();
      await runJob(analyzeJob(gone, 'push'), deps(origin));
      await runJob(analyzeJob(kept, 'push'), deps(origin));
      const before = await snapshot(database.db, kept.id);
      expect(before.commits).toHaveLength(4);

      await runJob(deleteJob(gone), deps(origin));

      expect(await snapshot(database.db, kept.id)).toEqual(before);
    });
  });
});

describe.skipIf(testDatabaseUrl === null)('round trips', { timeout: 60_000 }, () => {
  let database: TestDatabase;
  let logged: ReturnType<typeof loggedDb>;
  const clock = new TestClock();

  beforeAll(async () => {
    database = await createTestDatabase();
    logged = loggedDb(database.schema);
  });
  afterAll(async () => {
    await logged?.destroy();
    await database?.destroy();
    removeTempDirs();
  });

  /** Runs one push job through the logged handle and returns its outcome and the statements it sent. */
  async function countedJob(origin: TestRepo, repo: RepoRef, jobGit: GitRunner = git) {
    const from = logged.events.length;
    const outcome = await runJob(analyzeJob(repo, 'push'), {
      db: logged.db,
      now: clock.now,
      workRoot: makeTempDir('code-trust-work-'),
      git: jobGit,
      cloneUrl: () => origin.url,
      log: () => {},
    });
    return { outcome, statements: logged.events.slice(from) };
  }

  test('an analyze job on a 50-commit repo issues 11 statements, as many as on a 10-commit repo', async () => {
    const large = TestRepo.create();
    buildHistory(large, 50);
    const small = TestRepo.create();
    buildHistory(small, 10);

    const fifty = await countedJob(large, newRepo('large'));
    const ten = await countedJob(small, newRepo('small'));

    expect(fifty.statements).toHaveLength(11);
    expect(fifty.outcome).toMatchObject({ outcome: 'analyzed', commitCount: 50, statementCount: 11 });
    expect(ten.statements).toHaveLength(11);
    expect(ten.outcome).toMatchObject({ outcome: 'analyzed', commitCount: 10, statementCount: 11 });
  });

  test('writes in the order packages/db/README.md gives, setRepoHead last', async () => {
    const origin = TestRepo.create();
    buildHistory(origin, 8);

    const { statements } = await countedJob(origin, newRepo());

    expect(statements.map(statementOf)).toEqual([
      'select repos',
      'insert repos',
      'insert commits',
      'insert attributions',
      'insert survival_observations',
      'delete commits',
      'delete attributions',
      'delete survival_observations',
      'insert survival_rollups',
      'insert survival_rollups',
      'update repos',
    ]);
  });
});
