import { readFileSync } from 'node:fs';
import { API_ENV } from '@code-trust/api/env';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, test } from 'vitest';
import { API_EXTERNAL_MODULES, ApiStack } from './api-stack.ts';
import { API_MEMORY_MB, API_TIMEOUT_SECONDS, DASHBOARD_ORIGIN, DATABASE_URL_PARAMETER_NAME, REGION } from './config.ts';

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
];

// Copied from the first synth. They change only if a construct is renamed, and a renamed function
// or URL gets a new URL that the dashboard's API_URL would not know.
const API_FUNCTION_ID = 'ApiFunctionCE271BD4';
const API_URL_ID = 'ApiFunctionFunctionUrl73AD62DC';

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Action: string | string[]; Effect: string; Resource: unknown };

function synth(databaseUrlParameterName = DATABASE_URL_PARAMETER_NAME): Template {
  // Bundling is skipped so these tests stay fast; `pnpm synth` and the bundle smoke script are
  // what prove the bundle builds and boots.
  const app = new App({ context: { ...context, 'aws:cdk:bundling-stacks': [] } });
  const stack = new ApiStack(app, 'TestApi', {
    env: { region: REGION },
    databaseUrlParameterName,
    dashboardOrigin: DASHBOARD_ORIGIN,
  });
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

describe('ApiStack', () => {
  const template = synth();
  const logGroupId = onlyId(template, 'AWS::Logs::LogGroup');

  test('contains exactly the allowed resource types', () => {
    const types = resourcesOf(template)
      .map(([, resource]) => resource.Type)
      // CDK's own analytics resource is free and only present when version reporting is on.
      .filter((type) => type !== 'AWS::CDK::Metadata')
      .sort();
    expect(types).toEqual([...ALLOWED_RESOURCE_TYPES].sort());
  });

  test('has no custom resource, KMS key, Secrets Manager secret or API Gateway resource', () => {
    const types = resourcesOf(template).map(([, resource]) => resource.Type);
    expect(types.filter((type) => type.startsWith('Custom::'))).toEqual([]);
    expect(types.filter((type) => type.startsWith('AWS::ApiGateway'))).toEqual([]);
    template.resourceCountIs('Custom::LogRetention', 0);
    template.resourceCountIs('AWS::KMS::Key', 0);
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });

  test('the function is arm64 on nodejs24.x, 512 MB or less, with a 10 to 15 second timeout', () => {
    const functions = resourcesOf(template, 'AWS::Lambda::Function');
    expect(functions).toHaveLength(1);
    const properties = functions[0]?.[1].Properties ?? {};
    expect(properties).toMatchObject({ Architectures: ['arm64'], Runtime: 'nodejs24.x', Handler: 'index.handler' });
    expect(properties.MemorySize).toBe(API_MEMORY_MB);
    expect(properties.MemorySize).toBeLessThanOrEqual(512);
    // A cold start plus a few queries, each of which may wait up to 5 seconds on a resuming Neon.
    expect(properties.Timeout).toBe(API_TIMEOUT_SECONDS);
    expect(properties.Timeout).toBeGreaterThanOrEqual(10);
    expect(properties.Timeout).toBeLessThanOrEqual(15);
    // Reserved concurrency can fail a deploy on a new account's low limit.
    expect(properties.ReservedConcurrentExecutions).toBeUndefined();
  });

  test('every log group keeps 14 days, and the function logs to its own', () => {
    for (const [, logGroup] of resourcesOf(template, 'AWS::Logs::LogGroup')) {
      expect(logGroup.Properties.RetentionInDays).toBe(14);
    }
    template.hasResourceProperties('AWS::Lambda::Function', { LoggingConfig: { LogGroup: { Ref: logGroupId } } });
  });

  test('the Function URL has auth NONE, CORS for the dashboard origin and GET only, and both invoke permissions', () => {
    const urls = resourcesOf(template, 'AWS::Lambda::Url');
    expect(urls).toHaveLength(1);
    const properties = urls[0]?.[1].Properties ?? {};
    expect(properties.AuthType).toBe('NONE');
    expect(properties.TargetFunctionArn).toEqual({ 'Fn::GetAtt': [API_FUNCTION_ID, 'Arn'] });
    // Exactly these keys: no wildcard origin, no other method, no credentials, no extra headers.
    expect(properties.Cors).toEqual({ AllowOrigins: [DASHBOARD_ORIGIN], AllowMethods: ['GET'] });
    expect(DASHBOARD_ORIGIN).toBe('https://wahidbabar.github.io');

    // Since October 2025 a URL needs both, or callers get 403 before the function runs.
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      FunctionUrlAuthType: 'NONE',
      Principal: '*',
      FunctionName: { 'Fn::GetAtt': [API_FUNCTION_ID, 'Arn'] },
    });
    // The condition keeps the public grant to calls through the URL, not direct Invoke calls.
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      InvokedViaFunctionUrl: true,
      Principal: '*',
      FunctionName: { 'Fn::GetAtt': [API_FUNCTION_ID, 'Arn'] },
    });
  });

  test('the role has no managed policy, so nothing grants more than its own policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
      },
      ManagedPolicyArns: Match.absent(),
    });
  });

  test('the policy grants GetParameter on the database URL parameter and log writes, nothing else', () => {
    const statements = policyStatements(template);
    const byAction = Object.fromEntries(statements.map((s) => [actionsOf(s).sort().join(','), s.Resource]));
    expect(byAction).toEqual({
      'ssm:GetParameter': expect.objectContaining({ 'Fn::Join': expect.any(Array) }),
      'logs:CreateLogStream,logs:PutLogEvents': { 'Fn::GetAtt': [logGroupId, 'Arn'] },
    });
    expect(statements.every((s) => s.Effect === 'Allow')).toBe(true);
    expect(parameterArn(template)).toBe('arn:aws:ssm:ap-south-1:<token>:parameter/code-trust/database-url');
    expect(statements.flatMap(actionsOf).filter((action) => action.startsWith('kms:'))).toEqual([]);
  });

  test('no statement has a * resource, or a wildcard anywhere in one', () => {
    for (const statement of policyStatements(template)) {
      expect(statement.Resource).not.toEqual('*');
      expect(JSON.stringify(statement.Resource)).not.toContain('*');
    }
  });

  test.each([
    ['/code-trust/database-url', ':parameter/code-trust/database-url'],
    ['/database-url', ':parameter/database-url'],
    ['database-url', ':parameter/database-url'],
  ])('the parameter ARN for %s has exactly one slash after "parameter"', (name, suffix) => {
    const arn = parameterArn(synth(name));
    expect(arn.endsWith(suffix)).toBe(true);
    expect(arn).not.toContain('parameter//');
  });

  test('the function gets the parameter name under the env name the handler reads, and nothing else', () => {
    const [, fn] = resourcesOf(template, 'AWS::Lambda::Function')[0] ?? [];
    expect(fn?.Properties.Environment).toEqual({
      Variables: { [API_ENV.databaseUrlParameter]: DATABASE_URL_PARAMETER_NAME },
    });
  });

  test('the function and URL keep their logical IDs, so the API URL survives redeploys', () => {
    expect(onlyId(template, 'AWS::Lambda::Function')).toBe(API_FUNCTION_ID);
    expect(onlyId(template, 'AWS::Lambda::Url')).toBe(API_URL_ID);
  });

  test('outputs the API URL', () => {
    template.hasOutput('ApiUrl', { Value: { 'Fn::GetAtt': [API_URL_ID, 'FunctionUrl'] } });
  });

  test('template carries no account ID or ARN literal', () => {
    const body = JSON.stringify(template.toJSON());
    expect(body).not.toMatch(/\b\d{12}\b/);
    expect(body).not.toMatch(/arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/);
  });

  test("the bundle leaves out the runtime's SDK, which a custom externals list would otherwise drop", () => {
    expect(API_EXTERNAL_MODULES).toEqual(expect.arrayContaining(['@aws-sdk/*', '@smithy/*']));
  });
});
