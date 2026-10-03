import type { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { GetParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, test } from 'vitest';
import { AWS_CLIENT_CONFIG, type SqsClientLike, type SsmClientLike, sqsBatchSender, ssmSecretLoader } from './aws.ts';

const QUEUE_URL = 'https://sqs.ap-south-1.amazonaws.com/account/events';

function fakeSsm(value: string | undefined) {
  const sent: GetParameterCommand[] = [];
  const client: SsmClientLike = {
    send: async (command) => {
      sent.push(command);
      return { $metadata: {}, ...(value === undefined ? {} : { Parameter: { Value: value } }) };
    },
  };
  return { client, sent };
}

function fakeSqs(failedIds: readonly string[] = []) {
  const sent: SendMessageBatchCommand[] = [];
  const client: SqsClientLike = {
    send: async (command) => {
      sent.push(command);
      return {
        $metadata: {},
        Successful: [],
        Failed: failedIds.map((Id) => ({ Id, Code: 'InternalError', SenderFault: false })),
      };
    },
  };
  return { client, sent };
}

describe('AWS_CLIENT_CONFIG', () => {
  test('bounds every call: two attempts, 1 s to connect, 1.5 s per request, and a timeout throws', () => {
    expect(AWS_CLIENT_CONFIG).toEqual({
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 1000, requestTimeout: 1500, throwOnRequestTimeout: true },
    });
  });
});

describe('ssmSecretLoader', () => {
  test('reads the named parameter with decryption', async () => {
    const ssm = fakeSsm('s3cret');
    expect(await ssmSecretLoader(ssm.client, '/code-trust/github-webhook-secret')()).toBe('s3cret');
    expect(ssm.sent.map((command) => command.input)).toEqual([
      { Name: '/code-trust/github-webhook-secret', WithDecryption: true },
    ]);
  });

  test('throws when the parameter has no value', async () => {
    await expect(ssmSecretLoader(fakeSsm(undefined).client, '/x')()).rejects.toThrow(/no value/);
  });

  test('a missing name fails when the loader runs, not when it is built', async () => {
    const ssm = fakeSsm('s3cret');
    const load = ssmSecretLoader(ssm.client, undefined);
    await expect(load()).rejects.toThrow(/WEBHOOK_SECRET_PARAMETER is not set/);
    expect(ssm.sent).toEqual([]);
  });
});

describe('sqsBatchSender', () => {
  test('sends one batch to the queue URL and reports no failures', async () => {
    const sqs = fakeSqs();
    const result = await sqsBatchSender(
      sqs.client,
      QUEUE_URL,
    )([
      { id: 'm0', body: '{"a":1}' },
      { id: 'm1', body: '{"b":2}' },
    ]);
    expect(result).toEqual({ failedCount: 0 });
    expect(sqs.sent.map((command) => command.input)).toEqual([
      {
        QueueUrl: QUEUE_URL,
        Entries: [
          { Id: 'm0', MessageBody: '{"a":1}' },
          { Id: 'm1', MessageBody: '{"b":2}' },
        ],
      },
    ]);
  });

  test('counts entries SQS reports as failed in a successful response', async () => {
    const sqs = fakeSqs(['m1']);
    expect(await sqsBatchSender(sqs.client, QUEUE_URL)([{ id: 'm1', body: '{}' }])).toEqual({ failedCount: 1 });
  });

  test('a missing queue URL fails when it sends, not when it is built', async () => {
    const sqs = fakeSqs();
    await expect(sqsBatchSender(sqs.client, undefined)([{ id: 'm0', body: '{}' }])).rejects.toThrow(
      /EVENTS_QUEUE_URL is not set/,
    );
    expect(sqs.sent).toEqual([]);
  });
});
