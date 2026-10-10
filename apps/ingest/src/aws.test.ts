import type { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { GetParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, test } from 'vitest';
import {
  AWS_CLIENT_CONFIG,
  type SqsClientLike,
  type SsmClientLike,
  sqsBatchSender,
  sqsFifoBatchSender,
  ssmSecretLoader,
} from './aws.ts';
import type { FifoBatchEntry } from './dispatcher.ts';

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

const JOBS_QUEUE_URL = 'https://sqs.ap-south-1.amazonaws.com/account/jobs.fifo';

/** A FIFO batch response: `failed` maps an entry id to its code, and `missing` ids are in neither list. */
function fakeFifoSqs(failed: Readonly<Record<string, string>> = {}, missing: readonly string[] = []) {
  const sent: SendMessageBatchCommand[] = [];
  const client: SqsClientLike = {
    send: async (command) => {
      sent.push(command);
      const ids = (command.input.Entries ?? []).map((entry) => entry.Id ?? '');
      return {
        $metadata: {},
        Successful: ids
          .filter((Id) => !(Id in failed) && !missing.includes(Id))
          .map((Id) => ({ Id, MessageId: `msg-${Id}`, MD5OfMessageBody: '' })),
        Failed: Object.entries(failed).map(([Id, Code]) => ({ Id, Code, SenderFault: false })),
      };
    },
  };
  return { client, sent };
}

const fifoEntry = (id: string, repoId: number): FifoBatchEntry => ({
  id,
  body: `{"repo":${repoId}}`,
  groupId: String(repoId),
  deduplicationId: `72d3162e-cc78-11e3-81ab-4c9367dc0958:${repoId}`,
});

describe('sqsFifoBatchSender', () => {
  test('passes MessageGroupId and MessageDeduplicationId for every entry, and reports no failures', async () => {
    const sqs = fakeFifoSqs();
    const result = await sqsFifoBatchSender(sqs.client, JOBS_QUEUE_URL)([fifoEntry('m0', 1001), fifoEntry('m1', 1002)]);
    expect(result).toEqual({ failed: [] });
    expect(sqs.sent.map((command) => command.input)).toEqual([
      {
        QueueUrl: JOBS_QUEUE_URL,
        Entries: [
          {
            Id: 'm0',
            MessageBody: '{"repo":1001}',
            MessageGroupId: '1001',
            MessageDeduplicationId: '72d3162e-cc78-11e3-81ab-4c9367dc0958:1001',
          },
          {
            Id: 'm1',
            MessageBody: '{"repo":1002}',
            MessageGroupId: '1002',
            MessageDeduplicationId: '72d3162e-cc78-11e3-81ab-4c9367dc0958:1002',
          },
        ],
      },
    ]);
  });

  test('returns which entries failed, by id, with the code SQS gave', async () => {
    const sqs = fakeFifoSqs({ m1: 'InternalError' });
    const send = sqsFifoBatchSender(sqs.client, JOBS_QUEUE_URL);
    expect(await send([fifoEntry('m0', 1001), fifoEntry('m1', 1002), fifoEntry('m2', 1003)])).toEqual({
      failed: [{ id: 'm1', code: 'InternalError' }],
    });
  });

  test('an entry missing from Successful is failed even when Failed does not list it', async () => {
    const sqs = fakeFifoSqs({}, ['m0']);
    const send = sqsFifoBatchSender(sqs.client, JOBS_QUEUE_URL);
    expect(await send([fifoEntry('m0', 1001), fifoEntry('m1', 1002)])).toEqual({
      failed: [{ id: 'm0', code: 'NotAcknowledged' }],
    });
  });

  test('a missing queue URL fails when it sends, not when it is built', async () => {
    const sqs = fakeFifoSqs();
    await expect(sqsFifoBatchSender(sqs.client, undefined)([fifoEntry('m0', 1001)])).rejects.toThrow(
      /JOBS_QUEUE_URL is not set/,
    );
    expect(sqs.sent).toEqual([]);
  });
});
