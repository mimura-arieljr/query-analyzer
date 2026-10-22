import { useEffect, useRef, useState } from 'react';
import { checkSecret } from './api';

interface Props {
  onUnlock: (secret: string) => void;
  notice?: string;
}

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

function InfoIcon() {
  return (
    <svg
      className="info-icon"
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
      <circle cx="12" cy="12" r="10" />
      <path d="M12 11v5" />
      <path d="M12 7.5h.01" />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }) {
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
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

function UnlockIcon({ busy }: { busy: boolean }) {
  return (
    <svg
      className={busy ? 'spin' : undefined}
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
      {busy ? (
        <path d="M12 3a9 9 0 1 0 9 9" />
      ) : (
        <>
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 7.5-2" />
        </>
      )}
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
  const [helpOpen, setHelpOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const helpButton = useRef<HTMLButtonElement>(null);
  const helpWrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // While the help is open: Escape or a click elsewhere closes it.
  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setHelpOpen(false);
      helpButton.current?.focus();
    };
    const onPress = (e: MouseEvent) => {
      if (!helpWrap.current?.contains(e.target as Node)) setHelpOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPress);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPress);
    };
  }, [helpOpen]);

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
        <h1>
          Query <span>Analyzer</span>
        </h1>
      </div>
      <p className="muted">
        This tool is private. Paste the shared secret that was created when it was deployed.
      </p>

      <div className="label-row" ref={helpWrap}>
        <label htmlFor="secret">Secret</label>
        <button
          ref={helpButton}
          className="info-button"
          type="button"
          aria-label="Where do I find it?"
          aria-expanded={helpOpen}
          aria-controls="secret-help"
          onClick={() => setHelpOpen(!helpOpen)}
        >
          <InfoIcon />
        </button>
        {helpOpen && (
          <div className="help-panel" id="secret-help">
            <ol>
              <li>Open the AWS console in the region you deployed this app to.</li>
              <li>
                Go to Secrets Manager and open the secret named in the <code>SecretName</code> output of
                the deploy (it is also on the stack's Outputs tab in CloudFormation).
              </li>
              <li>Choose Retrieve secret value and copy the value.</li>
            </ol>
            <p>Never paste it into chats, tickets or scripts.</p>
          </div>
        )}
      </div>
      <p className="hint" id="secret-hint">
        Kept in this tab only. It is forgotten when you refresh the page.
      </p>
      <div className="secret-field">
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
        <div className="field-actions">
          <button
            className="icon-button"
            type="button"
            aria-label={shown ? 'Hide' : 'Show'}
            title={shown ? 'Hide' : 'Show'}
            aria-pressed={shown}
            aria-controls="secret"
            onClick={() => setShown(!shown)}
          >
            <EyeIcon off={shown} />
          </button>
          <button
            className="icon-button primary"
            type="submit"
            aria-label={checking ? 'Checking...' : 'Unlock'}
            title={checking ? 'Checking...' : 'Unlock'}
            disabled={checking}
          >
            <UnlockIcon busy={checking} />
          </button>
        </div>
      </div>
      <p className="error" id="secret-error" role="alert">
        {message}
      </p>
    </form>
  );
}
