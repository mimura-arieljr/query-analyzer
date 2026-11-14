import { describe, expect, it } from 'vitest';
import { dedent, formatLogsInsights, formatQuery, isLogsInsights } from '../src/format';

const words = (s: string) => s.replace(/\s+/g, '');

describe('formatQuery', () => {
  it('lays a one-line SQL query out clause by clause', () => {
    const out = formatQuery("select id, email from users where active = false and email like '%@x.internal' order by id");
    expect(out.split('\n')).toEqual([
      'select',
      '  id,',
      '  email',
      'from',
      '  users',
      'where',
      '  active = false',
      "  and email like '%@x.internal'",
      'order by',
      '  id',
    ]);
  });

  it('only ever moves whitespace: keyword case, strings and comments survive', () => {
    const q = "DELETE FROM `orders`\n\t\tWHERE note = 'two  spaces' -- keep me\n\t\tAND id IN (SELECT id FROM t)";
    const out = formatQuery(q);
    expect(words(out)).toBe(words(q));
    expect(out).toContain("'two  spaces'");
    expect(out).toContain('-- keep me');
    expect(out).toContain('DELETE FROM');
  });

  it('keeps function calls tight', () => {
    expect(formatQuery("select a from t where x > now() - interval '7 days'")).toContain('now() - interval');
  });

  it('reads PostgreSQL casts and RETURNING', () => {
    const q = 'update t set n = n::int + 1 where id = $1 returning id';
    expect(words(formatQuery(q))).toBe(words(q));
    expect(formatQuery(q)).toContain('returning');
  });

  it('keeps the layout, dedented, when the text cannot be parsed', () => {
    const q = '    not ) a ( query\n      at all';
    expect(formatQuery(q)).toBe('not ) a ( query\n  at all');
  });

  it('leaves blank text alone', () => {
    expect(formatQuery('   ')).toBe('   ');
  });
});

describe('Logs Insights', () => {
  it('is told apart from SQL', () => {
    expect(isLogsInsights('fields @timestamp | limit 5')).toBe(true);
    expect(isLogsInsights('filter @message like /x/')).toBe(true);
    expect(isLogsInsights('select * from logs')).toBe(false);
  });

  it('puts each command on its own line with the pipe leading', () => {
    const q = 'fields @timestamp, @message   |filter @message like /a|b/ |  stats count(*) by bin(5m)';
    expect(formatQuery(q)).toBe(
      ['fields @timestamp, @message', '| filter @message like /a|b/', '| stats count(*) by bin(5m)'].join('\n'),
    );
  });

  it('keeps pipes and spacing inside quotes', () => {
    expect(formatLogsInsights('filter msg = "a  |  b" | limit 5')).toBe('filter msg = "a  |  b"\n| limit 5');
  });

  it('only dedents when a # comment is present', () => {
    expect(formatLogsInsights('  fields a # note\n  | limit 5')).toBe('fields a # note\n| limit 5');
  });
});

describe('dedent', () => {
  it('removes the shared indent, turns tabs to spaces and trims blank edges', () => {
    expect(dedent('\n\tselect *\n\t  from t   \n\n')).toBe('select *\n  from t');
  });
});
