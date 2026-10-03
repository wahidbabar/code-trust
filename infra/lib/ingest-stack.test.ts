import { readFileSync } from 'node:fs';
import { WEBHOOK_ENV } from '@code-trust/ingest/env';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, test } from 'vitest';
import { REGION, WEBHOOK_SECRET_PARAMETER_NAME } from './config.ts';
import { IngestStack } from './ingest-stack.ts';

// The CLI feeds cdk.json's feature flags to the app. Load the same ones here, so these
// assertions hold for what `pnpm synth` produces and not for a flagless App.
const { context } = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>;
};

// Every resource this stack may create, with its count. Anything else, such as a NAT gateway, a
// KMS key, a secret, a custom resource or an API Gateway, fails the first test.
const ALLOWED_RESOURCE_TYPES = [
  'AWS::IAM::Policy',
  'AWS::IAM::Role',
  'AWS::Lambda::Function',
  'AWS::Lambda::Permission', // lambda:InvokeFunctionUrl for auth type NONE
  'AWS::Lambda::Permission', // lambda:InvokeFunction, only through the Function URL
  'AWS::Lambda::Url',
  'AWS::Logs::LogGroup',
  'AWS::SQS::Queue', // events
  'AWS::SQS::Queue', // dead letters
  'AWS::SQS::QueuePolicy', // TLS only, one per queue
  'AWS::SQS::QueuePolicy',
];

// Copied from the first synth. They change only if a construct is renamed, and a renamed
// function or URL gets a new URL that the registered GitHub App would not know.
const WEBHOOK_FUNCTION_ID = 'WebhookFunction59DCB58D';
const WEBHOOK_URL_ID = 'WebhookFunctionFunctionUrl2641526E';

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Action: string | string[]; Effect: string; Resource: unknown };

function synth(webhookSecretParameterName = WEBHOOK_SECRET_PARAMETER_NAME): Template {
  // Bundling is skipped so these tests stay fast; `pnpm synth` is what proves the bundle builds.
  const app = new App({ context: { ...context, 'aws:cdk:bundling-stacks': [] } });
  const stack = new IngestStack(app, 'TestIngest', { env: { region: REGION }, webhookSecretParameterName });
  return Template.fromStack(stack);
}

function resourcesOf(template: Template, type?: string): [string, Resource][] {
  const resources = template.toJSON().Resources as Record<string, Resource>;
  return Object.entries(resources).filter(([, resource]) => type === undefined || resource.Type === type);
}

function onlyId(template: Template, type: string): string {
  const ids = resourcesOf(template, type).map(([id]) => id);
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

function policyStatements(template: Template): Statement[] {
  return resourcesOf(template, 'AWS::IAM::Policy').flatMap(
    ([, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement,
  );
}

const actionsOf = (statement: Statement): string[] =>
  Array.isArray(statement.Action) ? statement.Action : [statement.Action];

// An Fn::Join rendered as text, with every token shown as <token>.
function joined(value: unknown): string {
  const join = (value as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
  if (join === undefined) return typeof value === 'string' ? value : '<token>';
  return join[1].map((part) => (typeof part === 'string' ? part : '<token>')).join(join[0]);
}

function parameterArn(template: Template): string {
  const statement = policyStatements(template).find((s) => actionsOf(s).includes('ssm:GetParameter'));
  return joined(statement?.Resource);
}

describe('IngestStack', () => {
  const template = synth();
  const eventsQueueId = resourcesOf(template, 'AWS::SQS::Queue').find(([, q]) => q.Properties.RedrivePolicy)?.[0];
  const deadLetterQueueId = resourcesOf(template, 'AWS::SQS::Queue').find(([, q]) => !q.Properties.RedrivePolicy)?.[0];
  const logGroupId = onlyId(template, 'AWS::Logs::LogGroup');

  test('contains exactly the allowed resource types', () => {
    const types = resourcesOf(template)
      .map(([, resource]) => resource.Type)
      // CDK's own analytics resource is free and only present when version reporting is on.
      .filter((type) => type !== 'AWS::CDK::Metadata')
      .sort();
    expect(types).toEqual([...ALLOWED_RESOURCE_TYPES].sort());
  });

  test('has no custom resource, KMS key or Secrets Manager secret', () => {
    expect(resourcesOf(template).filter(([, r]) => r.Type.startsWith('Custom::'))).toEqual([]);
    template.resourceCountIs('Custom::LogRetention', 0);
    template.resourceCountIs('AWS::KMS::Key', 0);
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });

  test('the function is arm64 on a pinned Node runtime, small and quick to time out', () => {
    const functions = resourcesOf(template, 'AWS::Lambda::Function');
    expect(functions).toHaveLength(1);
    const properties = functions[0]?.[1].Properties ?? {};
    expect(properties).toMatchObject({ Architectures: ['arm64'], Runtime: 'nodejs24.x', Handler: 'index.handler' });
    expect(properties.MemorySize).toBeLessThanOrEqual(256);
    // Below GitHub's 10 second cutoff, so the handler's own 500 reaches GitHub first.
    expect(properties.Timeout).toBe(8);
    expect(properties.Timeout).toBeLessThanOrEqual(10);
    // Reserved concurrency can fail a deploy on a new account's low limit.
    expect(properties.ReservedConcurrentExecutions).toBeUndefined();
  });

  test('every log group keeps 14 days, and the function logs to its own', () => {
    for (const [, logGroup] of resourcesOf(template, 'AWS::Logs::LogGroup')) {
      expect(logGroup.Properties.RetentionInDays).toBe(14);
    }
    template.hasResourceProperties('AWS::Lambda::Function', { LoggingConfig: { LogGroup: { Ref: logGroupId } } });
  });

  test('the events queue redrives to the dead-letter queue', () => {
    expect(deadLetterQueueId).toBeDefined();
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': [deadLetterQueueId, 'Arn'] }, maxReceiveCount: 5 },
    });
  });

  test('both queues use SQS-managed encryption and keep messages 14 days', () => {
    const queues = resourcesOf(template, 'AWS::SQS::Queue');
    expect(queues).toHaveLength(2);
    for (const [, queue] of queues) {
      expect(queue.Properties).toMatchObject({ SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 86_400 });
      expect(queue.Properties.KmsMasterKeyId).toBeUndefined();
    }
  });

  test('both queue policies deny requests that are not over TLS', () => {
    for (const queueId of [eventsQueueId, deadLetterQueueId]) {
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

  test('the role has no managed policy, so nothing grants more than its own policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
      },
      ManagedPolicyArns: Match.absent(),
    });
  });

  test('the policy grants SendMessage on the events queue, GetParameter on one parameter, and log writes', () => {
    const statements = policyStatements(template);
    const byAction = Object.fromEntries(statements.map((s) => [actionsOf(s).sort().join(','), s.Resource]));
    expect(byAction).toEqual({
      'sqs:SendMessage': { 'Fn::GetAtt': [eventsQueueId, 'Arn'] },
      'ssm:GetParameter': expect.objectContaining({ 'Fn::Join': expect.any(Array) }),
      'logs:CreateLogStream,logs:PutLogEvents': { 'Fn::GetAtt': [logGroupId, 'Arn'] },
    });
    expect(statements.every((s) => s.Effect === 'Allow')).toBe(true);
    expect(parameterArn(template)).toBe('arn:aws:ssm:ap-south-1:<token>:parameter/code-trust/github-webhook-secret');
  });

  test('no statement has a * resource, or a wildcard anywhere in one', () => {
    for (const statement of policyStatements(template)) {
      expect(statement.Resource).not.toEqual('*');
      expect(JSON.stringify(statement.Resource)).not.toContain('*');
    }
  });

  test.each([
    ['/code-trust/github-webhook-secret', ':parameter/code-trust/github-webhook-secret'],
    ['/github-webhook-secret', ':parameter/github-webhook-secret'],
    ['github-webhook-secret', ':parameter/github-webhook-secret'],
  ])('the parameter ARN for %s has exactly one slash after "parameter"', (name, suffix) => {
    const arn = parameterArn(synth(name));
    expect(arn.endsWith(suffix)).toBe(true);
    expect(arn).not.toContain('parameter//');
  });

  test('the function gets the parameter name and the queue URL under the names the handler reads', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          [WEBHOOK_ENV.secretParameter]: WEBHOOK_SECRET_PARAMETER_NAME,
          [WEBHOOK_ENV.eventsQueueUrl]: { Ref: eventsQueueId },
        },
      },
    });
  });

  test('the front door is a Function URL with auth NONE and both invoke permissions', () => {
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'NONE',
      TargetFunctionArn: { 'Fn::GetAtt': [WEBHOOK_FUNCTION_ID, 'Arn'] },
    });
    // Since October 2025 a URL needs both, or callers get 403 before the function runs.
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      FunctionUrlAuthType: 'NONE',
      Principal: '*',
      FunctionName: { 'Fn::GetAtt': [WEBHOOK_FUNCTION_ID, 'Arn'] },
    });
    // The condition keeps the public grant to calls through the URL, not direct Invoke calls.
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      InvokedViaFunctionUrl: true,
      Principal: '*',
      FunctionName: { 'Fn::GetAtt': [WEBHOOK_FUNCTION_ID, 'Arn'] },
    });
  });

  test('the function and URL keep their logical IDs, so the webhook URL survives redeploys', () => {
    expect(onlyId(template, 'AWS::Lambda::Function')).toBe(WEBHOOK_FUNCTION_ID);
    expect(onlyId(template, 'AWS::Lambda::Url')).toBe(WEBHOOK_URL_ID);
  });

  test('outputs the webhook URL and the events queue URL', () => {
    template.hasOutput('WebhookUrl', { Value: { 'Fn::GetAtt': [WEBHOOK_URL_ID, 'FunctionUrl'] } });
    template.hasOutput('EventsQueueUrl', { Value: { Ref: eventsQueueId } });
  });

  test('template carries no account ID or ARN literal', () => {
    const body = JSON.stringify(template.toJSON());
    expect(body).not.toMatch(/\b\d{12}\b/);
    expect(body).not.toMatch(/arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/);
  });
});
