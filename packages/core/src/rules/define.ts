import type { Category } from '../types';
import type { RuleFn, RuleHit, Stmt } from './types';

type Spec = Omit<RuleHit, 'certainty' | 'assumption' | 'how_to_verify' | 'category'>;

// A rule is its fixed fields, a `when` test, and a reason (fixed or built from the statement).
type RuleDef = Omit<Spec, 'reason'> & {
  reason: string | ((stmt: Stmt) => string);
  when: (stmt: Stmt) => boolean;
};

export function certain(spec: Spec, category: Category = 'danger'): RuleHit {
  return { ...spec, category, certainty: 'certain', assumption: '', how_to_verify: '' };
}

export function possible(spec: Spec, category: Category, assumption: string, how_to_verify: string): RuleHit {
  return { ...spec, category, certainty: 'possible', assumption, how_to_verify };
}

function toRule(def: RuleDef, build: (spec: Spec) => RuleHit): RuleFn {
  const { when, reason, ...fixed } = def;
  return (stmt) => (when(stmt) ? [build({ ...fixed, reason: typeof reason === 'string' ? reason : reason(stmt) })] : []);
}

export function certainRule(def: RuleDef, category: Category = 'danger'): RuleFn {
  return toRule(def, (spec) => certain(spec, category));
}

export function possibleRule(def: RuleDef, category: Category, assumption: string, how_to_verify: string): RuleFn {
  return toRule(def, (spec) => possible(spec, category, assumption, how_to_verify));
}
