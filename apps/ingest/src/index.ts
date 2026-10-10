// The AWS-free core of the webhook and the dispatcher. The Lambda entries are src/lambda.ts and
// src/dispatcher-lambda.ts, and the environment variable names the stacks set are in
// '@code-trust/ingest/env'.
export {
  createDispatcherHandler,
  type DispatcherDeps,
  type DispatcherHandler,
  type FailedEntry,
  type FifoBatchEntry,
  type FifoEntry,
  type SendFifoBatch,
  type SqsBatchResponse,
  type SqsEvent,
  type SqsRecord,
  type ToJobDeps,
  toJob,
} from './dispatcher.ts';
export { type RepoEventsInput, type RepoEventsResult, toRepoEvents } from './events.ts';
export { parseSignatureHeader, verifySignature } from './signature.ts';
export {
  createWebhookHandler,
  MAX_BATCH_SIZE,
  type QueueEntry,
  type SendBatch,
  type WebhookDeps,
  type WebhookHandler,
  type WebhookRequest,
  type WebhookResponse,
} from './webhook.ts';
