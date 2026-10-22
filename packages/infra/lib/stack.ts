import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_budgets as budgets,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { OutputMode } from '@qa/backend';
import { foundationModelArns, inferenceProfileArn } from './bedrock-arns';

export interface QueryAnalyzerProps extends StackProps {
  webDistPath: string;
  budgetEmail: string;
  inferenceProfileId: string;
  foundationModelId: string;
  maxTokens: number;
  outputMode: OutputMode;
  // 0 means "do not reserve concurrency" (see the note where it is applied).
  concurrencyCap: number;
  budgetUsd: number;
  logRetentionDays: number;
  temperature?: number;
}

const SECRET_NAME = 'query-analyzer-shared-secret';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HANDLER_ENTRY = fileURLToPath(new URL('../../backend/src/handler.ts', import.meta.url));
const LOCK_FILE = fileURLToPath(new URL('../../../package-lock.json', import.meta.url));

// RetentionDays values equal the day counts; INFINITE is not allowed.
function retentionFor(days: number): logs.RetentionDays {
  const supported = Object.values(logs.RetentionDays).filter(
    (v): v is number => typeof v === 'number' && v !== logs.RetentionDays.INFINITE,
  );
  if (!supported.includes(days)) {
    throw new Error(`Unsupported logRetentionDays ${days}. Supported values: ${supported.join(', ')}`);
  }
  return days as logs.RetentionDays;
}

export class QueryAnalyzerStack extends Stack {
  constructor(scope: Construct, id: string, props: QueryAnalyzerProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const secret = new secretsmanager.Secret(this, 'SharedSecret', {
      secretName: SECRET_NAME,
      description: 'Shared secret for the query-analyzer API',
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
    });

    const logGroup = new logs.LogGroup(this, 'FunctionLogs', {
      retention: retentionFor(props.logRetentionDays),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const environment: Record<string, string> = {
      SECRET_ARN: secret.secretArn,
      INFERENCE_PROFILE_ID: props.inferenceProfileId,
      MAX_TOKENS: String(props.maxTokens),
      OUTPUT_MODE: props.outputMode,
      REQUEST_TIMEOUT_MS: '25000',
    };
    if (props.temperature !== undefined) environment.TEMPERATURE = String(props.temperature);

    const fn = new nodejs.NodejsFunction(this, 'AnalyzerFunction', {
      entry: HANDLER_ENTRY,
      handler: 'handler',
      projectRoot: REPO_ROOT,
      depsLockFilePath: LOCK_FILE,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(28),
      memorySize: 512,
      logGroup,
      environment,
      // Reserved concurrency (0 skips it):
      // - Lambda keeps a minimum unreserved pool for the account.
      // - Accounts with a low concurrency limit cannot reserve any (this project's account had 10).
      // - See the Lambda docs on reserved concurrency for the exact rule.
      ...(props.concurrencyCap > 0 ? { reservedConcurrentExecutions: props.concurrencyCap } : {}),
      // Bundle the SDK: the runtime one may be too old for Converse outputConfig.
      bundling: { externalModules: [] },
    });

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          inferenceProfileArn(props.inferenceProfileId, this.region, this.account),
          ...foundationModelArns(props.inferenceProfileId, props.foundationModelId, this.region),
        ],
      }),
    );
    secret.grantRead(fn);

    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const responseHeadersPolicy = cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS;
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          responseHeadersPolicy,
        },
      },
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(props.webDistPath)],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'query-analyzer-monthly-budget',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.budgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail }],
        },
      ],
    });

    new CfnOutput(this, 'SiteUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'SecretName', { value: SECRET_NAME });
  }
}
