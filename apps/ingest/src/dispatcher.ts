// The dispatcher: drains the events queue the webhook fills and sends one job per event to the
// FIFO jobs queue, grouped by repo. The queue sender, the id generator and the clock are injected,
// so tests need no AWS. The Lambda entry is src/dispatcher-lambda.ts.
import { type JobMessage, JobMessageSchema, type RepoEventMessage, RepoEventMessageSchema } from '@code-trust/shared';
import { type LogEntry, MAX_BATCH_SIZE } from './webhook.ts';

export interface ToJobDeps {
  /** A fresh UUID for each job. */
  readonly newId: () => string;
  readonly now: () => Date;
}

/** One job, ready for the FIFO jobs queue. */
export interface FifoEntry {
  readonly job: JobMessage;
  readonly body: string;
  /** The repo id, so one repo's jobs run one at a time, in the order SQS received them. */
  readonly groupId: string;
  /**
   * `<deliveryId>:<repo id>`. An installation delivery yields one event per repo under one delivery
   * id, so the delivery id alone would drop every repo after the first as a duplicate. Not the
   * job id: that is new on every attempt, and a retry of a send SQS took must still dedupe.
   */
  readonly deduplicationId: string;
}

export interface FifoBatchEntry {
  /** Unique within its batch, as SQS requires. */
  readonly id: string;
  readonly body: string;
  readonly groupId: string;
  readonly deduplicationId: string;
}

export interface FailedEntry {
  readonly id: string;
  /** SQS's error code for the entry, never its message. */
  readonly code: string;
}

/** Sends one batch of at most MAX_BATCH_SIZE entries and names the entries SQS did not take. */
export type SendFifoBatch = (
  entries: readonly FifoBatchEntry[],
) => Promise<{ readonly failed: readonly FailedEntry[] }>;

export function toJob(event: RepoEventMessage, deps: ToJobDeps): FifoEntry {
  // Parsed, not just typed: the output drops any field the contract does not name.
  const job = JobMessageSchema.parse(jobFor(event, deps));
  return {
    job,
    body: JSON.stringify(job),
    groupId: String(event.repo.id),
    deduplicationId: `${event.deliveryId}:${event.repo.id}`,
  };
}

function jobFor(event: RepoEventMessage, deps: ToJobDeps): JobMessage {
  const fields = {
    version: 1,
    jobId: deps.newId(),
    requestedAt: deps.now().toISOString(),
    deliveryId: event.deliveryId,
  } as const;
  switch (event.type) {
    case 'push':
      return {
        ...fields,
        type: 'analyze',
        reason: 'push',
        installationId: event.installationId,
        repo: event.repo,
        headSha: event.headSha,
      };
    case 'repository_added':
      return {
        ...fields,
        type: 'analyze',
        reason: 'backfill',
        installationId: event.installationId,
        repo: event.repo,
        headSha: null,
      };
    case 'repository_removed':
      return { ...fields, type: 'delete_repo', repo: event.repo, reason: event.reason };
  }
}

/** The fields of an SQS record this handler reads. */
export interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
}

export interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

/** The partial batch response, for an event source mapping with ReportBatchItemFailures. */
export interface SqsBatchResponse {
  readonly batchItemFailures: { readonly itemIdentifier: string }[];
}

export interface DispatcherDeps extends ToJobDeps {
  readonly sendBatch: SendFifoBatch;
  readonly log?: (entry: LogEntry) => void;
}

export type DispatcherHandler = (event: SqsEvent) => Promise<SqsBatchResponse>;

interface Ready {
  readonly record: SqsRecord;
  readonly entry: FifoEntry;
  readonly context: LogEntry;
}

export function createDispatcherHandler(deps: DispatcherDeps): DispatcherHandler {
  const log = deps.log ?? ((entry: LogEntry) => console.log(JSON.stringify(entry)));

  /** The record's job, or null once its failure is logged. */
  const prepare = (record: SqsRecord): Ready | null => {
    const fail = (entry: LogEntry): null => {
      log({ messageId: record.messageId, ...entry });
      return null;
    };
    let body: unknown;
    try {
      body = JSON.parse(record.body);
    } catch {
      // The parse error quotes the body, so it is not logged.
      return fail({ outcome: 'invalid', reason: 'body-not-json' });
    }
    const parsed = RepoEventMessageSchema.safeParse(body);
    if (!parsed.success) {
      // Schema paths only: a zod message can quote the value it refused.
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))];
      return fail({ outcome: 'invalid', reason: 'invalid-event', fields: fields.join(',') });
    }
    const event = parsed.data;
    const context: LogEntry = { deliveryId: event.deliveryId, repoId: event.repo.id, event: event.type };
    try {
      return { record, entry: toJob(event, deps), context };
    } catch (error) {
      return fail({ ...context, outcome: 'failed', reason: 'invalid-job', error: errorName(error) });
    }
  };

  return async (event) => {
    const failed = new Set<string>();
    const ready: Ready[] = [];
    for (const record of event.Records) {
      const item = prepare(record);
      if (item === null) failed.add(record.messageId);
      else ready.push(item);
    }

    const report = ({ record, entry, context }: Ready, outcome: LogEntry) => {
      log({ messageId: record.messageId, ...context, job: entry.job.type, jobId: entry.job.jobId, ...outcome });
      if (outcome.outcome !== 'dispatched') failed.add(record.messageId);
    };

    // One batch at a time, in record order. FIFO keeps a group's order as SQS receives it, so
    // parallel calls could land a repo's delete before an analyze from an earlier batch. A batch
    // that throws fails only its own records; the next batch is still sent.
    for (const batch of chunk(ready, MAX_BATCH_SIZE)) {
      const entries = batch.map(({ entry }, i) => ({
        id: `m${i}`,
        body: entry.body,
        groupId: entry.groupId,
        deduplicationId: entry.deduplicationId,
      }));
      let codes: Map<string, string>;
      try {
        const result = await deps.sendBatch(entries);
        codes = new Map(result.failed.map(({ id, code }) => [id, code]));
      } catch (error) {
        for (const item of batch) report(item, { outcome: 'failed', reason: 'send-threw', error: errorName(error) });
        continue;
      }
      batch.forEach((item, i) => {
        const code = codes.get(`m${i}`);
        report(
          item,
          code === undefined ? { outcome: 'dispatched' } : { outcome: 'failed', reason: 'send-failed', error: code },
        );
      });
    }

    return {
      batchItemFailures: event.Records.filter(({ messageId }) => failed.has(messageId)).map(({ messageId }) => ({
        itemIdentifier: messageId,
      })),
    };
  };
}

// Only the name: an error message can quote a request or a response body.
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
