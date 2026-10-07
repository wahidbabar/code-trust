// The worker function's environment variable names. WorkerStack imports these from
// '@code-trust/worker/env', so the stack and the handler cannot drift apart.
export const WORKER_ENV = {
  /** Name of the SSM SecureString that holds the database URL, with its leading slash. */
  databaseUrlParameter: 'DATABASE_URL_PARAMETER',
  /** Where jobs clone. Every job empties it first, so nothing else may live there. */
  workRoot: 'WORK_ROOT',
} as const;

/** The work root when WORK_ROOT is unset: a directory of the worker's own under Lambda's writable /tmp. */
export const DEFAULT_WORK_ROOT = '/tmp/work';
