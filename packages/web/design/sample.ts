import type { FinalAnalysis } from '@qa/core/types';

// Sample data for the design preview only; replace with a real run when judging copy.
export const SAMPLE_QUERY = `DELETE FROM orders o
USING customers c
WHERE o.customer_id = c.id
  AND c.email LIKE '%@loadtest.internal'
  AND o.created_at < now() - interval '90 days';`;

export const SAMPLE_ANALYSIS: FinalAnalysis = {
  is_query: true,
  not_a_query_message: '',
  query_type: { language: 'postgresql', dialect_note: '', confidence: 'high' },
  what_it_does:
    'Deletes every order older than 90 days that belongs to a customer with an @loadtest.internal email address.',
  simple_explanation: 'Clears out old orders from test accounts.',
  detailed_explanation:
    'PostgreSQL joins orders to customers through USING, keeps the pairs where the email ends in @loadtest.internal and the order is more than 90 days old, and removes those order rows. Nothing is returned, so you only learn how many rows went.',
  step_by_step: [
    { snippet: 'DELETE FROM orders o', explanation: 'Removes rows from the orders table, called o below.' },
    { snippet: 'USING customers c', explanation: "Brings in customers so the filter can look at each order's customer." },
    { snippet: 'WHERE o.customer_id = c.id', explanation: 'Pairs each order with the customer who placed it.' },
    { snippet: "AND c.email LIKE '%@loadtest.internal'", explanation: 'Keeps only customers whose email ends in @loadtest.internal.' },
    {
      snippet: "AND o.created_at < now() - interval '90 days'",
      explanation: 'Keeps only orders placed more than 90 days ago.',
    },
  ],
  improvements: [
    'Run the same WHERE as a SELECT count(*) first to see how many orders will go.',
    'Delete in batches if more than a few thousand rows match, so locks stay short.',
  ],
  rewritten_query: {
    query: `BEGIN;

DELETE FROM orders o
USING customers c
WHERE o.customer_id = c.id
  AND c.email LIKE '%@loadtest.internal'
  AND o.created_at < now() - interval '90 days'
RETURNING o.id;

-- Check the returned ids, then COMMIT or ROLLBACK.`,
    reason: 'Runs inside a transaction and lists every deleted order, so you can check them before anything is final.',
  },
  security: { level: 'none', findings: [] },
  danger: {
    level: 'high',
    can_change_data: 'yes',
    data_change_summary: 'it deletes old orders from @loadtest.internal customers.',
    findings: [
      {
        reason: 'DELETE removes rows permanently. Outside a transaction there is no undo.',
        certainty: 'certain',
        assumption: '',
        how_to_verify: '',
        source: 'rule',
      },
      {
        reason: 'Other tables such as payments or shipments may point at these orders and be deleted with them.',
        certainty: 'possible',
        assumption: 'Foreign keys on orders use ON DELETE CASCADE.',
        how_to_verify: 'List the constraints that reference orders with \\d orders in psql.',
        source: 'ai',
      },
    ],
  },
  performance: {
    level: 'medium',
    findings: [
      {
        reason: 'A LIKE pattern that starts with % cannot use an index on email, so every customer row is read.',
        certainty: 'possible',
        assumption: 'customers holds many rows.',
        how_to_verify: 'Run EXPLAIN on the query and look for a Seq Scan on customers.',
        source: 'ai',
      },
    ],
  },
};
