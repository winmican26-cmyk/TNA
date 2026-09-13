import { useEffect, useState, useCallback } from 'react';
import { api, ApiError } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1. Team (Control-Center human user) management — distinct
 * from the Identities page, which governs Client Gateway SERVICE identities, not human logins. A
 * client-admin invites a teammate by fixing their username and role and receives a real, single-use
 * signup link shown exactly once; the invitee chooses only their own password. Password reset works the
 * same way: a real, single-use reset link, shown once, delivered by the admin out of band. No email
 * integration exists anywhere in this project — nothing here claims to have sent anything.
 */
const CAN_MANAGE = new Set(['client-admin']);
const ROLES = ['client-viewer', 'client-auditor', 'client-reviewer', 'client-admin'];

export default function Team({ role }: { readonly role: string }) {
  const [users, setUsers] = useState<readonly { username: string; role: string; created_at: string; disabled: boolean }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ username: '', role: ROLES[0]! });
  const [linkPanel, setLinkPanel] = useState<{ readonly title: string; readonly url: string; readonly expires_at: string } | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.users().then(page => setUsers(page.items)).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load team members.'));
  }, []);
  useEffect(load, [load]);

  const canManage = CAN_MANAGE.has(role);

  const runInvite = () => {
    if (form.username.trim().length === 0) { setError('A username is required.'); return; }
    setBusy('__invite__');
    api.inviteUser(form.username.trim(), form.role)
      .then(res => {
        setLinkPanel({ title: `Signup link for "${form.username.trim()}"`, url: `${window.location.origin}/signup?token=${res.token}`, expires_at: res.expires_at });
        setInviting(false);
        setForm({ username: '', role: ROLES[0]! });
        load();
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Invite failed'))
      .finally(() => setBusy(null));
  };
  const runResetLink = (username: string) => {
    setBusy(username);
    api.createPasswordResetToken(username)
      .then(res => setLinkPanel({ title: `Password reset link for "${username}"`, url: `${window.location.origin}/reset-password?token=${res.token}`, expires_at: res.expires_at }))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not create a reset link'))
      .finally(() => setBusy(null));
  };

  if (error) return <p className="error-text">{error}</p>;
  if (!users) return <p className="muted">Loading team…</p>;

  return (
    <div>
      <h1>Team</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        No email is sent by this console. A signup or reset link is real, single-use, and expiring — copy it and deliver it to the
        person yourself.
      </p>

      {linkPanel && (
        <div className="panel" style={{ borderColor: 'var(--warn)' }}>
          <h3 style={{ marginTop: 0 }}>{linkPanel.title} — shown once</h3>
          <p className="muted" style={{ fontSize: 12 }}>This link will not be shown again. Expires {linkPanel.expires_at}.</p>
          <p style={{ wordBreak: 'break-all' }}><code>{linkPanel.url}</code></p>
          <button className="secondary" onClick={() => setLinkPanel(null)}>I have copied this — dismiss</button>
        </div>
      )}

      {canManage && (
        <div className="panel">
          {inviting ? (
            <div>
              <label>Username<input type="text" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} /></label>
              <label>Role
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} style={{ display: 'block', marginTop: 4, marginBottom: 6 }}>
                  {ROLES.map(r => <option key={r}>{r}</option>)}
                </select>
              </label>
              <button onClick={runInvite} disabled={busy === '__invite__'}>{busy === '__invite__' ? 'Creating invite…' : 'Confirm invite'}</button>{' '}
              <button className="secondary" onClick={() => setInviting(false)} disabled={busy === '__invite__'}>Cancel</button>
            </div>
          ) : <button onClick={() => setInviting(true)}>Invite teammate…</button>}
        </div>
      )}

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Username</th><th>Role</th><th>Created</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {users.map(u => (
              <tr key={u.username}>
                <td>{u.username}</td>
                <td className="muted">{u.role}</td>
                <td className="muted">{u.created_at}</td>
                <td>{u.disabled ? <span className="status-badge status-UNAVAILABLE">DISABLED</span> : <span className="status-badge status-AVAILABLE">ACTIVE</span>}</td>
                <td>
                  {canManage && !u.disabled && (
                    <button className="secondary" disabled={busy === u.username} onClick={() => runResetLink(u.username)}>
                      {busy === u.username ? '…' : 'Create reset link'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!canManage && <p className="muted">Your role ({role}) cannot invite teammates or create reset links — a client-admin is required.</p>}
    </div>
  );
}
