import { codeReading, looksLikeCode } from './code-strings';
import { combine } from './combine';
import { isLogsInsights, logsInsightsHit } from './logs-insights';
import { runReading } from './reading';
import type { RuleHit } from './types';

export type { RuleHit, RuleId } from './types';
export { isLogsInsights };

// MySQL and PostgreSQL read some syntax differently (`--x`, `#`, backslash, nested comments).
// - Run both readings, since the dialect is not known here.
// - When the text looks like code, also read the SQL in its string literals.
export function runRules(query: string): RuleHit[] {
  const readings = [runReading(query, 'mysql'), runReading(query, 'postgresql')];
  if (looksLikeCode(query, readings.flat())) readings.push(codeReading(query, 'mysql'), codeReading(query, 'postgresql'));
  const out = combine(readings);
  // Read-only only if nothing else found a data change or a danger.
  const risky = out.some((h) => h.changesData || (h.category === 'danger' && h.level !== 'none'));
  if (isLogsInsights(query) && !risky) out.push(logsInsightsHit());
  return out;
}
