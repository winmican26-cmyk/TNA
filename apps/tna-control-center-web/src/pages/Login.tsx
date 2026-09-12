import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.js';

export default function Login({ onLoggedIn }: { readonly onLoggedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    api.login(username, password)
      .then(onLoggedIn)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Login failed'))
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="login-shell">
      <form className="panel login-box" onSubmit={handleSubmit}>
        <h2 style={{ marginTop: 0 }}>TNA Control Center</h2>
        <p className="muted" style={{ marginTop: -8 }}>Sign in to your organization's tenant.</p>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="username">Username</label>
          <input id="username" type="text" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button type="submit" disabled={submitting} style={{ width: '100%' }}>{submitting ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
