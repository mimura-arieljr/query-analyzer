import { describe, expect, it } from 'vitest';
import { runRules } from '../src/index';

const ids = (q: string) => runRules(q).map((h) => h.id);
const has = (q: string, id: string, level?: string) =>
  runRules(q).some((h) => h.id === id && (level === undefined || h.level === level));

describe('review findings 1 and 7: two dialect readings', () => {
  it('finding 1: -- without a space is a comment in PostgreSQL, so the WHERE is not real', () => {
    expect(has('DELETE FROM orders --where id = 5', 'delete-update-no-where', 'high')).toBe(true);
    expect(has('DELETE FROM orders --WHERE id = 5\n;', 'delete-update-no-where', 'high')).toBe(true);
  });

  it('finding 1: # is a line comment in MySQL', () => {
    expect(has('DELETE FROM orders # WHERE id = 5', 'delete-update-no-where', 'high')).toBe(true);
    expect(has('DELETE FROM orders #WHERE id = 5\n', 'delete-update-no-where', 'high')).toBe(true);
  });

  it('finding 1: a backslash-escaped quote does not hide the next statement (MySQL)', () => {
    const hits = runRules("SELECT 'a\\''; DELETE FROM t; -- '");
    expect(hits.some((h) => h.id === 'delete-update-no-where')).toBe(true);
  });

  it('finding 1: a backslash is not an escape in PostgreSQL', () => {
    expect(has("SELECT 'a\\'; DELETE FROM t; --'", 'delete-update-no-where')).toBe(true);
  });

  it('finding 7: MySQL version comments run their inner text', () => {
    expect(has('/*!50000 DELETE FROM t */', 'delete-update-no-where')).toBe(true);
    expect(has('/*!50000DELETE FROM t*/', 'delete-update-no-where')).toBe(true);
  });

  it('finding 7: PostgreSQL nested block comments do not leak a statement', () => {
    expect(has('/* a /* b */ c */ DELETE FROM t', 'delete-update-no-where')).toBe(true);
    expect(has('/* a /* b */ c */ UPDATE t SET x = 1; SELECT 1', 'delete-update-no-where')).toBe(true);
  });

  it('does not duplicate a hit that both readings produce', () => {
    expect(runRules('DELETE FROM orders;')).toHaveLength(1);
    expect(runRules('DELETE FROM a; DELETE FROM b;')).toHaveLength(2);
  });
});

describe('review finding 2: statement prefixes', () => {
  it('EXPLAIN ANALYZE runs the statement', () => {
    expect(has('EXPLAIN ANALYZE DELETE FROM t', 'delete-update-no-where', 'high')).toBe(true);
    expect(has('explain (analyze, buffers) DELETE FROM t', 'delete-update-no-where')).toBe(true);
    expect(has('EXPLAIN ANALYZE VERBOSE UPDATE t SET a = 1', 'delete-update-no-where')).toBe(true);
  });

  it('plain EXPLAIN does not execute and stays silent', () => {
    expect(runRules('EXPLAIN DELETE FROM t')).toEqual([]);
    expect(runRules('EXPLAIN (VERBOSE) DELETE FROM t')).toEqual([]);
    expect(runRules('EXPLAIN (ANALYZE false) DELETE FROM t')).toEqual([]);
  });

  it('PREPARE name AS statement is checked', () => {
    expect(has('PREPARE p AS DELETE FROM t', 'delete-update-no-where')).toBe(true);
    expect(has('PREPARE p (int, text) AS UPDATE t SET a = $1', 'delete-update-no-where')).toBe(true);
    expect(has('PREPARE p(numeric(10,2)) AS DELETE FROM t WHERE a = $1', 'delete-update-with-where')).toBe(true);
  });

  it('DO bodies are checked as statements', () => {
    expect(has('DO $$ BEGIN DELETE FROM t; END $$;', 'delete-update-no-where')).toBe(true);
    expect(has('DO $body$ DECLARE n int; BEGIN UPDATE t SET a = 1; END $body$', 'delete-update-no-where')).toBe(true);
    expect(has('DO $$ BEGIN IF true THEN DROP TABLE x; END IF; END $$', 'drop-truncate')).toBe(true);
    expect(has('DO LANGUAGE plpgsql $$ BEGIN DELETE FROM t WHERE a = 1; END $$', 'delete-update-with-where')).toBe(true);
    expect(runRules('DO $$ BEGIN PERFORM 1; END $$')).toEqual([]);
  });

  it('DELETE/UPDATE words that are not a statement stay silent', () => {
    expect(runRules('CREATE TABLE t (a int REFERENCES u ON DELETE CASCADE)')).toEqual([]);
  });
});

describe('review finding 3: data-modifying CTE bodies', () => {
  it('checks the body for a missing WHERE', () => {
    const q = 'WITH a AS (DELETE FROM jobs RETURNING *) SELECT * FROM a';
    expect(has(q, 'delete-update-no-where', 'high')).toBe(true);
    expect(has(q, 'data-modifying-cte', 'medium')).toBe(true);
  });

  it('checks the body for an always-true condition', () => {
    expect(has('WITH a AS (UPDATE t SET x = 1 WHERE y = 2 OR 1=1 RETURNING *) SELECT * FROM a', 'always-true-where')).toBe(true);
  });

  it('a CTE body with a WHERE adds no no-where hit, and does not hide the main statement', () => {
    expect(ids("WITH a AS (DELETE FROM jobs WHERE s = 'x' RETURNING *) SELECT 1")).toEqual(['data-modifying-cte']);
    expect(ids('WITH a AS (DELETE FROM x RETURNING *) DELETE FROM y WHERE id = 1')).toEqual([
      'data-modifying-cte',
      'delete-update-with-where',
      'delete-update-no-where',
    ]);
  });
});

describe('review finding 4: always-true forms', () => {
  it('catches OR(1=1), ||, double-quoted literals, OR 1 and OR 1 IS NOT NULL', () => {
    const flagged = [
      'DELETE FROM t WHERE id = 1 OR(1=1)',
      'DELETE FROM t WHERE id = 1 || 1=1',
      'DELETE FROM t WHERE id = 1 OR "a"="a"',
      'DELETE FROM t WHERE id = 1 OR 1',
      'DELETE FROM t WHERE id = 1 OR 1 IS NOT NULL',
      'UPDATE t SET a = 1 WHERE id = 1 OR 1.0 = 1.0',
      'DELETE FROM t WHERE id = 1 OR 01=01',
      'DELETE FROM t WHERE id = 1 OR NOT FALSE',
    ];
    for (const q of flagged) expect(has(q, 'always-true-where', 'high'), q).toBe(true);
  });

  it('catches a WHERE that is entirely a tautology, or a tautology then OR', () => {
    const flagged = [
      'DELETE FROM t WHERE 1=1',
      'DELETE FROM t WHERE 1 = 1;',
      'DELETE FROM t WHERE true',
      'DELETE FROM t WHERE 1',
      'DELETE FROM t WHERE (1=1)',
      'UPDATE t SET a = 1 WHERE 1=1 OR x = 5',
      'DELETE FROM t WHERE 1=1 RETURNING *',
    ];
    for (const q of flagged) {
      expect(has(q, 'always-true-where', 'high'), q).toBe(true);
      expect(ids(q), q).not.toContain('delete-update-with-where');
    }
  });

  it('stays silent for narrowing conditions', () => {
    const quiet = [
      'DELETE FROM t WHERE 1=1 AND x = 5',
      'DELETE FROM t WHERE true AND x = 5',
      'DELETE FROM t WHERE x = 5 OR 1=2',
      'DELETE FROM t WHERE x = 5 OR 1=12',
      'DELETE FROM t WHERE x = 5 OR 0',
      'DELETE FROM t WHERE x = 5 OR a = 1',
      'DELETE FROM t WHERE id = 1',
    ];
    for (const q of quiet) expect(ids(q), q).not.toContain('always-true-where');
  });
});

describe('review finding 5: ALTER ... DROP', () => {
  it('flags ALTER ... DROP of columns, partitions and bare names', () => {
    for (const q of [
      'ALTER TABLE t DROP c',
      'ALTER TABLE t DROP COLUMN c',
      'ALTER TABLE t DROP COLUMN IF EXISTS c',
      'ALTER TABLE t DROP PARTITION p0',
      'ALTER TABLE t TRUNCATE PARTITION p0',
      'ALTER TABLE t ADD d int, DROP c',
    ]) {
      expect(has(q, 'drop-truncate', 'high'), q).toBe(true);
    }
  });

  it('stays silent for constraint-like drops', () => {
    for (const q of [
      'ALTER TABLE t DROP CONSTRAINT x',
      'ALTER TABLE t DROP INDEX i',
      'ALTER TABLE t DROP KEY k',
      'ALTER TABLE t DROP PRIMARY KEY',
      'ALTER TABLE t DROP FOREIGN KEY f',
      'ALTER TABLE t DROP CHECK c',
      'ALTER TABLE t ALTER COLUMN c DROP DEFAULT',
      'ALTER TABLE t ALTER COLUMN c DROP NOT NULL',
    ]) {
      expect(ids(q), q).not.toContain('drop-truncate');
    }
  });
});

describe('review finding 6: REPLACE INTO and MERGE', () => {
  it('flags REPLACE INTO as replace-into medium', () => {
    const hit = runRules('REPLACE INTO t VALUES (1)').find((h) => h.id === 'replace-into');
    expect(hit).toMatchObject({
      category: 'danger',
      level: 'medium',
      certainty: 'certain',
      changesData: true,
      assumption: '',
      how_to_verify: '',
    });
    expect(hit?.matchesModel.test('REPLACE overwrites existing rows')).toBe(true);
  });

  it('flags MERGE INTO as merge medium', () => {
    const q = 'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE';
    const hit = runRules(q).find((h) => h.id === 'merge');
    expect(hit).toMatchObject({ level: 'medium', certainty: 'certain', changesData: true });
    expect(hit?.matchesModel.test('This MERGE can delete rows')).toBe(true);
  });
});

describe('review round 2, item 1: DO bodies are prepared before splitting', () => {
  it('a line comment in the body does not hide the statement', () => {
    expect(has('DO $$ BEGIN -- note\nDELETE FROM t; END $$', 'delete-update-no-where', 'high')).toBe(true);
  });

  it('a block comment in the body does not hide the statement', () => {
    expect(has('DO $$ BEGIN /* c */ DELETE FROM t; END $$', 'delete-update-no-where', 'high')).toBe(true);
  });

  it('a string in the body does not fake a WHERE', () => {
    expect(has("DO $$ BEGIN UPDATE t SET note = 'where'; END $$", 'delete-update-no-where', 'high')).toBe(true);
  });

  it('a WHERE inside a comment in the body does not count', () => {
    expect(has('DO $$ BEGIN DELETE FROM t -- WHERE id = 1\n; END $$', 'delete-update-no-where', 'high')).toBe(true);
  });

  it('statements after the body are still checked, and a body without writes is silent', () => {
    expect(ids('DO $$ BEGIN PERFORM 1; END $$; DELETE FROM u')).toEqual(['delete-update-no-where']);
    expect(runRules('DO $$ BEGIN -- DELETE FROM t\nPERFORM 1; END $$')).toEqual([]);
  });
});

describe('review round 2, item 2: PostgreSQL E-strings', () => {
  it("E'\\'' is one complete string in PostgreSQL", () => {
    expect(has("SELECT E'\\'', 'b\\'; DELETE FROM t; -- '", 'delete-update-no-where', 'high')).toBe(true);
    expect(has("SELECT length(E'\\'') # 1; DELETE FROM t; -- '", 'delete-update-no-where', 'high')).toBe(true);
  });

  it('simpler E-string forms are still caught', () => {
    expect(has("SELECT E'\\''; DELETE FROM t; -- '", 'delete-update-no-where', 'high')).toBe(true);
    expect(has("SELECT e'a\\'b'; DELETE FROM t", 'delete-update-no-where')).toBe(true);
  });
});

describe('review round 2, item 3: dollar-quoted spans in the WHERE scan', () => {
  it('a dollar-quoted WHERE word is not the clause', () => {
    for (const q of [
      'UPDATE t SET a = $$ where $$ WHERE 1=1',
      'UPDATE t SET a = $$where$$ WHERE 1=1',
      'UPDATE t SET a = $tag$ where $tag$ WHERE 1=1',
    ]) {
      expect(has(q, 'always-true-where', 'high'), q).toBe(true);
    }
  });

  it('a dollar-quoted WHERE is not a real one', () => {
    expect(has('UPDATE t SET a = $tag$ where $tag$', 'delete-update-no-where', 'high')).toBe(true);
    expect(ids('UPDATE t SET a = $$ where $$ WHERE id = 5')).toEqual(['delete-update-with-where']);
  });
});
