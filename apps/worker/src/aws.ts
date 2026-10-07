// The worker's one AWS call: reading the database URL from SSM, behind an injected client.
import { GetParameterCommand, type GetParameterCommandOutput, type SSMClientConfig } from '@aws-sdk/client-ssm';
import { WORKER_ENV } from './env.ts';

/**
 * The SDK sets no connection or request timeout by default, so a hung read would hold the batch
 * until Lambda killed the function, with nothing logged. With these it fails in seconds and the
 * records go back to the queue. throwOnRequestTimeout is required: since
 * @smithy/node-http-handler 4.4.0 a request timeout alone only logs a warning.
 */
export const SSM_CLIENT_CONFIG = {
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true },
} satisfies SSMClientConfig;

export interface SsmClientLike {
  send(command: GetParameterCommand): Promise<GetParameterCommandOutput>;
}

class MissingConfigError extends Error {
  override readonly name = 'MissingConfigError';
}

class MissingSecretError extends Error {
  override readonly name = 'MissingSecretError';
}

/**
 * Reads the database URL, a SecureString under the AWS-managed key. A missing name is reported
 * when the loader runs, not when it is built, so a misconfigured function fails its records
 * instead of failing to start.
 */
export function ssmParameterLoader(client: SsmClientLike, parameterName: string | undefined): () => Promise<string> {
  return async () => {
    if (!parameterName) throw new MissingConfigError(`${WORKER_ENV.databaseUrlParameter} is not set`);
    const output = await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
    const value = output.Parameter?.Value;
    if (!value) throw new MissingSecretError('the database URL parameter has no value');
    return value;
  };
}
