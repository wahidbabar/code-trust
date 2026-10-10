import { fileURLToPath } from 'node:url';
import { DISPATCHER_ENV } from '@code-trust/ingest/env';
import { WORKER_ENV } from '@code-trust/worker/env';
import { CfnOutput, Duration, RemovalPolicy, Size, Stack, type StackProps } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { type IQueue, Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import {
  DISPATCHER_MEMORY_MB,
  DISPATCHER_TIMEOUT_SECONDS,
  JOBS_MAX_RECEIVE_COUNT,
  JOBS_VISIBILITY_TIMEOUT_SECONDS,
  QUEUE_RETENTION_DAYS,
  WORKER_EPHEMERAL_STORAGE_MB,
  WORKER_MEMORY_MB,
  WORKER_TIMEOUT_SECONDS,
} from './config.ts';
import { GitLayer } from './git-layer.ts';

// Absolute, for the same reason as in ingest-stack.ts: NodejsFunction runs esbuild from
// projectRoot, which must contain both the entry and the lockfile.
const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL('../../apps/worker/src/lambda.ts', import.meta.url));
const DISPATCHER_ENTRY = fileURLToPath(new URL('../../apps/ingest/src/dispatcher-lambda.ts', import.meta.url));
const LOCKFILE = fileURLToPath(new URL('../../pnpm-lock.yaml', import.meta.url));

/**
 * What Lambda's SQS poller calls. Granted by hand rather than through SqsEventSource, whose
 * grantConsumeMessages also adds ChangeMessageVisibility and GetQueueUrl, which nothing here calls.
 */
const CONSUME_ACTIONS = ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'];

export interface WorkerStackProps extends StackProps {
  /** IngestStack's events queue, which the dispatcher drains. */
  readonly eventsQueue: IQueue;
  /** Name of the SSM SecureString that holds the Neon database URL, such as `/code-trust/x`. */
  readonly databaseUrlParameterName: string;
}

/**
 * The back of the pipeline: the dispatcher turns each event on IngestStack's events queue into a job
 * on the FIFO jobs queue, grouped by repo, and the worker runs each job with git from the layer.
 *
 * The events queue arrives as a weak cross-stack reference (cdk.json's defaultCrossStackReferences),
 * so this template reads its ARN with Fn::GetStackOutput and CodeTrustIngest has a plain output, not
 * an export. CodeTrustIngest can replace the queue, and the dispatcher keeps reading the old ARN
 * until this stack is deployed again.
 */
export class WorkerStack extends Stack {
  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);

    // SQS-managed encryption rather than KMS: a customer-managed key bills monthly. FIFO on both,
    // because a FIFO queue's dead-letter queue must be FIFO too.
    const jobsDeadLetterQueue = new Queue(this, 'JobsDeadLetterQueue', {
      fifo: true,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(QUEUE_RETENTION_DAYS),
    });

    // Content-based deduplication off: the dispatcher sets `<deliveryId>:<repo id>`, and two jobs
    // with the same body but different deliveries must both run.
    const jobsQueue = new Queue(this, 'JobsQueue', {
      fifo: true,
      contentBasedDeduplication: false,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(QUEUE_RETENTION_DAYS),
      visibilityTimeout: Duration.seconds(JOBS_VISIBILITY_TIMEOUT_SECONDS),
      deadLetterQueue: { queue: jobsDeadLetterQueue, maxReceiveCount: JOBS_MAX_RECEIVE_COUNT },
    });

    // Passed to the functions as logGroup. logRetention would add a custom-resource Lambda.
    const workerLogs = new LogGroup(this, 'WorkerLogs', {
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const dispatcherLogs = new LogGroup(this, 'DispatcherLogs', {
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Explicit roles, as in IngestStack: CDK's default role carries AWSLambdaBasicExecutionRole (log
    // actions on every resource), and its grant helpers add actions these functions never call.
    const workerRole = new Role(this, 'WorkerRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'code-trust worker: consume the jobs queue, read the database URL, write its own logs.',
    });
    workerRole.addToPolicy(new PolicyStatement({ actions: CONSUME_ACTIONS, resources: [jobsQueue.queueArn] }));
    workerRole.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        // The ARN format adds the slash after `parameter`, so the name's own leading slash goes.
        // No kms:Decrypt: the parameter uses the AWS-managed aws/ssm key.
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: props.databaseUrlParameterName.replace(/^\/+/, ''),
          }),
        ],
      }),
    );
    workerLogs.grantWrite(workerRole);

    const dispatcherRole = new Role(this, 'DispatcherRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'code-trust dispatcher: consume the events queue, send to the jobs queue, write its own logs.',
    });
    dispatcherRole.addToPolicy(
      new PolicyStatement({ actions: CONSUME_ACTIONS, resources: [props.eventsQueue.queueArn] }),
    );
    // SendMessageBatch is authorized as sqs:SendMessage.
    dispatcherRole.addToPolicy(new PolicyStatement({ actions: ['sqs:SendMessage'], resources: [jobsQueue.queueArn] }));
    dispatcherLogs.grantWrite(dispatcherRole);

    const worker = new NodejsFunction(this, 'WorkerFunction', {
      description: 'code-trust worker: clone a repo, analyze its history, write the result to Neon.',
      entry: WORKER_ENTRY,
      handler: 'handler',
      projectRoot: WORKSPACE_ROOT,
      depsLockFilePath: LOCKFILE,
      // Pinned, not NODEJS_LATEST, so the bundle leaves out the SDK the runtime ships.
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: WORKER_MEMORY_MB,
      ephemeralStorageSize: Size.mebibytes(WORKER_EPHEMERAL_STORAGE_MB),
      timeout: Duration.seconds(WORKER_TIMEOUT_SECONDS),
      layers: [new GitLayer(this, 'GitLayer')],
      role: workerRole,
      logGroup: workerLogs,
      environment: {
        [WORKER_ENV.databaseUrlParameter]: props.databaseUrlParameterName,
      },
    });

    const dispatcher = new NodejsFunction(this, 'DispatcherFunction', {
      description: 'code-trust dispatcher: one FIFO job per event, grouped by repo.',
      entry: DISPATCHER_ENTRY,
      handler: 'handler',
      projectRoot: WORKSPACE_ROOT,
      depsLockFilePath: LOCKFILE,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: DISPATCHER_MEMORY_MB,
      timeout: Duration.seconds(DISPATCHER_TIMEOUT_SECONDS),
      role: dispatcherRole,
      logGroup: dispatcherLogs,
      environment: {
        [DISPATCHER_ENV.jobsQueueUrl]: jobsQueue.queueUrl,
      },
    });

    // Mappings rather than SqsEventSource, which would grant consume rights on its own. A FIFO
    // queue's poller takes one message group at a time, which keeps a repo's jobs in order, and a
    // batch of 1 means a failed job holds back only its own repo. No maxConcurrency: a cap stops
    // Lambda from scaling idle pollers down, and their empty receives would outgrow SQS's free
    // tier. The worker still runs at most one execution per repo with jobs waiting.
    worker.addEventSourceMapping('JobsQueueMapping', {
      eventSourceArn: jobsQueue.queueArn,
      batchSize: 1,
      reportBatchItemFailures: true,
    });
    dispatcher.addEventSourceMapping('EventsQueueMapping', {
      eventSourceArn: props.eventsQueue.queueArn,
      batchSize: 10,
      reportBatchItemFailures: true,
    });

    new CfnOutput(this, 'JobsQueueUrl', {
      value: jobsQueue.queueUrl,
      description: 'Jobs queue URL. It contains the account ID: keep it out of the repo.',
    });
    new CfnOutput(this, 'JobsDeadLetterQueueUrl', {
      value: jobsDeadLetterQueue.queueUrl,
      description: 'Jobs dead-letter queue URL. It contains the account ID: keep it out of the repo.',
    });
  }
}
