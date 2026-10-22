import { prepare } from '../text';
import { certain } from './define';
import type { RuleHit } from './types';

const LOGS_START = /^(?:fields|filter|stats|parse)\b/i;
const LOGS_FORBIDDEN =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|FROM|TRUNCATE|GRANT|REVOKE|CREATE|ALTER|REPLACE|MERGE|CALL)\b/i;

// CloudWatch Logs Insights: starts with a Logs command and holds none of the SQL words.
export function isLogsInsights(query: string): boolean {
  const text = prepare(query, 'mysql').stripped.trim();
  return LOGS_START.test(text) && !LOGS_FORBIDDEN.test(text);
}

export const logsInsightsHit = (): RuleHit =>
  certain({
    id: 'logs-insights-read-only',
    level: 'none',
    reason: 'This is a CloudWatch Logs Insights query, which can only read log data.',
    changesData: false,
    matchesModel: /read[- ]only|only (reads?|queries|searches)|cannot (change|modify|delete)|does not (change|modify)/i,
  });
