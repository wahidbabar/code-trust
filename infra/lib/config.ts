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
