import { useState, type FormEvent } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1. Redeems a real, admin-issued signup invite token (from
 * the URL, shared out of band by a client-admin) — this page never lets the invitee choose their own
 * tenant or role, only their password. There is no email integration anywhere in this project; the token
 * itself is the only thing proving the invite is real.
 */
export default function Signup({ onSignedUp }: { readonly onSignedUp: () => void }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setSubmitting(true);
    api.signup(token, password)
      .then(() => setDone(true))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Signup failed'))
      .finally(() => setSubmitting(false));
  };

  if (!token) {
    return <div className="login-shell"><div className="panel login-box"><p className="error-text">This link is missing its invite token.</p></div></div>;
  }
  if (done) {
    return (
      <div className="login-shell">
        <div className="panel login-box">
          <h2 style={{ marginTop: 0 }}>Account created</h2>
          <p>Your account is ready.</p>
          <button style={{ width: '100%' }} onClick={() => { onSignedUp(); navigate('/', { replace: true }); }}>Continue to sign in</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <form className="panel login-box" onSubmit={handleSubmit}>
        <h2 style={{ marginTop: 0 }}>Set up your account</h2>
        <p className="muted" style={{ marginTop: -8 }}>Your organization's admin invited you. Choose a password to finish.</p>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="confirm">Confirm password</label>
          <input id="confirm" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required minLength={12} />
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button type="submit" disabled={submitting} style={{ width: '100%' }}>{submitting ? 'Creating account…' : 'Create account'}</button>
      </form>
    </div>
  );
}
