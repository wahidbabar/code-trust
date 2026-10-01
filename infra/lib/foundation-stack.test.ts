import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, test } from 'vitest';
import { REGION } from './config.ts';
import { FoundationStack } from './foundation-stack.ts';

const ALERT_EMAIL = 'alerts@example.com';

// The CLI feeds cdk.json's feature flags to the app. Load the same ones here, so these
// assertions hold for what `pnpm synth` produces and not for a flagless App.
const { context } = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>;
};

function synth(): Template {
  const stack = new FoundationStack(new App({ context }), 'TestFoundation', {
    env: { region: REGION },
    alertEmail: ALERT_EMAIL,
  });
  return Template.fromStack(stack);
}

describe('FoundationStack', () => {
  const template = synth();

  test('contains only the bucket, its SSL policy and the budget', () => {
    const resources = template.toJSON().Resources as Record<string, { Type: string }>;
    const types = Object.values(resources)
      .map((resource) => resource.Type)
      // CDK's own analytics resource is free and only present when version reporting is on.
      .filter((type) => type !== 'AWS::CDK::Metadata')
      .sort();
    expect(types).toEqual(['AWS::Budgets::Budget', 'AWS::S3::Bucket', 'AWS::S3::BucketPolicy']);
  });

  test('budget is 5 USD of monthly cost, counted before credits', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 5, Unit: 'USD' },
        CostTypes: { IncludeCredit: false, IncludeRefund: false },
      },
    });
  });

  test('budget emails at 50, 80 and 100 percent of actual spend', () => {
    const budgets = template.findResources('AWS::Budgets::Budget');
    const [budget] = Object.values(budgets);
    expect(budget?.Properties.NotificationsWithSubscribers).toEqual(
      [50, 80, 100].map((threshold) => ({
        Notification: {
          NotificationType: 'ACTUAL',
          ComparisonOperator: 'GREATER_THAN',
          Threshold: threshold,
          ThresholdType: 'PERCENTAGE',
        },
        Subscribers: [{ SubscriptionType: 'EMAIL', Address: ALERT_EMAIL }],
      })),
    );
  });

  test('bucket blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('bucket uses SSE-S3, not KMS', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    });
    template.resourceCountIs('AWS::KMS::Key', 0);
  });

  test('bucket versioning is off', () => {
    template.hasResourceProperties('AWS::S3::Bucket', { VersioningConfiguration: Match.absent() });
  });

  test('bucket expires raw/ after 14 days and aborts incomplete multipart uploads after 7', () => {
    const [bucket] = Object.values(template.findResources('AWS::S3::Bucket'));
    expect(bucket?.Properties.LifecycleConfiguration.Rules).toEqual([
      { Id: 'expire-raw', Prefix: 'raw/', ExpirationInDays: 14, Status: 'Enabled' },
      {
        Id: 'abort-incomplete-multipart-uploads',
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
        Status: 'Enabled',
      },
    ]);
  });

  test('bucket survives stack deletion and needs no cleanup Lambda', () => {
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });

  test('bucket policy denies requests that are not over TLS', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Principal: { AWS: '*' },
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  test('bucket name is a stack output', () => {
    const [bucketId] = Object.keys(template.findResources('AWS::S3::Bucket'));
    template.hasOutput('DataBucketName', { Value: { Ref: bucketId } });
  });

  test('template carries no account ID or ARN literal', () => {
    const body = JSON.stringify(template.toJSON());
    expect(body).not.toMatch(/\b\d{12}\b/);
    expect(body).not.toMatch(/arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/);
  });
});
