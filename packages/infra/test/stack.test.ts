import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { QueryAnalyzerStack, type QueryAnalyzerProps } from '../lib/stack';

const MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0';
const webDistPath = mkdtempSync(join(tmpdir(), 'qa-web-'));
writeFileSync(join(webDistPath, 'index.html'), '<html></html>');

function build(over: Partial<QueryAnalyzerProps> = {}): Template {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new QueryAnalyzerStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'ap-southeast-2' },
    webDistPath,
    budgetEmail: 'owner@example.com',
    inferenceProfileId: `global.${MODEL}`,
    foundationModelId: MODEL,
    maxTokens: 4096,
    outputMode: 'structured',
    concurrencyCap: 5,
    budgetUsd: 5,
    logRetentionDays: 14,
    ...over,
  });
  return Template.fromStack(stack);
}

function statements(t: Template): any[] {
  const out: any[] = [];
  for (const p of Object.values(t.findResources('AWS::IAM::Policy'))) {
    const s = (p as any).Properties.PolicyDocument.Statement;
    out.push(...(Array.isArray(s) ? s : [s]));
  }
  return out;
}

const hasAction = (s: any, a: string) => [s.Action].flat().includes(a);

describe('QueryAnalyzerStack', () => {
  const t = build();

  it('lambda has reservedConcurrentExecutions 5, arm64 and timeout under 30', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 5,
      Architectures: ['arm64'],
      Timeout: 28,
      MemorySize: 512,
    });
  });

  it('lambda env has the handler variables and no TEMPERATURE by default', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          SECRET_ARN: Match.anyValue(),
          INFERENCE_PROFILE_ID: `global.${MODEL}`,
          MAX_TOKENS: '4096',
          OUTPUT_MODE: 'structured',
          REQUEST_TIMEOUT_MS: '25000',
        },
      },
    });
    const fn = Object.values(t.findResources('AWS::Lambda::Function')).find(
      (r: any) => r.Properties.Environment,
    ) as any;
    expect(fn.Properties.Environment.Variables).not.toHaveProperty('TEMPERATURE');
  });

  it('lambda env gets TEMPERATURE when set', () => {
    build({ temperature: 0.2 }).hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { TEMPERATURE: '0.2' } },
    });
  });

  it('concurrencyCap 0 sets no reserved concurrency', () => {
    const fns = build({ concurrencyCap: 0 }).findResources('AWS::Lambda::Function');
    const main = Object.values(fns).find((r: any) => r.Properties.Environment) as any;
    expect(main.Properties).not.toHaveProperty('ReservedConcurrentExecutions');
  });

  it('function URL auth type is AWS_IAM', () => {
    t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  });

  it('a CloudFront origin access control for lambda exists', () => {
    t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 'lambda' }),
    });
  });

  it('bucket blocks public access', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('bucket enforces SSL', () => {
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('secret has no KmsKeyId and a generated value', () => {
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'query-analyzer-shared-secret',
      GenerateSecretString: { PasswordLength: 32, ExcludePunctuation: true },
    });
    const secret = Object.values(t.findResources('AWS::SecretsManager::Secret'))[0] as any;
    expect(secret.Properties).not.toHaveProperty('KmsKeyId');
  });

  it('budget is 5 USD monthly with an 80 percent ACTUAL notification to the email', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetName: 'query-analyzer-monthly-budget',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 5, Unit: 'USD' },
      },
      NotificationsWithSubscribers: [
        {
          Notification: {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 80,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'owner@example.com' }],
        },
      ],
    });
  });

  it('log group retention is 14', () => {
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
  });

  it('rejects an unsupported log retention value', () => {
    expect(() => build({ logRetentionDays: 15 })).toThrow(/logRetentionDays/);
  });

  it('bedrock policy has no Resource of "*"', () => {
    const bedrock = statements(t).filter((s) => hasAction(s, 'bedrock:InvokeModel'));
    expect(bedrock).toHaveLength(1);
    expect(JSON.stringify(bedrock[0].Resource)).not.toContain('"*"');
    expect(bedrock[0].Resource).not.toBe('*');
    expect(bedrock[0].Resource).toHaveLength(3);
  });

  it('the secret policy is scoped to one secret', () => {
    const sec = statements(t).filter((s) => hasAction(s, 'secretsmanager:GetSecretValue'));
    expect(sec).toHaveLength(1);
    expect(typeof sec[0].Resource).toBe('object');
    expect([sec[0].Resource].flat()).toHaveLength(1);
    expect(sec[0].Resource).toHaveProperty('Ref');
  });

  it('/api/* behavior allows POST and disables caching', () => {
    const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as any;
    const cfg = dist.Properties.DistributionConfig;
    const api = cfg.CacheBehaviors.find((b: any) => b.PathPattern === '/api/*');
    expect(api.AllowedMethods).toContain('POST');
    expect(api.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    expect(api.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac');
    expect(api.ViewerProtocolPolicy).toBe('https-only');
    expect(cfg.DefaultRootObject).toBe('index.html');
    expect(cfg.DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    expect(cfg.DefaultCacheBehavior.ResponseHeadersPolicyId).toBe(api.ResponseHeadersPolicyId);
  });

  it('outputs the site URL and secret name', () => {
    t.hasOutput('SiteUrl', {});
    t.hasOutput('SecretName', { Value: 'query-analyzer-shared-secret' });
  });

  it('no resource name or description contains an em dash', () => {
    expect(JSON.stringify(t.toJSON())).not.toContain('—');
  });
});
