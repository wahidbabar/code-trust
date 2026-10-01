import { describe, expect, test } from 'vitest';
import { PLACEHOLDER_ALERT_EMAIL, REGION, resolveAlertEmail } from './config.ts';

describe('resolveAlertEmail', () => {
  test('uses ALERT_EMAIL when set', () => {
    expect(resolveAlertEmail({ ALERT_EMAIL: 'alerts@example.com' })).toBe('alerts@example.com');
  });

  test('ALERT_EMAIL wins over the placeholder flag', () => {
    expect(resolveAlertEmail({ ALERT_EMAIL: 'alerts@example.com', ALERT_EMAIL_PLACEHOLDER: '1' })).toBe(
      'alerts@example.com',
    );
  });

  test('falls back to the placeholder only behind the synth flag', () => {
    expect(resolveAlertEmail({ ALERT_EMAIL_PLACEHOLDER: '1' })).toBe(PLACEHOLDER_ALERT_EMAIL);
  });

  test('throws without ALERT_EMAIL and without the flag', () => {
    expect(() => resolveAlertEmail({})).toThrow(/ALERT_EMAIL is required/);
  });

  test('CI alone does not unlock the placeholder', () => {
    expect(() => resolveAlertEmail({ CI: 'true' })).toThrow(/ALERT_EMAIL is required/);
  });

  test('a blank ALERT_EMAIL counts as unset', () => {
    expect(() => resolveAlertEmail({ ALERT_EMAIL: '  ' })).toThrow(/ALERT_EMAIL is required/);
  });

  test('rejects the unedited .env.example value and non-addresses', () => {
    expect(() => resolveAlertEmail({ ALERT_EMAIL: 'REPLACE_ME@example.com' })).toThrow(/not a usable email/);
    expect(() => resolveAlertEmail({ ALERT_EMAIL: 'not-an-email' })).toThrow(/not a usable email/);
  });
});

test('region is ap-south-1', () => {
  expect(REGION).toBe('ap-south-1');
});
