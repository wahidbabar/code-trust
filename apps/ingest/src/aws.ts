// The two AWS calls the webhook makes, behind the injected interfaces of webhook.ts.

import { SendMessageBatchCommand, type SendMessageBatchCommandOutput, type SQSClientConfig } from '@aws-sdk/client-sqs';
import { GetParameterCommand, type GetParameterCommandOutput, type SSMClientConfig } from '@aws-sdk/client-ssm';
import { WEBHOOK_ENV } from './env.ts';
import type { SendBatch } from './webhook.ts';

/**
 * Shared by the SSM and SQS clients. The SDK sets no connection or request timeout by default, so
 * a hung call would run until Lambda killed the function and no outcome would be logged. With
 * these, a hung call fails in about 5 seconds and becomes the handler's own 500, inside the
 * function's 8 second timeout and GitHub's 10. throwOnRequestTimeout is required: since
 * @smithy/node-http-handler 4.4.0 a request timeout alone only logs a warning, and older
 * handlers ignore the flag and abort anyway.
 */
export const AWS_CLIENT_CONFIG = {
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 1500, throwOnRequestTimeout: true },
} satisfies SSMClientConfig & SQSClientConfig;

export interface SsmClientLike {
  send(command: GetParameterCommand): Promise<GetParameterCommandOutput>;
}

export interface SqsClientLike {
  send(command: SendMessageBatchCommand): Promise<SendMessageBatchCommandOutput>;
}

class MissingConfigError extends Error {
  override readonly name = 'MissingConfigError';
}

class MissingSecretError extends Error {
  override readonly name = 'MissingSecretError';
}

/**
 * Reads the webhook secret, a SecureString under the AWS-managed key. A missing name is reported
 * when the loader runs, not when it is built, so a misconfigured function answers 500 instead of
 * failing to start.
 */
export function ssmSecretLoader(client: SsmClientLike, parameterName: string | undefined): () => Promise<string> {
  return async () => {
    if (!parameterName) throw new MissingConfigError(`${WEBHOOK_ENV.secretParameter} is not set`);
    const output = await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
    const value = output.Parameter?.Value;
    if (value === undefined) throw new MissingSecretError('the webhook secret parameter has no value');
    return value;
  };
}

export function sqsBatchSender(client: SqsClientLike, queueUrl: string | undefined): SendBatch {
  return async (entries) => {
    if (!queueUrl) throw new MissingConfigError(`${WEBHOOK_ENV.eventsQueueUrl} is not set`);
    const output = await client.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: entries.map((entry) => ({ Id: entry.id, MessageBody: entry.body })),
      }),
    );
    // A partial failure comes back in Failed on a successful response, not as an error.
    return { failedCount: output.Failed?.length ?? 0 };
  };
}
