import { describe, expect, it } from 'vitest';
import { foundationModelArns, inferenceProfileArn } from '../lib/bedrock-arns';

const MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0';

describe('foundationModelArns', () => {
  it('global. returns the region-less ARN and the home region ARN', () => {
    expect(foundationModelArns(`global.${MODEL}`, MODEL, 'ap-southeast-2')).toEqual([
      `arn:aws:bedrock:::foundation-model/${MODEL}`,
      `arn:aws:bedrock:ap-southeast-2::foundation-model/${MODEL}`,
    ]);
  });

  it('au. returns ap-southeast-2 and ap-southeast-4', () => {
    expect(foundationModelArns(`au.${MODEL}`, MODEL, 'ap-southeast-2')).toEqual([
      `arn:aws:bedrock:ap-southeast-2::foundation-model/${MODEL}`,
      `arn:aws:bedrock:ap-southeast-4::foundation-model/${MODEL}`,
    ]);
  });

  it('throws for an unknown prefix and names the supported ones', () => {
    expect(() => foundationModelArns(`us.${MODEL}`, MODEL, 'ap-southeast-2')).toThrow(/global\..*au\./);
  });
});

describe('inferenceProfileArn', () => {
  it('builds the inference profile ARN', () => {
    expect(inferenceProfileArn(`global.${MODEL}`, 'ap-southeast-2', '123456789012')).toBe(
      `arn:aws:bedrock:ap-southeast-2:123456789012:inference-profile/global.${MODEL}`,
    );
  });
});
