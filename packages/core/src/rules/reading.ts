import { prepare } from '../text';
import type { Dialect } from '../text';
import { RULES } from './registry';
import { statementsOf } from './statements';
import type { RuleHit } from './types';

// Runs every rule on every statement of `query`, read under one dialect.
export function runReading(query: string, dialect: Dialect): RuleHit[] {
  return statementsOf(prepare(query, dialect), dialect).flatMap((stmt) => RULES.flatMap((rule) => rule(stmt)));
}
