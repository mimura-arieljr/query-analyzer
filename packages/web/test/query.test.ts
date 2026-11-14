import { describe, expect, it } from 'vitest';
import { findInOrder, lineRanges, tokenize, wordRanges } from '../src/query';

const slice = (text: string, r: [number, number] | null) => (r ? text.slice(r[0], r[1]) : null);

describe('tokenize', () => {
  it('covers the text exactly once and sorts out keywords, strings, numbers and comments', () => {
    const q = "SELECT id, 'a''b' FROM t -- note\nWHERE n > 10";
    const tokens = tokenize(q);
    expect(tokens.map((t) => q.slice(t.start, t.end)).join('')).toBe(q);
    const kindOf = (text: string) => tokens.find((t) => q.slice(t.start, t.end) === text)?.kind;
    expect(kindOf('SELECT')).toBe('keyword');
    expect(kindOf('WHERE')).toBe('keyword');
    expect(kindOf('id')).toBe('word');
    expect(kindOf("'a''b'")).toBe('string');
    expect(kindOf('10')).toBe('number');
    expect(kindOf('-- note')).toBe('comment');
  });

  it('reads Logs Insights commands and @fields', () => {
    const q = 'fields @timestamp | filter @message like /error/ | stats count(*) by bin(5m)';
    const kinds = new Map(tokenize(q).map((t) => [q.slice(t.start, t.end), t.kind]));
    expect(kinds.get('fields')).toBe('keyword');
    expect(kinds.get('stats')).toBe('keyword');
    expect(kinds.get('@timestamp')).toBe('word');
  });

  it('keeps an unclosed string or comment to the end', () => {
    expect(tokenize("select 'oops").at(-1)?.kind).toBe('string');
    expect(tokenize('select 1 /* open').at(-1)?.kind).toBe('comment');
  });
});

describe('scan units', () => {
  it('steps through words, strings and numbers, skipping punctuation', () => {
    const q = "where a = 'x' and b > 2;";
    expect(wordRanges(q).map((r) => slice(q, r))).toEqual(['where', 'a', "'x'", 'and', 'b', '2']);
  });

  it('steps through non-empty lines without their indent', () => {
    const q = 'select *\n\n  from t\n';
    expect(lineRanges(q).map((r) => slice(q, r))).toEqual(['select *', 'from t']);
  });
});

describe('findInOrder', () => {
  const q = 'SELECT a\nFROM t\nWHERE a = 1\n  AND a = 1';

  it('finds snippets ignoring case and reflowed whitespace', () => {
    const [r] = findInOrder(q, ['from   T where']);
    expect(slice(q, r)).toBe('FROM t\nWHERE');
  });

  it('matches repeated snippets in order', () => {
    const rs = findInOrder(q, ['a = 1', 'a = 1']);
    expect(rs[0]![0]).toBeLessThan(rs[1]![0]);
  });

  it('falls back to the top, and returns null for a miss or an empty snippet', () => {
    const rs = findInOrder(q, ['WHERE', 'SELECT', 'LIMIT', '  ']);
    expect(slice(q, rs[1])).toBe('SELECT');
    expect(rs[2]).toBeNull();
    expect(rs[3]).toBeNull();
  });

  it('treats regex characters in a snippet literally', () => {
    const text = 'select count(*) from t';
    expect(slice(text, findInOrder(text, ['count(*)'])[0])).toBe('count(*)');
  });
});
