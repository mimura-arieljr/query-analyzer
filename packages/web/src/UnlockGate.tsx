import { useState } from 'react';
import { checkSecret } from './api';

interface Props {
  onUnlock: (secret: string) => void;
  notice?: string;
}

export function UnlockGate({ onUnlock, notice }: Props) {
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState(notice ?? '');
  const [checking, setChecking] = useState(false);

  async function submit() {
    if (checking) return;
    if (secret === '') {
      setMessage('Wrong or missing secret.');
      return;
    }
    setChecking(true);
    setMessage('');
    const result = await checkSecret(secret);
    setChecking(false);
    if (result === 'ok') onUnlock(secret);
    else if (result === 'wrong') setMessage('Wrong or missing secret.');
    else setMessage("Couldn't reach the server. Try again.");
  }

  return (
    <form
      className="unlock"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="secret">Secret</label>
      <p className="hint" id="secret-hint">
        Enter the shared secret to use this tool.
      </p>
      <input
        id="secret"
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-describedby="secret-hint"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
      />
      <div className="actions">
        <button className="btn-primary" type="submit" disabled={checking}>
          Unlock
        </button>
      </div>
      <p className="error" role="alert">
        {message}
      </p>
    </form>
  );
}
