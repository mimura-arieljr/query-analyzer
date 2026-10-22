import { dropTruncate, grantRevoke, insertSelectInto, merge, replaceInto } from './definitions/destructive';
import { leadingWildcardLike, orderByRandom } from './definitions/performance';
import { hardcodedPassword, stringBuiltSql } from './definitions/security';
import { alwaysTrue, cteBodies, dataModifyingCte, noWhere, withWhere } from './definitions/write-safety';
import type { RuleFn } from './types';

// Rules are independent, so the order only sets the order hits are reported in.
export const RULES: RuleFn[] = [
  noWhere,
  alwaysTrue,
  dropTruncate,
  dataModifyingCte,
  withWhere,
  cteBodies,
  insertSelectInto,
  grantRevoke,
  replaceInto,
  merge,
  stringBuiltSql,
  hardcodedPassword,
  leadingWildcardLike,
  orderByRandom,
];
