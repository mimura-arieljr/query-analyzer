import { describe, expect, it } from 'vitest';
import { numberSetting, webDistPathFrom } from '../lib/app-config';

describe('webDistPathFrom', () => {
  it('returns a plain file path for a checkout path with a space', () => {
    const url = 'file:///Users/me/My%20Projects/query-analyzer/packages/infra/bin/app.ts';
    expect(webDistPathFrom(url)).toBe('/Users/me/My Projects/query-analyzer/packages/web/dist');
  });

  it('returns a plain file path for non-ASCII characters', () => {
    const url = new URL('file:///Users/me/Projekte-%C3%BC/qa/packages/infra/bin/app.ts');
    expect(webDistPathFrom(url)).toBe('/Users/me/Projekte-ü/qa/packages/web/dist');
  });
});

describe('numberSetting', () => {
  it('accepts a JSON number from cdk.json and a string from -c', () => {
    expect(numberSetting('concurrencyCap', 0, 5)).toBe(0);
    expect(numberSetting('concurrencyCap', '0', 5)).toBe(0);
    expect(numberSetting('maxTokens', 2048, 4096)).toBe(2048);
    expect(numberSetting('maxTokens', '2048', 4096)).toBe(2048);
  });

  it('uses the fallback when unset or empty', () => {
    expect(numberSetting('budgetUsd', undefined, 5)).toBe(5);
    expect(numberSetting('budgetUsd', '', 5)).toBe(5);
    expect(numberSetting('temperature', undefined, undefined)).toBeUndefined();
  });

  it('rejects a non-number', () => {
    expect(() => numberSetting('maxTokens', 'lots', 4096)).toThrow(/maxTokens/);
  });
});
