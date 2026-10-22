import { describe, expect, it } from 'vitest';
import { runRules } from '../src/index';

// A hit that would raise a data-change or danger warning.
const alarms = (q: string) =>
  runRules(q).filter((h) => h.changesData || (h.category === 'danger' && h.level !== 'none'));
const alarmIds = (q: string) => alarms(q).map((h) => h.id).sort();
const has = (q: string, id: string) => runRules(q).some((h) => h.id === id);

describe('code strings that only mention SQL words stay quiet', () => {
  it.each([
    'console.log("UPDATE the docs")',
    "print('Delete from cart clicked')",
    'alert("Delete from favourites?")',
    'throw new Error("Update failed: " + err)',
    'res.send("Drop table tennis club signups here")',
    'echo "drop the cache"',
    'label = "Grant access"',
    'git commit -m "update readme"',
    'logger.warn("Drop connection if idle")',
    'if (action === "update") { run() }',
    'if (method == "delete") {}',
    'const kinds = ["insert", "update", "delete", "drop", "grant"]',
    'toast("Truncate the summary to two lines.")',
    'flash("Update your profile to continue")',
    'console.log("Replace the logo in the header")',
    'console.log("Merge the two lists")',
    '{"msg": "Please update the table and delete from the list"}',
    'print("Revoke access for the user")',
    'Please "update the table" and "delete from the list"',
  ])('does not flag %s', (q) => {
    expect(alarms(q)).toEqual([]);
  });

  it('a real delete next to a log line raises only its own warning', () => {
    const q = 'await db.query("DELETE FROM users WHERE id = $1", [id]); console.log("Delete complete");';
    expect(alarmIds(q)).toEqual(['delete-update-with-where']);
  });

  it('a Python update function with a print raises only the real warning', () => {
    const q = [
      'def update_user(cur, uid, n):',
      '    cur.execute("UPDATE users SET name = %s WHERE id = %s", (n, uid))',
      '    print("Update done for user")',
    ].join('\n');
    expect(alarmIds(q)).toEqual(['delete-update-with-where']);
  });

  it('a read-only web view with a flash message stays quiet', () => {
    const q = '@app.route("/profile")\ndef profile():\n    flash("Update your profile to continue")\n    return render_template("profile.html")';
    expect(alarms(q)).toEqual([]);
  });
});

describe('short SQL forms need context before they count', () => {
  it.each([
    'print("Delete from cart")',
    'label = "Truncate text"',
    'alert("Delete from " + item + "?")',
    'toast("Delete from list")',
  ])('does not flag the plain-text use %s', (q) => {
    expect(alarms(q)).toEqual([]);
  });

  it.each([
    ['db.query("delete from cart")', 'delete-update-no-where'],
    ['sql = "delete from cart"', 'delete-update-no-where'],
    ['rows = await sql`delete from cart`', 'delete-update-no-where'],
    ['cur.execute("truncate audit_log")', 'drop-truncate'],
    ['db.exec("DELETE FROM " + table)', 'delete-update-no-where'],
  ])('flags the database use %s', (q, id) => {
    expect(has(q, id)).toBe(true);
  });
});

describe('Logs Insights queries with SQL words in their text stay quiet', () => {
  it.each([
    'sort @timestamp desc | filter @message like "Delete user"',
    'display @message | filter @message like "Update failed"',
    'SOURCE logGroups(namePrefix: ["/aws/app"]) | filter @message like "Drop connection"',
    'filter @message like "DELETE FROM orders"',
    'stats count(*) by bin(5m) | filter @message like "DROP TABLE x"',
    'limit 20 | filter @message like "TRUNCATE TABLE logs"',
  ])('does not flag %s', (q) => {
    expect(alarms(q)).toEqual([]);
  });
});

describe('code strings that really are SQL are still read', () => {
  it.each([
    ['sql = "DROP TABLE " + name', 'drop-truncate'],
    ['q = "DELETE FROM " + table + " WHERE id = " + id', 'delete-update-with-where'],
    ['cur.execute("TRUNCATE TABLE " + t)', 'drop-truncate'],
    ['cursor.execute("GRANT ALL ON db.* TO \'app\'")', 'grant-revoke'],
    ['cursor.execute("REVOKE ALL ON db.* FROM \'app\'")', 'grant-revoke'],
    ['db.exec("INSERT INTO log (msg) VALUES (1)")', 'insert-select-into'],
    ['db.exec("REPLACE INTO t VALUES (1)")', 'replace-into'],
    ['db.exec("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE")', 'merge'],
    ['db.exec("ALTER TABLE t DROP COLUMN c")', 'drop-truncate'],
    ['db.exec("CREATE TABLE t2 AS SELECT * FROM t")', 'insert-select-into'],
    ['db.exec("DELETE FROM `orders`")', 'delete-update-no-where'],
    ["db.exec('DELETE FROM \"orders\"')", 'delete-update-no-where'],
    ['db.exec("UPDATE ONLY accounts SET a = 1")', 'delete-update-no-where'],
    ['db.exec("UPDATE accounts SET a = 1")', 'delete-update-no-where'],
    ['db.exec("DROP TABLE IF EXISTS tmp_users")', 'drop-truncate'],
    ['db.exec("TRUNCATE audit_log")', 'drop-truncate'],
    ['db.exec("DELETE FROM orders WHERE id = 5")', 'delete-update-with-where'],
  ])('flags %s', (q, id) => {
    expect(has(q, id)).toBe(true);
  });
});
