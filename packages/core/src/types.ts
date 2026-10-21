export type Level = 'none' | 'low' | 'medium' | 'high';
export type Certainty = 'certain' | 'possible';
export type Category = 'security' | 'danger' | 'performance';

export interface Finding {
  reason: string;
  certainty: Certainty;
  assumption: string;
  how_to_verify: string;
}

export interface FinalFinding extends Finding {
  source: 'ai' | 'rule';
  ruleId?: string;
}

export interface QueryType {
  language: 'postgresql' | 'mysql' | 'cloudwatch_logs_insights' | 'other' | 'unknown';
  dialect_note: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface StepExplanation {
  snippet: string;
  explanation: string;
}

export interface RewrittenQuery {
  query: string;
  reason: string;
}

export interface CategoryResult<F extends Finding = Finding> {
  level: Level;
  findings: F[];
}

export interface DangerResult<F extends Finding = Finding> extends CategoryResult<F> {
  can_change_data: 'yes' | 'no' | 'unclear';
  data_change_summary: string;
}

interface AnalysisShape<F extends Finding> {
  is_query: boolean;
  not_a_query_message: string;
  query_type: QueryType;
  what_it_does: string;
  detailed_explanation: string;
  simple_explanation: string;
  step_by_step: StepExplanation[];
  improvements: string[];
  rewritten_query: RewrittenQuery;
  security: CategoryResult<F>;
  danger: DangerResult<F>;
  performance: CategoryResult<F>;
}

export type ModelAnalysis = AnalysisShape<Finding>;
export type FinalAnalysis = AnalysisShape<FinalFinding>;

export type ErrorCode =
  | 'empty'
  | 'too_long'
  | 'bad_request'
  | 'unauthorized'
  | 'throttled'
  | 'bad_output'
  | 'failed';

export type AnalyzeResponse =
  | { ok: true; analysis: FinalAnalysis }
  | { ok: false; error: ErrorCode; message: string };

export const MAX_QUERY_CHARS = 20000;
