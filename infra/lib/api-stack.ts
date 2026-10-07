import { fileURLToPath } from 'node:url';
import { API_ENV } from '@code-trust/api/env';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, FunctionUrlAuthType, HttpMethod, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { API_MEMORY_MB, API_TIMEOUT_SECONDS } from './config.ts';

// Absolute, for the same reason as in ingest-stack.ts: NodejsFunction runs esbuild from
// projectRoot, which must contain both the entry and the lockfile.
const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const API_ENTRY = fileURLToPath(new URL('../../apps/api/src/lambda.ts', import.meta.url));
const LOCKFILE = fileURLToPath(new URL('../../pnpm-lock.yaml', import.meta.url));

/**
 * Left out of the bundle. Setting externalModules replaces NodejsFunction's default, so the SDK the
 * runtime provides is listed again. Nest loads the other four only when a feature needs them, and
 * esbuild fails on them otherwise; a missing one throws inside Nest's optional loader, which
 * expects that. A package also covers its subpaths.
 */
export const API_EXTERNAL_MODULES = [
  '@aws-sdk/*',
  '@smithy/*',
  '@nestjs/microservices',
  '@nestjs/websockets',
  'class-validator',
  'class-transformer',
];

export interface ApiStackProps extends StackProps {
  /** Name of the SSM SecureString that holds the Neon database URL, such as `/code-trust/x`. */
  readonly databaseUrlParameterName: string;
  /** The only origin the Function URL's CORS allows: the dashboard's. */
  readonly dashboardOrigin: string;
}

/**
 * The read API: a public Function URL in front of the NestJS app, which reads Neon. The URL's CORS
 * configuration allows the dashboard's origin and GET, and nothing else; the app sends no CORS
 * headers of its own.
 *
 * Never rename this stack, `ApiFunction` or its `FunctionUrl` after the first deploy: a new
 * construct ID means a new URL, and the dashboard's API_URL would still point at the old one.
 */
export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // Passed to the function as logGroup. logRetention would add a custom-resource Lambda.
    const logGroup = new LogGroup(this, 'ApiLogs', {
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // An explicit role, because CDK's default one carries AWSLambdaBasicExecutionRole (log actions
    // on every resource), and StringParameter.grantRead would add actions this function never calls.
    const role = new Role(this, 'ApiRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'code-trust API: read the database URL parameter, write its own logs.',
    });
    role.addToPolicy(
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
    logGroup.grantWrite(role);

    const api = new NodejsFunction(this, 'ApiFunction', {
      description: 'code-trust read API: NestJS behind a Function URL, reading Neon.',
      entry: API_ENTRY,
      handler: 'handler',
      projectRoot: WORKSPACE_ROOT,
      depsLockFilePath: LOCKFILE,
      // Pinned, not NODEJS_LATEST, so the bundle leaves out the SDK the runtime ships.
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: API_MEMORY_MB,
      timeout: Duration.seconds(API_TIMEOUT_SECONDS),
      role,
      logGroup,
      environment: {
        [API_ENV.databaseUrlParameter]: props.databaseUrlParameterName,
      },
      bundling: { externalModules: API_EXTERNAL_MODULES },
    });

    // Auth NONE: the API is public and read-only. CORS lives here rather than in Nest, so a change
    // to it is a change to this template. A simple GET needs no preflight, so nothing else is set.
    const apiUrl = api.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: { allowedOrigins: [props.dashboardOrigin], allowedMethods: [HttpMethod.GET] },
    });

    new CfnOutput(this, 'ApiUrl', {
      value: apiUrl.url,
      description: 'The API URL, ending in a slash. The dashboard polls it, so it is public.',
    });
  }
}
