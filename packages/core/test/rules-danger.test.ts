import { describe, expect, it } from 'vitest';
import { runRules } from '../src/index';

const ids = (q: string) => runRules(q).map((h) => h.id);

describe('danger rules', () => {
  it('flags DELETE FROM orders; as no-where, high', () => {
    const hits = runRules('DELETE FROM orders;');
    const hit = hits.find((h) => h.id === 'delete-update-no-where');
    expect(hit).toMatchObject({
      category: 'danger',
      level: 'high',
      certainty: 'certain',
      assumption: '',
      how_to_verify: '',
      changesData: true,
    });
    expect(hit?.reason).toMatch(/DELETE/);
    expect(hit?.matchesModel.test('This DELETE has no WHERE clause')).toBe(true);
    expect(ids('DELETE FROM orders;')).not.toContain('delete-update-with-where');
  });

  it('flags UPDATE with no WHERE', () => {
    const hit = runRules('UPDATE users SET active = false').find(
      (h) => h.id === 'delete-update-no-where',
    );
    expect(hit?.level).toBe('high');
    expect(hit?.reason).toMatch(/UPDATE/);
  });

  it('does not flag DELETE with a WHERE as no-where, gives delete-update-with-where medium', () => {
    const hits = runRules('DELETE FROM orders WHERE id = 5;');
    expect(hits.map((h) => h.id)).toEqual(['delete-update-with-where']);
    expect(hits[0]).toMatchObject({ level: 'medium', changesData: true, certainty: 'certain' });
  });

  it('flags OR 1=1, OR 1 = 1, or true, and OR \'a\'=\'a\' in an UPDATE as always-true-where', () => {
    const queries = [
      'UPDATE t SET a = 1 WHERE id = 2 OR 1=1',
      'UPDATE t SET a = 1 WHERE id = 2 OR 1 = 1',
      'UPDATE t SET a = 1 WHERE id = 2 OR  1  =  1',
      'UPDATE t SET a = 1 WHERE id = 2 or true',
      "UPDATE t SET a = 1 WHERE id = 2 OR 'a'='a'",
      'UPDATE t SET a = 1 WHERE id = 2 OR (1=1)',
      'Delete\nFrom orders\nWHERE id = 2\nOR\t1=1',
    ];
    for (const q of queries) {
      const hit = runRules(q).find((h) => h.id === 'always-true-where');
      expect(hit, q).toMatchObject({ level: 'high', changesData: true, certainty: 'certain' });
      expect(ids(q), q).not.toContain('delete-update-with-where');
    }
  });

  it('does not flag OR 1=2 or OR \'a\'=\'b\'', () => {
    for (const q of [
      'UPDATE t SET a = 1 WHERE id = 2 OR 1=2',
      "UPDATE t SET a = 1 WHERE id = 2 OR 'a'='b'",
      'UPDATE t SET a = 1 WHERE id = 2 OR 1=12',
      "UPDATE t SET a = 1 WHERE note = 'x OR 1=1'",
    ]) {
      expect(ids(q), q).not.toContain('always-true-where');
    }
  });

  it('does not flag OR 1=1 inside a SELECT', () => {
    expect(runRules('SELECT * FROM t WHERE id = 2 OR 1=1')).toEqual([]);
  });

  it('flags TRUNCATE, DROP TABLE IF EXISTS, ALTER TABLE t DROP COLUMN c', () => {
    for (const q of [
      'TRUNCATE TABLE logs',
      'drop table if exists users',
      'ALTER TABLE t DROP COLUMN c',
      'alter  table t\n drop\tcolumn c',
    ]) {
      const hit = runRules(q).find((h) => h.id === 'drop-truncate');
      expect(hit, q).toMatchObject({ level: 'high', changesData: true, certainty: 'certain' });
    }
    expect(ids('ALTER TABLE t ADD COLUMN c int')).toEqual([]);
  });

  it('flags a data-modifying CTE as changesData medium', () => {
    const hit = runRules(
      "WITH moved AS (DELETE FROM jobs WHERE status = 'done' RETURNING *) SELECT count(*) FROM moved;",
    ).find((h) => h.id === 'data-modifying-cte');
    expect(hit).toMatchObject({ level: 'medium', changesData: true, certainty: 'certain' });
  });

  it('flags a DELETE after a WITH clause as if it were a plain DELETE', () => {
    expect(ids('WITH x AS (SELECT id FROM t WHERE a = 1) DELETE FROM u')).toContain(
      'delete-update-no-where',
    );
    expect(ids('WITH x AS (SELECT id FROM t) DELETE FROM u WHERE id IN (SELECT id FROM x)')).toEqual(
      ['delete-update-with-where'],
    );
    expect(ids('WITH x AS (SELECT 1) SELECT * FROM x')).toEqual([]);
  });

  it('flags INSERT INTO, SELECT x INTO y, CREATE TABLE a AS SELECT', () => {
    for (const q of [
      'INSERT INTO t VALUES (1)',
      'insert ignore into t values (1)',
      'SELECT x INTO y FROM z',
      'CREATE TABLE a AS SELECT * FROM b',
      'create temp table if not exists a as\n(select 1)',
    ]) {
      const hit = runRules(q).find((h) => h.id === 'insert-select-into');
      expect(hit, q).toMatchObject({ level: 'low', changesData: true, certainty: 'certain' });
    }
    expect(ids('CREATE TABLE a (id int)')).toEqual([]);
  });

  it('flags GRANT and REVOKE high without changesData', () => {
    for (const q of ['GRANT ALL ON t TO bob', 'revoke select on t from bob']) {
      const hit = runRules(q).find((h) => h.id === 'grant-revoke');
      expect(hit, q).toMatchObject({ level: 'high', changesData: false, certainty: 'certain' });
    }
  });

  it('ignores keywords inside comments and strings', () => {
    expect(runRules("SELECT 'DELETE FROM t'; -- DROP TABLE x")).toEqual([]);
  });

  it('a WHERE in a comment does not hide a missing WHERE', () => {
    expect(ids('DELETE FROM t /* where x */;')).toContain('delete-update-no-where');
    expect(ids('DELETE FROM t -- where x\n')).toContain('delete-update-no-where');
  });

  it('a WHERE in the first statement does not hide the second', () => {
    const hits = runRules('DELETE FROM a WHERE id=1; DELETE FROM b;');
    expect(hits.map((h) => h.id)).toEqual(['delete-update-with-where', 'delete-update-no-where']);
  });

  it('emits one hit per statement for the same rule', () => {
    const hits = runRules('DELETE FROM a; DELETE FROM b;');
    expect(hits.filter((h) => h.id === 'delete-update-no-where')).toHaveLength(2);
  });

  it('a subquery WHERE does not hide a missing outer WHERE', () => {
    expect(ids('UPDATE t SET x = (SELECT max(y) FROM u WHERE u.id = 1)')).toContain(
      'delete-update-no-where',
    );
    expect(ids('DELETE FROM t USING (SELECT id FROM u WHERE a = 1) s')).toContain(
      'delete-update-no-where',
    );
  });

  it('keeps statements apart when a string contains a semicolon', () => {
    const hits = runRules("UPDATE t SET a = 'x;y' WHERE id = 1 OR 1=1; DELETE FROM u;");
    expect(hits.map((h) => h.id)).toEqual(['always-true-where', 'delete-update-no-where']);
    expect(ids("UPDATE t SET a = 'p;q' WHERE b = 'z' OR 'a'='a'; UPDATE u SET c = 1 WHERE d = 'a'")).toEqual([
      'always-true-where',
      'delete-update-with-where',
    ]);
  });

  it('a plain SELECT returns no hits', () => {
    expect(runRules('SELECT id, name FROM users WHERE id = 1')).toEqual([]);
    expect(runRules('')).toEqual([]);
  });
});

describe('danger rules: evasion attempts', () => {
  it('a comment between keywords does not hide the statement', () => {
    expect(ids('DELETE/**/FROM t')).toContain('delete-update-no-where');
    expect(ids('UPDATE/**/t SET a = 1')).toContain('delete-update-no-where');
    expect(ids('DROP/**/TABLE t')).toContain('drop-truncate');
    expect(ids('DELETE FROM t WHERE id = 1 OR/**/1=1')).toContain('always-true-where');
  });

  it('leading semicolons and MySQL conditional comments are still checked', () => {
    expect(ids(';;DELETE FROM t')).toContain('delete-update-no-where');
    expect(ids('/*! DELETE FROM t */')).toContain('delete-update-no-where');
    expect(ids('DELETE t1 FROM t1 JOIN t2 ON t1.id = t2.id')).toContain('delete-update-no-where');
  });
});
