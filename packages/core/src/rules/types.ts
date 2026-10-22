import type { Category, Certainty, Level } from '../types';

export type RuleId =
  | 'delete-update-no-where'
  | 'always-true-where'
  | 'drop-truncate'
  | 'data-modifying-cte'
  | 'delete-update-with-where'
  | 'insert-select-into'
  | 'grant-revoke'
  | 'replace-into'
  | 'merge'
  | 'string-built-sql'
  | 'hardcoded-password'
  | 'leading-wildcard-like'
  | 'order-by-random'
  | 'logs-insights-read-only';

export interface RuleHit {
  id: RuleId;
  category: Category;
  level: Level;
  reason: string;
  certainty: Certainty;
  assumption: string;
  how_to_verify: string;
  changesData: boolean;
  matchesModel: RegExp;
}

// One statement as seen by the rules.
export interface Stmt {
  // Comments removed, strings blanked to ''.
  stripped: string;
  // Comments removed, strings intact.
  noComments: string;
  // First statement keyword, upper case; looks past a WITH clause.
  kind: string;
}

// Rules are independent: each reads only the statement, never another rule's hits.
export type RuleFn = (stmt: Stmt) => RuleHit[];
