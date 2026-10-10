// The ingest functions' environment variable names. The stacks import these from
// '@code-trust/ingest/env', so a stack and its handler cannot drift apart.
export const WEBHOOK_ENV = {
  /** Name of the SSM SecureString that holds the GitHub webhook secret, with its leading slash. */
  secretParameter: 'WEBHOOK_SECRET_PARAMETER',
  eventsQueueUrl: 'EVENTS_QUEUE_URL',
} as const;

/** The dispatcher's, for WorkerStack. */
export const DISPATCHER_ENV = {
  /** URL of the FIFO jobs queue. */
  jobsQueueUrl: 'JOBS_QUEUE_URL',
} as const;
