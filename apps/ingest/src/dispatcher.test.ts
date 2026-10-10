import { JobMessageSchema, type RepoEventMessage } from '@code-trust/shared';
import {
  analysisJobFixture,
  backfillJobFixture,
  deleteRepoJobFixture,
  pushEventFixture,
  REPO_ID,
  repositoryAddedEventFixture,
  repositoryRemovedEventFixture,
} from '@code-trust/shared/fixtures';
import { describe, expect, test } from 'vitest';
import {
  createDispatcherHandler,
  type FifoBatchEntry,
  type SendFifoBatch,
  type SqsRecord,
  type ToJobDeps,
  toJob,
} from './dispatcher.ts';
import { captureLogs } from './testing.ts';

const fixedDeps = (job: { jobId: string; requestedAt: string }): ToJobDeps => ({
  newId: () => job.jobId,
  now: () => new Date(job.requestedAt),
});

/** Ids 00000000-0000-4000-8000-000000000001, ...2 and so on, in call order. */
function sequentialIds() {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
}

const testDeps = (): ToJobDeps => ({ newId: sequentialIds(), now: () => new Date('2026-10-01T09:30:01.000Z') });

/** One installation delivery's events: repos 1001, 1002 and so on, all under one delivery id. */
function installationEvents(count: number): RepoEventMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    ...repositoryAddedEventFixture,
    repo: { id: 1001 + i, owner: 'octo-org', name: `repo-${i + 1}` },
  }));
}

const record = (messageId: string, body: unknown): SqsRecord => ({
  messageId,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const records = (events: readonly RepoEventMessage[]) => events.map((event, i) => record(`r${i}`, event));

/**
 * Records every batch. `failures` maps a batch index to an error to throw or the entry ids SQS
 * reports as failed. `maxInFlight` is the most calls that were ever pending at once.
 */
function fakeJobsQueue(failures: Readonly<Record<number, Error | readonly string[]>> = {}) {
  const batches: FifoBatchEntry[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const sendBatch: SendFifoBatch = async (entries) => {
    const index = batches.length;
    batches.push([...entries]);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Yield, so a caller that does not wait for this call would start the next one now.
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight -= 1;
    const failure = failures[index];
    if (failure instanceof Error) throw failure;
    return { failed: (failure ?? []).map((id) => ({ id, code: 'InternalError' })) };
  };
  return {
    sendBatch,
    batches,
    get maxInFlight() {
      return maxInFlight;
    },
    get jobs() {
      return batches.flat().map((entry) => JSON.parse(entry.body));
    },
  };
}

const failedIds = (response: { batchItemFailures: { itemIdentifier: string }[] }) =>
  response.batchItemFailures.map((failure) => failure.itemIdentifier);

describe('toJob', () => {
  test('push maps to an analyze job with reason push and the head from the event', () => {
    const entry = toJob(pushEventFixture, fixedDeps(analysisJobFixture));
    expect(JSON.parse(entry.body)).toEqual(analysisJobFixture);
    expect(JobMessageSchema.parse(JSON.parse(entry.body))).toEqual(analysisJobFixture);
    expect(entry.job).toEqual(analysisJobFixture);
  });

  test('repository_added maps to an analyze job with reason backfill and a null head', () => {
    const entry = toJob(repositoryAddedEventFixture, fixedDeps(backfillJobFixture));
    expect(JSON.parse(entry.body)).toEqual(backfillJobFixture);
    expect(JobMessageSchema.parse(JSON.parse(entry.body))).toEqual(backfillJobFixture);
  });

  test('repository_removed maps to delete_repo with the reason from the event and no installation', () => {
    const entry = toJob(repositoryRemovedEventFixture, fixedDeps(deleteRepoJobFixture));
    expect(JSON.parse(entry.body)).toEqual(deleteRepoJobFixture);
    expect(JobMessageSchema.parse(JSON.parse(entry.body))).toEqual(deleteRepoJobFixture);
    expect(JSON.parse(entry.body)).not.toHaveProperty('installationId');
  });

  test('jobId and requestedAt come from the injected id generator and clock, not the event', () => {
    const deps = testDeps();
    const first = toJob(pushEventFixture, deps).job;
    const second = toJob(pushEventFixture, deps).job;
    expect([first.jobId, second.jobId]).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(first.requestedAt).toBe('2026-10-01T09:30:01.000Z');
    expect(first.requestedAt).not.toBe(pushEventFixture.receivedAt);
  });

  test('the body carries only the fields of the job contract', () => {
    const extra = { extra: 'not in the contract' };
    const event: RepoEventMessage = { ...pushEventFixture, ...extra };
    expect(JSON.parse(toJob(event, fixedDeps(analysisJobFixture)).body)).toEqual(analysisJobFixture);
  });

  test('a job that breaks the contract throws instead of being sent', () => {
    expect(() => toJob(pushEventFixture, { ...testDeps(), newId: () => 'not-a-uuid' })).toThrow();
  });
});

describe('FIFO group and deduplication ids', () => {
  test('MessageGroupId is the repo id string and MessageDeduplicationId is <deliveryId>:<repo id>', () => {
    const entry = toJob(pushEventFixture, testDeps());
    expect(entry.groupId).toBe(String(REPO_ID));
    expect(entry.groupId).toBe('1296269');
    expect(entry.deduplicationId).toBe(`${pushEventFixture.deliveryId}:${REPO_ID}`);
  });

  test('two events of one installation delivery for two repos get different dedupe ids and different groups', () => {
    const [first, second] = installationEvents(2).map((event) => toJob(event, testDeps()));
    if (!first || !second) throw new Error('expected two entries');
    expect(first.deduplicationId).toBe(`${repositoryAddedEventFixture.deliveryId}:1001`);
    expect(second.deduplicationId).toBe(`${repositoryAddedEventFixture.deliveryId}:1002`);
    expect([first.groupId, second.groupId]).toEqual(['1001', '1002']);
  });

  test('the handler sends each entry with its own group and dedupe id', async () => {
    const queue = fakeJobsQueue();
    await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: () => {} })({
      Records: records(installationEvents(2)),
    });
    expect(queue.batches).toEqual([
      [
        expect.objectContaining({
          id: 'm0',
          groupId: '1001',
          deduplicationId: `${repositoryAddedEventFixture.deliveryId}:1001`,
        }),
        expect.objectContaining({
          id: 'm1',
          groupId: '1002',
          deduplicationId: `${repositoryAddedEventFixture.deliveryId}:1002`,
        }),
      ],
    ]);
  });
});

describe('the dispatcher handler', () => {
  test('25 records become 3 SendMessageBatch calls of at most 10 entries, with entry ids unique within each call', async () => {
    const queue = fakeJobsQueue();
    const response = await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: () => {} })({
      Records: records(installationEvents(25)),
    });
    expect(response).toEqual({ batchItemFailures: [] });
    expect(queue.batches.map((batch) => batch.length)).toEqual([10, 10, 5]);
    for (const batch of queue.batches) {
      expect(new Set(batch.map((entry) => entry.id)).size).toBe(batch.length);
    }
    expect(queue.jobs.map((job) => job.repo.id)).toEqual(installationEvents(25).map((event) => event.repo.id));
    for (const job of queue.jobs) expect(JobMessageSchema.safeParse(job).success).toBe(true);
  });

  test('batches are sent one at a time, in record order', async () => {
    const queue = fakeJobsQueue();
    await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: () => {} })({
      Records: records(installationEvents(25)),
    });
    expect(queue.batches).toHaveLength(3);
    expect(queue.maxInFlight).toBe(1);
  });

  test('an empty event sends nothing and reports nothing', async () => {
    const queue = fakeJobsQueue();
    const response = await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: () => {} })({
      Records: [],
    });
    expect(response).toEqual({ batchItemFailures: [] });
    expect(queue.batches).toEqual([]);
  });

  test('a record whose body is not JSON is reported by its messageId, and the other records are still sent', async () => {
    const queue = fakeJobsQueue();
    const response = await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: () => {} })({
      Records: [record('a', pushEventFixture), record('b', '{not json'), record('c', repositoryRemovedEventFixture)],
    });
    expect(failedIds(response)).toEqual(['b']);
    expect(queue.jobs.map((job) => job.type)).toEqual(['analyze', 'delete_repo']);
  });

  test('a record that fails RepoEventMessageSchema (version 2) is reported by its messageId, and the other records are still sent', async () => {
    const queue = fakeJobsQueue();
    const response = await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: () => {} })({
      Records: [
        record('a', pushEventFixture),
        record('b', { ...pushEventFixture, version: 2 }),
        record('c', { ...repositoryRemovedEventFixture, reason: 'archived' }),
        record('d', repositoryAddedEventFixture),
      ],
    });
    expect(failedIds(response)).toEqual(['b', 'c']);
    expect(queue.jobs.map((job) => job.deliveryId)).toEqual([
      pushEventFixture.deliveryId,
      repositoryAddedEventFixture.deliveryId,
    ]);
  });

  test('a partial SendMessageBatch failure reports exactly the failed records', async () => {
    // Entries m3 and m7 of the second batch are records r13 and r17.
    const queue = fakeJobsQueue({ 1: ['m3', 'm7'] });
    const response = await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: () => {} })({
      Records: records(installationEvents(25)),
    });
    expect(failedIds(response)).toEqual(['r13', 'r17']);
    expect(queue.batches).toHaveLength(3);
  });

  test('a partial failure is mapped back through the valid records, not the record positions', async () => {
    // The invalid record r1 takes no batch entry, so entry m1 is record r2.
    const queue = fakeJobsQueue({ 0: ['m1'] });
    const response = await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: () => {} })({
      Records: [
        record('r0', pushEventFixture),
        record('r1', 'nope'),
        record('r2', repositoryAddedEventFixture),
        record('r3', repositoryRemovedEventFixture),
      ],
    });
    expect(failedIds(response)).toEqual(['r1', 'r2']);
  });

  test('a thrown send reports every record of that batch and only that batch, and later batches are still sent', async () => {
    const queue = fakeJobsQueue({ 1: new Error('socket hang up') });
    const response = await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: () => {} })({
      Records: records(installationEvents(25)),
    });
    expect(failedIds(response)).toEqual(Array.from({ length: 10 }, (_, i) => `r${10 + i}`));
    expect(queue.batches.map((batch) => batch.length)).toEqual([10, 10, 5]);
  });

  test('a record whose job cannot be built is reported and the others are still sent', async () => {
    const queue = fakeJobsQueue();
    let calls = 0;
    const newId = () => {
      calls += 1;
      return calls === 2 ? 'not-a-uuid' : '00000000-0000-4000-8000-000000000001';
    };
    const response = await createDispatcherHandler({ ...testDeps(), newId, sendBatch: queue.sendBatch, log: () => {} })(
      { Records: records(installationEvents(3)) },
    );
    expect(failedIds(response)).toEqual(['r1']);
    expect(queue.jobs.map((job) => job.repo.id)).toEqual([1001, 1003]);
  });
});

describe('dispatcher logs', () => {
  test('log lines carry the delivery id, repo id, event type and outcome', async () => {
    const logs = captureLogs();
    const queue = fakeJobsQueue({ 0: ['m1'] });
    await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: logs.log })({
      Records: [record('a', pushEventFixture), record('b', repositoryRemovedEventFixture)],
    });
    expect(logs.lines.map((line) => JSON.parse(line))).toEqual([
      {
        messageId: 'a',
        deliveryId: pushEventFixture.deliveryId,
        repoId: REPO_ID,
        event: 'push',
        job: 'analyze',
        jobId: '00000000-0000-4000-8000-000000000001',
        outcome: 'dispatched',
      },
      {
        messageId: 'b',
        deliveryId: repositoryRemovedEventFixture.deliveryId,
        repoId: REPO_ID,
        event: 'repository_removed',
        job: 'delete_repo',
        jobId: '00000000-0000-4000-8000-000000000002',
        outcome: 'failed',
        reason: 'send-failed',
        error: 'InternalError',
      },
    ]);
  });

  test('a record that cannot be parsed logs its messageId and the reason only', async () => {
    const logs = captureLogs();
    const queue = fakeJobsQueue();
    await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: logs.log })({
      Records: [record('a', 'not json'), record('b', { ...pushEventFixture, version: 2 }), record('c', '"a string"')],
    });
    expect(logs.lines.map((line) => JSON.parse(line))).toEqual([
      { messageId: 'a', outcome: 'invalid', reason: 'body-not-json' },
      { messageId: 'b', outcome: 'invalid', reason: 'invalid-event', fields: 'version' },
      { messageId: 'c', outcome: 'invalid', reason: 'invalid-event', fields: '(root)' },
    ]);
  });

  test('no log line carries a message body, in any outcome', async () => {
    const SENTINEL = 'sentinel7c1e';
    const repo = { id: 4242, owner: `${SENTINEL}-owner`, name: `${SENTINEL}-name` };
    const event = (deliveryId: string): RepoEventMessage => ({ ...pushEventFixture, deliveryId, repo });
    const logs = captureLogs();
    // Batch 0 has a failed entry and batch 1 throws an error that quotes a body.
    const queue = fakeJobsQueue({ 0: ['m1'], 1: new Error(`could not send ${SENTINEL}`) });
    const valid = Array.from({ length: 12 }, (_, i) =>
      record(`v${i}`, event(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)),
    );
    await createDispatcherHandler({ ...testDeps(), sendBatch: queue.sendBatch, log: logs.log })({
      Records: [
        record('json', `not json ${SENTINEL}`),
        record('version', { ...event(pushEventFixture.deliveryId), version: 2 }),
        record('owner', { ...event(pushEventFixture.deliveryId), repo: { ...repo, owner: `${SENTINEL} bad owner` } }),
        ...valid,
      ],
    });

    const outcomes = logs.lines.map((line) => {
      const entry = JSON.parse(line);
      return entry.reason ?? entry.outcome;
    });
    expect(new Set(outcomes)).toEqual(
      new Set(['body-not-json', 'invalid-event', 'dispatched', 'send-failed', 'send-threw']),
    );
    for (const line of logs.lines) {
      expect(line).not.toContain(SENTINEL);
      expect(Object.keys(JSON.parse(line)).filter((key) => !ALLOWED_LOG_KEYS.has(key))).toEqual([]);
    }
  });
});

const ALLOWED_LOG_KEYS = new Set([
  'messageId',
  'deliveryId',
  'repoId',
  'event',
  'job',
  'jobId',
  'outcome',
  'reason',
  'fields',
  'error',
]);
