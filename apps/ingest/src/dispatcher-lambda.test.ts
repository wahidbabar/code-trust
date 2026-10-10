// The real dispatcher entry, run offline: the SQS client's send() is stubbed, so nothing reaches
// AWS. The last test bundles the entry the way WorkerStack's NodejsFunction will (see the esbuild
// row in docs/architecture.md). In a CommonJS bundle import.meta is empty and top-level await is an
// error, so the whole import graph must do without both.
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { JobMessageSchema } from '@code-trust/shared';
import { pushEventFixture, REPO_ID, repositoryRemovedEventFixture } from '@code-trust/shared/fixtures';
import { build, formatMessages } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { AWS_CLIENT_CONFIG } from './aws.ts';
import type { DispatcherHandler } from './dispatcher.ts';
import { DISPATCHER_ENV } from './env.ts';

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

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const QUEUE_URL = 'https://sqs.ap-south-1.amazonaws.com/account/jobs.fifo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const sqsSend = vi.spyOn(SQSClient.prototype, 'send');
const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
let handler: DispatcherHandler;

beforeAll(async () => {
  vi.stubEnv(DISPATCHER_ENV.jobsQueueUrl, QUEUE_URL);
  ({ handler } = await import('./dispatcher-lambda.ts'));
});

afterAll(() => {
  vi.unstubAllEnvs();
  consoleLog.mockRestore();
});

beforeEach(() => {
  sqsSend.mockReset();
  consoleLog.mockClear();
});

const record = (messageId: string, body: unknown) => ({ messageId, body: JSON.stringify(body) });

describe('the dispatcher Lambda entry', () => {
  test('builds one SQS client from AWS_CLIENT_CONFIG and no SSM client', () => {
    expect(configs.sqs).toEqual([AWS_CLIENT_CONFIG]);
    expect(configs.ssm).toEqual([]);
  });

  test('sends each job to the queue in its environment, grouped by repo and deduplicated by delivery and repo', async () => {
    sqsSend.mockImplementation(async () => ({
      $metadata: {},
      Successful: [{ Id: 'm0', MessageId: 'x', MD5OfMessageBody: '' }],
      Failed: [{ Id: 'm1', Code: 'InternalError', SenderFault: false }],
    }));

    const response = await handler({
      Records: [record('a', pushEventFixture), record('b', repositoryRemovedEventFixture)],
    });
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'b' }] });

    const [command] = sqsSend.mock.calls.map(([sent]) => sent);
    expect(command).toBeInstanceOf(SendMessageBatchCommand);
    expect(command?.input).toEqual({
      QueueUrl: QUEUE_URL,
      Entries: [
        {
          Id: 'm0',
          MessageBody: expect.any(String),
          MessageGroupId: String(REPO_ID),
          MessageDeduplicationId: `${pushEventFixture.deliveryId}:${REPO_ID}`,
        },
        {
          Id: 'm1',
          MessageBody: expect.any(String),
          MessageGroupId: String(REPO_ID),
          MessageDeduplicationId: `${repositoryRemovedEventFixture.deliveryId}:${REPO_ID}`,
        },
      ],
    });
    if (!(command instanceof SendMessageBatchCommand)) throw new Error('expected a SendMessageBatchCommand');
    const jobs = (command.input.Entries ?? []).map((entry) =>
      JobMessageSchema.parse(JSON.parse(entry.MessageBody ?? '')),
    );
    // The real id generator and clock: a fresh UUID per job.
    expect(jobs.map((job) => job.jobId)).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
    expect(new Set(jobs.map((job) => job.jobId)).size).toBe(2);
    expect(consoleLog).toHaveBeenCalledTimes(2);
  });

  test('a thrown send reports every record of the batch', async () => {
    sqsSend.mockImplementation(async () => {
      throw new Error('connect ETIMEDOUT');
    });
    const response = await handler({
      Records: [record('a', pushEventFixture), record('b', repositoryRemovedEventFixture)],
    });
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'a' }, { itemIdentifier: 'b' }] });
  });
});

test('src/dispatcher-lambda.ts bundles as NodejsFunction does with zero warnings and loads', async () => {
  const result = await build({
    entryPoints: [join(PACKAGE_DIR, 'src', 'dispatcher-lambda.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    external: ['@aws-sdk/*', '@smithy/*'],
    write: false,
    logLevel: 'silent',
  });
  expect(await formatMessages(result.warnings, { kind: 'warning' })).toEqual([]);

  const [output] = result.outputFiles;
  if (!output) throw new Error('esbuild wrote no output');

  // The bundle requires the AWS SDK, which Lambda's runtime provides. Here it resolves through a
  // node_modules link to this package's own.
  const dir = await mkdtemp(join(tmpdir(), 'code-trust-dispatcher-bundle-'));
  // With no queue URL the sender throws before any network call, so a valid record exercises the
  // whole path offline.
  vi.stubEnv(DISPATCHER_ENV.jobsQueueUrl, undefined);
  try {
    await symlink(join(PACKAGE_DIR, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const file = join(dir, 'index.cjs');
    await writeFile(file, output.text);
    const bundle = createRequire(import.meta.url)(file) as { handler: DispatcherHandler };

    expect(await bundle.handler({ Records: [] })).toEqual({ batchItemFailures: [] });
    expect(await bundle.handler({ Records: [record('a', pushEventFixture)] })).toEqual({
      batchItemFailures: [{ itemIdentifier: 'a' }],
    });
    expect(consoleLog.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({ messageId: 'a', outcome: 'failed', reason: 'send-threw', error: 'MissingConfigError' }),
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
