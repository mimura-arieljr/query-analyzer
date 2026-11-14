import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  CategoryResult,
  DangerResult,
  FinalAnalysis,
  FinalFinding,
  Level,
  QueryType,
} from '@qa/core/types';
import { findInOrder, type Range } from './query';
import { Code } from './QueryView';

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

// Sections rise in one after another; `i` is the section's place in that order.
function rise(i: number): CSSProperties {
  return { '--i': i } as CSSProperties;
}

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

function Verdict({ danger }: { danger: DangerResult<FinalFinding> }) {
  return (
    <div className={`verdict ${danger.level} rv`} role="alert" style={rise(0)}>
      <span className={danger.level === 'high' ? 'tag pulse' : 'tag'}>
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
      <p>{finding.reason}</p>
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

function Category({ title, result }: { title: string; result: CategoryResult<FinalFinding> }) {
  const { level, findings } = result;
  const count = findings.length;
  return (
    <section className={`cat ${level}`}>
      <div className="cat-head">
        <h3>{title}</h3>
        <span className="count">
          {count} {count === 1 ? 'finding' : 'findings'}
        </span>
        <Badge level={level} />
      </div>
      {findings.map((f, i) => (
        <FindingItem key={i} finding={f} />
      ))}
      {count === 0 && <p className="empty">{level === 'none' ? 'No findings.' : 'No specific issue listed'}</p>}
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [label, setLabel] = useState('Copy');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    let next = 'Copied';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = "Couldn't copy";
    }
    setLabel(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLabel('Copy'), 2000);
  }

  return (
    <button type="button" className="btn-ghost small" onClick={() => void copy()}>
      {label}
    </button>
  );
}

type Highlight = (range: Range | null) => void;

// Hover or focus a row to light up its part of the query.
function hoverProps(onHighlight: Highlight, range: Range) {
  const on = () => onHighlight(range);
  const off = () => onHighlight(null);
  return { tabIndex: 0, onMouseEnter: on, onMouseLeave: off, onFocus: on, onBlur: off };
}

function Steps({
  analysis,
  query,
  onHighlight,
  index,
}: {
  analysis: FinalAnalysis;
  query: string;
  onHighlight: Highlight;
  index: number;
}) {
  const steps = analysis.step_by_step;
  const ranges = useMemo(() => findInOrder(query, steps.map((s) => s.snippet)), [query, steps]);
  const linked = ranges.some(Boolean);
  return (
    <div className="panel rv" style={rise(index)}>
      <div className="panel-head">
        <h2>Step by step</h2>
        {linked && <p className="aside">Hover a part to find it in your query</p>}
      </div>
      <table className="steps">
        <thead>
          <tr>
            <th className="part">Part</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => {
            const r = ranges[i];
            return (
              <tr key={i} className={r ? 'linked' : undefined} {...(r ? hoverProps(onHighlight, r) : {})}>
                <td>
                  <code>{s.snippet}</code>
                </td>
                <td>{s.explanation}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Props {
  analysis: FinalAnalysis;
  // The query this result belongs to, for finding each step's part.
  query?: string;
  onHighlight?: Highlight;
}

const noop: Highlight = () => {};

export function ResultView({ analysis, query = '', onHighlight = noop }: Props) {
  if (!analysis.is_query) {
    return (
      <div className="panel rv" style={rise(0)}>
        <p>{analysis.not_a_query_message}</p>
      </div>
    );
  }
  const { query_type: qt } = analysis;
  const rewrite = analysis.rewritten_query.query.trim() !== '';
  const tips = analysis.improvements;
  // The verdict is 0 and "What it does" is 1; the rest count on from there.
  let i = 2;
  return (
    <>
      <Verdict danger={analysis.danger} />

      <div className="panel rv" style={rise(1)}>
        <div className="panel-head">
          <h2>What it does</h2>
          <div className="meta">
            <span className="chip accent">{LANGUAGE_LABEL[qt.language]}</span>
            <span className="chip">Confidence: {qt.confidence}</span>
          </div>
        </div>
        {qt.dialect_note && <p className="note">{qt.dialect_note}</p>}
        <p className="lead">{analysis.what_it_does}</p>
        {analysis.simple_explanation && <p className="muted">In plain words: {analysis.simple_explanation}</p>}
        {analysis.detailed_explanation && (
          <details>
            <summary>Show the detailed explanation</summary>
            <p className="detail">{analysis.detailed_explanation}</p>
          </details>
        )}
      </div>

      {analysis.step_by_step.length > 0 && (
        <Steps analysis={analysis} query={query} onHighlight={onHighlight} index={i++} />
      )}

      <div className="panel findings rv" style={rise(i++)}>
        <h2>Findings</h2>
        <Category title="Danger" result={analysis.danger} />
        <Category title="Security" result={analysis.security} />
        <Category title="Performance" result={analysis.performance} />
      </div>

      {(rewrite || tips.length > 0) && (
        <div className="panel rv" style={rise(i++)}>
          {rewrite ? (
            <>
              <div className="panel-head">
                <h2>Rewritten query</h2>
                <CopyButton text={analysis.rewritten_query.query} />
              </div>
              <Code text={analysis.rewritten_query.query} />
              {analysis.rewritten_query.reason && <p className="muted">{analysis.rewritten_query.reason}</p>}
              {tips.length > 0 && <h3 className="sub">Improvements</h3>}
            </>
          ) : (
            <h2>Improvements</h2>
          )}
          {tips.length > 0 && (
            <ul className="tips">
              {tips.map((tip, k) => (
                <li key={k}>{tip}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
