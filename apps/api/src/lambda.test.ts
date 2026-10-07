// The real Lambda entry, run offline: the SSM client's send() is stubbed, so nothing reaches AWS,
// and createNeonDb is wrapped to record its arguments.

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createNeonDb } from '@code-trust/db/neon';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { AWS_CLIENT_CONFIG } from './aws.ts';
import { API_ENV } from './env.ts';
import type { FunctionUrlHandler } from './handler.ts';
import { functionUrlEvent } from './testing.ts';

const configs = vi.hoisted(() => ({ ssm: [] as unknown[] }));

// Record what the client is built with, and otherwise keep the real class.
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ssm')>();
  class RecordingSSMClient extends actual.SSMClient {
    constructor(...args: ConstructorParameters<typeof actual.SSMClient>) {
      super(...args);
      configs.ssm.push(args[0]);
    }
  }
  return { ...actual, SSMClient: RecordingSSMClient };
});

// The real createNeonDb, with its calls recorded.
vi.mock('@code-trust/db/neon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@code-trust/db/neon')>();
  return { ...actual, createNeonDb: vi.fn(actual.createNeonDb) };
});

const PARAMETER = '/code-trust/test-database-url';
// Never queried: /health makes no query, so the Neon handle makes no request.
const DATABASE_URL = 'postgres://u:p@example.invalid/db';

const HEALTH = functionUrlEvent('GET', '/health');

const ssmSend = vi.spyOn(SSMClient.prototype, 'send');
let handler: FunctionUrlHandler;
let createHandlerExport: unknown;

beforeAll(async () => {
  vi.stubEnv(API_ENV.databaseUrlParameter, PARAMETER);
  ({ handler, createHandler: createHandlerExport } = await import('./lambda.ts'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('the Lambda entry', () => {
  test('builds the SSM client from AWS_CLIENT_CONFIG and makes no call at load', () => {
    expect(configs.ssm).toEqual([AWS_CLIENT_CONFIG]);
    expect(ssmSend).not.toHaveBeenCalled();
    expect(createNeonDb).not.toHaveBeenCalled();
  });

  test('exports createHandler for the bundle smoke script', () => {
    expect(typeof createHandlerExport).toBe('function');
  });

  test('reads the URL from the parameter in its environment once, and builds Neon with a 5 second query timeout', async () => {
    ssmSend.mockImplementation(async () => ({ $metadata: {}, Parameter: { Value: DATABASE_URL } }));

    const first = await handler(HEALTH);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body ?? '')).toEqual({ status: 'ok' });
    expect((await handler(HEALTH)).statusCode).toBe(200);

    expect(ssmSend).toHaveBeenCalledTimes(1);
    const [command] = ssmSend.mock.calls.map(([sent]) => sent);
    expect(command).toBeInstanceOf(GetParameterCommand);
    expect(command?.input).toEqual({ Name: PARAMETER, WithDecryption: true });
    expect(vi.mocked(createNeonDb).mock.calls).toEqual([[DATABASE_URL, { queryTimeoutMs: 5000 }]]);
  });
});
