// The webhook function's environment variable names. IngestStack imports these from
// '@code-trust/ingest/env', so the stack and the handler cannot drift apart.
export const WEBHOOK_ENV = {
  /** Name of the SSM SecureString that holds the GitHub webhook secret, with its leading slash. */
  secretParameter: 'WEBHOOK_SECRET_PARAMETER',
  eventsQueueUrl: 'EVENTS_QUEUE_URL',
} as const;
