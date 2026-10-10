export const REGION = 'ap-south-1';

export const BUDGET_LIMIT_USD = 5;
export const BUDGET_ALERT_THRESHOLDS_PERCENT = [50, 80, 100] as const;

export const RAW_PREFIX = 'raw/';
export const RAW_EXPIRY_DAYS = 14;
export const MULTIPART_ABORT_DAYS = 7;

export const PLACEHOLDER_ALERT_EMAIL = 'placeholder@example.com';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The address that receives budget alerts. The repo is public, so it comes from the environment.
 *
 * The placeholder is honored only behind ALERT_EMAIL_PLACEHOLDER=1, which the root `synth` script
 * sets. A deploy never sets it, so a budget alarm can't ship pointing at an address nobody reads.
 */
export function resolveAlertEmail(env: Env): string {
  const email = env.ALERT_EMAIL?.trim();
  if (email) {
    // .env.example ships a REPLACE_ME address; copying it unedited must not pass for a real one.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.startsWith('REPLACE_ME')) {
      throw new Error('ALERT_EMAIL is not a usable email address. Set it to the inbox that should get budget alerts.');
    }
    return email;
  }
  if (env.ALERT_EMAIL_PLACEHOLDER === '1') return PLACEHOLDER_ALERT_EMAIL;
  throw new Error(
    'ALERT_EMAIL is required: budget alerts need a real inbox. Export it before running cdk. ' +
      'Only `pnpm synth` may run without it.',
  );
}

// IngestStack. The webhook secret is an SSM SecureString under the AWS-managed key, created by
// hand: CloudFormation cannot create a SecureString.
export const WEBHOOK_SECRET_PARAMETER_NAME = '/code-trust/github-webhook-secret';
// SQS's maximum. Storage is free, and events wait here until the wave 2 consumer exists.
export const QUEUE_RETENTION_DAYS = 14;
export const EVENTS_MAX_RECEIVE_COUNT = 5;
export const WEBHOOK_MEMORY_MB = 256;
// Below GitHub's 10 second delivery timeout, so the function's own 500 reaches GitHub first.
export const WEBHOOK_TIMEOUT_SECONDS = 8;

// ApiStack (T10). The database URL is an SSM SecureString under the AWS-managed key, created by
// hand; the worker's stack (T13) reads the same parameter.
export const DATABASE_URL_PARAMETER_NAME = '/code-trust/database-url';
// The dashboard is a GitHub Pages project site, and an origin has no path. The username is public.
export const DASHBOARD_ORIGIN = 'https://wahidbabar.github.io';
export const API_MEMORY_MB = 512;
// A cold start (about 5 s for SSM at worst, under 1 s to boot) plus one Neon query at its 5 s timeout.
export const API_TIMEOUT_SECONDS = 15;

// WorkerStack (T13). Lambda gives CPU in proportion to memory, one vCPU at 1769 MB, and clone,
// index-pack and blame are CPU-bound, so 2048 MB buys a little over one vCPU. It stays under the
// 3008 MB a new account is capped at, and the always-free 400,000 GB-seconds a month cover about
// 200 full 15 minute runs.
export const WORKER_MEMORY_MB = 2048;
// Lambda's maximum /tmp. A full-history clone of a large repo can take gigabytes, and space above
// 512 MB bills only while the worker runs: about $0.0003 for a full 15 minute run at 10 GB.
export const WORKER_EPHEMERAL_STORAGE_MB = 10_240;
// Lambda's maximum. A repo that needs longer is out of scope until the hardening trial.
export const WORKER_TIMEOUT_SECONDS = 900;
// AWS's guidance for a Lambda event source: at least six times the function's timeout, so a
// throttled or retried batch does not reappear while it is still running. 90 minutes.
export const JOBS_VISIBILITY_TIMEOUT_SECONDS = 6 * WORKER_TIMEOUT_SECONDS;
// A job that fails three times is in the jobs DLQ, and its repo's group moves on.
export const JOBS_MAX_RECEIVE_COUNT = 3;
export const DISPATCHER_MEMORY_MB = 256;
// Well under the events queue's 30 second visibility timeout. One batch of 10 is one SendMessageBatch,
// at most two attempts of 2.5 seconds each under the ingest SDK client's timeouts.
export const DISPATCHER_TIMEOUT_SECONDS = 10;
// A cap on each event source's pollers, not reserved concurrency, so it cannot fail a deploy on a
// low account limit. A new account can start with 10 concurrent executions shared by all four
// functions, and the webhook and the API need the rest: a throttled webhook loses deliveries,
// because GitHub does not retry a failed one. 2 is the lowest value SQS event sources accept.
export const WORKER_MAX_CONCURRENCY = 2;
export const DISPATCHER_MAX_CONCURRENCY = 2;
