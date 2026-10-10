// The dispatcher's Lambda entry, which WorkerStack bundles. It is bundled as CommonJS, so nothing it
// imports may use import.meta or top-level await. The AWS SDK comes from the nodejs24.x runtime.
import { randomUUID } from 'node:crypto';
import { SQSClient } from '@aws-sdk/client-sqs';
import { AWS_CLIENT_CONFIG, sqsFifoBatchSender } from './aws.ts';
import { createDispatcherHandler } from './dispatcher.ts';
import { DISPATCHER_ENV } from './env.ts';

// Built once per execution environment. The client makes no call until the first record.
export const handler = createDispatcherHandler({
  sendBatch: sqsFifoBatchSender(new SQSClient(AWS_CLIENT_CONFIG), process.env[DISPATCHER_ENV.jobsQueueUrl]),
  newId: () => randomUUID(),
  now: () => new Date(),
});
