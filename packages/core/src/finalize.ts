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

// A model finding is a duplicate only in the same category AND when a hit's regex matches its reason.
function dropDuplicates(findings: FinalFinding[], hits: RuleHit[]): FinalFinding[] {
  return findings.filter((f) => !hits.some((h) => h.matchesModel.test(f.reason)));
}

// Level of a category: the highest of the model's level and every hit's level.
function mergeCategory(model: CategoryResult, hits: RuleHit[]): CategoryResult<FinalFinding> {
  const kept = dropDuplicates(model.findings.map(tagAi), hits);
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
  const base = mergeCategory(model, hits);
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

function dangerFloor(hits: RuleHit[]): Level {
  return hits.filter((h) => h.category === 'danger').reduce<Level>((acc, h) => maxLevel(acc, h.level), 'none');
}

const hasHit = (hits: RuleHit[], id: RuleHit['id']) => hits.some((h) => h.id === id);

function guardRewrite(query: string, model: ModelAnalysis, hits: RuleHit[]): RewrittenQuery {
  const rewrite = model.rewritten_query;
  const text = rewrite.query.trim();
  if (text === '' || text === query.trim() || rewrite.reason.trim() === '') return NO_REWRITE;
  const rewriteHits = runRules(rewrite.query);
  if (rank(dangerFloor(rewriteHits)) > rank(dangerFloor(hits))) return NO_REWRITE;
  const changesData =
    hits.some((h) => h.changesData) || model.danger.can_change_data === 'yes' || model.danger.can_change_data === 'unclear';
  const parameterized = hasHit(hits, 'string-built-sql') && !hasHit(rewriteHits, 'string-built-sql');
  return changesData && !parameterized ? NO_REWRITE : rewrite;
}

// Rules only raise warnings. The one exception is a Logs Insights query, which is read-only.
export function finalize(query: string, model: ModelAnalysis): FinalAnalysis {
  if (!model.is_query) {
    return {
      ...model,
      security: { ...model.security, findings: model.security.findings.map(tagAi) },
      danger: { ...model.danger, findings: model.danger.findings.map(tagAi) },
      performance: { ...model.performance, findings: model.performance.findings.map(tagAi) },
    };
  }
  const hits = runRules(query);
  const logs = hasHit(hits, 'logs-insights-read-only');
  const rest = hits.filter((h) => h.id !== 'logs-insights-read-only');
  const inCategory = (c: Category) => rest.filter((h) => h.category === c);
  return {
    ...model,
    security: raiseEmptyLevel(mergeCategory(model.security, inCategory('security'))),
    danger: logs ? logsDanger() : raiseEmptyLevel(mergeDanger(model.danger, inCategory('danger'))),
    performance: raiseEmptyLevel(mergeCategory(model.performance, inCategory('performance'))),
    rewritten_query: guardRewrite(query, model, hits),
  };
}
