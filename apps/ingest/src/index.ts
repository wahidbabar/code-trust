// The AWS-free core of the webhook. The Lambda entry is src/lambda.ts, and the environment
// variable names IngestStack sets are in '@code-trust/ingest/env'.
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
