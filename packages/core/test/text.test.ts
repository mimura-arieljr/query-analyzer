import { describe, expect, it } from 'vitest';
import { hasTopLevelWhere, prepare, splitStatements } from '../src/index';

describe('prepare', () => {
  it('removes line and block comments', () => {
    const p = prepare('SELECT 1 -- trailing\n/* block\nspan */ FROM t');
    expect(p.raw).toContain('trailing');
    expect(p.noComments).not.toContain('trailing');
    expect(p.noComments).not.toContain('block');
    expect(p.noComments).toContain('SELECT 1');
    expect(p.noComments).toContain('FROM t');
  });

  it('replaces string literals with empty quotes', () => {
    const p = prepare("SELECT 'a; DELETE FROM t' AS x");
    expect(p.noComments).toContain("'a; DELETE FROM t'");
    expect(p.stripped).toBe("SELECT '' AS x");
  });

  it('handles doubled quotes inside a string', () => {
    const p = prepare("SELECT 'it''s; DROP TABLE t' , 'b'");
    expect(p.stripped).toBe("SELECT '' , ''");
  });

  it('keeps a keyword that only appears in a comment out of stripped', () => {
    const p = prepare('SELECT 1 -- DROP TABLE t\n/* DELETE FROM t */');
    expect(p.stripped).not.toMatch(/DROP|DELETE/);
  });

  it('leaves an unterminated string untouched', () => {
    const p = prepare("SELECT 'oops; DELETE FROM t");
    expect(p.stripped).toBe("SELECT 'oops; DELETE FROM t");
    expect(p.noComments).toBe("SELECT 'oops; DELETE FROM t");
  });

  it('leaves an unterminated block comment untouched', () => {
    const p = prepare('SELECT 1 /* oops; DELETE FROM t');
    expect(p.noComments).toBe('SELECT 1 /* oops; DELETE FROM t');
  });

  it('does not treat comment markers inside strings as comments', () => {
    const p = prepare("SELECT '-- not', '/* not */' FROM t");
    expect(p.noComments).toBe("SELECT '-- not', '/* not */' FROM t");
    expect(p.stripped).toBe("SELECT '', '' FROM t");
  });

  it('does not treat quotes inside comments as strings', () => {
    const p = prepare("SELECT 1 -- it's\nFROM t /* ' */ WHERE a = 'x'");
    expect(p.stripped).toBe('SELECT 1 \nFROM t  WHERE a = \'\'');
  });

  it('does not misread markers or quotes inside quoted identifiers', () => {
    const p = prepare('SELECT "a--b", "it\'s" FROM t -- c');
    expect(p.stripped).toBe('SELECT "a--b", "it\'s" FROM t ');
  });

  it('does not strip dollar-quoted bodies', () => {
    const p = prepare('DO $$ BEGIN DELETE FROM t; END $$');
    expect(p.stripped).toContain('DELETE FROM t');
  });
});

describe('splitStatements', () => {
  it('splits statements and drops empties', () => {
    expect(splitStatements(' SELECT 1 ;; UPDATE t SET a = 1 ; ')).toEqual([
      'SELECT 1',
      'UPDATE t SET a = 1',
    ]);
  });
});

describe('hasTopLevelWhere', () => {
  it('hasTopLevelWhere is false when WHERE is only inside a subquery', () => {
    expect(hasTopLevelWhere('UPDATE t SET a = (SELECT max(b) FROM u WHERE u.id = 1)')).toBe(false);
  });

  it('hasTopLevelWhere is true for a plain WHERE', () => {
    expect(hasTopLevelWhere('DELETE FROM t WHERE id = 1')).toBe(true);
    expect(hasTopLevelWhere('delete from t\nwhere id = 1')).toBe(true);
  });

  it('does not match WHERE as part of another word', () => {
    expect(hasTopLevelWhere('SELECT somewhere, where_x FROM t')).toBe(false);
  });
});
