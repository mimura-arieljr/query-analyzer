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

function ThemeIcon({ theme }: { theme: Theme }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {theme === 'dark' ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>
      ) : (
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      )}
    </svg>
  );
}

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
    <div className={secret === null ? 'wrap wrap-gate' : 'wrap'}>
      <header>
        {secret !== null && (
          <h1>
            Query <span>Analyzer</span>
          </h1>
        )}
        <button
          className="theme"
          type="button"
          aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <ThemeIcon theme={theme} />
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
