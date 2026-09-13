import { useState, type FormEvent } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1. Redeems a real, admin-issued password-reset token (from
 * the URL, shared out of band by a client-admin). On success the real backend has already destroyed every
 * existing session for this account — this page never claims that itself, it only reports what the real
 * response confirmed.
 */
export default function ResetPassword({ onReset }: { readonly onReset: () => void }) {
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
    api.resetPassword(token, password)
      .then(() => setDone(true))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Reset failed'))
      .finally(() => setSubmitting(false));
  };

  if (!token) {
    return <div className="login-shell"><div className="panel login-box"><p className="error-text">This link is missing its reset token.</p></div></div>;
  }
  if (done) {
    return (
      <div className="login-shell">
        <div className="panel login-box">
          <h2 style={{ marginTop: 0 }}>Password reset</h2>
          <p>Your password has been changed, and any previously signed-in sessions for this account have been signed out.</p>
          <button style={{ width: '100%' }} onClick={() => { onReset(); navigate('/', { replace: true }); }}>Continue to sign in</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <form className="panel login-box" onSubmit={handleSubmit}>
        <h2 style={{ marginTop: 0 }}>Choose a new password</h2>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="password">New password</label>
          <input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="confirm">Confirm new password</label>
          <input id="confirm" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required minLength={12} />
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button type="submit" disabled={submitting} style={{ width: '100%' }}>{submitting ? 'Resetting…' : 'Reset password'}</button>
      </form>
    </div>
  );
}
