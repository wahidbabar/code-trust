import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import {
  BUDGET_ALERT_THRESHOLDS_PERCENT,
  BUDGET_LIMIT_USD,
  MULTIPART_ABORT_DAYS,
  RAW_EXPIRY_DAYS,
  RAW_PREFIX,
} from './config.ts';

export interface FoundationStackProps extends StackProps {
  readonly alertEmail: string;
}

/**
 * Account guardrails that must exist before anything else: the budget tripwire and the data bucket.
 * Keep it to these two. Later concerns are new stacks in new files.
 */
export class FoundationStack extends Stack {
  readonly dataBucket: Bucket;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    this.dataBucket = new Bucket(this, 'DataBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      // SSE-S3 rather than KMS: a customer-managed key bills monthly.
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      // Retain without autoDeleteObjects: auto-delete adds a Lambda-backed custom resource.
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-raw',
          prefix: RAW_PREFIX,
          expiration: Duration.days(RAW_EXPIRY_DAYS),
        },
        {
          // Bucket-wide: abandoned multipart parts bill as storage and never show up in listings.
          id: 'abort-incomplete-multipart-uploads',
          abortIncompleteMultipartUploadAfter: Duration.days(MULTIPART_ABORT_DAYS),
        },
      ],
    });

    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: BUDGET_LIMIT_USD, unit: 'USD' },
        // Count spend before credits and refunds. With the default, credits net usage to zero and
        // the alarm stays silent while a runaway resource burns through them.
        costTypes: { includeCredit: false, includeRefund: false },
      },
      notificationsWithSubscribers: BUDGET_ALERT_THRESHOLDS_PERCENT.map((threshold) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }],
      })),
    });

    new CfnOutput(this, 'DataBucketName', {
      value: this.dataBucket.bucketName,
      description: 'S3 bucket for raw diffs and snapshots (raw/ expires after 14 days).',
    });
  }
}
