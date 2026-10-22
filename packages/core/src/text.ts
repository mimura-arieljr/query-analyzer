export interface PreparedSql {
  raw: string;
  noComments: string;
  stripped: string;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

// Index just past the closing quote, or -1 if unterminated. `i` is the opening quote.
function endOfQuoted(sql: string, i: number, backslash = false): number {
  const q = sql[i];
  let j = i + 1;
  while (j < sql.length) {
    if (backslash && sql[j] === '\\') {
      j += 2;
      continue;
    }
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

// Index of the `*/` that closes a nested comment opened at `i`, or -1.
function endOfNestedComment(sql: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < sql.length - 1) {
    if (sql[j] === '/' && sql[j + 1] === '*') {
      depth++;
      j += 2;
    } else if (sql[j] === '*' && sql[j + 1] === '/') {
      depth--;
      if (depth === 0) return j;
      j += 2;
    } else {
      j++;
    }
  }
  return -1;
}

// Dialect picks how ambiguous syntax is read:
// - mysql: `#` comments, backslash escapes, non-nesting comments, `/*!` runs its text.
// - postgresql: `--` always comments, nested comments, no backslash escapes.
export type Dialect = 'mysql' | 'postgresql';

export function prepare(sql: string, dialect: Dialect = 'mysql'): PreparedSql {
  const my = dialect === 'mysql';
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
      const after = sql[i + 2];
      if (!my || after === undefined || after.charCodeAt(0) <= 32) {
        // Line comment ends at the first CR or LF (kept) or at end of input.
        const m = /[\r\n]/.exec(sql.slice(i));
        i = m ? i + m.index : sql.length;
      } else {
        // MySQL: `--` without trailing whitespace is not a comment. Keep it visible.
        emit('--');
        i += 2;
      }
    } else if (my && c === '#') {
      const m = /[\r\n]/.exec(sql.slice(i));
      i = m ? i + m.index : sql.length;
    } else if (c === '/' && next === '*') {
      const close = my ? sql.indexOf('*/', i + 2) : endOfNestedComment(sql, i);
      if (close === -1) {
        // Unterminated: keep the rest as is.
        emit(sql.slice(i));
        i = sql.length;
      } else if (my && sql[i + 2] === '!') {
        // MySQL executes `/*! ... */` (optionally `/*!50000 ... */`), so keep the inner text.
        const inner = prepare(sql.slice(i + 3, close).replace(/^\d+/, ''), dialect);
        noComments += ' ' + inner.noComments + ' ';
        stripped += ' ' + inner.stripped + ' ';
        i = close + 2;
      } else {
        // A comment separates tokens: `DELETE/**/FROM` must not fuse into one word.
        const before = stripped[stripped.length - 1];
        const after = sql[close + 2];
        if (before && after && !/\s/.test(before) && !/\s/.test(after)) emit(' ');
        i = close + 2;
      }
    } else if (c === "'") {
      const end = endOfQuoted(sql, i, my);
      if (end === -1) {
        emit(sql.slice(i));
        i = sql.length;
      } else {
        emit("''", sql.slice(i, end));
        i = end;
      }
    } else if (c === '"' || c === '`') {
      // Quoted identifiers pass through so markers inside them are not misread.
      const end = endOfQuoted(sql, i, my && c === '"');
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

// Expects `stripped` input from prepare().
export function hasTopLevelWhere(statement: string): boolean {
  let depth = 0;
  let i = 0;
  while (i < statement.length) {
    const c = statement[i];
    if (c === '"' || c === '`') {
      const end = endOfQuoted(statement, i);
      i = end === -1 ? i + 1 : end;
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
      if (depth === 0 && statement.slice(i, j).toLowerCase() === 'where') return true;
      i = j;
    } else {
      i++;
    }
  }
  return false;
}
