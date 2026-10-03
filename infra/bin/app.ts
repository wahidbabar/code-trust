import { App } from 'aws-cdk-lib';
import { REGION, resolveAlertEmail, WEBHOOK_SECRET_PARAMETER_NAME } from '../lib/config.ts';
import { FoundationStack } from '../lib/foundation-stack.ts';
import { IngestStack } from '../lib/ingest-stack.ts';

const app = new App();

// No account here: the stack stays environment-agnostic, so synth needs no AWS credentials
// and no account ID lands in this public repo.
new FoundationStack(app, 'CodeTrustFoundation', {
  env: { region: REGION },
  alertEmail: resolveAlertEmail(process.env),
  description: 'code-trust account guardrails: budget alarm and data bucket.',
});

// The stack ID is part of the webhook URL's identity: never rename it after the first deploy.
new IngestStack(app, 'CodeTrustIngest', {
  env: { region: REGION },
  webhookSecretParameterName: WEBHOOK_SECRET_PARAMETER_NAME,
  description: 'code-trust ingest: GitHub webhook Function URL to the events queue.',
});
