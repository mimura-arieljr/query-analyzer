import { hasTopLevelWhere, prepare, splitStatements } from './text';
import type { PreparedSql } from './text';
import type { Category, Certainty, Level } from './types';

// Task 4 adds: 'string-built-sql' | 'hardcoded-password' | 'leading-wildcard-like'
// | 'order-by-random' | 'logs-insights-read-only'.
export type RuleId =
  | 'delete-update-no-where'
  | 'always-true-where'
  | 'drop-truncate'
  | 'data-modifying-cte'
  | 'delete-update-with-where'
  | 'insert-select-into'
  | 'grant-revoke';

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

function certain(spec: Spec): RuleHit {
  return { ...spec, category: 'danger', certainty: 'certain', assumption: '', how_to_verify: '' };
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

// Splits `noComments` at the same semicolons splitStatements() uses on `stripped`.
// - Only single-quoted strings hide a `;` here, because only they are blanked there.
// - Quoted identifiers and dollar-quoted spans are walked so a quote inside them is ignored.
function splitNoComments(text: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let i = 0;
  const closeOf = (open: number, tag: string): number => {
    const at = text.indexOf(tag, open + tag.length);
    return at === -1 ? -1 : at + tag.length;
  };
  while (i < text.length) {
    const c = text[i];
    let end = -1;
    let hides = false;
    if (c === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          end = j + 1;
          break;
        }
        j++;
      }
      hides = true;
      if (end === -1) end = text.length;
    } else if (c === '"' || c === '`') {
      // Unterminated: prepare() consumes just the quote character.
      end = closeOf(i, c);
    } else if (c === '$' && !(i > 0 && IDENT_CHAR.test(text[i - 1]))) {
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 64))?.[0];
      if (tag) end = closeOf(i, tag);
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

// Words at parenthesis depth 0, in order, upper-cased.
function topLevelWords(statement: string): string[] {
  const words: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < statement.length) {
    const c = statement[i];
    if (c === '"' || c === '`') {
      const close = statement.indexOf(c, i + 1);
      i = close === -1 ? i + 1 : close + 1;
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (IDENT_CHAR.test(c)) {
      let j = i;
      while (j < statement.length && IDENT_CHAR.test(statement[j])) j++;
      if (depth === 0) words.push(statement.slice(i, j).toUpperCase());
      i = j;
    } else {
      i++;
    }
  }
  return words;
}

// `WITH x AS (...) DELETE FROM t` is a DELETE, so look past the WITH clause.
function kindOf(statement: string): string {
  const words = topLevelWords(statement);
  const first = words[0] ?? '';
  if (first !== 'WITH') return first;
  const main = words.find((w) => ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(w));
  return main ?? first;
}

const ALWAYS_TRUE_STRIPPED = /\bOR\s+\(*\s*(?:TRUE\b|(\d+(?:\.\d+)?)\s*=\s*\1(?![\d.]))/i;
const ALWAYS_TRUE_STRING = /\bOR\s+\(*\s*'((?:[^']|'')*)'\s*=\s*'\1'/i;

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
  isWrite(s) && (ALWAYS_TRUE_STRIPPED.test(s.stripped) || ALWAYS_TRUE_STRING.test(s.noComments))
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

const dropTruncate: RuleFn = (s) => {
  const dropsColumn = s.kind === 'ALTER' && /\bDROP\s+COLUMN\b/i.test(s.stripped);
  if (s.kind !== 'DROP' && s.kind !== 'TRUNCATE' && !dropsColumn) return [];
  return [
    certain({
      id: 'drop-truncate',
      level: 'high',
      reason: dropsColumn
        ? 'This ALTER statement drops a column and the data in it.'
        : `This ${s.kind} statement permanently removes ${s.kind === 'DROP' ? 'a database object and its data' : 'all rows from a table'}.`,
      changesData: true,
      matchesModel:
        /\b(drop|dropp\w*|truncat\w*|irreversibl\w*|permanently|destroy\w*|cannot be undone|removes? (the )?(table|column|all))\b/i,
    }),
  ];
};

const dataModifyingCte: RuleFn = (s) =>
  s.stripped.trimStart().slice(0, 4).toUpperCase() === 'WITH' &&
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

// Order matters: withWhere reads the hits the earlier rules produced for the statement.
const RULES: RuleFn[] = [
  noWhere,
  alwaysTrue,
  dropTruncate,
  dataModifyingCte,
  withWhere,
  insertSelectInto,
  grantRevoke,
];

function statementsOf(p: PreparedSql): Stmt[] {
  const stripped = splitStatements(p.stripped);
  const plain = splitNoComments(p.noComments);
  const aligned = plain.length === stripped.length;
  // On a split mismatch use the whole text: a spurious warning beats a missed one.
  return stripped.map((text, i) => ({
    stripped: text,
    noComments: aligned ? plain[i] : p.noComments,
    kind: kindOf(text),
  }));
}

export function runRules(query: string): RuleHit[] {
  const out: RuleHit[] = [];
  for (const stmt of statementsOf(prepare(query))) {
    const hits: RuleHit[] = [];
    for (const rule of RULES) hits.push(...rule(stmt, hits));
    out.push(...hits);
  }
  return out;
}
