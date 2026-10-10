import { App } from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack.ts';
import {
  DASHBOARD_ORIGIN,
  DATABASE_URL_PARAMETER_NAME,
  REGION,
  resolveAlertEmail,
  WEBHOOK_SECRET_PARAMETER_NAME,
} from '../lib/config.ts';
import { FoundationStack } from '../lib/foundation-stack.ts';
import { IngestStack } from '../lib/ingest-stack.ts';
import { WorkerStack } from '../lib/worker-stack.ts';

const app = new App();

// No account here: the stack stays environment-agnostic, so synth needs no AWS credentials
// and no account ID lands in this public repo.
new FoundationStack(app, 'CodeTrustFoundation', {
  env: { region: REGION },
  alertEmail: resolveAlertEmail(process.env),
  description: 'code-trust account guardrails: budget alarm and data bucket.',
});

// The stack ID is part of the webhook URL's identity: never rename it after the first deploy.
const ingest = new IngestStack(app, 'CodeTrustIngest', {
  env: { region: REGION },
  webhookSecretParameterName: WEBHOOK_SECRET_PARAMETER_NAME,
  description: 'code-trust ingest: GitHub webhook Function URL to the events queue.',
});

// ApiStack (T10). The stack ID is part of the API URL's identity: never rename it after the first
// deploy. It needs no other stack, so it deploys on its own with --exclusively.
new ApiStack(app, 'CodeTrustApi', {
  env: { region: REGION },
  databaseUrlParameterName: DATABASE_URL_PARAMETER_NAME,
  dashboardOrigin: DASHBOARD_ORIGIN,
  description: 'code-trust API: NestJS on Lambda behind a Function URL, reading Neon.',
});

// WorkerStack (T13). It reads the events queue's ARN from CodeTrustIngest's outputs, so deploying it
// without --exclusively deploys CodeTrustIngest first. It holds the git layer, so once it exists,
// every deploy without --exclusively needs the layer zip.
new WorkerStack(app, 'CodeTrustWorker', {
  env: { region: REGION },
  eventsQueue: ingest.eventsQueue,
  databaseUrlParameterName: DATABASE_URL_PARAMETER_NAME,
  description: 'code-trust worker: dispatcher, FIFO jobs queue and worker on Lambda, writing to Neon.',
});
