import { useEffect, useState, useCallback } from 'react';
import { NavLink, Route, Routes, Navigate, useNavigate } from 'react-router-dom';
import { api, type SessionUser } from './api.js';
import { useNotifications } from './notifications.js';
import Login from './pages/Login.js';
import Signup from './pages/Signup.js';
import ResetPassword from './pages/ResetPassword.js';
import Team from './pages/Team.js';
import Dashboard from './pages/Dashboard.js';
import Actions from './pages/Actions.js';
import ActionDetail from './pages/ActionDetail.js';
import Connections from './pages/Connections.js';
import Tools from './pages/Tools.js';
import Evidence from './pages/Evidence.js';
import Audit from './pages/Audit.js';
import Improvements from './pages/Improvements.js';
import ImprovementDetail from './pages/ImprovementDetail.js';
import Incidents from './pages/Incidents.js';
import Identities from './pages/Identities.js';
import Onboarding from './pages/Onboarding.js';
import Help from './pages/Help.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), section 62. Session state is never assumed:
 * on load, this component asks the real backend `GET /api/session/me` and renders nothing authenticated
 * until that real answer comes back. There is no "logged in" flag persisted or guessed client-side.
 */
type LoadState = { readonly kind: 'loading' } | { readonly kind: 'anonymous' } | { readonly kind: 'authenticated'; readonly user: SessionUser };

const SEVERITY_DOT: Record<string, string> = { CRITICAL: 'var(--bad)', HIGH: 'var(--bad)', MEDIUM: 'var(--warn)', LOW: 'var(--muted)' };

function NotificationBell({ permissions }: { readonly permissions: readonly string[] }) {
  const { items, unseenCount, markAllSeen } = useNotifications(permissions.includes('incident.read'), permissions.includes('action.read'));
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <div style={{ position: 'relative', padding: '0 20px 12px' }}>
      <button className="secondary" onClick={() => { setOpen(!open); if (!open) markAllSeen(); }} style={{ width: '100%' }}>
        Notifications{unseenCount > 0 ? ` (${unseenCount})` : ''}
      </button>
      {open && (
        <div className="panel" style={{ position: 'absolute', left: 20, right: 20, top: '100%', zIndex: 10, maxHeight: 300, overflowY: 'auto' }}>
          {items.length === 0 ? <p className="muted" style={{ margin: 0 }}>No open items.</p> : items.map(n => (
            <div key={n.id} style={{ marginBottom: 8, cursor: 'pointer' }} onClick={() => { navigate(n.href); setOpen(false); }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: SEVERITY_DOT[n.severity], marginRight: 6 }} />
              {n.summary}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const refresh = useCallback(() => {
    api.me().then(user => setState({ kind: 'authenticated', user })).catch(() => setState({ kind: 'anonymous' }));
  }, []);
  useEffect(refresh, [refresh]);

  if (state.kind === 'loading') return <div className="login-shell"><span className="muted">Loading…</span></div>;
  if (state.kind === 'anonymous') {
    // `/signup` and `/reset-password` must be reachable with NO session at all — they are how one gets
    // created/changed in the first place. Both still require a real, admin-issued token in the URL; there
    // is no route here that creates or changes an account without one.
    return (
      <Routes>
        <Route path="/signup" element={<Signup onSignedUp={refresh} />} />
        <Route path="/reset-password" element={<ResetPassword onReset={refresh} />} />
        <Route path="*" element={<Login onLoggedIn={refresh} />} />
      </Routes>
    );
  }

  const handleLogout = () => { api.logout().finally(() => setState({ kind: 'anonymous' })); };

  return (
    <div>
      {/* Build-order item 17: the environment is now real backend state (`GET /api/session/me`), never a
          frontend constant — a user approving a HELD action must never be misled about whether they are
          acting on production. An unrecognized value still renders as `development`'s styling (the
          least-trusted-looking option) rather than defaulting to a falsely reassuring one. */}
      <div className={`env-banner ${['development', 'staging', 'production'].includes(state.user.environment ?? '') ? state.user.environment : 'development'}`}>
        {(state.user.environment ?? 'development').toUpperCase()}
      </div>
      <div className="app-shell">
        <nav className="sidebar">
          <div className="brand">TNA Control Center</div>
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/actions">Actions</NavLink>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/tools">Tools</NavLink>
          <NavLink to="/evidence">Evidence</NavLink>
          <NavLink to="/audit">Audit</NavLink>
          <NavLink to="/improvements">Improvements</NavLink>
          <NavLink to="/incidents">Incidents</NavLink>
          <NavLink to="/identities">Identities</NavLink>
          <NavLink to="/onboarding">Onboarding</NavLink>
          <NavLink to="/help">Help</NavLink>
          {state.user.permissions?.includes('user.invite') && <NavLink to="/team">Team</NavLink>}
          <NotificationBell permissions={state.user.permissions ?? []} />
          <div style={{ padding: '16px 20px 4px', fontSize: 12 }} className="muted">
            {state.user.username} · {state.user.role}<br />tenant: {state.user.tenant_id}
          </div>
          <button className="secondary" style={{ margin: '8px 20px' }} onClick={handleLogout}>Log out</button>
        </nav>
        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/actions" element={<Actions />} />
            <Route path="/actions/:id" element={<ActionDetail role={state.user.role} environment={state.user.environment ?? 'development'} />} />
            <Route path="/connections" element={<Connections />} />
            <Route path="/tools" element={<Tools role={state.user.role} environment={state.user.environment ?? 'development'} />} />
            <Route path="/evidence" element={<Evidence />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/improvements" element={<Improvements />} />
            <Route path="/improvements/:id" element={<ImprovementDetail role={state.user.role} environment={state.user.environment ?? 'development'} />} />
            <Route path="/incidents" element={<Incidents role={state.user.role} />} />
            <Route path="/identities" element={<Identities role={state.user.role} />} />
            <Route path="/onboarding" element={<Onboarding role={state.user.role} />} />
            <Route path="/help" element={<Help />} />
            <Route path="/help/:slug" element={<Help />} />
            <Route path="/team" element={<Team role={state.user.role} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
