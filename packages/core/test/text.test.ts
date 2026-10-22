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

describe('prepare dialects', () => {
  it('mysql: # starts a line comment; postgresql: it does not', () => {
    expect(prepare('SELECT 1 # note\nFROM t').stripped).not.toContain('note');
    expect(prepare('SELECT a #> b FROM t', 'postgresql').stripped).toContain('#>');
  });

  it('postgresql: -- is always a comment; mysql keeps it without a space', () => {
    expect(prepare('SELECT 1 --x\nFROM t', 'postgresql').stripped).not.toContain('x');
    expect(prepare('SELECT 1 --x\nFROM t', 'mysql').stripped).toContain('--x');
  });

  it('mysql: a backslash escapes a quote; postgresql: it does not', () => {
    expect(prepare("SELECT 'a\\'' , 1").stripped).toBe("SELECT '' , 1");
    expect(prepare("SELECT 'a\\' , 1", 'postgresql').stripped).toBe("SELECT '' , 1");
  });

  it('postgresql: block comments nest; mysql: they do not', () => {
    expect(prepare('A /* x /* y */ z */ B', 'postgresql').stripped).toBe('A  B');
    expect(prepare('A /* x /* y */ z */ B', 'mysql').stripped).toContain('z');
  });

  it('mysql: /*!50000 ... */ drops the version digits and keeps the inner text', () => {
    expect(prepare('/*!50000DELETE FROM t*/').stripped.trim()).toBe('DELETE FROM t');
    expect(prepare('/*!50000 DELETE FROM t */').stripped.trim()).toBe('DELETE FROM t');
  });

  it('postgresql: /*! is an ordinary comment', () => {
    expect(prepare('A /*! B */ C', 'postgresql').stripped).toBe('A  C');
  });
});

describe('prepare E-strings', () => {
  it("postgresql: a backslash escapes only inside E'...'", () => {
    expect(prepare("SELECT E'\\'' , 1", 'postgresql').stripped).toBe("SELECT E'' , 1");
    expect(prepare("SELECT 'b\\' , 1", 'postgresql').stripped).toBe("SELECT '' , 1");
  });

  it('an E at the end of a longer word is not an E-string prefix', () => {
    expect(prepare("SELECT CASE WHEN a THEN 'x' ELSE'b\\' END", 'postgresql').stripped).toBe(
      "SELECT CASE WHEN a THEN '' ELSE'' END",
    );
  });
});
