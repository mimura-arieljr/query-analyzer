import { describe, expect, it, vi } from 'vitest';
import { ANALYSIS_SCHEMA, type ModelAnalysis } from '@qa/core';
import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { AnalyzeError, analyzeWithBedrock, type BedrockConfig } from '../src/bedrock';
import { SYSTEM_PROMPT, wrapQuery } from '../src/prompt';

function analysis(): ModelAnalysis {
  return {
    is_query: true,
    not_a_query_message: '',
    query_type: { language: 'postgresql', dialect_note: '', confidence: 'high' },
    what_it_does: 'Reads one row.',
    detailed_explanation: 'Selects a constant.',
    simple_explanation: 'Returns the number one.',
    step_by_step: [{ snippet: 'SELECT 1', explanation: 'Returns 1.' }],
    improvements: [],
    rewritten_query: { query: '', reason: '' },
    security: { level: 'none', findings: [] },
    danger: { level: 'none', can_change_data: 'no', data_change_summary: 'Nothing changes.', findings: [] },
    performance: { level: 'none', findings: [] },
  };
}

function textReply(text: string, stopReason = 'end_turn'): ConverseCommandOutput {
  return {
    $metadata: {},
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason,
    usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
    metrics: { latencyMs: 1 },
  } as ConverseCommandOutput;
}

function toolReply(input: unknown, stopReason = 'tool_use'): ConverseCommandOutput {
  return {
    $metadata: {},
    output: {
      message: {
        role: 'assistant',
        content: [{ text: 'thinking' }, { toolUse: { toolUseId: 't1', name: 'report_analysis', input } }],
      },
    },
    stopReason,
    usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
    metrics: { latencyMs: 1 },
  } as ConverseCommandOutput;
}

function named(name: string, message = 'aws says something'): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

const cfg: BedrockConfig = {
  profileId: 'test-profile',
  maxTokens: 1234,
  outputMode: 'structured',
  timeoutMs: 5000,
};

function fake(...results: Array<ConverseCommandOutput | Error>) {
  const send = vi.fn();
  for (const r of results) {
    if (r instanceof Error) send.mockRejectedValueOnce(r);
    else send.mockResolvedValueOnce(r);
  }
  return { send };
}

// The command's input is what the SDK was asked to send.
function inputOf(send: ReturnType<typeof vi.fn>, call = 0) {
  return (send.mock.calls[call][0] as ConverseCommand).input;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AnalyzeError);
    return (e as AnalyzeError).code;
  }
  throw new Error('expected a rejection');
}

describe('analyzeWithBedrock', () => {
  it('structured mode sends the schema string and returns a validated analysis', async () => {
    const client = fake(textReply(JSON.stringify(analysis())));
    const out = await analyzeWithBedrock(client, cfg, 'SELECT 1');
    expect(out.analysis).toEqual(analysis());
    expect(out.mode).toBe('structured');
    const input = inputOf(client.send);
    expect(input.modelId).toBe('test-profile');
    expect(input.system).toEqual([{ text: SYSTEM_PROMPT }]);
    expect(input.messages).toEqual([{ role: 'user', content: [{ text: wrapQuery('SELECT 1') }] }]);
    expect(input.outputConfig).toEqual({
      textFormat: {
        type: 'json_schema',
        structure: { jsonSchema: { name: 'query_analysis', schema: JSON.stringify(ANALYSIS_SCHEMA) } },
      },
    });
    expect(client.send.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('sends maxTokens and no temperature by default', async () => {
    const client = fake(textReply(JSON.stringify(analysis())));
    await analyzeWithBedrock(client, cfg, 'SELECT 1');
    expect(inputOf(client.send).inferenceConfig).toEqual({ maxTokens: 1234 });
  });

  it('sends temperature when configured', async () => {
    const client = fake(textReply(JSON.stringify(analysis())));
    await analyzeWithBedrock(client, { ...cfg, temperature: 0 }, 'SELECT 1');
    expect(inputOf(client.send).inferenceConfig).toEqual({ maxTokens: 1234, temperature: 0 });
  });

  it('max_tokens stop reason throws bad_output', async () => {
    const client = fake(textReply(JSON.stringify(analysis()), 'max_tokens'));
    expect(await codeOf(analyzeWithBedrock(client, cfg, 'SELECT 1'))).toBe('bad_output');
  });

  it('valid JSON that breaks the schema throws bad_output', async () => {
    const client = fake(textReply(JSON.stringify({ ...analysis(), extra: true })));
    expect(await codeOf(analyzeWithBedrock(client, cfg, 'SELECT 1'))).toBe('bad_output');
  });

  it('empty content throws bad_output', async () => {
    const empty = {
      $metadata: {},
      output: { message: { role: 'assistant', content: [] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    } as unknown as ConverseCommandOutput;
    const client = fake(empty);
    expect(await codeOf(analyzeWithBedrock(client, cfg, 'SELECT 1'))).toBe('bad_output');
  });

  it('non-JSON text throws bad_output', async () => {
    const client = fake(textReply('Sorry, I cannot help with that.'));
    expect(await codeOf(analyzeWithBedrock(client, cfg, 'SELECT 1'))).toBe('bad_output');
  });

  it('ThrottlingException maps to throttled', async () => {
    const client = fake(named('ThrottlingException'));
    expect(await codeOf(analyzeWithBedrock(client, cfg, 'SELECT 1'))).toBe('throttled');
  });

  it('AccessDeniedException maps to failed', async () => {
    const client = fake(named('AccessDeniedException'));
    expect(await codeOf(analyzeWithBedrock(client, cfg, 'SELECT 1'))).toBe('failed');
  });

  it('maps timeouts, aborts and unknown errors to failed', async () => {
    for (const name of ['ModelTimeoutException', 'ServiceUnavailableException', 'InternalServerException', 'AbortError', 'TimeoutError', 'Weird']) {
      const client = fake(named(name));
      expect(await codeOf(analyzeWithBedrock(client, cfg, 'SELECT 1'))).toBe('failed');
    }
  });

  it('ValidationException in structured mode retries once in tool mode and succeeds', async () => {
    const client = fake(named('ValidationException'), toolReply(analysis()));
    const out = await analyzeWithBedrock(client, cfg, 'SELECT 1');
    expect(out.mode).toBe('tool');
    expect(out.analysis).toEqual(analysis());
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(inputOf(client.send, 0).outputConfig).toBeDefined();
    expect(inputOf(client.send, 1).outputConfig).toBeUndefined();
  });

  it('ValidationException in all modes throws failed', async () => {
    const client = fake(named('ValidationException'), named('ValidationException'), named('ValidationException'));
    expect(await codeOf(analyzeWithBedrock(client, cfg, 'SELECT 1'))).toBe('failed');
    expect(client.send).toHaveBeenCalledTimes(3);
  });

  it('starts at the configured mode and a ValidationException in json mode throws failed', async () => {
    const client = fake(named('ValidationException'));
    expect(await codeOf(analyzeWithBedrock(client, { ...cfg, outputMode: 'json' }, 'SELECT 1'))).toBe('failed');
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('does not retry on bad_output', async () => {
    const client = fake(textReply('not json'));
    expect(await codeOf(analyzeWithBedrock(client, cfg, 'SELECT 1'))).toBe('bad_output');
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('tool mode reads toolUse.input', async () => {
    const client = fake(toolReply(analysis()));
    const out = await analyzeWithBedrock(client, { ...cfg, outputMode: 'tool' }, 'SELECT 1');
    expect(out.analysis).toEqual(analysis());
    expect(out.mode).toBe('tool');
    expect(inputOf(client.send).toolConfig).toEqual({
      tools: [{ toolSpec: { name: 'report_analysis', description: expect.any(String), inputSchema: { json: ANALYSIS_SCHEMA } } }],
      toolChoice: { tool: { name: 'report_analysis' } },
    });
  });

  it('tool mode with the wrong stop reason throws bad_output', async () => {
    const client = fake(toolReply(analysis(), 'end_turn'));
    expect(await codeOf(analyzeWithBedrock(client, { ...cfg, outputMode: 'tool' }, 'SELECT 1'))).toBe('bad_output');
  });

  it('json mode strips a code fence', async () => {
    const fenced = '```json\n' + JSON.stringify(analysis()) + '\n```';
    const client = fake(textReply(fenced));
    const out = await analyzeWithBedrock(client, { ...cfg, outputMode: 'json' }, 'SELECT 1');
    expect(out.analysis).toEqual(analysis());
    expect(out.mode).toBe('json');
    const input = inputOf(client.send);
    expect(input.outputConfig).toBeUndefined();
    const system = (input.system as Array<{ text: string }>)[0].text;
    expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(system).toContain(JSON.stringify(ANALYSIS_SCHEMA));
  });

  it('returns token usage and latency', async () => {
    const client = fake(textReply(JSON.stringify(analysis())));
    const out = await analyzeWithBedrock(client, cfg, 'SELECT 1');
    expect(out.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(out.latencyMs)).toBe(true);
  });

  it('never puts the query, the model reply or the AWS message in the error detail', async () => {
    const secret = 'SECRET_TABLE_xyz';
    for (const result of [textReply(`nope ${secret}`), named('ThrottlingException', secret), named('Weird', secret)]) {
      const client = fake(result);
      try {
        await analyzeWithBedrock(client, cfg, `SELECT ${secret}`);
        throw new Error('expected a rejection');
      } catch (e) {
        expect(e).toBeInstanceOf(AnalyzeError);
        expect(String((e as AnalyzeError).detail ?? '')).not.toContain(secret);
        expect((e as AnalyzeError).message).not.toContain(secret);
      }
    }
  });
});
