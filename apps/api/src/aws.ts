// The one AWS call the API makes, reading its database URL, behind the loader createHandler takes.

import { GetParameterCommand, type GetParameterCommandOutput, type SSMClientConfig } from '@aws-sdk/client-ssm';
import { API_ENV } from './env.ts';

/**
 * The SDK sets no connection or request timeout by default, so a hung SSM call would run until
 * Lambda killed the function and nothing would be logged. With these, it fails in about 5 seconds
 * and becomes the handler's own 500, inside the function's timeout. throwOnRequestTimeout is
 * required: since @smithy/node-http-handler 4.4.0 a request timeout alone only logs a warning.
 * The same settings as the webhook's (apps/ingest/src/aws.ts); one app never imports another.
 */
export const AWS_CLIENT_CONFIG = {
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 1500, throwOnRequestTimeout: true },
} satisfies SSMClientConfig;

export interface SsmClientLike {
  send(command: GetParameterCommand): Promise<GetParameterCommandOutput>;
}

class MissingConfigError extends Error {
  override readonly name = 'MissingConfigError';
}

class MissingParameterValueError extends Error {
  override readonly name = 'MissingParameterValueError';
}

/**
 * Reads the database URL, a SecureString under the AWS-managed key. A missing name is reported when
 * the loader runs, not when it is built, so a misconfigured function answers 500 instead of failing
 * to start. No error here carries the value: each one fires before it is read, or without it.
 */
export function ssmParameterLoader(client: SsmClientLike, parameterName: string | undefined): () => Promise<string> {
  return async () => {
    if (!parameterName) throw new MissingConfigError(`${API_ENV.databaseUrlParameter} is not set`);
    const output = await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
    const value = output.Parameter?.Value;
    if (!value) throw new MissingParameterValueError('the database URL parameter has no value');
    return value;
  };
}
