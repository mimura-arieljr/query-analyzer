import { endOfDollarQuoted, hasTopLevelWhere, isEscapeString, prepare, splitStatements } from './text';
import type { Dialect, PreparedSql } from './text';
import type { Category, Certainty, Level } from './types';

export type RuleId =
  | 'delete-update-no-where'
  | 'always-true-where'
  | 'drop-truncate'
  | 'data-modifying-cte'
  | 'delete-update-with-where'
  | 'insert-select-into'
  | 'grant-revoke'
  | 'replace-into'
  | 'merge'
  | 'string-built-sql'
  | 'hardcoded-password'
  | 'leading-wildcard-like'
  | 'order-by-random'
  | 'logs-insights-read-only';

export interface RuleHit {
  id: RuleId;
  category: Category;
  level: Level;
  reason: string;
  certainty: Certainty;
  assumption: string;
  how_to_verify: string;
  changesData: boolean;
  matchesModel: RegExp;
}

// One statement as seen by the rules.
interface Stmt {
  // Comments removed, strings blanked to ''.
  stripped: string;
  // Comments removed, strings intact.
  noComments: string;
  // First statement keyword, upper case; looks past a WITH clause.
  kind: string;
}

type RuleFn = (stmt: Stmt, hitsSoFar: RuleHit[]) => RuleHit[];

type Spec = Omit<RuleHit, 'certainty' | 'assumption' | 'how_to_verify' | 'category'>;

interface Extra {
  category: Category;
  certainty: Certainty;
  assumption: string;
  how_to_verify: string;
}

function hit(spec: Spec, extra: Extra): RuleHit {
  return { ...spec, ...extra };
}

function certain(spec: Spec, category: Category = 'danger'): RuleHit {
  return hit(spec, { category, certainty: 'certain', assumption: '', how_to_verify: '' });
}

function possible(spec: Spec, category: Category, assumption: string, how_to_verify: string): RuleHit {
  return hit(spec, { category, certainty: 'possible', assumption, how_to_verify });
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

// Splits `noComments` at the same semicolons splitStatements() uses on `stripped`.
// - Only single-quoted strings hide a `;` here, because only they are blanked there.
// - Quoted identifiers and dollar-quoted spans are walked so a quote inside them is ignored.
function splitNoComments(text: string, dialect: Dialect): string[] {
  const backslash = dialect === 'mysql';
  const parts: string[] = [];
  let cur = '';
  let i = 0;
  // Index past the closing quote, or -1 if unterminated.
  const quoteEnd = (open: number, escapes: boolean): number => {
    const q = text[open];
    let j = open + 1;
    while (j < text.length) {
      if (escapes && text[j] === '\\') {
        j += 2;
        continue;
      }
      if (text[j] === q) {
        if (text[j + 1] === q) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return -1;
  };
  while (i < text.length) {
    const c = text[i];
    let end = -1;
    let hides = false;
    if (c === "'") {
      end = quoteEnd(i, backslash || isEscapeString(text, i));
      hides = true;
      if (end === -1) end = text.length;
    } else if (c === '"') {
      end = quoteEnd(i, backslash);
    } else if (c === '`') {
      end = quoteEnd(i, false);
    } else if (c === '$' && !(i > 0 && IDENT_CHAR.test(text[i - 1]))) {
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 64))?.[0];
      if (tag) {
        const at = text.indexOf(tag, i + tag.length);
        end = at === -1 ? -1 : at + tag.length;
      }
    }
    if (end === -1) end = i + 1;
    for (let k = i; k < end; k++) {
      if (text[k] === ';' && !hides) {
        parts.push(cur);
        cur = '';
      } else {
        cur += text[k];
      }
    }
    i = end;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

interface Word {
  text: string;
  start: number;
  end: number;
}

// Words at parenthesis depth 0, in order, upper-cased.
function topLevelWords(statement: string): Word[] {
  const words: Word[] = [];
  let depth = 0;
  let i = 0;
  while (i < statement.length) {
    const c = statement[i];
    if (c === '"' || c === '`') {
      const close = statement.indexOf(c, i + 1);
      i = close === -1 ? i + 1 : close + 1;
    } else if (c === '$' && endOfDollarQuoted(statement, i) !== -1) {
      i = endOfDollarQuoted(statement, i);
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (IDENT_CHAR.test(c)) {
      let j = i;
      while (j < statement.length && IDENT_CHAR.test(statement[j])) j++;
      if (depth === 0) words.push({ text: statement.slice(i, j).toUpperCase(), start: i, end: j });
      i = j;
    } else {
      i++;
    }
  }
  return words;
}

// `WITH x AS (...) DELETE FROM t` is a DELETE, so look past the WITH clause.
function kindOf(statement: string): string {
  const words = topLevelWords(statement).map((w) => w.text);
  const first = words[0] ?? '';
  if (first !== 'WITH') return first;
  const main = words.find((w) => ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(w));
  return main ?? first;
}

// Text after the top-level WHERE, or null when there is none.
function whereClause(statement: string): string | null {
  const w = topLevelWords(statement).find((x) => x.text === 'WHERE');
  return w ? statement.slice(w.end) : null;
}

// OR, or `||` which MySQL reads as OR.
const OR_OP = String.raw`(?:\bOR\b|\|\|)`;
// A bare value or comparison that is true for every row (one capture group, for the backreference).
const TERM = String.raw`(?:$|\bOR\b|\|\||\bRETURNING\b|\bORDER\b|\bLIMIT\b|\bGROUP\b)`;
const BARE_END = String.raw`(?=\s*\)*\s*${TERM})`;
const TAUTOLOGY = String.raw`(?:TRUE\b|(\d+(?:\.\d+)?)\s*=\s*\1(?![\d.])|NOT\s+FALSE\b|\d+\s+IS\s+NOT\s+NULL\b|[1-9]\d*(?:\.\d+)?${BARE_END})`;
// `... OR <always true>` anywhere in the statement.
const OR_TRUE = new RegExp(String.raw`${OR_OP}\s*\(*\s*${TAUTOLOGY}`, 'i');
// A WHERE clause that is only a tautology, or a tautology followed by OR.
const WHERE_TRUE = new RegExp(String.raw`^\s*\(*\s*${TAUTOLOGY}\s*\)*\s*${TERM}`, 'i');
// `OR 'x' = 'x'` or `OR "x" = "x"` (same literal), checked where the literals are still visible.
const OR_SAME_LITERAL = new RegExp(
  String.raw`${OR_OP}\s*\(*\s*(?:'((?:[^']|'')*)'\s*=\s*'\1'|"((?:[^"]|"")*)"\s*=\s*"\2")`,
  'i',
);

const isWrite = (s: Stmt) => s.kind === 'DELETE' || s.kind === 'UPDATE';

const noWhere: RuleFn = (s) =>
  isWrite(s) && !hasTopLevelWhere(s.stripped)
    ? [
        certain({
          id: 'delete-update-no-where',
          level: 'high',
          reason: `This ${s.kind} statement has no WHERE clause, so it changes every row in the table.`,
          changesData: true,
          matchesModel:
            /\b(no|without|missing|lacks?)\b[^.]*\bWHERE\b|\ball (the )?(rows|records)\b|\bevery row\b|\bentire table\b/i,
        }),
      ]
    : [];

const alwaysTrue: RuleFn = (s) =>
  isWrite(s) &&
  (OR_TRUE.test(s.stripped) ||
    OR_SAME_LITERAL.test(s.noComments) ||
    WHERE_TRUE.test(whereClause(s.stripped) ?? '\u0000'))
    ? [
        certain({
          id: 'always-true-where',
          level: 'high',
          reason: `This ${s.kind} statement has a condition that is always true, so its WHERE clause does not limit the rows.`,
          changesData: true,
          matchesModel:
            /always[- ]true|tautolog|\bOR\s+\(*\s*(1\s*=\s*1|true)\b|(matches|affects|changes) (all|every) rows?/i,
        }),
      ]
    : [];

// After DROP in an ALTER, these words name a constraint-like object, not data.
const ALTER_DROPS_DATA =
  /\bDROP\s+(?!(?:CONSTRAINT|INDEX|KEY|PRIMARY|FOREIGN|CHECK|DEFAULT|NOT)\b)[\w"`]|\bTRUNCATE\s+PARTITION\b/i;

const dropTruncate: RuleFn = (s) => {
  const alterDrop = s.kind === 'ALTER' && ALTER_DROPS_DATA.test(s.stripped);
  if (s.kind !== 'DROP' && s.kind !== 'TRUNCATE' && !alterDrop) return [];
  return [
    certain({
      id: 'drop-truncate',
      level: 'high',
      reason: alterDrop
        ? 'This ALTER statement drops a column, partition or other object and the data in it.'
        : `This ${s.kind} statement permanently removes ${s.kind === 'DROP' ? 'a database object and its data' : 'all rows from a table'}.`,
      changesData: true,
      matchesModel:
        /\b(drop|dropp\w*|truncat\w*|irreversibl\w*|permanently|destroy\w*|cannot be undone|removes? (the )?(table|column|all))\b/i,
    }),
  ];
};

const dataModifyingCte: RuleFn = (s) =>
  /^WITH\b/i.test(s.stripped) &&
  /\(\s*(?:DELETE|UPDATE|INSERT)\b/i.test(s.stripped)
    ? [
        certain({
          id: 'data-modifying-cte',
          level: 'medium',
          reason: 'This WITH statement contains a DELETE, UPDATE or INSERT inside a CTE, so it changes data.',
          changesData: true,
          matchesModel: /data[- ]modifying|\b(CTE|WITH)\b[^.]*\b(delet|updat|insert|modif|writes?|chang)\w*/i,
        }),
      ]
    : [];

const withWhere: RuleFn = (s, hits) =>
  isWrite(s) &&
  hasTopLevelWhere(s.stripped) &&
  !hits.some((h) => h.id === 'delete-update-no-where' || h.id === 'always-true-where')
    ? [
        certain({
          id: 'delete-update-with-where',
          level: 'medium',
          reason: `This ${s.kind} statement changes data in the rows its WHERE clause matches.`,
          changesData: true,
          matchesModel: /\b(delet|updat|modif|overwrit|chang|remov)\w*\b[^.]*\b(rows?|records?|data)\b/i,
        }),
      ]
    : [];

const insertSelectInto: RuleFn = (s) => {
  const insert = s.kind === 'INSERT';
  const selectInto = s.kind === 'SELECT' && /\bINTO\b/i.test(s.stripped);
  const ctas =
    s.kind === 'CREATE' &&
    /^CREATE\s+(?:(?:GLOBAL|LOCAL|TEMP|TEMPORARY|UNLOGGED|OR\s+REPLACE)\s+)*TABLE\b[\s\S]*?\bAS\s*\(*\s*(?:SELECT|WITH|TABLE|VALUES)\b/i.test(
      s.stripped,
    );
  if (!insert && !selectInto && !ctas) return [];
  return [
    certain({
      id: 'insert-select-into',
      level: 'low',
      reason: insert
        ? 'This INSERT statement adds rows to a table.'
        : selectInto
          ? 'This SELECT ... INTO statement writes its result into another table or file.'
          : 'This CREATE TABLE ... AS statement creates a new table filled from a query.',
      changesData: true,
      matchesModel:
        /\b(inserts?|inserting|adds? (new )?rows|writes? (rows|data)|creates? (a )?(new )?table|SELECT\s+INTO|copies)\b/i,
    }),
  ];
};

const grantRevoke: RuleFn = (s) =>
  s.kind === 'GRANT' || s.kind === 'REVOKE'
    ? [
        certain({
          id: 'grant-revoke',
          level: 'high',
          reason: `This ${s.kind} statement changes who is allowed to access the database.`,
          changesData: false,
          matchesModel: /\b(grant\w*|revok\w*|privileges?|permissions?)\b/i,
        }),
      ]
    : [];

const replaceInto: RuleFn = (s) =>
  s.kind === 'REPLACE'
    ? [
        certain({
          id: 'replace-into',
          level: 'medium',
          reason: 'This REPLACE statement deletes any existing row with the same key and inserts a new one.',
          changesData: true,
          matchesModel: /\bREPLACE\b|overwrit\w*\s+(existing|rows?)|(deletes?|removes?)\b[^.]*\b(existing|same key)/i,
        }),
      ]
    : [];

const merge: RuleFn = (s) =>
  s.kind === 'MERGE'
    ? [
        certain({
          id: 'merge',
          level: 'medium',
          reason: 'This MERGE statement inserts, updates or deletes rows depending on whether they match.',
          changesData: true,
          matchesModel: /\bMERGE\b|\bupsert\b|\bWHEN\s+(NOT\s+)?MATCHED\b/i,
        }),
      ]
    : [];

// Bodies of `(DELETE ...)` and `(UPDATE ...)` inside a WITH clause.
function cteWriteBodies(statement: string): string[] {
  const bodies: string[] = [];
  const open = /\(\s*(?=(?:DELETE|UPDATE)\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = open.exec(statement))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < statement.length && depth > 0) {
      if (statement[i] === '(') depth++;
      else if (statement[i] === ')') depth--;
      i++;
    }
    bodies.push(statement.slice(start, depth === 0 ? i - 1 : i));
  }
  return bodies;
}

// A data-modifying CTE is checked like the DELETE/UPDATE it contains.
const cteBodies: RuleFn = (s) =>
  /^WITH\b/i.test(s.stripped)
    ? cteWriteBodies(s.stripped).flatMap((body) => {
        const inner: Stmt = { stripped: body, noComments: s.noComments, kind: kindOf(body) };
        return [...noWhere(inner, []), ...alwaysTrue(inner, [])];
      })
    : [];

const SQL_WORD = /\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM|DROP|TRUNCATE|ALTER|GRANT)\b/i;
const IDENT_START = String.raw`[A-Za-z_$]`;
const IDENT_TAIL = String.raw`[\w$.\])]*`;
// Ways SQL text gets joined to a value:
// - a quote next to `+` and an identifier ("..." + name + "...")
// - `${...}` in a template string
// - an f-string with a `{name}` placeholder
// - "...%s..." % value (a bare %s with a parameter tuple is not matched)
const CONCAT_AFTER_QUOTE = new RegExp(String.raw`["'\`]\s*\+\s*${IDENT_START}`);
const CONCAT_BEFORE_QUOTE = new RegExp(String.raw`(?<![\w$.])${IDENT_START}${IDENT_TAIL}\s*\+\s*["'\`]`);
const TEMPLATE_HOLE = /\$\{[^}]+\}/;
const F_STRING = /(?<![\w$])[fF](["'])(?:(?!\1)[^\n])*\{\s*[A-Za-z_]/;
const PERCENT_FORMAT = /%(?:\(\w+\))?s[^%]{0,200}?["']\s*%\s*[A-Za-z_([{]/;

const stringBuiltSql: RuleFn = (s) => {
  const t = s.noComments;
  const joined =
    CONCAT_AFTER_QUOTE.test(t) ||
    CONCAT_BEFORE_QUOTE.test(t) ||
    TEMPLATE_HOLE.test(t) ||
    F_STRING.test(t) ||
    PERCENT_FORMAT.test(t);
  return joined && SQL_WORD.test(t)
    ? [
        certain(
          {
            id: 'string-built-sql',
            level: 'high',
            reason:
              'This looks like SQL built from user input by joining strings together, which can allow SQL injection.',
            changesData: false,
            matchesModel: /inject|concatenat|string[- ]built|built (from|with|by) (user|string)|user input/i,
          },
          'security',
        ),
      ]
    : [];
};

// PASSWORD 'x' (PostgreSQL), IDENTIFIED [WITH plugin] BY 'x', SET PASSWORD [FOR u] = 'x' (MySQL).
const PASSWORD_LITERAL =
  /(?<![\w$.])(?:PASSWORD\s+['"]|IDENTIFIED\s+(?:WITH\s+\w+\s+)?BY\s+['"]|SET\s+PASSWORD\s+(?:FOR\s+\S+\s*)?=\s*['"])/i;

const hardcodedPassword: RuleFn = (s) =>
  PASSWORD_LITERAL.test(s.noComments)
    ? [
        certain(
          {
            id: 'hardcoded-password',
            level: 'none',
            reason: 'This statement has a password written directly in the SQL text.',
            changesData: false,
            matchesModel: /hard-?coded.*(password|credential)|(password|credential)s?\b.*\b(hard-?coded|plain ?text|in the (query|sql|statement))/i,
          },
          'security',
        ),
      ]
    : [];

const LEADING_WILDCARD = /\bI?LIKE\s+(?:BINARY\s+)?(?:[EN]\s*)?['"]%|\bI?LIKE\s+CONCAT\s*\(\s*['"]%/i;

const leadingWildcardLike: RuleFn = (s) =>
  LEADING_WILDCARD.test(s.noComments)
    ? [
        possible(
          {
            id: 'leading-wildcard-like',
            level: 'low',
            reason: 'This LIKE pattern starts with %, so the database usually cannot use an index and has to scan every row.',
            changesData: false,
            matchesModel: /leading wildcard|LIKE\s*'%|B-?tree/i,
          },
          'performance',
          'The column has a standard B-tree index.',
          'Run EXPLAIN (without ANALYZE) and look for a sequential scan.',
        ),
      ]
    : [];

// RAND( or RANDOM( inside an ORDER BY, not crossing into another clause.
const ORDER_BY_RANDOM =
  /\bORDER\s+BY\b(?:(?!\b(?:FROM|WHERE|SELECT|GROUP|HAVING|LIMIT|OFFSET|UNION)\b)[^;])*?\b(?:RAND|RANDOM)\s*\(/i;

const orderByRandom: RuleFn = (s) =>
  ORDER_BY_RANDOM.test(s.stripped)
    ? [
        possible(
          {
            id: 'order-by-random',
            level: 'low',
            reason: 'ORDER BY a random value makes the database compute and sort a random number for every row.',
            changesData: false,
            matchesModel: /RAND\(|RANDOM\(|ORDER BY RAND/i,
          },
          'performance',
          'The table has many rows, so sorting all of them is costly.',
          'Run EXPLAIN (without ANALYZE) and look for a sort over the whole table.',
        ),
      ]
    : [];

const LOGS_START = /^(?:fields|filter|stats|parse)\b/i;
const LOGS_FORBIDDEN =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|FROM|TRUNCATE|GRANT|REVOKE|CREATE|ALTER|REPLACE|MERGE|CALL)\b/i;

// CloudWatch Logs Insights: starts with a Logs command and holds none of the SQL words.
export function isLogsInsights(query: string): boolean {
  const text = prepare(query, 'mysql').stripped.trim();
  return LOGS_START.test(text) && !LOGS_FORBIDDEN.test(text);
}

const logsInsightsHit = (): RuleHit =>
  certain({
    id: 'logs-insights-read-only',
    level: 'none',
    reason: 'This is a CloudWatch Logs Insights query, which can only read log data.',
    changesData: false,
    matchesModel: /read[- ]only|only (reads?|queries|searches)|cannot (change|modify|delete)|does not (change|modify)/i,
  });

// Order matters: withWhere reads the hits earlier rules made for the statement,
// so cteBodies runs after it.
const RULES: RuleFn[] = [
  noWhere,
  alwaysTrue,
  dropTruncate,
  dataModifyingCte,
  withWhere,
  cteBodies,
  insertSelectInto,
  grantRevoke,
  replaceInto,
  merge,
  stringBuiltSql,
  hardcodedPassword,
  leadingWildcardLike,
  orderByRandom,
];

const BALANCED = String.raw`(?:\((?:[^()]|\([^()]*\))*\))`;
const EXPLAIN_PAREN = new RegExp(String.raw`^EXPLAIN\s*\(((?:[^()]|\([^()]*\))*)\)\s*`, 'i');
const EXPLAIN_PLAIN = /^EXPLAIN\s+(?:(?:ANALY[SZ]E|VERBOSE|FORMAT\s*=\s*\w+)\b\s*)+/i;
const ANALYZE_ON = /\bANALY[SZ]E\b(?!\s*(?:FALSE|OFF|0)\b)/i;
const PREPARE = new RegExp(String.raw`^PREPARE\s+[\w$"]+\s*${BALANCED}?\s*AS\s+`, 'i');

// Drops a leading `EXPLAIN ANALYZE` or `PREPARE name AS`, which still run the statement.
// Plain EXPLAIN does not execute, so it is left alone.
function peelPrefixes(text: string): string {
  let cur = text;
  for (;;) {
    let next = cur;
    const paren = EXPLAIN_PAREN.exec(cur);
    if (paren) {
      if (ANALYZE_ON.test(paren[1])) next = cur.slice(paren[0].length);
    } else {
      const plain = EXPLAIN_PLAIN.exec(cur);
      if (plain && ANALYZE_ON.test(plain[0])) next = cur.slice(plain[0].length);
    }
    next = next.replace(PREPARE, '');
    if (next === cur) return cur;
    cur = next;
  }
}

const DO_OPEN = /^DO\b(?:\s+LANGUAGE\s+\w+)?\s*(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/i;
const PLPGSQL_WORD = /^\s*(?:BEGIN|ELSE|LOOP|EXCEPTION|DECLARE|END|THEN)\b/i;
const PLPGSQL_COND = /^\s*(?:IF|ELSIF|ELSEIF|WHEN|FOR|WHILE|FOREACH|CASE)\b[\s\S]*?\b(?:THEN|LOOP)\b/i;

// Drops block keywords in front of a statement inside a DO body.
function peelPlpgsql(text: string): string {
  let cur = text;
  for (;;) {
    const next = cur.replace(PLPGSQL_WORD, '').replace(PLPGSQL_COND, '');
    if (next === cur) return cur.trim();
    cur = next;
  }
}

function statementsOf(p: PreparedSql, dialect: Dialect): Stmt[] {
  const pieces = splitStatements(p.stripped);
  const plain = splitNoComments(p.noComments, dialect);
  const aligned = plain.length === pieces.length;
  const out: Stmt[] = [];
  // On a split mismatch use the whole text: a spurious warning beats a missed one.
  const push = (text: string, noComments: string) => {
    const t = peelPrefixes(text);
    out.push({ stripped: t, noComments, kind: kindOf(t) });
  };
  for (let i = 0; i < pieces.length; i++) {
    const open = DO_OPEN.exec(pieces[i]);
    if (!open) {
      push(pieces[i], aligned ? plain[i] : p.noComments);
      continue;
    }
    // A DO body was split at its own `;`: join it back, then read it as SQL text of its own.
    const tag = open[1];
    const parts = [pieces[i].slice(open[0].length)];
    while (!parts[parts.length - 1].includes(tag) && i + 1 < pieces.length) parts.push(pieces[++i]);
    const joined = parts.join(';');
    const closeAt = joined.indexOf(tag);
    const body = prepare(closeAt === -1 ? joined : joined.slice(0, closeAt), dialect);
    const inner = splitStatements(body.stripped);
    const innerPlain = splitNoComments(body.noComments, dialect);
    inner.forEach((text, k) => {
      push(peelPlpgsql(text), innerPlain.length === inner.length ? innerPlain[k] : body.noComments);
    });
  }
  return out;
}

function runReading(query: string, dialect: Dialect): RuleHit[] {
  const out: RuleHit[] = [];
  for (const stmt of statementsOf(prepare(query, dialect), dialect)) {
    const hits: RuleHit[] = [];
    for (const rule of RULES) hits.push(...rule(stmt, hits));
    out.push(...hits);
  }
  return out;
}

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
function codeReading(query: string, dialect: Dialect): RuleHit[] {
  return codeSql(prepare(query, dialect).noComments).flatMap((sql) =>
    runReading(sql, dialect).filter((h) => h.category === 'danger'),
  );
}

// Code, not SQL: SQL is built from strings, or no statement starts like SQL.
function looksLikeCode(query: string, hits: RuleHit[]): boolean {
  if (hits.some((h) => h.id === 'string-built-sql')) return true;
  const text = prepare(query, 'mysql').noComments;
  if (LOGS_COMMAND.test(text.trim())) return false;
  return !scanQuotes(text).statements.some(isSqlStatement);
}

const hitKey = (h: RuleHit) => `${h.id}\u0000${h.reason}`;

// Per (rule, reason), keep the largest count seen in any one reading.
function combine(readings: RuleHit[][]): RuleHit[] {
  const out: RuleHit[] = [];
  const have = new Map<string, number>();
  for (const reading of readings) {
    const seen = new Map<string, number>();
    for (const h of reading) {
      const n = (seen.get(hitKey(h)) ?? 0) + 1;
      seen.set(hitKey(h), n);
      if (n > (have.get(hitKey(h)) ?? 0)) {
        out.push(h);
        have.set(hitKey(h), n);
      }
    }
  }
  return out;
}

// MySQL and PostgreSQL read some syntax differently (`--x`, `#`, backslash, nested comments).
// - Run both readings, since the dialect is not known here.
// - When the text looks like code, also read the SQL in its string literals.
export function runRules(query: string): RuleHit[] {
  const readings = [runReading(query, 'mysql'), runReading(query, 'postgresql')];
  if (looksLikeCode(query, readings.flat())) readings.push(codeReading(query, 'mysql'), codeReading(query, 'postgresql'));
  const out = combine(readings);
  // Read-only only if nothing else found a data change or a danger.
  const risky = out.some((h) => h.changesData || (h.category === 'danger' && h.level !== 'none'));
  if (isLogsInsights(query) && !risky) out.push(logsInsightsHit());
  return out;
}
