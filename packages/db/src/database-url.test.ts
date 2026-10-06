import { expect, test } from 'vitest';
import { INVALID_DATABASE_URL, parseDatabaseUrl, redactSecrets } from './database-url.ts';

test('parseDatabaseUrl refuses a malformed URL without echoing it', () => {
  expect(() => parseDatabaseUrl('postgres://u:s3cret-pw@[bad')).toThrow(INVALID_DATABASE_URL);
  expect(() => parseDatabaseUrl('postgres://u:s3cret-pw@[bad')).not.toThrow(/s3cret-pw/);
  expect(() => parseDatabaseUrl('https://u:s3cret-pw@example.invalid/db')).toThrow(/postgres:\/\//);
  expect(parseDatabaseUrl('postgresql://u:p@example.invalid/db?sslmode=verify-full').host).toBe('example.invalid');
});

test('redactSecrets hides the URL, the user and the password, raw or percent-decoded', () => {
  const url = parseDatabaseUrl('postgres://neon_owner:p%40ss-w0rd@ep-x.example.invalid/neondb?sslmode=verify-full');
  const text = [
    `connecting to ${url.href}`,
    'password authentication failed for user "neon_owner"',
    'raw p%40ss-w0rd and decoded p@ss-w0rd',
  ].join('\n');
  const redacted = redactSecrets(text, url);
  for (const secret of ['neon_owner', 'p%40ss-w0rd', 'p@ss-w0rd', 'postgres://'])
    expect(redacted).not.toContain(secret);
  expect(redacted).toContain('password authentication failed for user "***"');
});
