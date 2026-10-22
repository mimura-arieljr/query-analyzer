import { runRules } from './rules';
import type { RuleHit } from './rules';
import type {
  Category,
  CategoryResult,
  DangerResult,
  FinalAnalysis,
  FinalFinding,
  Finding,
  Level,
  ModelAnalysis,
  RewrittenQuery,
} from './types';

const LEVEL_ORDER: Level[] = ['none', 'low', 'medium', 'high'];
const LOGS_SUMMARY = 'CloudWatch Logs Insights queries only read data.';

const rank = (l: Level) => LEVEL_ORDER.indexOf(l);

function maxLevel(a: Level, b: Level): Level {
  return rank(a) >= rank(b) ? a : b;
}

const tagAi = (f: Finding): FinalFinding => ({ ...f, source: 'ai' });

function fromHit(h: RuleHit): FinalFinding {
  return {
    reason: h.reason,
    certainty: h.certainty,
    assumption: h.assumption,
    how_to_verify: h.how_to_verify,
    source: 'rule',
    ruleId: h.id,
  };
}

// Certain findings carry no assumption to verify.
const blankIfCertain = (f: FinalFinding): FinalFinding =>
  f.certainty === 'certain' ? { ...f, assumption: '', how_to_verify: '' } : f;

// A model finding is a duplicate only when it is certain, in the hit's category and matched by its regex.
// - Each hit drops at most one model finding (the first match).
// - Possible model findings are always kept.
function dropDuplicates(findings: FinalFinding[], hits: RuleHit[], category: Category): FinalFinding[] {
  const kept = [...findings];
  for (const h of hits.filter((x) => x.category === category)) {
    const i = kept.findIndex((f) => f.certainty === 'certain' && h.matchesModel.test(f.reason));
    if (i !== -1) kept.splice(i, 1);
  }
  return kept;
}

// Level of a category: the highest of the model's level and every hit's level.
function mergeCategory(model: CategoryResult, hits: RuleHit[], category: Category): CategoryResult<FinalFinding> {
  const kept = dropDuplicates(model.findings.map(tagAi), hits, category);
  const level = hits.reduce<Level>((acc, h) => maxLevel(acc, h.level), model.level);
  const findings = [...kept, ...hits.map(fromHit)].map(blankIfCertain);
  return { level, findings };
}

// First data-changing hit at the highest level.
function topChangeHit(hits: RuleHit[]): RuleHit | undefined {
  return hits
    .filter((h) => h.changesData)
    .reduce<RuleHit | undefined>((best, h) => (!best || rank(h.level) > rank(best.level) ? h : best), undefined);
}

function mergeDanger(model: DangerResult, hits: RuleHit[]): DangerResult<FinalFinding> {
  const base = mergeCategory(model, hits, 'danger');
  const change = topChangeHit(hits);
  if (!change) return { ...base, can_change_data: model.can_change_data, data_change_summary: model.data_change_summary };
  return {
    ...base,
    can_change_data: 'yes',
    data_change_summary: model.can_change_data === 'yes' ? model.data_change_summary : change.reason,
  };
}

const logsDanger = (): DangerResult<FinalFinding> => ({
  level: 'none',
  can_change_data: 'no',
  data_change_summary: LOGS_SUMMARY,
  findings: [],
});

// A category with findings never reads as level none.
function raiseEmptyLevel<T extends CategoryResult<FinalFinding>>(c: T): T {
  return c.findings.length > 0 && c.level === 'none' ? { ...c, level: 'low' } : c;
}

const NO_REWRITE: RewrittenQuery = { query: '', reason: '' };

function floor(hits: RuleHit[], category: Category): Level {
  return hits.filter((h) => h.category === category).reduce<Level>((acc, h) => maxLevel(acc, h.level), 'none');
}

const hasHit = (hits: RuleHit[], id: RuleHit['id']) => hits.some((h) => h.id === id);

const EXPR = String.raw`[^"'\`+]+?`;
// Joins in a string-built original, each replaced by one `?`.
const JOINS: RegExp[] = [
  new RegExp(String.raw`'["\`]\s*\+\s*${EXPR}\s*\+\s*["\`]'`, 'g'),
  new RegExp(String.raw`["\`]\s*\+\s*${EXPR}\s*\+\s*["\`]`, 'g'),
  new RegExp(String.raw`["\`]\s*\+\s*[^"'\`+]+$`, 'g'),
  /'?\$\{[^}]*\}'?/g,
  /'?%(?:\(\w+\))?s'?/g,
  /'?\{[^{}]*\}'?/g,
];
// The `" % value` after a Python format string: one name, attribute or tuple to the end.
const PERCENT_TAIL = /["']\s*%\s*(?:[\w.]+|\([^()]*\))\s*;?\s*$/;
// Placeholders in a rewrite, each replaced by one `?`.
const PLACEHOLDER = /'?(?:\$\d+|\?|%s|%\(\w+\)s|(?<!:):\w+|@\w+)'?/g;
const CALL_OPEN = /^[\w.]+\(\s*(?=["'`])/;
// Comments and escapes can hide text once whitespace is collapsed, so they are not compared.
const COMMENT_OR_ESCAPE = /--|#|\/\*|\\/;
const SQL_START = /^(?:SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|MERGE)\b/i;

// `db.query("...")` becomes `"..."`, only when it is one balanced call and nothing follows it but `;`.
function unwrapCall(text: string): string {
  const open = CALL_OPEN.exec(text);
  if (!open) return text;
  let depth = 1;
  let quote = '';
  for (let i = open[0].length; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return /^\s*;?\s*$/.test(text.slice(i + 1)) ? text.slice(open[0].length, i) : text;
    }
  }
  return text;
}

// The statement with values and quoting removed, so a string-built query and
// its parameterized rewrite can be compared for the same shape.
function skeleton(text: string, original: boolean): string {
  let t = text.trim().toLowerCase();
  if (original) {
    t = unwrapCall(t).trim().replace(/^f(?=["'])/, '');
    for (const re of JOINS) t = t.replace(re, '?');
    t = t.replace(PERCENT_TAIL, '').replace(/^["'`]/, '').replace(/["'`;\s]+$/, '');
  } else {
    t = t.replace(PLACEHOLDER, '?').replace(/[;\s]+$/, '');
  }
  return t.replace(/\s+/g, ' ');
}

// For a string-built original, keep only a bare-SQL rewrite with the same shape and parameters.
// Known limitation: a rewrite wrapped in a call (db.query("...", [n])) is dropped.
function isParameterized(query: string, rewrite: string, rewriteHits: RuleHit[]): boolean {
  if (hasHit(rewriteHits, 'string-built-sql') || rank(floor(rewriteHits, 'danger')) >= rank('high')) return false;
  if (!SQL_START.test(rewrite.trim())) return false;
  if (COMMENT_OR_ESCAPE.test(query) || COMMENT_OR_ESCAPE.test(rewrite)) return false;
  const want = skeleton(query, true);
  return want !== '' && want === skeleton(rewrite, false);
}

function guardRewrite(query: string, model: ModelAnalysis, hits: RuleHit[]): RewrittenQuery {
  const rewrite = model.rewritten_query;
  const text = rewrite.query.trim();
  if (text === '' || text === query.trim() || rewrite.reason.trim() === '') return NO_REWRITE;
  const rewriteHits = runRules(rewrite.query);
  if (hasHit(hits, 'string-built-sql')) return isParameterized(query, rewrite.query, rewriteHits) ? rewrite : NO_REWRITE;
  const worse = (c: Category) => rank(floor(rewriteHits, c)) > rank(floor(hits, c));
  if (worse('danger') || worse('security')) return NO_REWRITE;
  const changesData =
    hits.some((h) => h.changesData) || model.danger.can_change_data === 'yes' || model.danger.can_change_data === 'unclear';
  return changesData ? NO_REWRITE : rewrite;
}

const NOT_RECOGNISED = 'The AI did not recognise this as a query; the rule checks found the issues below.';

// Hits strong enough to override the model's "not a query".
const overridesNonQuery = (h: RuleHit) =>
  (h.category === 'danger' && h.level !== 'none') || h.changesData || h.id === 'string-built-sql';

// Stand-in for the model when it called the text "not a query" but the rules flagged it.
function rulesOnlyModel(): ModelAnalysis {
  const empty = { level: 'none' as const, findings: [] };
  return {
    is_query: true,
    not_a_query_message: '',
    query_type: { language: 'unknown', dialect_note: NOT_RECOGNISED, confidence: 'low' },
    what_it_does: NOT_RECOGNISED,
    detailed_explanation: '',
    simple_explanation: '',
    step_by_step: [],
    improvements: [],
    rewritten_query: NO_REWRITE,
    security: empty,
    danger: { ...empty, can_change_data: 'unclear', data_change_summary: '' },
    performance: empty,
  };
}

function passThrough(model: ModelAnalysis): FinalAnalysis {
  return {
    ...model,
    security: { ...model.security, findings: model.security.findings.map(tagAi) },
    danger: { ...model.danger, findings: model.danger.findings.map(tagAi) },
    performance: { ...model.performance, findings: model.performance.findings.map(tagAi) },
  };
}

function merge(query: string, model: ModelAnalysis, hits: RuleHit[]): FinalAnalysis {
  const logs = hasHit(hits, 'logs-insights-read-only');
  const rest = hits.filter((h) => h.id !== 'logs-insights-read-only');
  const inCategory = (c: Category) => rest.filter((h) => h.category === c);
  return {
    ...model,
    security: raiseEmptyLevel(mergeCategory(model.security, inCategory('security'), 'security')),
    danger: logs ? logsDanger() : raiseEmptyLevel(mergeDanger(model.danger, inCategory('danger'))),
    performance: raiseEmptyLevel(mergeCategory(model.performance, inCategory('performance'), 'performance')),
    rewritten_query: guardRewrite(query, model, hits),
  };
}

// Merges the model reply with the rule hits:
// - Rules only raise warnings, except that a Logs Insights query is read-only.
// - A "not a query" reply passes through unless the rules find danger, a data change or string-built SQL.
export function finalize(query: string, model: ModelAnalysis): FinalAnalysis {
  const hits = runRules(query);
  if (model.is_query) return merge(query, model, hits);
  return hits.some(overridesNonQuery) ? merge(query, rulesOnlyModel(), hits) : passThrough(model);
}
