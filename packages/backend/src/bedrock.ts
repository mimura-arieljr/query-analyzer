import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ToolInputSchema,
} from '@aws-sdk/client-bedrock-runtime';
import { ANALYSIS_SCHEMA, SchemaError, validateAnalysis, type ErrorCode, type ModelAnalysis } from '@qa/core';
import { SYSTEM_PROMPT, wrapQuery } from './prompt';

export type OutputMode = 'structured' | 'tool' | 'json';

export interface BedrockConfig {
  profileId: string;
  maxTokens: number;
  temperature?: number;
  outputMode: OutputMode;
  timeoutMs: number;
}

// detail holds an error name or a fixed reason, never query text or model output.
export class AnalyzeError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AnalyzeError';
  }
}

export interface BedrockSender {
  send: (cmd: ConverseCommand, opts?: { abortSignal?: AbortSignal }) => Promise<ConverseCommandOutput>;
}

export interface AnalyzeResult {
  analysis: ModelAnalysis;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  mode: OutputMode;
}

const MODES: readonly OutputMode[] = ['structured', 'tool', 'json'];
const TOOL_NAME = 'report_analysis';
const JSON_INSTRUCTION = `Reply with only a JSON object that matches this JSON schema, with no other text: ${JSON.stringify(ANALYSIS_SCHEMA)}`;

export function createBedrockClient(region: string): BedrockRuntimeClient {
  return new BedrockRuntimeClient({ region, maxAttempts: 5, retryMode: 'adaptive' });
}

function buildInput(cfg: BedrockConfig, query: string, mode: OutputMode): ConverseCommandInput {
  const system = mode === 'json' ? `${SYSTEM_PROMPT}\n\n${JSON_INSTRUCTION}` : SYSTEM_PROMPT;
  const input: ConverseCommandInput = {
    modelId: cfg.profileId,
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: wrapQuery(query) }] }],
    inferenceConfig: {
      maxTokens: cfg.maxTokens,
      ...(cfg.temperature !== undefined && { temperature: cfg.temperature }),
    },
  };
  if (mode === 'structured') {
    input.outputConfig = {
      textFormat: {
        type: 'json_schema',
        structure: { jsonSchema: { name: 'query_analysis', schema: JSON.stringify(ANALYSIS_SCHEMA) } },
      },
    };
  } else if (mode === 'tool') {
    input.toolConfig = {
      tools: [
        {
          toolSpec: {
            name: TOOL_NAME,
            description: 'Report the analysis of the pasted query.',
            inputSchema: { json: ANALYSIS_SCHEMA as unknown as ToolInputSchema.JsonMember['json'] },
          },
        },
      ],
      toolChoice: { tool: { name: TOOL_NAME } },
    };
  }
  return input;
}

function stripFence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i.exec(text);
  return m ? m[1] : text;
}

function extract(res: ConverseCommandOutput, mode: OutputMode): ModelAnalysis {
  const expectedStop = mode === 'tool' ? 'tool_use' : 'end_turn';
  if (res.stopReason !== expectedStop) throw new AnalyzeError('bad_output', 'unexpected stop reason');
  const blocks = res.output?.message?.content ?? [];
  let value: unknown;
  if (mode === 'tool') {
    const block = blocks.find((b) => b.toolUse !== undefined);
    if (!block?.toolUse) throw new AnalyzeError('bad_output', 'no tool use');
    value = block.toolUse.input;
  } else {
    const block = blocks.find((b) => typeof b.text === 'string');
    if (block?.text === undefined) throw new AnalyzeError('bad_output', 'no text');
    try {
      value = JSON.parse(mode === 'json' ? stripFence(block.text) : block.text);
    } catch {
      throw new AnalyzeError('bad_output', 'unparsable JSON');
    }
  }
  try {
    return validateAnalysis(value);
  } catch (e) {
    if (e instanceof SchemaError) throw new AnalyzeError('bad_output', 'schema validation failed');
    throw e;
  }
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'UnknownError';
}

function toAnalyzeError(e: unknown): AnalyzeError {
  if (e instanceof AnalyzeError) return e;
  const name = errorName(e);
  return new AnalyzeError(name === 'ThrottlingException' ? 'throttled' : 'failed', name);
}

export async function analyzeWithBedrock(
  client: BedrockSender,
  cfg: BedrockConfig,
  query: string,
): Promise<AnalyzeResult> {
  for (let i = MODES.indexOf(cfg.outputMode); i < MODES.length; i++) {
    const mode = MODES[i];
    const started = Date.now();
    try {
      const res = await client.send(new ConverseCommand(buildInput(cfg, query, mode)), {
        abortSignal: AbortSignal.timeout(cfg.timeoutMs),
      });
      const analysis = extract(res, mode);
      return {
        analysis,
        usage: { inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 },
        latencyMs: Date.now() - started,
        mode,
      };
    } catch (e) {
      // Only a Bedrock ValidationException moves to the next mode.
      if (!(e instanceof AnalyzeError) && errorName(e) === 'ValidationException' && i < MODES.length - 1) continue;
      throw toAnalyzeError(e);
    }
  }
  throw new AnalyzeError('failed', 'no output mode');
}
