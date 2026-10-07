// Test support: Function URL events for the handler tests. Never imported by lambda.ts.
import type { LambdaFunctionURLEvent } from 'aws-lambda';

export interface FunctionUrlEventOptions {
  rawQueryString?: string;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

/**
 * A Function URL event in payload format 2.0, shaped like the ones Lambda sends: the query string
 * is only in rawQueryString, never in rawPath.
 */
export function functionUrlEvent(
  method: string,
  rawPath: string,
  options: FunctionUrlEventOptions = {},
): LambdaFunctionURLEvent {
  const { rawQueryString = '', headers = {}, body, isBase64Encoded = false } = options;
  const domainName = 'abc123example.lambda-url.ap-south-1.on.aws';
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString,
    headers: { host: domainName, 'user-agent': 'vitest', 'x-forwarded-proto': 'https', ...headers },
    requestContext: {
      accountId: 'anonymous',
      apiId: 'abc123example',
      domainName,
      domainPrefix: 'abc123example',
      http: { method, path: rawPath, protocol: 'HTTP/1.1', sourceIp: '203.0.113.7', userAgent: 'vitest' },
      requestId: 'test-request',
      routeKey: '$default',
      stage: '$default',
      time: '07/Oct/2026:12:00:00 +0000',
      timeEpoch: 1_791_374_400_000,
    },
    isBase64Encoded,
    ...(body === undefined ? {} : { body }),
  };
}
