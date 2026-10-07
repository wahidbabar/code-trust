// The Lambda entry that ApiStack bundles. It is bundled as CommonJS, so nothing it imports may use
// import.meta or top-level await, which keeps main.ts and seed.ts out of this graph. The AWS SDK
// comes from the nodejs24.x runtime.
import { SSMClient } from '@aws-sdk/client-ssm';
import { AWS_CLIENT_CONFIG, ssmParameterLoader } from './aws.ts';
import { API_ENV } from './env.ts';
import { createHandler } from './handler.ts';

// The bundle smoke script (infra/scripts) calls it with its own loader, so it needs no AWS.
export { createHandler };

// Built once per execution environment. Nothing is read until the first request.
export const handler = createHandler({
  loadDatabaseUrl: ssmParameterLoader(new SSMClient(AWS_CLIENT_CONFIG), process.env[API_ENV.databaseUrlParameter]),
});
