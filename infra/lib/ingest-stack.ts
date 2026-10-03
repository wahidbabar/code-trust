import { fileURLToPath } from 'node:url';
import { WEBHOOK_ENV } from '@code-trust/ingest/env';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, FunctionUrlAuthType, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import {
  EVENTS_MAX_RECEIVE_COUNT,
  QUEUE_RETENTION_DAYS,
  WEBHOOK_MEMORY_MB,
  WEBHOOK_TIMEOUT_SECONDS,
} from './config.ts';

// Absolute, because the working directory differs between `pnpm synth` and the two ways the
// tests run. NodejsFunction runs esbuild from projectRoot, which must contain both the entry and
// the lockfile, so it is the workspace root.
const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEBHOOK_ENTRY = fileURLToPath(new URL('../../apps/ingest/src/lambda.ts', import.meta.url));
const LOCKFILE = fileURLToPath(new URL('../../pnpm-lock.yaml', import.meta.url));

export interface IngestStackProps extends StackProps {
  /** Name of the SSM SecureString that holds the GitHub webhook secret, such as `/code-trust/x`. */
  readonly webhookSecretParameterName: string;
}

/**
 * The front of the pipeline: GitHub's webhook reaches a Lambda Function URL, and the function
 * verifies the signature and puts small messages on the events queue.
 *
 * Never rename this stack, `WebhookFunction` or its `FunctionUrl` after the first deploy: a new
 * construct ID means a new URL, and the GitHub App would keep posting to the old one.
 */
export class IngestStack extends Stack {
  /** Wave 2's dispatcher consumes this queue. */
  readonly eventsQueue: Queue;

  constructor(scope: Construct, id: string, props: IngestStackProps) {
    super(scope, id, props);

    // SQS-managed encryption rather than KMS: a customer-managed key bills monthly.
    const deadLetterQueue = new Queue(this, 'EventsDeadLetterQueue', {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(QUEUE_RETENTION_DAYS),
    });

    this.eventsQueue = new Queue(this, 'EventsQueue', {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(QUEUE_RETENTION_DAYS),
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: EVENTS_MAX_RECEIVE_COUNT },
    });

    // Passed to the function as logGroup. logRetention would add a custom-resource Lambda.
    const logGroup = new LogGroup(this, 'WebhookLogs', {
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // An explicit role, because CDK's default one carries AWSLambdaBasicExecutionRole (log actions
    // on every resource), and grantSendMessages or StringParameter.grantRead would add actions
    // this function never calls.
    const role = new Role(this, 'WebhookRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'code-trust webhook: send to the events queue, read the webhook secret, write its own logs.',
    });
    role.addToPolicy(new PolicyStatement({ actions: ['sqs:SendMessage'], resources: [this.eventsQueue.queueArn] }));
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        // The ARN format adds the slash after `parameter`. Keeping the name's own leading slash
        // would give `parameter//`, which IAM never matches. No kms:Decrypt: the parameter uses
        // the AWS-managed aws/ssm key, whose policy already allows use through SSM.
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: props.webhookSecretParameterName.replace(/^\/+/, ''),
          }),
        ],
      }),
    );
    logGroup.grantWrite(role);

    const webhook = new NodejsFunction(this, 'WebhookFunction', {
      description: 'code-trust GitHub webhook: verify the signature, enqueue, answer fast.',
      entry: WEBHOOK_ENTRY,
      handler: 'handler',
      projectRoot: WORKSPACE_ROOT,
      depsLockFilePath: LOCKFILE,
      // Pinned, not NODEJS_LATEST: a variable runtime makes NodejsFunction bundle the whole SDK
      // instead of using the one the runtime ships.
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: WEBHOOK_MEMORY_MB,
      timeout: Duration.seconds(WEBHOOK_TIMEOUT_SECONDS),
      role,
      logGroup,
      environment: {
        [WEBHOOK_ENV.secretParameter]: props.webhookSecretParameterName,
        [WEBHOOK_ENV.eventsQueueUrl]: this.eventsQueue.queueUrl,
      },
    });

    // Auth NONE: GitHub cannot sign AWS requests, and the HMAC check is the authentication.
    const webhookUrl = webhook.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    new CfnOutput(this, 'WebhookUrl', {
      value: webhookUrl.url,
      description: 'Webhook URL for the GitHub App. Keep it out of the repo, issues and PRs.',
    });
    new CfnOutput(this, 'EventsQueueUrl', {
      value: this.eventsQueue.queueUrl,
      description: 'Events queue URL. It contains the account ID: keep it out of the repo.',
    });
  }
}
