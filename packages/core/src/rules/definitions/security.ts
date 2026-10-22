import { certainRule } from '../define';

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

const joinsValueIntoText = (t: string) =>
  CONCAT_AFTER_QUOTE.test(t) ||
  CONCAT_BEFORE_QUOTE.test(t) ||
  TEMPLATE_HOLE.test(t) ||
  F_STRING.test(t) ||
  PERCENT_FORMAT.test(t);

export const stringBuiltSql = certainRule(
  {
    id: 'string-built-sql',
    level: 'high',
    reason: 'This looks like SQL built from user input by joining strings together, which can allow SQL injection.',
    changesData: false,
    matchesModel: /inject|concatenat|string[- ]built|built (from|with|by) (user|string)|user input/i,
    when: (s) => joinsValueIntoText(s.noComments) && SQL_WORD.test(s.noComments),
  },
  'security',
);

// PASSWORD 'x' (PostgreSQL), IDENTIFIED [WITH plugin] BY 'x', SET PASSWORD [FOR u] = 'x' (MySQL).
const PASSWORD_LITERAL =
  /(?<![\w$.])(?:PASSWORD\s+['"]|IDENTIFIED\s+(?:WITH\s+\w+\s+)?BY\s+['"]|SET\s+PASSWORD\s+(?:FOR\s+\S+\s*)?=\s*['"])/i;

export const hardcodedPassword = certainRule(
  {
    id: 'hardcoded-password',
    level: 'none',
    reason: 'This statement has a password written directly in the SQL text.',
    changesData: false,
    matchesModel:
      /hard-?coded.*(password|credential)|(password|credential)s?\b.*\b(hard-?coded|plain ?text|in the (query|sql|statement))/i,
    when: (s) => PASSWORD_LITERAL.test(s.noComments),
  },
  'security',
);
