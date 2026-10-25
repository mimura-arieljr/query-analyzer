import { useEffect, useRef, useState } from 'react';
import type {
  CategoryResult,
  DangerResult,
  FinalAnalysis,
  FinalFinding,
  Level,
  QueryType,
} from '@qa/core/types';

const LEVEL_LABEL: Record<Level, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const LANGUAGE_LABEL: Record<QueryType['language'], string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  cloudwatch_logs_insights: 'CloudWatch Logs Insights',
  other: 'Other SQL',
  unknown: 'Unknown',
};

const LEVEL_BARS: Record<Level, number> = { none: 0, low: 1, medium: 2, high: 3 };

// Three rising bars, filled up to the level; the label stays the accessible text.
function Meter({ level }: { level: Level }) {
  return (
    <span className="meter" aria-hidden="true">
      {[1, 2, 3].map((n) => (
        <i key={n} className={n <= LEVEL_BARS[level] ? 'on' : undefined} />
      ))}
    </span>
  );
}

function Badge({ level }: { level: Level }) {
  return (
    <span className={`badge ${level}`}>
      <Meter level={level} />
      {LEVEL_LABEL[level]}
    </span>
  );
}

function dangerLine(danger: DangerResult<FinalFinding>): string {
  const summary = danger.data_change_summary.trim();
  switch (danger.can_change_data) {
    case 'yes':
      return summary ? `This query changes data: ${summary}` : 'This query changes data.';
    case 'no':
      // GRANT and similar change no rows but still carry danger.
      return danger.level === 'none'
        ? 'This query only reads data.'
        : 'This query does not change table rows, but see the danger findings below.';
    default:
      return summary
        ? `Unclear whether this query changes data: ${summary}`
        : 'Unclear whether this query changes data.';
  }
}

function Banner({ danger }: { danger: DangerResult<FinalFinding> }) {
  return (
    <div className={`banner ${danger.level}`} role="alert">
      <span className="tag">
        <Meter level={danger.level} />
        Danger: {danger.level}
      </span>
      <p>{dangerLine(danger)}</p>
    </div>
  );
}

function FindingItem({ finding }: { finding: FinalFinding }) {
  const certain = finding.certainty === 'certain';
  return (
    <div className={`finding ${finding.certainty}`}>
      <div className="row">
        <span className="tag-s">{certain ? 'Certain' : 'Possible'}</span>
        {finding.source === 'rule' ? (
          <span className="tag-s rule">Rule check</span>
        ) : (
          <span className="tag-s">AI</span>
        )}
      </div>
      {finding.reason}
      {!certain && (finding.assumption || finding.how_to_verify) && (
        <dl>
          {finding.assumption && (
            <div>
              <dt>Assumed:</dt> <dd>{finding.assumption}</dd>
            </div>
          )}
          {finding.how_to_verify && (
            <div>
              <dt>Check it:</dt> <dd>{finding.how_to_verify}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

function CategoryCard({ title, result }: { title: string; result: CategoryResult<FinalFinding> }) {
  const { level, findings } = result;
  return (
    <div className="card">
      <div className="cat-head">
        <h2>{title}</h2>
        <Badge level={level} />
      </div>
      {findings.map((f, i) => (
        <FindingItem key={i} finding={f} />
      ))}
      {findings.length === 0 && (
        <p className="empty">{level === 'none' ? 'No findings.' : 'No specific issue listed'}</p>
      )}
    </div>
  );
}

function RewriteCard({ query, reason }: { query: string; reason: string }) {
  const [label, setLabel] = useState('Copy');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    let next = 'Copied';
    try {
      await navigator.clipboard.writeText(query);
    } catch {
      next = "Couldn't copy";
    }
    setLabel(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLabel('Copy'), 2000);
  }

  return (
    <div className="card">
      <div className="cat-head">
        <h2>Rewritten query</h2>
        <button type="button" className="btn-ghost small" onClick={() => void copy()}>
          {label}
        </button>
      </div>
      <pre className="code">
        <code>{query}</code>
      </pre>
      {reason && <p className="muted">{reason}</p>}
    </div>
  );
}

export function ResultView({ analysis }: { analysis: FinalAnalysis }) {
  if (!analysis.is_query) {
    return (
      <div className="card">
        <p>{analysis.not_a_query_message}</p>
      </div>
    );
  }
  const { query_type: qt } = analysis;
  return (
    <>
      <Banner danger={analysis.danger} />

      <div className="card">
        <h2>What it does</h2>
        <div className="meta">
          <span className="chip accent">{LANGUAGE_LABEL[qt.language]}</span>
          <span className="chip">Confidence: {qt.confidence}</span>
          {qt.dialect_note && <span className="chip">{qt.dialect_note}</span>}
        </div>
        <p>{analysis.what_it_does}</p>
        {analysis.simple_explanation && (
          <p className="muted">In plain words: {analysis.simple_explanation}</p>
        )}
        {analysis.detailed_explanation && (
          <details>
            <summary>Show the detailed explanation</summary>
            <p className="detail">{analysis.detailed_explanation}</p>
          </details>
        )}
      </div>

      {analysis.step_by_step.length > 0 && (
        <div className="card">
          <h2>Step by step</h2>
          <table>
            <thead>
              <tr>
                <th className="part">Part</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {analysis.step_by_step.map((s, i) => (
                <tr key={i}>
                  <td>
                    <code>{s.snippet}</code>
                  </td>
                  <td>{s.explanation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="cats">
        <CategoryCard title="Security" result={analysis.security} />
        <CategoryCard title="Danger" result={analysis.danger} />
        <CategoryCard title="Performance" result={analysis.performance} />
      </div>

      {analysis.improvements.length > 0 && (
        <div className="card">
          <h2>Improvements</h2>
          <ul>
            {analysis.improvements.map((tip, i) => (
              <li key={i}>{tip}</li>
            ))}
          </ul>
        </div>
      )}

      {analysis.rewritten_query.query.trim() !== '' && (
        <RewriteCard
          query={analysis.rewritten_query.query}
          reason={analysis.rewritten_query.reason}
        />
      )}
    </>
  );
}
