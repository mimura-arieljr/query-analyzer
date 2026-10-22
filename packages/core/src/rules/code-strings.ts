import { endOfDollarQuoted, prepare } from '../text';
import type { Dialect } from '../text';
import { runReading } from './reading';
import { DO_OPEN } from './statements';
import type { RuleHit } from './types';

interface Literal {
  body: string;
  start: number;
  end: number;
}

// Splits text at `;` outside quotes and collects every quoted body.
// - Backslash escapes in all three quote styles, as in most programming languages.
// - Dollar-quoted spans and `//` line comments are skipped whole.
function scanQuotes(text: string): { statements: string[]; literals: Literal[] } {
  const statements: string[] = [];
  const literals: Literal[] = [];
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const eol = text.indexOf('\n', i);
      i = eol === -1 ? text.length : eol;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const close = Math.min(j, text.length);
      literals.push({ body: text.slice(i + 1, close), start: i, end: close + 1 });
      i = close + 1;
    } else if (c === '$' && endOfDollarQuoted(text, i) !== -1) {
      i = endOfDollarQuoted(text, i);
    } else if (c === ';') {
      statements.push(text.slice(from, i));
      from = ++i;
    } else {
      i++;
    }
  }
  statements.push(text.slice(from));
  return { statements: statements.map((s) => s.trim()).filter((s) => s.length > 0), literals };
}

// A code string whose text starts like a SQL statement (a keyword, then more text).
const LITERAL_SQL = /^(?:SELECT|INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|GRANT|REVOKE|REPLACE|MERGE|WITH|CREATE|EXPLAIN|CALL)\s+\S/i;
// A pasted statement that is SQL, not code:
// - the keyword is followed by whitespace, so calls like `update(x)` do not count
// - SHOW, DESCRIBE, COPY and similar also count, since they are SQL-only words
// - WITH must open a CTE, so Python's `with conn.cursor() as cur:` does not count
const SQL_STATEMENT =
  /^(?:SELECT|INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|GRANT|REVOKE|REPLACE|MERGE|CREATE|EXPLAIN|CALL|SHOW|DESCRIBE|COPY|VALUES|LOCK|VACUUM|ANALYZE|COMMENT)(?:\s|$)/i;
// A Logs Insights query, even one holding SQL words, is not code.
const LOGS_COMMAND = /^(?:fields|filter|stats|parse)\s/i;
const CTE_START = /^WITH\s+(?:RECURSIVE\s+)?[\w"`$]+\s*(?:\([^()]*\)\s*)?AS\s*(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/i;
// Text between two string pieces that are joined: `+` or `.` with an optional value in between.
const JOIN_GAP = /^\s*(?:[+.]\s*(?:[^;"'`]*?[+.]\s*)?)?$/;
const DIRECT_GAP = /^\s*[+.]?\s*$/;

const isSqlStatement = (s: string) => {
  const t = s.replace(/^\(+\s*/, '');
  return SQL_STATEMENT.test(t) || CTE_START.test(t) || DO_OPEN.test(t);
};

// `\n`, `\r` and `\t` become spaces; other escapes become the escaped character.
const unescape = (s: string) => s.replace(/\\(.)/gs, (_m, ch: string) => ('nrt'.includes(ch) ? ' ' : ch));

// SQL found in code string literals.
// - Pieces joined by `+` or `.` are read as one text, with `?` for a value in between.
// - A run starts at the first piece that looks like SQL.
function codeSql(text: string): string[] {
  const { literals } = scanQuotes(text);
  const out: string[] = [];
  let run: string | null = null;
  literals.forEach((lit, k) => {
    const body = unescape(lit.body);
    const gap = k > 0 ? text.slice(literals[k - 1].end, lit.start) : '';
    if (run !== null && JOIN_GAP.test(gap)) {
      run += DIRECT_GAP.test(gap) ? body : `?${body}`;
      return;
    }
    if (run !== null) out.push(run);
    run = LITERAL_SQL.test(body.trim()) ? body : null;
  });
  if (run !== null) out.push(run);
  return out;
}

// Danger hits for SQL inside the code strings of `query`.
export function codeReading(query: string, dialect: Dialect): RuleHit[] {
  return codeSql(prepare(query, dialect).noComments).flatMap((sql) =>
    runReading(sql, dialect).filter((h) => h.category === 'danger'),
  );
}

// Code, not SQL: SQL is built from strings, or no statement starts like SQL.
export function looksLikeCode(query: string, hits: RuleHit[]): boolean {
  if (hits.some((h) => h.id === 'string-built-sql')) return true;
  const text = prepare(query, 'mysql').noComments;
  if (LOGS_COMMAND.test(text.trim())) return false;
  return !scanQuotes(text).statements.some(isSqlStatement);
}
