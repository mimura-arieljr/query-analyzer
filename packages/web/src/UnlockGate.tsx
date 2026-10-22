import { useEffect, useRef, useState } from 'react';
import { checkSecret } from './api';

interface Props {
  onUnlock: (secret: string) => void;
  notice?: string;
}

const SECRET_NAME = 'query-analyzer-shared-secret';

function LockIcon() {
  return (
    <svg
      className="lock-icon"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function UnlockGate({ onUnlock, notice }: Props) {
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState(notice ?? '');
  // True only when the secret itself was rejected or missing.
  const [invalid, setInvalid] = useState(Boolean(notice));
  const [checking, setChecking] = useState(false);
  const [shown, setShown] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  function refocus() {
    input.current?.focus();
    input.current?.select();
  }

  async function submit() {
    if (checking) return;
    const value = secret.trim();
    if (value === '') {
      setMessage('Paste the secret first.');
      setInvalid(true);
      refocus();
      return;
    }
    setChecking(true);
    setMessage('');
    setInvalid(false);
    const result = await checkSecret(value);
    setChecking(false);
    if (result === 'ok') {
      onUnlock(value);
    } else if (result === 'wrong') {
      setMessage('Wrong or missing secret.');
      setInvalid(true);
      refocus();
    } else {
      setMessage("Couldn't reach the server. Try again.");
    }
  }

  return (
    <form
      className="unlock"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="unlock-head">
        <span className="lock-badge">
          <LockIcon />
        </span>
        <h2>Unlock</h2>
      </div>
      <p className="muted">
        This tool is private. Paste the shared secret that was created when it was deployed.
      </p>

      <label htmlFor="secret">Secret</label>
      <p className="hint" id="secret-hint">
        Kept in this tab only. It is forgotten when you refresh the page.
      </p>
      <div className="secret-row">
        <input
          ref={input}
          id="secret"
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          aria-invalid={invalid}
          aria-describedby={message ? 'secret-hint secret-error' : 'secret-hint'}
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value);
            setMessage('');
            setInvalid(false);
          }}
        />
        <button
          className="btn-ghost small"
          type="button"
          aria-pressed={shown}
          aria-controls="secret"
          onClick={() => setShown(!shown)}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>

      <div className="actions">
        <button className="btn-primary" type="submit" disabled={checking}>
          {checking ? 'Checking...' : 'Unlock'}
        </button>
      </div>
      <p className="error" id="secret-error" role="alert">
        {message}
      </p>

      <details className="help">
        <summary>Where do I find the secret?</summary>
        <ol>
          <li>Open the AWS console and switch to the region ap-southeast-2 (Sydney).</li>
          <li>
            Go to Secrets Manager and open <code>{SECRET_NAME}</code>.
          </li>
          <li>Choose Retrieve secret value and copy the value.</li>
        </ol>
        <p className="muted">Never paste the secret into chats, tickets or scripts.</p>
      </details>
    </form>
  );
}
