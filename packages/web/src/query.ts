export type Range = [start: number, end: number];

export type TokenKind = 'keyword' | 'word' | 'string' | 'number' | 'comment' | 'punct' | 'space';

export interface Token {
  start: number;
  end: number;
  kind: TokenKind;
}

// SQL and CloudWatch Logs Insights words set in the keyword style.
const KEYWORDS = new Set(
  `select from where and or not in is null like ilike between exists as on join inner left right full outer cross
  using group by order having limit offset distinct union all intersect except insert into values update set delete
  truncate drop alter create table index view grant revoke to with returning case when then else end asc desc
  begin commit rollback interval true false primary key references cascade if
  fields filter stats sort parse display dedup unmask pattern diff count sum avg min max bin desc`
    .split(/\s+/)
    .filter(Boolean),
);

// One pass over the text; tokens cover it exactly once, in order.
const TOKEN = new RegExp(
  [
    String.raw`(?<space>\s+)`,
    String.raw`(?<comment>--[^\n]*|/\*[\s\S]*?(?:\*/|$))`,
    String.raw`(?<string>'(?:[^']|'')*(?:'|$)|"(?:[^"]|"")*(?:"|$)|\`[^\`]*(?:\`|$))`,
    String.raw`(?<number>\b\d+(?:\.\d+)?\b)`,
    String.raw`(?<word>[@A-Za-z_][\w@.$]*)`,
    String.raw`(?<punct>[\s\S])`,
  ].join('|'),
  'g',
);

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const g = m.groups ?? {};
    const kind = (Object.keys(g).find((k) => g[k] !== undefined) ?? 'punct') as TokenKind;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const isKeyword = kind === 'word' && KEYWORDS.has(m[0].toLowerCase());
    out.push({ start, end, kind: isKeyword ? 'keyword' : kind });
  }
  return out;
}

// Words, strings and numbers: what the scan steps through while it checks for risky patterns.
export function wordRanges(text: string): Range[] {
  return tokenize(text)
    .filter((t) => t.kind !== 'space' && t.kind !== 'punct')
    .map((t) => [t.start, t.end] as Range);
}

// Non-empty lines without their indent: what the scan steps through while it explains each part.
export function lineRanges(text: string): Range[] {
  const out: Range[] = [];
  for (const m of text.matchAll(/[^\n]+/g)) {
    const start = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
    const end = (m.index ?? 0) + m[0].trimEnd().length;
    if (end > start) out.push([start, end]);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Where each snippet sits in the query, matched in order.
// - Case and runs of whitespace are ignored, since the model may reflow a clause.
// - Each search starts after the previous match; on a miss, from the top.
export function findInOrder(text: string, snippets: string[]): (Range | null)[] {
  let cursor = 0;
  return snippets.map((snippet) => {
    const words = snippet.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    const re = new RegExp(words.map(escape).join(String.raw`\s+`), 'gi');
    re.lastIndex = cursor;
    let m = re.exec(text);
    if (!m) {
      re.lastIndex = 0;
      m = re.exec(text);
    }
    if (!m) return null;
    cursor = m.index + m[0].length;
    return [m.index, m.index + m[0].length];
  });
}
