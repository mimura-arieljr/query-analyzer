import { describe, expect, it } from 'vitest';
import { finalize } from '../src/index';
import type { Finding, ModelAnalysis } from '../src/index';

function baseAnalysis(): ModelAnalysis {
  return {
    is_query: true,
    not_a_query_message: '',
    query_type: { language: 'postgresql', dialect_note: '', confidence: 'high' },
    what_it_does: 'Does something.',
    detailed_explanation: 'Details.',
    simple_explanation: 'Simple.',
    step_by_step: [{ snippet: 'SELECT 1', explanation: 'Selects one.' }],
    improvements: [],
    rewritten_query: { query: '', reason: '' },
    security: { level: 'none', findings: [] },
    danger: { level: 'none', can_change_data: 'no', data_change_summary: '', findings: [] },
    performance: { level: 'none', findings: [] },
  };
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  reason: 'Something to know.',
  certainty: 'certain',
  assumption: '',
  how_to_verify: '',
  ...over,
});

const LOGS_QUERY =
  'fields @timestamp, @message | filter @message like /ERROR/ | stats count(*) by bin(5m) | sort @timestamp desc';
const STRING_BUILT = `"SELECT * FROM users WHERE name = '" + userInput + "'"`;
const CTE_DELETE = 'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d';

describe('finalize: merge', () => {
  it('DELETE FROM orders; with model danger none becomes high, yes, with a rule finding', () => {
    const out = finalize('DELETE FROM orders;', baseAnalysis());
    expect(out.danger.level).toBe('high');
    expect(out.danger.can_change_data).toBe('yes');
    expect(out.danger.data_change_summary).toMatch(/no WHERE clause/);
    expect(out.danger.findings).toHaveLength(1);
    expect(out.danger.findings[0]).toMatchObject({
      source: 'rule',
      ruleId: 'delete-update-no-where',
      certainty: 'certain',
    });
  });

  it('never lowers a model level', () => {
    const model = baseAnalysis();
    model.danger = { level: 'high', can_change_data: 'yes', data_change_summary: 'Deletes a row.', findings: [finding()] };
    const out = finalize('DELETE FROM orders WHERE id = 1', model);
    expect(out.danger.level).toBe('high');
    expect(out.danger.data_change_summary).toBe('Deletes a row.');
  });

  it('data-modifying CTE: model says no/none, result is yes/medium', () => {
    const out = finalize('WITH d AS (DELETE FROM orders WHERE id = 1 RETURNING *) SELECT * FROM d', baseAnalysis());
    expect(out.danger.can_change_data).toBe('yes');
    expect(out.danger.level).toBe('medium');
  });

  it('uses the highest-level data-changing rule for the summary when the model said no', () => {
    const model = baseAnalysis();
    model.danger.data_change_summary = 'Only reads.';
    const out = finalize(CTE_DELETE, model);
    expect(out.danger.level).toBe('high');
    expect(out.danger.can_change_data).toBe('yes');
    expect(out.danger.data_change_summary).toMatch(/no WHERE clause/);
    // Both the medium and the high rule findings are kept.
    expect(out.danger.findings.map((f) => f.ruleId).sort()).toEqual(['data-modifying-cte', 'delete-update-no-where']);
  });

  it('drops a duplicate model finding when a rule matches it', () => {
    const model = baseAnalysis();
    model.danger.findings = [finding({ reason: 'This deletes every row because there is no WHERE clause.' })];
    const out = finalize('DELETE FROM orders', model);
    expect(out.danger.findings).toHaveLength(1);
    expect(out.danger.findings[0].source).toBe('rule');
  });

  it('does not drop a matching model finding that sits in another category', () => {
    const model = baseAnalysis();
    model.security.findings = [finding({ reason: 'This deletes every row because there is no WHERE clause.' })];
    const out = finalize('DELETE FROM orders', model);
    expect(out.security.findings).toHaveLength(1);
    expect(out.security.findings[0].source).toBe('ai');
    expect(out.danger.findings).toHaveLength(1);
  });

  it('keeps an unrelated model finding', () => {
    const model = baseAnalysis();
    model.danger.findings = [finding({ reason: 'The orders table may be referenced by other tables.' })];
    const out = finalize('DELETE FROM orders', model);
    expect(out.danger.findings).toHaveLength(2);
    expect(out.danger.findings[0]).toMatchObject({ source: 'ai' });
    expect(out.danger.findings[1]).toMatchObject({ source: 'rule' });
  });
});

describe('finalize: certainty fields', () => {
  it('blanks assumption and how_to_verify on certain findings', () => {
    const model = baseAnalysis();
    model.security.findings = [finding({ assumption: 'Guess.', how_to_verify: 'Check.' })];
    model.security.level = 'low';
    const out = finalize('DELETE FROM orders', model);
    expect(out.security.findings[0]).toMatchObject({ assumption: '', how_to_verify: '' });
    expect(out.danger.findings[0]).toMatchObject({ assumption: '', how_to_verify: '' });
  });

  it('keeps them on possible findings', () => {
    const model = baseAnalysis();
    model.performance.findings = [finding({ certainty: 'possible', assumption: 'Big table.', how_to_verify: 'Run EXPLAIN.' })];
    model.performance.level = 'low';
    const out = finalize("SELECT * FROM logs WHERE msg LIKE '%error%'", model);
    expect(out.performance.findings).toHaveLength(2);
    for (const f of out.performance.findings) {
      expect(f.certainty).toBe('possible');
      expect(f.assumption).not.toBe('');
      expect(f.how_to_verify).not.toBe('');
    }
    expect(out.performance.findings[1]).toMatchObject({ source: 'rule', ruleId: 'leading-wildcard-like' });
  });
});

describe('finalize: rewrite guard', () => {
  const withRewrite = (query: string, reason = 'Because.'): ModelAnalysis => ({
    ...baseAnalysis(),
    rewritten_query: { query, reason },
  });

  it('drops a rewrite equal to the input', () => {
    const out = finalize('SELECT * FROM orders', withRewrite('  SELECT * FROM orders  '));
    expect(out.rewritten_query).toEqual({ query: '', reason: '' });
  });

  it('drops an empty rewrite', () => {
    const out = finalize('SELECT * FROM orders', withRewrite('   ', 'Because.'));
    expect(out.rewritten_query).toEqual({ query: '', reason: '' });
  });

  it('drops a rewrite with an empty reason', () => {
    const out = finalize('SELECT * FROM orders', withRewrite('SELECT id FROM orders', ''));
    expect(out.rewritten_query).toEqual({ query: '', reason: '' });
  });

  it('drops a rewrite that removed a WHERE from a DELETE', () => {
    const out = finalize('DELETE FROM orders WHERE id = 1', withRewrite('DELETE FROM orders'));
    expect(out.rewritten_query).toEqual({ query: '', reason: '' });
  });

  it('drops a rewrite whose own rule floor is higher than the original', () => {
    const out = finalize('SELECT * FROM orders', withRewrite('DROP TABLE orders'));
    expect(out.rewritten_query).toEqual({ query: '', reason: '' });
  });

  it('drops any rewrite on an UPDATE', () => {
    const out = finalize('UPDATE orders SET paid = true WHERE id = 1', withRewrite('UPDATE orders SET paid = TRUE WHERE id = 1 AND paid = FALSE'));
    expect(out.rewritten_query).toEqual({ query: '', reason: '' });
  });

  it('drops a rewrite when the model says the statement may change data', () => {
    const model = withRewrite('SELECT id FROM orders');
    model.danger.can_change_data = 'unclear';
    const out = finalize('SELECT * FROM orders', model);
    expect(out.rewritten_query).toEqual({ query: '', reason: '' });
  });

  it('keeps a parameterized rewrite of string-built SQL', () => {
    const model = withRewrite('SELECT * FROM users WHERE name = $1', 'Uses a parameter.');
    model.danger.can_change_data = 'unclear';
    const out = finalize(STRING_BUILT, model);
    expect(out.rewritten_query).toEqual({ query: 'SELECT * FROM users WHERE name = $1', reason: 'Uses a parameter.' });
  });

  it('drops a rewrite of string-built SQL that is still string-built', () => {
    const model = withRewrite(`"SELECT id FROM users WHERE name = '" + name + "'"`);
    model.danger.can_change_data = 'unclear';
    const out = finalize(STRING_BUILT, model);
    expect(out.rewritten_query).toEqual({ query: '', reason: '' });
  });

  it('keeps a rewrite on a plain SELECT', () => {
    const out = finalize('SELECT * FROM orders', withRewrite('SELECT id FROM orders', 'Fewer columns.'));
    expect(out.rewritten_query).toEqual({ query: 'SELECT id FROM orders', reason: 'Fewer columns.' });
  });
});

describe('finalize: rewrite guard for string-built SQL', () => {
  const rewriteOf = (original: string, rewrite: string, change: 'yes' | 'no' = 'yes') => {
    const model = baseAnalysis();
    model.danger.can_change_data = change;
    model.rewritten_query = { query: rewrite, reason: 'Uses a parameter.' };
    return finalize(original, model).rewritten_query;
  };
  const KEPT = (rewrite: string) => ({ query: rewrite, reason: 'Uses a parameter.' });
  const CLEARED = { query: '', reason: '' };

  const UPDATE_Q = `"UPDATE users SET name = '" + n + "' WHERE id = 1"`;
  const UPDATE_BARE = `UPDATE users SET name = '" + n + "' WHERE id = 1`;
  const UPDATE_P = 'UPDATE users SET name = $1 WHERE id = 1';

  it('keeps a parameterized rewrite of a quoted string-built UPDATE', () => {
    expect(rewriteOf(UPDATE_Q, UPDATE_P)).toEqual(KEPT(UPDATE_P));
  });

  it('keeps a parameterized rewrite of a string-built DELETE', () => {
    const rewrite = 'DELETE FROM users WHERE id = $1';
    expect(rewriteOf(`"DELETE FROM users WHERE id = " + id`, rewrite)).toEqual(KEPT(rewrite));
  });

  it('keeps a parameterized rewrite of a template-literal UPDATE', () => {
    expect(rewriteOf('`UPDATE users SET name = \'${n}\' WHERE id = 1`', UPDATE_P)).toEqual(KEPT(UPDATE_P));
  });

  it('keeps a parameterized rewrite of a Python %-formatted UPDATE', () => {
    expect(rewriteOf(`"UPDATE users SET name = '%s' WHERE id = 1" % name`, 'UPDATE users SET name = %s WHERE id = 1')).toEqual(
      KEPT('UPDATE users SET name = %s WHERE id = 1'),
    );
  });

  it('keeps a parameterized rewrite wrapped in a db.query call', () => {
    const original = `db.query("UPDATE users SET name = '" + n + "' WHERE id = 1")`;
    const rewrite = 'db.query("UPDATE users SET name = $1 WHERE id = 1", [n])';
    expect(rewriteOf(original, rewrite)).toEqual(KEPT(rewrite));
  });

  it('keeps a parameterized rewrite of a SELECT the model said does not change data', () => {
    const rewrite = 'SELECT * FROM users WHERE name = $1';
    expect(rewriteOf(STRING_BUILT, rewrite, 'no')).toEqual(KEPT(rewrite));
  });

  it('drops a rewrite that swaps a string-built UPDATE for a DELETE', () => {
    expect(rewriteOf(UPDATE_BARE, 'DELETE FROM users WHERE id = $1')).toEqual(CLEARED);
  });

  it('drops a rewrite that updates a different table', () => {
    expect(rewriteOf(UPDATE_BARE, 'UPDATE accounts SET balance = 0 WHERE id = $1')).toEqual(CLEARED);
  });

  it('drops a rewrite that widens the WHERE of a string-built UPDATE', () => {
    expect(rewriteOf(UPDATE_BARE, 'UPDATE users SET name = $1 WHERE id > 0')).toEqual(CLEARED);
  });

  it('drops a rewrite that adds SQL injection to a parameterized query', () => {
    const original = 'SELECT * FROM users WHERE name = $1';
    expect(rewriteOf(original, `"SELECT * FROM users WHERE name = '" + name + "'"`, 'no')).toEqual(CLEARED);
  });
});

describe('finalize: logs insights, levels and pass-through', () => {
  it('Logs Insights query is forced to danger none even if the model said high', () => {
    const model = baseAnalysis();
    model.danger = { level: 'high', can_change_data: 'yes', data_change_summary: 'Deletes things.', findings: [finding()] };
    const out = finalize(LOGS_QUERY, model);
    expect(out.danger).toEqual({
      level: 'none',
      can_change_data: 'no',
      data_change_summary: 'CloudWatch Logs Insights queries only read data.',
      findings: [],
    });
  });

  it('raises level none to low when a finding exists', () => {
    const model = baseAnalysis();
    model.security.findings = [finding({ reason: 'Looks odd.' })];
    const out = finalize('SELECT 1', model);
    expect(out.security.level).toBe('low');
    const pw = finalize("CREATE ROLE app PASSWORD 'secret'", baseAnalysis());
    expect(pw.security.level).toBe('low');
    expect(pw.security.findings[0]).toMatchObject({ source: 'rule', ruleId: 'hardcoded-password' });
  });

  it('keeps level medium with no findings', () => {
    const model = baseAnalysis();
    model.performance.level = 'medium';
    const out = finalize('SELECT 1', model);
    expect(out.performance).toEqual({ level: 'medium', findings: [] });
  });

  it('non-query passes through', () => {
    const model = baseAnalysis();
    model.is_query = false;
    model.not_a_query_message = 'This is a recipe.';
    model.rewritten_query = { query: 'x', reason: 'y' };
    model.danger = { level: 'low', can_change_data: 'unclear', data_change_summary: 's', findings: [finding({ assumption: 'kept' })] };
    const out = finalize('DELETE FROM orders', model);
    expect(out).toEqual({
      ...model,
      danger: { ...model.danger, findings: [{ ...model.danger.findings[0], source: 'ai' }] },
      security: { level: 'none', findings: [] },
      performance: { level: 'none', findings: [] },
    });
  });

  it('does not mutate the input model', () => {
    const model = baseAnalysis();
    model.danger.findings = [finding({ reason: 'This deletes every row because there is no WHERE clause.', assumption: 'x' })];
    model.rewritten_query = { query: 'DELETE FROM orders WHERE id = 1', reason: 'Safer.' };
    const before = JSON.stringify(model);
    finalize('DELETE FROM orders', model);
    expect(JSON.stringify(model)).toBe(before);
  });
});
