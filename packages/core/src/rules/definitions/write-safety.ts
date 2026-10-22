import { hasTopLevelWhere } from '../../text';
import { certainRule } from '../define';
import { kindOf, whereClause } from '../statements';
import type { RuleFn, Stmt } from '../types';

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

const hasAlwaysTrueCondition = (s: Stmt) =>
  isWrite(s) &&
  (OR_TRUE.test(s.stripped) ||
    OR_SAME_LITERAL.test(s.noComments) ||
    WHERE_TRUE.test(whereClause(s.stripped) ?? '\u0000'));

export const noWhere = certainRule({
  id: 'delete-update-no-where',
  level: 'high',
  reason: (s) => `This ${s.kind} statement has no WHERE clause, so it changes every row in the table.`,
  changesData: true,
  matchesModel:
    /\b(no|without|missing|lacks?)\b[^.]*\bWHERE\b|\ball (the )?(rows|records)\b|\bevery row\b|\bentire table\b/i,
  when: (s) => isWrite(s) && !hasTopLevelWhere(s.stripped),
});

export const alwaysTrue = certainRule({
  id: 'always-true-where',
  level: 'high',
  reason: (s) =>
    `This ${s.kind} statement has a condition that is always true, so its WHERE clause does not limit the rows.`,
  changesData: true,
  matchesModel: /always[- ]true|tautolog|\bOR\s+\(*\s*(1\s*=\s*1|true)\b|(matches|affects|changes) (all|every) rows?/i,
  when: hasAlwaysTrueCondition,
});

// The ordinary case: a WHERE that really limits the rows (noWhere and alwaysTrue cover the rest).
export const withWhere = certainRule({
  id: 'delete-update-with-where',
  level: 'medium',
  reason: (s) => `This ${s.kind} statement changes data in the rows its WHERE clause matches.`,
  changesData: true,
  matchesModel: /\b(delet|updat|modif|overwrit|chang|remov)\w*\b[^.]*\b(rows?|records?|data)\b/i,
  when: (s) => isWrite(s) && hasTopLevelWhere(s.stripped) && !hasAlwaysTrueCondition(s),
});

export const dataModifyingCte = certainRule({
  id: 'data-modifying-cte',
  level: 'medium',
  reason: 'This WITH statement contains a DELETE, UPDATE or INSERT inside a CTE, so it changes data.',
  changesData: true,
  matchesModel: /data[- ]modifying|\b(CTE|WITH)\b[^.]*\b(delet|updat|insert|modif|writes?|chang)\w*/i,
  when: (s) => /^WITH\b/i.test(s.stripped) && /\(\s*(?:DELETE|UPDATE|INSERT)\b/i.test(s.stripped),
});

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
export const cteBodies: RuleFn = (s) =>
  /^WITH\b/i.test(s.stripped)
    ? cteWriteBodies(s.stripped).flatMap((body) => {
        const inner: Stmt = { stripped: body, noComments: s.noComments, kind: kindOf(body) };
        return [...noWhere(inner), ...alwaysTrue(inner)];
      })
    : [];
