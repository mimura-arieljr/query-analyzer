import { endOfDollarQuoted, isEscapeString, prepare, splitStatements } from '../text';
import type { Dialect, PreparedSql } from '../text';
import type { Stmt } from './types';

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
export function kindOf(statement: string): string {
  const words = topLevelWords(statement).map((w) => w.text);
  const first = words[0] ?? '';
  if (first !== 'WITH') return first;
  const main = words.find((w) => ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(w));
  return main ?? first;
}

// Text after the top-level WHERE, or null when there is none.
export function whereClause(statement: string): string | null {
  const w = topLevelWords(statement).find((x) => x.text === 'WHERE');
  return w ? statement.slice(w.end) : null;
}

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

export const DO_OPEN = /^DO\b(?:\s+LANGUAGE\s+\w+)?\s*(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/i;
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

export function statementsOf(p: PreparedSql, dialect: Dialect): Stmt[] {
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
