import Ajv from 'ajv/dist/2020';
import type { ModelAnalysis } from './types';

// Copied verbatim from the v1 prompt-and-schema draft (JSON schema section).
export const ANALYSIS_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "is_query", "not_a_query_message", "query_type", "what_it_does",
    "detailed_explanation", "simple_explanation", "step_by_step",
    "improvements", "rewritten_query", "security", "danger", "performance"
  ],
  "properties": {
    "is_query": { "type": "boolean" },
    "not_a_query_message": { "type": "string" },
    "query_type": {
      "type": "object",
      "additionalProperties": false,
      "required": ["language", "dialect_note", "confidence"],
      "properties": {
        "language": {
          "type": "string",
          "enum": ["postgresql", "mysql", "cloudwatch_logs_insights", "other", "unknown"]
        },
        "dialect_note": { "type": "string" },
        "confidence": { "type": "string", "enum": ["high", "medium", "low"] }
      }
    },
    "what_it_does": { "type": "string" },
    "detailed_explanation": { "type": "string" },
    "simple_explanation": { "type": "string" },
    "step_by_step": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["snippet", "explanation"],
        "properties": {
          "snippet": { "type": "string" },
          "explanation": { "type": "string" }
        }
      }
    },
    "improvements": { "type": "array", "items": { "type": "string" } },
    "rewritten_query": {
      "type": "object",
      "additionalProperties": false,
      "required": ["query", "reason"],
      "properties": {
        "query": { "type": "string" },
        "reason": { "type": "string" }
      }
    },
    "security": { "$ref": "#/$defs/category" },
    "danger": {
      "type": "object",
      "additionalProperties": false,
      "required": ["level", "can_change_data", "data_change_summary", "findings"],
      "properties": {
        "level": { "type": "string", "enum": ["none", "low", "medium", "high"] },
        "can_change_data": { "type": "string", "enum": ["yes", "no", "unclear"] },
        "data_change_summary": { "type": "string" },
        "findings": { "type": "array", "items": { "$ref": "#/$defs/finding" } }
      }
    },
    "performance": { "$ref": "#/$defs/category" }
  },
  "$defs": {
    "finding": {
      "type": "object",
      "additionalProperties": false,
      "required": ["reason", "certainty", "assumption", "how_to_verify"],
      "properties": {
        "reason": { "type": "string" },
        "certainty": { "type": "string", "enum": ["certain", "possible"] },
        "assumption": { "type": "string" },
        "how_to_verify": { "type": "string" }
      }
    },
    "category": {
      "type": "object",
      "additionalProperties": false,
      "required": ["level", "findings"],
      "properties": {
        "level": { "type": "string", "enum": ["none", "low", "medium", "high"] },
        "findings": { "type": "array", "items": { "$ref": "#/$defs/finding" } }
      }
    }
  }
} as const;

export class SchemaError extends Error {
  constructor(readonly details: string) {
    super(`Analysis failed schema validation: ${details}`);
    this.name = 'SchemaError';
  }
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(ANALYSIS_SCHEMA);

export function validateAnalysis(value: unknown): ModelAnalysis {
  if (!validate(value)) {
    throw new SchemaError(ajv.errorsText(validate.errors));
  }
  return value as ModelAnalysis;
}
