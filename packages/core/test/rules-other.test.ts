import { describe, expect, it } from 'vitest';
import { isLogsInsights, runRules } from '../src/index';

const ids = (q: string) => runRules(q).map((h) => h.id);
const hitFor = (q: string, id: string) => runRules(q).find((h) => h.id === id);

const LOGS_QUERY =
  'fields @timestamp, @message | filter @message like /ERROR/ | stats count(*) by bin(5m) | sort @timestamp desc';

describe('string-built-sql', () => {
  it('flags "SELECT * FROM users WHERE name = \'" + userInput + "\'"', () => {
    const hit = hitFor(`"SELECT * FROM users WHERE name = '" + userInput + "'"`, 'string-built-sql');
    expect(hit).toMatchObject({
      category: 'security',
      level: 'high',
      certainty: 'certain',
      assumption: '',
      how_to_verify: '',
      changesData: false,
    });
    expect(hit?.reason).toMatch(/^This looks like SQL built from user input/);
    expect(hit?.matchesModel.test('This is open to SQL injection through string concatenation')).toBe(true);
  });

  it('flags a JS template string with ${id} in a SELECT', () => {
    expect(ids('`SELECT * FROM orders WHERE id = ${id}`')).toContain('string-built-sql');
  });

  it('flags "...%s..." % name', () => {
    expect(ids(`"SELECT * FROM users WHERE name = '%s'" % name`)).toContain('string-built-sql');
    expect(ids(`'DELETE FROM t WHERE id = %s' % row_id`)).toContain('string-built-sql');
  });

  it('flags a Python f-string with a placeholder', () => {
    expect(ids(`f"SELECT * FROM users WHERE name = '{name}'"`)).toContain('string-built-sql');
  });

  it('does not flag cursor.execute("SELECT 1 WHERE a = %s", (a,))', () => {
    expect(ids('cursor.execute("SELECT 1 WHERE a = %s", (a,))')).not.toContain('string-built-sql');
  });

  it('does not flag "+" in plain arithmetic like SELECT 1 + 2', () => {
    expect(ids('SELECT 1 + 2')).not.toContain('string-built-sql');
    expect(ids('SELECT price + tax FROM items')).not.toContain('string-built-sql');
  });

  it('does not flag a "+" inside a string or a normal parameterized query', () => {
    expect(ids("SELECT 'a+b'")).not.toContain('string-built-sql');
    expect(ids('SELECT * FROM users WHERE id = $1 AND name = ?')).not.toContain('string-built-sql');
    expect(ids("SELECT 'x' + 'y'")).not.toContain('string-built-sql');
  });

  it('needs a SQL keyword in the text', () => {
    expect(ids('"hello " + name + "!"')).not.toContain('string-built-sql');
  });
});

describe('hardcoded-password', () => {
  it("flags PASSWORD 'hunter2' and IDENTIFIED BY 'x'", () => {
    const pg = hitFor("CREATE ROLE app LOGIN PASSWORD 'hunter2'", 'hardcoded-password');
    expect(pg).toMatchObject({
      category: 'security',
      level: 'none',
      certainty: 'certain',
      changesData: false,
    });
    expect(pg?.matchesModel.test('The password is hard-coded in the statement')).toBe(true);
    expect(ids("CREATE USER 'app'@'%' IDENTIFIED BY 'x'")).toContain('hardcoded-password');
  });

  it('does not flag PASSWORD without a literal', () => {
    expect(ids('SELECT password FROM users WHERE id = 1')).not.toContain('hardcoded-password');
    expect(ids('CREATE ROLE app LOGIN PASSWORD NULL')).not.toContain('hardcoded-password');
    expect(ids('ALTER USER app IDENTIFIED BY ?')).not.toContain('hardcoded-password');
  });

  it('does not flag a password literal that is only in a comment', () => {
    expect(ids("SELECT 1 -- PASSWORD 'x'")).not.toContain('hardcoded-password');
  });
});

describe('leading-wildcard-like', () => {
  it("flags LIKE '%error%' and ILIKE '%x'", () => {
    const hit = hitFor("SELECT * FROM logs WHERE msg LIKE '%error%'", 'leading-wildcard-like');
    expect(hit).toMatchObject({
      category: 'performance',
      level: 'low',
      certainty: 'possible',
      assumption: 'The column has a standard B-tree index.',
      how_to_verify: 'Run EXPLAIN (without ANALYZE) and look for a sequential scan.',
      changesData: false,
    });
    expect(hit?.matchesModel.test("A leading wildcard in LIKE '%x' cannot use a B-tree index")).toBe(true);
    expect(ids("SELECT * FROM t WHERE a ILIKE '%x'")).toContain('leading-wildcard-like');
    expect(ids("SELECT * FROM t WHERE a NOT LIKE '%x'")).toContain('leading-wildcard-like');
  });

  it("does not flag LIKE 'abc%'", () => {
    expect(ids("SELECT * FROM t WHERE a LIKE 'abc%'")).not.toContain('leading-wildcard-like');
    expect(ids("SELECT * FROM t WHERE a LIKE 'a%b%'")).not.toContain('leading-wildcard-like');
  });

  it("does not flag a '%' that is not a LIKE pattern", () => {
    expect(ids("SELECT '%x' AS label FROM t")).not.toContain('leading-wildcard-like');
    expect(ids("SELECT * FROM t WHERE a = '%x'")).not.toContain('leading-wildcard-like');
  });
});

describe('order-by-random', () => {
  it('flags ORDER BY RAND() and random()', () => {
    const hit = hitFor('SELECT * FROM t ORDER BY RAND() LIMIT 1', 'order-by-random');
    expect(hit).toMatchObject({
      category: 'performance',
      level: 'low',
      certainty: 'possible',
      changesData: false,
    });
    expect(hit?.assumption).not.toBe('');
    expect(hit?.how_to_verify).not.toBe('');
    expect(hit?.matchesModel.test('ORDER BY RAND() sorts the whole table')).toBe(true);
    expect(ids('select * from t order by random() limit 5')).toContain('order-by-random');
    expect(ids('SELECT * FROM t ORDER BY created_at, RANDOM()')).toContain('order-by-random');
  });

  it('does not flag ORDER BY created_at or a column named random_id', () => {
    expect(ids('SELECT * FROM t ORDER BY created_at')).not.toContain('order-by-random');
    expect(ids('SELECT * FROM t ORDER BY random_id')).not.toContain('order-by-random');
    expect(ids('SELECT RAND() AS r FROM t ORDER BY id')).not.toContain('order-by-random');
  });
});

describe('logs insights', () => {
  it('isLogsInsights is true for fields/filter/stats/parse starts and false for SQL', () => {
    expect(isLogsInsights(LOGS_QUERY)).toBe(true);
    expect(isLogsInsights('filter @message like /x/')).toBe(true);
    expect(isLogsInsights('  STATS count(*) by bin(1h)')).toBe(true);
    expect(isLogsInsights('parse @message "user=*" as user')).toBe(true);
    expect(isLogsInsights('SELECT * FROM t')).toBe(false);
    expect(isLogsInsights('fields a | drop table x')).toBe(false);
    expect(isLogsInsights('fields a; DELETE FROM t')).toBe(false);
    expect(isLogsInsights('')).toBe(false);
  });

  it('a Logs Insights query yields only logs-insights-read-only', () => {
    const hits = runRules(LOGS_QUERY);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: 'logs-insights-read-only',
      category: 'danger',
      level: 'none',
      certainty: 'certain',
      changesData: false,
    });
  });

  it('SQL does not get logs-insights-read-only', () => {
    expect(ids('SELECT * FROM t')).not.toContain('logs-insights-read-only');
  });
});
