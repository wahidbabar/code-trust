// The Lambda entry that IngestStack bundles. It is bundled as CommonJS, so nothing it imports may
// use import.meta or top-level await. The AWS SDK comes from the nodejs24.x runtime.
import { SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { AWS_CLIENT_CONFIG, sqsBatchSender, ssmSecretLoader } from './aws.ts';
import { WEBHOOK_ENV } from './env.ts';
import { createWebhookHandler } from './webhook.ts';

// Built once per execution environment. Neither client makes a call until the first request.
export const handler = createWebhookHandler({
  loadSecret: ssmSecretLoader(new SSMClient(AWS_CLIENT_CONFIG), process.env[WEBHOOK_ENV.secretParameter]),
  sendBatch: sqsBatchSender(new SQSClient(AWS_CLIENT_CONFIG), process.env[WEBHOOK_ENV.eventsQueueUrl]),
  now: () => new Date(),
});
