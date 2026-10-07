import { getRepo } from '@code-trust/db';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '@code-trust/db/testing';
import type { JobMessage, RepoRef } from '@code-trust/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ssmParameterLoader } from './aws.ts';
import { createGitRunner, type GitRunner } from './git.ts';
import { createHandler, type SqsRecord } from './handler.ts';
import { type LogEntry, runJob } from './job.ts';
import {
  analyzeJob,
  buildHistory,
  deleteJob,
  failingGit,
  fakeSsm,
  makeTempDir,
  NOT_FOUND_STDERR,
  removeTempDirs,
  snapshot,
  TestClock,
  TestRepo,
} from './testing.ts';

const DATABASE_URL = 'postgres://worker:s3cret-pass@example.invalid/code_trust';
const PARAMETER = '/code-trust/database-url';

let nextRepoId = 5000;
function newRepo(): RepoRef {
  nextRepoId += 1;
  return { id: nextRepoId, owner: 'octo-org', name: `repo-${nextRepoId}` };
}

function record(messageId: string, body: JobMessage | string): SqsRecord {
  return { messageId, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

describe.skipIf(testDatabaseUrl === null)('createHandler', { timeout: 60_000 }, () => {
  let database: TestDatabase;
  const clock = new TestClock();
  const git = createGitRunner();
  // Every repo a test analyzes clones from here; a repo id with no origin points at nothing.
  const origins = new Map<number, TestRepo>();

  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.destroy();
    removeTempDirs();
  });

  function handlerWith(options: { ssm?: ReturnType<typeof fakeSsm>; git?: GitRunner } = {}) {
    const ssm = options.ssm ?? fakeSsm(DATABASE_URL);
    const opened: string[] = [];
    const logs: LogEntry[] = [];
    const handler = createHandler({
      loadDatabaseUrl: ssmParameterLoader(ssm.client, PARAMETER),
      openDb: (url) => {
        opened.push(url);
        return database.db;
      },
      workRoot: makeTempDir('code-trust-work-'),
      git: options.git ?? git,
      cloneUrl: (repo) => origins.get(repo.id)?.url ?? `file:///nonexistent/${repo.name}`,
      now: clock.now,
      log: (entry) => logs.push(entry),
    });
    return { handler, ssm, opened, logs };
  }

  /** A repo with a few commits, already analyzed, so a test can see whether a later record ran. */
  async function analyzedRepo(): Promise<RepoRef> {
    const repo = newRepo();
    const origin = TestRepo.create();
    buildHistory(origin, 3);
    origins.set(repo.id, origin);
    await runJob(analyzeJob(repo, 'backfill'), {
      db: database.db,
      now: clock.now,
      workRoot: makeTempDir('code-trust-work-'),
      git,
      cloneUrl: () => origin.url,
      log: () => {},
    });
    return repo;
  }

  test('parses each record with JobMessageSchema and runs its job', async () => {
    const analyzed = newRepo();
    const origin = TestRepo.create();
    buildHistory(origin, 3);
    origins.set(analyzed.id, origin);
    const removed = await analyzedRepo();
    const { handler, opened } = handlerWith();

    const response = await handler({
      Records: [record('m1', analyzeJob(analyzed, 'backfill')), record('m2', deleteJob(removed))],
    });

    expect(response).toEqual({ batchItemFailures: [] });
    expect((await getRepo(database.db, analyzed.id))?.headSha).toBe(origin.head());
    expect(await getRepo(database.db, removed.id)).toBeNull();
    expect(opened).toEqual([DATABASE_URL]);
  });

  test('a record that fails to parse is reported together with every record after it', async () => {
    const first = await analyzedRepo();
    const later = await analyzedRepo();
    const { handler, logs } = handlerWith();
    const unknownVersion = JSON.stringify({ ...deleteJob(later), version: 2 });

    const notJson = await handler({
      Records: [record('m1', deleteJob(first)), record('m2', '{not json'), record('m3', deleteJob(later))],
    });
    const badSchema = await handler({ Records: [record('m4', unknownVersion), record('m5', deleteJob(later))] });

    expect(notJson).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }, { itemIdentifier: 'm3' }] });
    expect(badSchema).toEqual({ batchItemFailures: [{ itemIdentifier: 'm4' }, { itemIdentifier: 'm5' }] });
    // The first record ran; the ones after the bad record did not.
    expect(await getRepo(database.db, first.id)).toBeNull();
    expect(await getRepo(database.db, later.id)).not.toBeNull();
    expect(logs).toContainEqual({ messageId: 'm2', outcome: 'failed', cause: 'invalid-message' });
    expect(logs).toContainEqual({
      messageId: 'm3',
      outcome: 'not-run',
      cause: 'an earlier record in the batch failed',
    });
  });

  test('a record whose job throws is reported together with every record after it', async () => {
    const later = await analyzedRepo();
    const { handler, logs } = handlerWith();
    // No origin for this repo, so git fails in a way the classifier does not know, and the job throws.
    const job = analyzeJob(newRepo(), 'backfill');

    const response = await handler({ Records: [record('m1', job), record('m2', deleteJob(later))] });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }, { itemIdentifier: 'm2' }] });
    expect(await getRepo(database.db, later.id)).not.toBeNull();
    expect(logs).toContainEqual(expect.objectContaining({ jobId: job.jobId, outcome: 'failed' }));
  });

  test('an unavailable job is acknowledged, and its repo keeps its rows', async () => {
    const repo = await analyzedRepo();
    const before = await snapshot(database.db, repo.id);
    const { handler } = handlerWith({ git: failingGit(git, 'ls-remote', NOT_FOUND_STDERR).git });

    const response = await handler({ Records: [record('m1', analyzeJob(repo, 'backfill'))] });

    expect(response).toEqual({ batchItemFailures: [] });
    expect(await snapshot(database.db, repo.id)).toEqual(before);
  });

  test('reads the SSM parameter once across invocations', async () => {
    const { handler, ssm, opened } = handlerWith();

    await handler({ Records: [record('m1', deleteJob(newRepo()))] });
    await handler({ Records: [record('m2', deleteJob(newRepo())), record('m3', deleteJob(newRepo()))] });

    expect(ssm.sent.map((command) => command.input)).toEqual([{ Name: PARAMETER, WithDecryption: true }]);
    expect(opened).toEqual([DATABASE_URL]);
  });

  test('a failed SSM read fails the batch and is retried on the next invocation, not cached', async () => {
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    const { handler, ssm, logs } = handlerWith({ ssm: fakeSsm(DATABASE_URL, [throttled]) });
    const repo = await analyzedRepo();

    const failed = await handler({ Records: [record('m1', deleteJob(repo)), record('m2', deleteJob(newRepo()))] });
    expect(failed).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }, { itemIdentifier: 'm2' }] });
    expect(await getRepo(database.db, repo.id)).not.toBeNull();
    expect(logs).toContainEqual(
      expect.objectContaining({ messageId: 'm1', cause: 'database-unavailable', error: 'ThrottlingException' }),
    );

    const retried = await handler({ Records: [record('m3', deleteJob(repo))] });
    expect(retried).toEqual({ batchItemFailures: [] });
    expect(ssm.sent).toHaveLength(2);
    expect(await getRepo(database.db, repo.id)).toBeNull();
  });

  test('an empty batch calls no AWS', async () => {
    const { handler, ssm, opened } = handlerWith();
    expect(await handler({ Records: [] })).toEqual({ batchItemFailures: [] });
    expect(ssm.sent).toEqual([]);
    expect(opened).toEqual([]);
  });

  test('a batch of records that do not parse calls no AWS', async () => {
    const { handler, ssm } = handlerWith();
    expect(await handler({ Records: [record('m1', '{}')] })).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(ssm.sent).toEqual([]);
  });

  test('no log line carries the database URL or anything read from SSM', async () => {
    const repo = await analyzedRepo();
    const { handler, logs } = handlerWith();

    await handler({ Records: [record('m1', analyzeJob(repo, 'backfill')), record('m2', deleteJob(repo))] });
    await handler({ Records: [record('m3', analyzeJob(newRepo(), 'backfill'))] });

    expect(logs.length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(logs);
    expect(text).not.toContain('s3cret-pass');
    expect(text).not.toContain('example.invalid');
  });
});
