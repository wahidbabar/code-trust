import { describe, expect, test } from 'vitest';
import { SSM_CLIENT_CONFIG, ssmParameterLoader } from './aws.ts';
import { fakeSsm } from './testing.ts';

describe('SSM_CLIENT_CONFIG', () => {
  test('bounds every read: three attempts, 2 s to connect, 5 s per request, and a timeout throws', () => {
    expect(SSM_CLIENT_CONFIG).toEqual({
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true },
    });
  });
});

describe('ssmParameterLoader', () => {
  test('reads the named parameter with decryption', async () => {
    const ssm = fakeSsm('postgres://u:p@example.invalid/db');
    expect(await ssmParameterLoader(ssm.client, '/code-trust/database-url')()).toBe(
      'postgres://u:p@example.invalid/db',
    );
    expect(ssm.sent.map((command) => command.input)).toEqual([
      { Name: '/code-trust/database-url', WithDecryption: true },
    ]);
  });

  test('throws when the parameter has no value', async () => {
    await expect(ssmParameterLoader(fakeSsm(undefined).client, '/x')()).rejects.toThrow(/no value/);
    await expect(ssmParameterLoader(fakeSsm('').client, '/x')()).rejects.toThrow(/no value/);
  });

  test('a missing name fails when the loader runs, not when it is built', async () => {
    const ssm = fakeSsm('postgres://u:p@example.invalid/db');
    const load = ssmParameterLoader(ssm.client, undefined);
    await expect(load()).rejects.toThrow(/DATABASE_URL_PARAMETER is not set/);
    expect(ssm.sent).toEqual([]);
  });
});
