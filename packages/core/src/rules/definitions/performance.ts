import { possibleRule } from '../define';

const LEADING_WILDCARD = /\bI?LIKE\s+(?:BINARY\s+)?(?:[EN]\s*)?['"]%|\bI?LIKE\s+CONCAT\s*\(\s*['"]%/i;

export const leadingWildcardLike = possibleRule(
  {
    id: 'leading-wildcard-like',
    level: 'low',
    reason: 'This LIKE pattern starts with %, so the database usually cannot use an index and has to scan every row.',
    changesData: false,
    matchesModel: /leading wildcard|LIKE\s*'%|B-?tree/i,
    when: (s) => LEADING_WILDCARD.test(s.noComments),
  },
  'performance',
  'The column has a standard B-tree index.',
  'Run EXPLAIN (without ANALYZE) and look for a sequential scan.',
);

// RAND( or RANDOM( inside an ORDER BY, not crossing into another clause.
const ORDER_BY_RANDOM =
  /\bORDER\s+BY\b(?:(?!\b(?:FROM|WHERE|SELECT|GROUP|HAVING|LIMIT|OFFSET|UNION)\b)[^;])*?\b(?:RAND|RANDOM)\s*\(/i;

export const orderByRandom = possibleRule(
  {
    id: 'order-by-random',
    level: 'low',
    reason: 'ORDER BY a random value makes the database compute and sort a random number for every row.',
    changesData: false,
    matchesModel: /RAND\(|RANDOM\(|ORDER BY RAND/i,
    when: (s) => ORDER_BY_RANDOM.test(s.stripped),
  },
  'performance',
  'The table has many rows, so sorting all of them is costly.',
  'Run EXPLAIN (without ANALYZE) and look for a sort over the whole table.',
);
