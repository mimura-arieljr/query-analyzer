import { useEffect, useState } from 'react';
import type { ErrorCode } from '@qa/core/types';
import { QueryForm } from './QueryForm';
import { ResultView } from './ResultView';
import { UnlockGate } from './UnlockGate';
import { useAnalyzer } from './useAnalyzer';

type Theme = 'dark' | 'light';

const ERROR_TEXT: Record<Exclude<ErrorCode, 'unauthorized'>, string> = {
  empty: 'Paste a query to analyze.',
  too_long: 'Too long (limit 20,000 characters).',
  bad_request: 'That request was not valid.',
  throttled: 'Too many requests. Wait a moment and try again.',
  bad_output: "Couldn't analyse that. Try again.",
  failed: "Couldn't analyse that. Try again.",
};

function initialTheme(): Theme {
  const light =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches;
  return light ? 'light' : 'dark';
}

function Workspace({ secret, onUnauthorized }: { secret: string; onUnauthorized: () => void }) {
  const { status, result, error, run, clear } = useAnalyzer(secret);

  useEffect(() => {
    if (error === 'unauthorized') onUnauthorized();
  }, [error, onUnauthorized]);

  return (
    <>
      <QueryForm onAnalyze={run} onClear={clear} busy={status === 'loading'} />
      <section className="result" aria-live="polite">
        {status === 'loading' && <p className="muted">Analyzing...</p>}
        {status === 'error' && error && error !== 'unauthorized' && (
          <p className="error">{ERROR_TEXT[error]}</p>
        )}
        {status === 'done' && result && <ResultView analysis={result} />}
      </section>
    </>
  );
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // The secret lives in React state only.
  const [secret, setSecret] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className="wrap">
      <header>
        <h1>
          Query <span>Analyzer</span>
        </h1>
        <button
          className="theme"
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
      </header>
      {secret === null ? (
        <UnlockGate
          notice={notice}
          onUnlock={(s) => {
            setNotice('');
            setSecret(s);
          }}
        />
      ) : (
        <Workspace
          secret={secret}
          onUnauthorized={() => {
            setNotice('Wrong or missing secret.');
            setSecret(null);
          }}
        />
      )}
    </div>
  );
}
