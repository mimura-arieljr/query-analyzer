import { describe, expect, it } from 'vitest';
import { hasTopLevelWhere, prepare, splitStatements } from '../src/index';

describe('prepare', () => {
  it('keeps tokens apart when a block comment sits between them', () => {
    expect(prepare('DELETE/**/FROM t').stripped).toBe('DELETE FROM t');
  });

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

describe('prepare hiding regressions', () => {
  it('ends a line comment at a lone CR', () => {
    expect(prepare('SELECT 1 -- c\rDELETE FROM t').stripped).toBe('SELECT 1 \rDELETE FROM t');
  });

  it('ends a line comment at CRLF', () => {
    expect(prepare('SELECT 1 -- c\r\nDELETE FROM t').stripped).toBe('SELECT 1 \r\nDELETE FROM t');
  });

  it('handles empty input', () => {
    expect(prepare('')).toEqual({ raw: '', noComments: '', stripped: '' });
  });

  it('keeps the body of a MySQL executable comment', () => {
    const p = prepare('SELECT 1 /*! DROP TABLE t */');
    expect(p.noComments).toContain('DROP TABLE t');
    expect(p.stripped).toContain('DROP TABLE t');
  });

  it('keeps version digits and still strips strings in an executable comment', () => {
    const p = prepare("/*!50000 DELETE FROM t WHERE a = 'x' */");
    expect(p.stripped).toContain('DELETE FROM t');
    expect(p.stripped).toContain("a = ''");
  });

  it('does not treat -- as a comment unless followed by whitespace or end', () => {
    expect(prepare('SELECT 1 --;DROP TABLE t\n').stripped).toContain('DROP TABLE t');
    expect(prepare('SELECT 1 -- ;DROP TABLE t\n').stripped).not.toContain('DROP');
    expect(prepare('SELECT 1 --').stripped).toBe('SELECT 1 ');
    expect(prepare('SELECT 1 --\tx').stripped).toBe('SELECT 1 ');
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

  it('ignores WHERE inside a dollar-quoted body', () => {
    expect(hasTopLevelWhere(prepare('UPDATE t SET note = $$ where $$').stripped)).toBe(false);
    expect(hasTopLevelWhere(prepare('UPDATE t SET note = $tag$ where $tag$').stripped)).toBe(false);
  });

  it('still finds a real WHERE after a dollar-quoted body', () => {
    expect(hasTopLevelWhere(prepare('UPDATE t SET note = $$ x $$ WHERE id = 1').stripped)).toBe(true);
  });
});
