import { useEffect, useRef, useState } from 'react';
import { MAX_QUERY_CHARS } from '@qa/core/types';
import type { Range } from './query';
import { QueryView } from './QueryView';

const nf = new Intl.NumberFormat('en-US');

// The formatter loads on first use, so it costs nothing until a query is pasted.
const loadFormat = () => import('./format').then((m) => m.formatQuery);

// Replace the box's text the way typing would, so Cmd+Z brings the old text back.
// - execCommand is the only way to keep the browser's undo; where it is missing, set the value.
function replaceText(el: HTMLTextAreaElement, value: string, set: (v: string) => void) {
  el.focus();
  el.select();
  const typed = typeof document.execCommand === 'function' && document.execCommand('insertText', false, value);
  if (!typed) set(value);
}

interface Props {
  onAnalyze: (query: string) => void;
  onClear: () => void;
  busy: boolean;
  // True once a result is on screen for `analyzed`.
  hasResult: boolean;
  // The query the result (or the running analysis) belongs to.
  analyzed: string | null;
  highlight: Range[];
  scan: Range | null;
}

export function QueryForm({ onAnalyze, onClear, busy, hasResult, analyzed, highlight, scan }: Props) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(true);
  const box = useRef<HTMLTextAreaElement>(null);
  const focusBox = useRef(false);

  const tooLong = text.length > MAX_QUERY_CHARS;
  const disabled = busy || tooLong || text.trim() === '';
  // While it runs and once it is answered, the query shows as code so its parts can light up.
  const showView = busy || (!editing && hasResult);
  const shown = analyzed ?? text;

  useEffect(() => {
    if (!showView && focusBox.current) {
      focusBox.current = false;
      box.current?.focus();
    }
  }, [showView]);

  async function format() {
    const el = box.current;
    if (!el || !text.trim()) return;
    const formatted = (await loadFormat())(text);
    if (formatted !== text) replaceText(el, formatted, setText);
  }

  // A paste that fills the whole box is laid out as a formatted query.
  async function pasteFormatted(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    const whole = el.value === '' || (el.selectionStart === 0 && el.selectionEnd === el.value.length);
    const raw = e.clipboardData.getData('text/plain');
    if (!whole || !raw.trim()) return;
    e.preventDefault();
    const formatted = (await loadFormat())(raw);
    replaceText(el, formatted, setText);
  }

  function edit() {
    focusBox.current = true;
    setEditing(true);
  }

  return (
    <form
      className="panel query-panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        setEditing(false);
        onAnalyze(text);
      }}
    >
      <label htmlFor="query">Paste a database or log query</label>
      <p className="hint" id="query-hint">
        Tested on PostgreSQL, MySQL and CloudWatch Logs Insights. Anything else is explained on a
        best-effort basis, with lower confidence.
      </p>
      {showView ? (
        <QueryView text={shown} highlight={highlight} scan={scan} onEdit={busy ? undefined : edit} />
      ) : (
        <textarea
          ref={box}
          id="query"
          spellCheck={false}
          aria-describedby="query-hint query-count"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => void pasteFormatted(e)}
        />
      )}
      <div className="actions">
        <button className="btn-primary" type="submit" disabled={disabled}>
          Analyze
        </button>
        {showView && !busy && (
          <button className="btn-ghost" type="button" onClick={edit}>
            Edit
          </button>
        )}
        {!showView && (
          <button className="btn-ghost" type="button" disabled={text.trim() === ''} onClick={() => void format()}>
            Format
          </button>
        )}
        <button
          className="btn-ghost"
          type="button"
          onClick={() => {
            setText('');
            setEditing(true);
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
