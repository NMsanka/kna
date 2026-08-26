import { useState, type FormEvent, type JSX } from 'react';
import { api, type Me } from '../api';

/**
 * The token is exchanged for a cookie and then forgotten.
 *
 * It is deliberately not kept in React state after the exchange, and never in `localStorage`:
 * the only copy in the browser is the httpOnly cookie, which no script on the page can read.
 */
export function SignIn(props: { onSignedIn: (me: Me) => void }): JSX.Element {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    api
      .signIn(token.trim())
      .then((me) => {
        setToken('');
        props.onSignedIn(me);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'That token was not accepted.'),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="shell">
      <form className="card narrow" onSubmit={submit}>
        <h1>Ask about our code</h1>
        <p className="muted small">
          Paste your KNA token. You will only ever be shown code you already have permission to
          read.
        </p>
        {error && <p className="error">{error}</p>}
        <label htmlFor="token">API token</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          placeholder="kna_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
        />
        <p style={{ marginTop: '1.25rem' }}>
          <button type="submit" disabled={busy || token.trim().length === 0}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </p>
        <p className="muted small">
          A stand-in for single sign-on, which is not built yet. The token is exchanged for an
          eight-hour cookie so you do not retype it.
        </p>
      </form>
    </div>
  );
}
