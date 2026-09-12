import { useEffect, useState, useCallback } from 'react';
import { api, ApiError, type ServiceIdentity } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Identity / credential lifecycle UX. Every
 * identity row is the real Volume 10 `ClientServiceIdentity` record. A real bearer token is rendered
 * EXACTLY ONCE, immediately after a real `createIdentity`/`rotateCredential` response — held only in this
 * component's own in-memory state for the current page view, never written to `localStorage`,
 * `sessionStorage`, any log, or any analytics call, and cleared the moment the operator dismisses it or
 * navigates away. There is no "REVEAL" affordance for a past credential anywhere in this UI, because the
 * real backend itself never stores or returns the plaintext value again after issuance.
 */
const CAN_MUTATE = new Set(['client-admin']);
const ROLES = ['agent-client', 'tool-provider', 'operator', 'read-only-auditor'];

function StatusBadge({ status }: { readonly status: string }) {
  return <span className={`status-badge ${status === 'ACTIVE' ? 'status-AVAILABLE' : 'status-UNAVAILABLE'}`}>{status}</span>;
}

export default function Identities({ role }: { readonly role: string }) {
  const [identities, setIdentities] = useState<readonly ServiceIdentity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', role: ROLES[0]! });
  const [revealedCredential, setRevealedCredential] = useState<{ readonly forName: string; readonly credential_ref: string; readonly token: string } | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.identities().then(page => setIdentities(page.items)).catch(() => setError('Could not load service identities from the backend.'));
  }, []);
  useEffect(load, [load]);

  const canMutate = CAN_MUTATE.has(role);

  const runCreate = () => {
    if (form.name.trim().length === 0) { setError('A name is required.'); return; }
    setBusyId('__create__');
    api.createIdentity(form.name.trim(), form.role)
      .then(res => { setRevealedCredential({ forName: form.name.trim(), ...res.credential }); setCreating(false); setForm({ name: '', role: ROLES[0]! }); load(); })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Create failed'))
      .finally(() => setBusyId(null));
  };
  const runRotate = (identity: ServiceIdentity) => {
    setBusyId(identity.service_id);
    api.rotateCredential(identity.service_id, identity.state_version)
      .then(res => { setRevealedCredential({ forName: identity.name, ...res.credential }); load(); })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Rotate failed'))
      .finally(() => setBusyId(null));
  };
  const runRevoke = (identity: ServiceIdentity) => {
    setBusyId(identity.service_id);
    api.revokeIdentity(identity.service_id, identity.state_version).then(load).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Revoke failed')).finally(() => setBusyId(null));
  };

  if (error) return <p className="error-text">{error}</p>;
  if (!identities) return <p className="muted">Loading service identities…</p>;

  return (
    <div>
      <h1>Identities</h1>

      {revealedCredential && (
        <div className="panel" style={{ borderColor: 'var(--warn)' }}>
          <h3 style={{ marginTop: 0 }}>Credential for "{revealedCredential.forName}" — shown once</h3>
          <p className="muted" style={{ fontSize: 12 }}>This is the only time this token will ever be shown. It is not stored anywhere by this browser.</p>
          <p>Reference: <code>{revealedCredential.credential_ref}</code></p>
          <p style={{ wordBreak: 'break-all' }}>Token: <code>{revealedCredential.token}</code></p>
          <button className="secondary" onClick={() => setRevealedCredential(null)}>I have copied this — dismiss</button>
        </div>
      )}

      {canMutate && (
        <div className="panel">
          {creating ? (
            <div>
              <label>Name<input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
              <label>Role
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} style={{ display: 'block', marginTop: 4 }}>
                  {ROLES.map(r => <option key={r}>{r}</option>)}
                </select>
              </label>
              <div style={{ marginTop: 8 }}>
                <button onClick={runCreate} disabled={busyId === '__create__'}>{busyId === '__create__' ? 'Creating…' : 'Confirm create'}</button>{' '}
                <button className="secondary" onClick={() => setCreating(false)} disabled={busyId === '__create__'}>Cancel</button>
              </div>
            </div>
          ) : <button onClick={() => setCreating(true)}>Create service identity…</button>}
        </div>
      )}

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Credential ref</th><th>Last rotated</th><th></th></tr></thead>
          <tbody>
            {identities.length === 0
              ? <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>No service identities for this tenant.</td></tr>
              : identities.map(i => (
                <tr key={i.service_id}>
                  <td>{i.name}</td>
                  <td className="muted">{i.role}</td>
                  <td><StatusBadge status={i.status} /></td>
                  <td className="muted">{i.credential_ref}</td>
                  <td className="muted">{i.last_rotated_at}</td>
                  <td>
                    {canMutate && i.status === 'ACTIVE' && (
                      <>
                        <button className="secondary" style={{ marginRight: 6 }} disabled={busyId === i.service_id} onClick={() => runRotate(i)}>{busyId === i.service_id ? '…' : 'Rotate'}</button>
                        <button className="secondary" disabled={busyId === i.service_id} onClick={() => runRevoke(i)}>{busyId === i.service_id ? '…' : 'Revoke'}</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!canMutate && <p className="muted">Your role ({role}) cannot create, rotate, or revoke identities — a client-admin is required.</p>}
    </div>
  );
}
