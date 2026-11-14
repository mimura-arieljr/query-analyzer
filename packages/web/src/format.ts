import { formatDialect, mysql, postgresql, sql, type DialectOptions } from 'sql-formatter';

// Logs Insights starts with one of its commands, or reads @fields through pipes.
const LOGS_START = /^\s*(fields|filter|stats|parse|sort|display|limit|dedup|pattern|unmask|diff|anomaly|source)\b/i;
const LOGS_FIELD = /@(timestamp|message|logStream|log|requestId)\b/;

export function isLogsInsights(text: string): boolean {
  return LOGS_START.test(text) || (LOGS_FIELD.test(text) && text.includes('|'));
}

// Tabs to two spaces, the shared indent and trailing spaces removed, blank edges trimmed.
export function dedent(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n').map((l) => l.trimEnd());
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l) => l.slice(cut))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

// Split at top-level pipes, keeping quoted text and /regex/ after like or =~ whole.
// - Whitespace outside quotes collapses to one space; inside quotes it is kept as is.
function pipeSegments(text: string): string[] {
  const out: string[] = [];
  let seg = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      seg += c;
      if (c === '\\') seg += text[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && /(like|=~)\s*$/i.test(seg)) quote = '/';
    else if (c === '|') {
      out.push(seg);
      seg = '';
      continue;
    } else if (/\s/.test(c)) {
      if (!seg.endsWith(' ')) seg += ' ';
      continue;
    }
    seg += c;
  }
  out.push(seg);
  return out;
}

// Each Logs Insights command on its own line, the pipe leading, as in the AWS docs.
export function formatLogsInsights(text: string): string {
  // A # comment runs to the end of its line; collapsing lines would swallow the command after it.
  if (/(^|\s)#/.test(text)) return dedent(text);
  const parts = pipeSegments(text)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p : `| ${p}`)).join('\n');
}

// Backticks mean MySQL; otherwise PostgreSQL, whose grammar also reads most plain SQL.
// - Generic SQL goes last: it spaces out calls it does not know, such as now ().
function sqlDialects(text: string): DialectOptions[] {
  if (text.includes('`')) return [mysql, postgresql, sql];
  return [postgresql, mysql, sql];
}

// Lay a pasted query out the way it would be written by hand.
// - The words stay as typed: only whitespace moves, so keyword case and comments survive.
// - Anything the formatter cannot parse keeps its own layout, only dedented.
export function formatQuery(text: string): string {
  if (!text.trim()) return text;
  const same = (out: string) => out.replace(/\s+/g, '') === text.replace(/\s+/g, '');
  if (isLogsInsights(text)) {
    const out = formatLogsInsights(text);
    return same(out) ? out : dedent(text);
  }
  for (const dialect of sqlDialects(text)) {
    try {
      const out = formatDialect(text, { dialect, tabWidth: 2, keywordCase: 'preserve' }).trim();
      // A guard, not an expectation: if anything but whitespace moved, keep the user's own layout.
      if (same(out)) return out;
    } catch {
      // Try the next dialect.
    }
  }
  return dedent(text);
}
