// The real Lambda entry, run offline: the SDK clients' send() is stubbed, so nothing reaches AWS.
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { AWS_CLIENT_CONFIG } from './aws.ts';
import { WEBHOOK_ENV } from './env.ts';
import { pushPayload, signedRequest, TEST_SECRET } from './testing.ts';
import type { WebhookHandler } from './webhook.ts';

const configs = vi.hoisted(() => ({ ssm: [] as unknown[], sqs: [] as unknown[] }));

// Record what each client is built with, and otherwise keep the real classes.
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

vi.mock('@aws-sdk/client-sqs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sqs')>();
  class RecordingSQSClient extends actual.SQSClient {
    constructor(...args: ConstructorParameters<typeof actual.SQSClient>) {
      super(...args);
      configs.sqs.push(args[0]);
    }
  }
  return { ...actual, SQSClient: RecordingSQSClient };
});

const PARAMETER = '/code-trust/test-webhook-secret';
const QUEUE_URL = 'https://sqs.ap-south-1.amazonaws.com/account/events';

const ssmSend = vi.spyOn(SSMClient.prototype, 'send');
const sqsSend = vi.spyOn(SQSClient.prototype, 'send');
let handler: WebhookHandler;

beforeAll(async () => {
  vi.stubEnv(WEBHOOK_ENV.secretParameter, PARAMETER);
  vi.stubEnv(WEBHOOK_ENV.eventsQueueUrl, QUEUE_URL);
  ({ handler } = await import('./lambda.ts'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  ssmSend.mockReset();
  sqsSend.mockReset();
});

describe('the Lambda entry', () => {
  test('builds both clients from AWS_CLIENT_CONFIG', () => {
    expect(configs.ssm).toEqual([AWS_CLIENT_CONFIG]);
    expect(configs.sqs).toEqual([AWS_CLIENT_CONFIG]);
  });

  test('answers an unsigned POST with 401 without calling AWS', async () => {
    const response = await handler({ headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.statusCode).toBe(401);
    expect(ssmSend).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  test('reads the secret from the parameter in its environment and enqueues to its queue', async () => {
    ssmSend.mockImplementation(async () => ({ $metadata: {}, Parameter: { Value: TEST_SECRET } }));
    sqsSend.mockImplementation(async () => ({ $metadata: {}, Successful: [], Failed: [] }));

    const response = await handler(signedRequest('push', pushPayload()));
    expect(response.statusCode).toBe(200);

    const [ssmCommand] = ssmSend.mock.calls.map(([command]) => command);
    expect(ssmCommand).toBeInstanceOf(GetParameterCommand);
    expect(ssmCommand?.input).toEqual({ Name: PARAMETER, WithDecryption: true });

    const [sqsCommand] = sqsSend.mock.calls.map(([command]) => command);
    expect(sqsCommand).toBeInstanceOf(SendMessageBatchCommand);
    expect(sqsCommand?.input).toMatchObject({ QueueUrl: QUEUE_URL, Entries: [{ Id: 'm0' }] });
  });
});
