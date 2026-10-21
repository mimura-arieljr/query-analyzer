import { describe, expect, it } from 'vitest';
import { SchemaError, validateAnalysis } from '../src/index';

const finding = {
  reason: 'Deletes every row because there is no WHERE clause.',
  certainty: 'certain',
  assumption: '',
  how_to_verify: '',
};

function validAnalysis() {
  return {
    is_query: true,
    not_a_query_message: '',
    query_type: { language: 'postgresql', dialect_note: '', confidence: 'high' },
    what_it_does: 'Reads orders.',
    detailed_explanation: 'Selects all columns from orders.',
    simple_explanation: 'Lists orders.',
    step_by_step: [{ snippet: 'SELECT *', explanation: 'Take every column.' }],
    improvements: ['Select only the columns you need.'],
    rewritten_query: { query: 'SELECT id FROM orders', reason: 'Fewer columns.' },
    security: { level: 'none', findings: [] },
    danger: {
      level: 'low',
      can_change_data: 'no',
      data_change_summary: '',
      findings: [finding],
    },
    performance: { level: 'medium', findings: [{ ...finding, certainty: 'possible' }] },
  };
}

describe('validateAnalysis', () => {
  it('accepts a full valid analysis', () => {
    const input = validAnalysis();
    expect(validateAnalysis(input)).toEqual(input);
  });

  it('rejects a missing required field', () => {
    const input: Record<string, unknown> = validAnalysis();
    delete input.what_it_does;
    expect(() => validateAnalysis(input)).toThrow(SchemaError);
  });

  it('rejects an unknown extra field', () => {
    const input = { ...validAnalysis(), surprise: 1 };
    expect(() => validateAnalysis(input)).toThrow(SchemaError);
  });

  it('rejects an invalid level value', () => {
    const input = validAnalysis();
    input.security.level = 'critical';
    expect(() => validateAnalysis(input)).toThrow(SchemaError);
  });

  it('accepts the is_query=false shape with empty strings, [] and "none"', () => {
    const input = {
      is_query: false,
      not_a_query_message: 'That looks like a recipe, not a query.',
      query_type: { language: 'unknown', dialect_note: '', confidence: 'low' },
      what_it_does: '',
      detailed_explanation: '',
      simple_explanation: '',
      step_by_step: [],
      improvements: [],
      rewritten_query: { query: '', reason: '' },
      security: { level: 'none', findings: [] },
      danger: { level: 'none', can_change_data: 'no', data_change_summary: '', findings: [] },
      performance: { level: 'none', findings: [] },
    };
    expect(validateAnalysis(input)).toEqual(input);
  });
});
