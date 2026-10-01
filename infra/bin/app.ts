import { App } from 'aws-cdk-lib';
import { REGION, resolveAlertEmail } from '../lib/config.ts';
import { FoundationStack } from '../lib/foundation-stack.ts';

const app = new App();

// No account here: the stack stays environment-agnostic, so synth needs no AWS credentials
// and no account ID lands in this public repo.
new FoundationStack(app, 'CodeTrustFoundation', {
  env: { region: REGION },
  alertEmail: resolveAlertEmail(process.env),
  description: 'code-trust account guardrails: budget alarm and data bucket.',
});
