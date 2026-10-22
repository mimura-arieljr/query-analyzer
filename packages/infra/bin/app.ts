import { App } from 'aws-cdk-lib';
import type { OutputMode } from '@qa/backend';
import { numberSetting, webDistPathFrom } from '../lib/app-config';
import { QueryAnalyzerStack } from '../lib/stack';

const app = new App();
const ctx = (key: string): unknown => app.node.tryGetContext(key);
const num = (key: string, fallback: number | undefined) => numberSetting(key, ctx(key), fallback);

function str(key: string, fallback: string): string {
  const raw = ctx(key);
  return raw === undefined || raw === '' ? fallback : String(raw);
}

const budgetEmail = ctx('budgetEmail');
if (typeof budgetEmail !== 'string' || budgetEmail === '') {
  throw new Error('Context "budgetEmail" is required, e.g. cdk synth -c budgetEmail=you@example.com');
}

const outputMode = str('outputMode', 'structured');
if (outputMode !== 'structured' && outputMode !== 'tool' && outputMode !== 'json') {
  throw new Error(`Context "outputMode" must be structured, tool or json, got "${outputMode}"`);
}

new QueryAnalyzerStack(app, 'QueryAnalyzerStack', {
  env: { region: 'ap-southeast-2', account: process.env.CDK_DEFAULT_ACCOUNT },
  webDistPath: webDistPathFrom(import.meta.url),
  budgetEmail,
  inferenceProfileId: str('inferenceProfileId', 'global.anthropic.claude-haiku-4-5-20251001-v1:0'),
  foundationModelId: str('foundationModelId', 'anthropic.claude-haiku-4-5-20251001-v1:0'),
  maxTokens: num('maxTokens', 4096)!,
  outputMode: outputMode as OutputMode,
  concurrencyCap: num('concurrencyCap', 5)!,
  budgetUsd: num('budgetUsd', 5)!,
  logRetentionDays: num('logRetentionDays', 14)!,
  temperature: num('temperature', undefined),
});
