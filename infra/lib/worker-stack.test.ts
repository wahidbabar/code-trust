import { readFileSync } from 'node:fs';
import { DISPATCHER_ENV } from '@code-trust/ingest/env';
import { WORKER_ENV } from '@code-trust/worker/env';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, test } from 'vitest';
import {
  DATABASE_URL_PARAMETER_NAME,
  DISPATCHER_TIMEOUT_SECONDS,
  REGION,
  WEBHOOK_SECRET_PARAMETER_NAME,
  WORKER_EPHEMERAL_STORAGE_MB,
  WORKER_MEMORY_MB,
} from './config.ts';
import { IngestStack } from './ingest-stack.ts';
import { WorkerStack } from './worker-stack.ts';

// The CLI feeds cdk.json's feature flags to the app. Load the same ones here, so these
// assertions hold for what `pnpm synth` produces and not for a flagless App. Among them is
// defaultCrossStackReferences: "weak", which decides how the events queue crosses stacks.
const { context } = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>;
};

// Every resource this stack may create, with its count. Anything else, such as a NAT gateway, a
// KMS key, a secret, a custom resource or a VPC, fails the first test.
const ALLOWED_RESOURCE_TYPES = [
  'AWS::IAM::Policy', // worker
  'AWS::IAM::Policy', // dispatcher
  'AWS::IAM::Role', // worker
  'AWS::IAM::Role', // dispatcher
  'AWS::Lambda::EventSourceMapping', // jobs queue to the worker
  'AWS::Lambda::EventSourceMapping', // events queue to the dispatcher
  'AWS::Lambda::Function', // worker
  'AWS::Lambda::Function', // dispatcher
  'AWS::Lambda::LayerVersion', // git
  'AWS::Logs::LogGroup', // worker
  'AWS::Logs::LogGroup', // dispatcher
  'AWS::SQS::Queue', // jobs
  'AWS::SQS::Queue', // jobs dead letters
  'AWS::SQS::QueuePolicy', // TLS only, one per queue
  'AWS::SQS::QueuePolicy',
];

// Copied from the first synth. A renamed queue is a new queue: the jobs waiting in the old one
// would be deleted with it.
const JOBS_QUEUE_ID = 'JobsQueue86ED6666';
const JOBS_DEAD_LETTER_QUEUE_ID = 'JobsDeadLetterQueueE6E1CCE2';

const CONSUME = 'sqs:DeleteMessage,sqs:GetQueueAttributes,sqs:ReceiveMessage';
const LOG_WRITES = 'logs:CreateLogStream,logs:PutLogEvents';

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Action: string | string[]; Effect: string; Resource: unknown };

function synth(databaseUrlParameterName = DATABASE_URL_PARAMETER_NAME): { worker: Template; ingest: Template } {
  // Bundling is skipped so these tests stay fast, and GitLayer then uses its placeholder, so no
  // zip is needed. `pnpm synth` and smoke:worker are what prove the bundles build and load.
  const app = new App({ context: { ...context, 'aws:cdk:bundling-stacks': [] } });
  // Both stacks in one app, as in bin/app.ts, so the events queue crosses stacks as it will deployed.
  const ingest = new IngestStack(app, 'TestIngest', {
    env: { region: REGION },
    webhookSecretParameterName: WEBHOOK_SECRET_PARAMETER_NAME,
  });
  const worker = new WorkerStack(app, 'TestWorker', {
    env: { region: REGION },
    eventsQueue: ingest.eventsQueue,
    databaseUrlParameterName,
  });
  return { worker: Template.fromStack(worker), ingest: Template.fromStack(ingest) };
}

function resourcesOf(template: Template, type?: string): [string, Resource][] {
  const resources = template.toJSON().Resources as Record<string, Resource>;
  return Object.entries(resources).filter(([, resource]) => type === undefined || resource.Type === type);
}

function onlyId(template: Template, type: string, prefix = ''): string {
  const ids = resourcesOf(template, type)
    .map(([id]) => id)
    .filter((id) => id.startsWith(prefix));
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

function propertiesOf(template: Template, id: string): Record<string, unknown> {
  return (template.toJSON().Resources as Record<string, Resource>)[id]?.Properties ?? {};
}

// The statements of the policies attached to this role and no other.
function statementsOf(template: Template, roleId: string): Statement[] {
  return resourcesOf(template, 'AWS::IAM::Policy')
    .filter(([, policy]) => JSON.stringify(policy.Properties.Roles) === JSON.stringify([{ Ref: roleId }]))
    .flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
}

const actionsOf = (statement: Statement): string[] =>
  Array.isArray(statement.Action) ? statement.Action : [statement.Action];

// One entry per statement, keyed by its sorted actions. Two statements with the same actions would
// share a key, so callers also compare the statement count with the key count.
function byAction(statements: Statement[]): Record<string, unknown> {
  return Object.fromEntries(statements.map((s) => [actionsOf(s).sort().join(','), s.Resource]));
}

// An Fn::Join rendered as text, with every token shown as <token>.
function joined(value: unknown): string {
  const join = (value as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
  if (join === undefined) return typeof value === 'string' ? value : '<token>';
  return join[1].map((part) => (typeof part === 'string' ? part : '<token>')).join(join[0]);
}

function parameterArn(template: Template): string {
  const statements = resourcesOf(template, 'AWS::IAM::Policy').flatMap(
    ([, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement,
  );
  return joined(statements.find((s) => actionsOf(s).includes('ssm:GetParameter'))?.Resource);
}

const arnOf = (id: string) => ({ 'Fn::GetAtt': [id, 'Arn'] });

describe('WorkerStack', () => {
  const { worker: template, ingest } = synth();
  const workerId = onlyId(template, 'AWS::Lambda::Function', 'WorkerFunction');
  const dispatcherId = onlyId(template, 'AWS::Lambda::Function', 'DispatcherFunction');
  const workerFn = propertiesOf(template, workerId);
  const dispatcherFn = propertiesOf(template, dispatcherId);
  const workerLogsId = onlyId(template, 'AWS::Logs::LogGroup', 'WorkerLogs');
  const dispatcherLogsId = onlyId(template, 'AWS::Logs::LogGroup', 'DispatcherLogs');
  const workerRoleId = onlyId(template, 'AWS::IAM::Role', 'WorkerRole');
  const dispatcherRoleId = onlyId(template, 'AWS::IAM::Role', 'DispatcherRole');
  const layerId = onlyId(template, 'AWS::Lambda::LayerVersion');

  // The events queue as CodeTrustIngest publishes it: the output whose value is the queue's ARN.
  const eventsQueueId = onlyId(ingest, 'AWS::SQS::Queue', 'EventsQueue');
  const ingestOutputs = ingest.toJSON().Outputs as Record<string, { Value: unknown; Export?: unknown }>;
  const [eventsArnOutputName, eventsArnOutput] =
    Object.entries(ingestOutputs).find(
      ([, output]) => JSON.stringify(output.Value) === JSON.stringify(arnOf(eventsQueueId)),
    ) ?? [];
  const eventsQueueArn = {
    'Fn::GetStackOutput': { StackName: 'TestIngest', Region: REGION, OutputName: eventsArnOutputName },
  };

  test('contains exactly the allowed resource types', () => {
    const types = resourcesOf(template)
      .map(([, resource]) => resource.Type)
      // CDK's own analytics resource is free and only present when version reporting is on.
      .filter((type) => type !== 'AWS::CDK::Metadata')
      .sort();
    expect(types).toEqual([...ALLOWED_RESOURCE_TYPES].sort());
  });

  test('has no custom resource, KMS key, secret, VPC, container or DynamoDB resource', () => {
    const types = resourcesOf(template).map(([, resource]) => resource.Type);
    expect(types.filter((type) => type.startsWith('Custom::'))).toEqual([]);
    for (const prefix of ['AWS::EC2::', 'AWS::ECS::', 'AWS::ECR::', 'AWS::DynamoDB::']) {
      expect(types.filter((type) => type.startsWith(prefix))).toEqual([]);
    }
    template.resourceCountIs('Custom::LogRetention', 0);
    template.resourceCountIs('AWS::KMS::Key', 0);
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });

  test('both functions are arm64 on nodejs24.x, without reserved concurrency', () => {
    for (const fn of [workerFn, dispatcherFn]) {
      expect(fn).toMatchObject({ Architectures: ['arm64'], Runtime: 'nodejs24.x', Handler: 'index.handler' });
      // Reserved concurrency can fail a deploy on a new account's low limit.
      expect(fn.ReservedConcurrentExecutions).toBeUndefined();
    }
  });

  test('the worker has the git layer, 15 minutes, the configured memory and /tmp', () => {
    expect(workerFn.Layers).toEqual([{ Ref: layerId }]);
    expect(propertiesOf(template, layerId)).toMatchObject({
      CompatibleArchitectures: ['arm64'],
      CompatibleRuntimes: ['nodejs24.x'],
    });
    expect(workerFn.Timeout).toBe(900);
    expect(workerFn.MemorySize).toBe(WORKER_MEMORY_MB);
    // A new account is capped at 3008 MB until AWS lifts the limit.
    expect(workerFn.MemorySize).toBeLessThanOrEqual(3008);
    expect(workerFn.EphemeralStorage).toEqual({ Size: WORKER_EPHEMERAL_STORAGE_MB });
    expect(WORKER_EPHEMERAL_STORAGE_MB).toBe(10_240);
  });

  test('the dispatcher is small, with a timeout well under the events queue visibility timeout', () => {
    expect(dispatcherFn.Layers).toBeUndefined();
    expect(dispatcherFn.MemorySize).toBeLessThanOrEqual(256);
    expect(dispatcherFn.Timeout).toBe(DISPATCHER_TIMEOUT_SECONDS);
    // IngestStack leaves the events queue at SQS's default of 30 seconds.
    const eventsVisibility = (propertiesOf(ingest, eventsQueueId).VisibilityTimeout as number | undefined) ?? 30;
    expect(3 * (dispatcherFn.Timeout as number)).toBeLessThanOrEqual(eventsVisibility);
  });

  test('every log group keeps 14 days, and each function logs to its own', () => {
    for (const [, logGroup] of resourcesOf(template, 'AWS::Logs::LogGroup')) {
      expect(logGroup.Properties.RetentionInDays).toBe(14);
    }
    expect(workerFn.LoggingConfig).toEqual({ LogGroup: { Ref: workerLogsId } });
    expect(dispatcherFn.LoggingConfig).toEqual({ LogGroup: { Ref: dispatcherLogsId } });
  });

  test('the jobs queue and its DLQ are FIFO, SQS-encrypted, keep 14 days and never dedupe on content', () => {
    const queues = resourcesOf(template, 'AWS::SQS::Queue');
    expect(queues.map(([id]) => id).sort()).toEqual([JOBS_DEAD_LETTER_QUEUE_ID, JOBS_QUEUE_ID].sort());
    for (const [, queue] of queues) {
      expect(queue.Properties).toMatchObject({
        FifoQueue: true,
        SqsManagedSseEnabled: true,
        MessageRetentionPeriod: 14 * 86_400,
      });
      expect(queue.Properties.KmsMasterKeyId).toBeUndefined();
      expect(queue.Properties.ContentBasedDeduplication).not.toBe(true);
    }
    expect(propertiesOf(template, JOBS_QUEUE_ID).ContentBasedDeduplication).toBe(false);
  });

  test('the jobs queue redrives after 3 receives, and stays invisible six worker timeouts', () => {
    const jobs = propertiesOf(template, JOBS_QUEUE_ID);
    expect(jobs.RedrivePolicy).toEqual({ deadLetterTargetArn: arnOf(JOBS_DEAD_LETTER_QUEUE_ID), maxReceiveCount: 3 });
    expect(jobs.VisibilityTimeout).toBeGreaterThanOrEqual(6 * (workerFn.Timeout as number));
  });

  test('both queue policies deny requests that are not over TLS', () => {
    for (const queueId of [JOBS_QUEUE_ID, JOBS_DEAD_LETTER_QUEUE_ID]) {
      template.hasResourceProperties('AWS::SQS::QueuePolicy', {
        Queues: [{ Ref: queueId }],
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Action: 'sqs:*',
              Principal: { AWS: '*' },
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      });
    }
  });

  test('the worker reads the jobs queue one job at a time, the dispatcher the events queue 10 at a time, neither capped', () => {
    const mappings = resourcesOf(template, 'AWS::Lambda::EventSourceMapping').map(([, m]) => m.Properties);
    expect(mappings).toHaveLength(2);
    const mappingOf = (functionId: string) =>
      mappings.find((m) => JSON.stringify(m.FunctionName) === JSON.stringify({ Ref: functionId }));

    // Exactly these keys: no batching window, filter or other setting, and no ScalingConfig, whose
    // MaximumConcurrency would stop Lambda from scaling idle pollers down.
    expect(mappingOf(workerId)).toEqual({
      FunctionName: { Ref: workerId },
      EventSourceArn: arnOf(JOBS_QUEUE_ID),
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
    expect(mappingOf(dispatcherId)).toEqual({
      FunctionName: { Ref: dispatcherId },
      EventSourceArn: eventsQueueArn,
      BatchSize: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
    for (const mapping of mappings) expect(mapping.ScalingConfig).toBeUndefined();
  });

  test('the events queue crosses stacks as a weak reference: a stack output, never an export', () => {
    expect(eventsArnOutputName).toBeDefined();
    // An export would lock the queue in CodeTrustIngest for as long as this stack imports it.
    expect(eventsArnOutput?.Export).toBeUndefined();
    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
  });

  test('each role is attached to its own function and has no managed policy', () => {
    expect(workerFn.Role).toEqual(arnOf(workerRoleId));
    expect(dispatcherFn.Role).toEqual(arnOf(dispatcherRoleId));
    for (const roleId of [workerRoleId, dispatcherRoleId]) {
      expect(propertiesOf(template, roleId)).toMatchObject({
        AssumeRolePolicyDocument: {
          Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
        },
      });
      expect(propertiesOf(template, roleId).ManagedPolicyArns).toBeUndefined();
    }
    // Every policy belongs to one of the two roles, so the two tests below see every statement.
    const attached = resourcesOf(template, 'AWS::IAM::Policy').map(([, p]) => JSON.stringify(p.Properties.Roles));
    expect(attached.sort()).toEqual(
      [JSON.stringify([{ Ref: dispatcherRoleId }]), JSON.stringify([{ Ref: workerRoleId }])].sort(),
    );
  });

  test('the worker may consume the jobs queue, read one parameter and write its logs, nothing else', () => {
    const statements = statementsOf(template, workerRoleId);
    const expected = {
      [CONSUME]: arnOf(JOBS_QUEUE_ID),
      'ssm:GetParameter': expect.objectContaining({ 'Fn::Join': expect.any(Array) }),
      [LOG_WRITES]: arnOf(workerLogsId),
    };
    expect(byAction(statements)).toEqual(expected);
    expect(statements).toHaveLength(Object.keys(expected).length);
    expect(statements.every((s) => s.Effect === 'Allow')).toBe(true);
    expect(parameterArn(template)).toBe('arn:aws:ssm:ap-south-1:<token>:parameter/code-trust/database-url');
  });

  test('the dispatcher may consume the events queue, send to the jobs queue and write its logs, nothing else', () => {
    const statements = statementsOf(template, dispatcherRoleId);
    const expected = {
      [CONSUME]: eventsQueueArn,
      'sqs:SendMessage': arnOf(JOBS_QUEUE_ID),
      [LOG_WRITES]: arnOf(dispatcherLogsId),
    };
    expect(byAction(statements)).toEqual(expected);
    expect(statements).toHaveLength(Object.keys(expected).length);
    expect(statements.every((s) => s.Effect === 'Allow')).toBe(true);
  });

  test('no statement has a wildcard action or resource, or a KMS action', () => {
    for (const roleId of [workerRoleId, dispatcherRoleId]) {
      for (const statement of statementsOf(template, roleId)) {
        expect(statement.Resource).not.toEqual('*');
        expect(JSON.stringify(statement.Resource)).not.toContain('*');
        expect(actionsOf(statement).filter((action) => action.includes('*') || action.startsWith('kms:'))).toEqual([]);
      }
    }
  });

  test.each([
    ['/code-trust/database-url', ':parameter/code-trust/database-url'],
    ['/database-url', ':parameter/database-url'],
    ['database-url', ':parameter/database-url'],
  ])('the parameter ARN for %s has exactly one slash after "parameter"', (name, suffix) => {
    const arn = parameterArn(synth(name).worker);
    expect(arn.endsWith(suffix)).toBe(true);
    expect(arn).not.toContain('parameter//');
  });

  test('each function gets exactly the env vars its handler reads', () => {
    expect(workerFn.Environment).toEqual({
      Variables: { [WORKER_ENV.databaseUrlParameter]: DATABASE_URL_PARAMETER_NAME },
    });
    expect(dispatcherFn.Environment).toEqual({ Variables: { [DISPATCHER_ENV.jobsQueueUrl]: { Ref: JOBS_QUEUE_ID } } });
  });

  test('outputs the jobs queue URL and the jobs DLQ URL, each saying it holds the account ID', () => {
    template.hasOutput('JobsQueueUrl', {
      Value: { Ref: JOBS_QUEUE_ID },
      Description: Match.stringLikeRegexp('account ID'),
    });
    template.hasOutput('JobsDeadLetterQueueUrl', {
      Value: { Ref: JOBS_DEAD_LETTER_QUEUE_ID },
      Description: Match.stringLikeRegexp('account ID'),
    });
  });

  test('template carries no account ID or ARN literal', () => {
    const body = JSON.stringify(template.toJSON());
    expect(body).not.toMatch(/\b\d{12}\b/);
    expect(body).not.toMatch(/arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/);
  });
});
