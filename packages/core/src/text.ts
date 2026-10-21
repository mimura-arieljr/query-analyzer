export interface PreparedSql {
  raw: string;
  noComments: string;
  stripped: string;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

// Index just past the closing quote, or -1 if unterminated. `i` is the opening quote.
function endOfQuoted(sql: string, i: number): number {
  const q = sql[i];
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === q) {
      if (sql[j + 1] === q) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return -1;
}

// Index just past a closing dollar tag, or -1 if there is no tag here or no closer.
function endOfDollarQuoted(sql: string, i: number): number {
  if (i > 0 && IDENT_CHAR.test(sql[i - 1])) return -1;
  const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))?.[0];
  if (!tag) return -1;
  const close = sql.indexOf(tag, i + tag.length);
  return close === -1 ? -1 : close + tag.length;
}

export function prepare(sql: string): PreparedSql {
  let noComments = '';
  let stripped = '';
  const emit = (both: string, onlyNoComments?: string) => {
    noComments += onlyNoComments ?? both;
    stripped += both;
  };

  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === '-' && next === '-') {
      // Line comment ends at the newline (kept) or at end of input.
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
    } else if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) {
        // Unterminated: keep the rest as is.
        emit(sql.slice(i));
        i = sql.length;
      } else {
        i = close + 2;
      }
    } else if (c === "'") {
      const end = endOfQuoted(sql, i);
      if (end === -1) {
        emit(sql.slice(i));
        i = sql.length;
      } else {
        emit("''", sql.slice(i, end));
        i = end;
      }
    } else if (c === '"' || c === '`') {
      // Quoted identifiers pass through so markers inside them are not misread.
      const end = endOfQuoted(sql, i);
      const stop = end === -1 ? i + 1 : end;
      emit(sql.slice(i, stop));
      i = stop;
    } else if (c === '$') {
      const end = endOfDollarQuoted(sql, i);
      const stop = end === -1 ? i + 1 : end;
      emit(sql.slice(i, stop));
      i = stop;
    } else {
      emit(c);
      i++;
    }
  }

  return { raw: sql, noComments, stripped };
}

export function splitStatements(stripped: string): string[] {
  return stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function hasTopLevelWhere(statement: string): boolean {
  let depth = 0;
  let i = 0;
  while (i < statement.length) {
    const c = statement[i];
    if (c === '"' || c === '`') {
      const end = endOfQuoted(statement, i);
      i = end === -1 ? i + 1 : end;
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (IDENT_CHAR.test(c)) {
      let j = i;
      while (j < statement.length && IDENT_CHAR.test(statement[j])) j++;
      if (depth === 0 && statement.slice(i, j).toLowerCase() === 'where') return true;
      i = j;
    } else {
      i++;
    }
  }
  return false;
}
