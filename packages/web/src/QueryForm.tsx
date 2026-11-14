import { useState } from 'react';
import { MAX_QUERY_CHARS } from '@qa/core/types';

const nf = new Intl.NumberFormat('en-US');

interface Props {
  onAnalyze: (query: string) => void;
  onClear: () => void;
  busy: boolean;
  // True while the wait panel is on its "risky patterns" step: a line sweeps the query.
  scanning?: boolean;
}

export function QueryForm({ onAnalyze, onClear, busy, scanning = false }: Props) {
  const [text, setText] = useState('');
  const tooLong = text.length > MAX_QUERY_CHARS;
  const disabled = busy || tooLong || text.trim() === '';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onAnalyze(text);
      }}
    >
      <label htmlFor="query">Paste a database or log query</label>
      <p className="hint" id="query-hint">
        Tested on PostgreSQL, MySQL and CloudWatch Logs Insights. Anything else is explained on a
        best-effort basis, with lower confidence.
      </p>
      <div className={scanning ? 'query-field scanning' : 'query-field'}>
        <textarea
          id="query"
          spellCheck={false}
          aria-describedby="query-hint query-count"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="actions">
        <button className="btn-primary" type="submit" disabled={disabled}>
          Analyze
        </button>
        <button
          className="btn-ghost"
          type="button"
          onClick={() => {
            setText('');
            onClear();
          }}
        >
          Clear
        </button>
        <span className={tooLong ? 'counter over' : 'counter'} id="query-count">
          {nf.format(text.length)} / {nf.format(MAX_QUERY_CHARS)} characters
        </span>
      </div>
    </form>
  );
}
