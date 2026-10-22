import type { RuleHit } from './types';

const hitKey = (h: RuleHit) => `${h.id}\u0000${h.reason}`;

// Per (rule, reason), keep the largest count seen in any one reading.
export function combine(readings: RuleHit[][]): RuleHit[] {
  const out: RuleHit[] = [];
  const have = new Map<string, number>();
  for (const reading of readings) {
    const seen = new Map<string, number>();
    for (const h of reading) {
      const n = (seen.get(hitKey(h)) ?? 0) + 1;
      seen.set(hitKey(h), n);
      if (n > (have.get(hitKey(h)) ?? 0)) {
        out.push(h);
        have.set(hitKey(h), n);
      }
    }
  }
  return out;
}
