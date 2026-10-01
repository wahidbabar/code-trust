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
