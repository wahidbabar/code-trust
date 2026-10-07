// The jobs queue's handler, apart from AWS: lambda.ts wires in SSM, Neon and the real git, and tests
// and the bundle smoke run it with fakes. The queue is FIFO with the repo id as the message group.
import type { Db } from '@code-trust/db';
import { type JobMessage, JobMessageSchema } from '@code-trust/shared';
import { type JobDeps, type LogEntry, runJob } from './job.ts';

/** The fields of an SQS record this handler reads. */
export interface SqsRecord {
  messageId: string;
  body: string;
}

export interface SqsEvent {
  Records: readonly SqsRecord[];
}

/** The partial batch response, for an event source mapping with ReportBatchItemFailures. */
export interface SqsBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

export interface HandlerDeps extends Omit<JobDeps, 'db'> {
  /** Reads the database URL. Called for the first record that needs the database, and again only after a failure. */
  loadDatabaseUrl: () => Promise<string>;
  openDb: (url: string) => Db;
}

export type WorkerHandler = (event: SqsEvent) => Promise<SqsBatchResponse>;

export function createHandler(deps: HandlerDeps): WorkerHandler {
  const { loadDatabaseUrl, openDb, ...jobDeps } = deps;
  const log = deps.log ?? ((entry: LogEntry) => console.log(JSON.stringify(entry)));

  // Opened for the first record and reused for the life of the execution environment. A failed
  // load is forgotten, so the next invocation reads SSM again instead of failing until a cold start.
  let db: Promise<Db> | undefined;
  const database = (): Promise<Db> => {
    if (db === undefined) {
      const pending = loadDatabaseUrl().then((url) => openDb(url));
      db = pending;
      pending.catch(() => {
        if (db === pending) db = undefined;
      });
    }
    return db;
  };

  /** True when the record is done with: its job returned, whatever the outcome. */
  const handle = async (record: SqsRecord): Promise<boolean> => {
    let job: JobMessage;
    try {
      job = JobMessageSchema.parse(JSON.parse(record.body));
    } catch {
      // Neither the body nor the parse error is logged: the error quotes the body.
      log({ messageId: record.messageId, outcome: 'failed', cause: 'invalid-message' });
      return false;
    }
    let handleDb: Db;
    try {
      handleDb = await database();
    } catch (error) {
      // Only the error's name: nothing read from SSM, or about it, goes in a log line.
      log({
        messageId: record.messageId,
        jobId: job.jobId,
        outcome: 'failed',
        cause: 'database-unavailable',
        error: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
    try {
      await runJob(job, { ...jobDeps, db: handleDb });
      return true;
    } catch {
      // runJob has logged the failure with the job's ids.
      return false;
    }
  };

  return async (event) => {
    for (const [index, record] of event.Records.entries()) {
      if (await handle(record)) continue;
      // FIFO: the records after a failed one may belong to its message group and must not run
      // ahead of it, so they all go back to the queue with it.
      const unprocessed = event.Records.slice(index);
      for (const later of unprocessed.slice(1)) {
        log({ messageId: later.messageId, outcome: 'not-run', cause: 'an earlier record in the batch failed' });
      }
      return { batchItemFailures: unprocessed.map((r) => ({ itemIdentifier: r.messageId })) };
    }
    return { batchItemFailures: [] };
  };
}
