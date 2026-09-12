import { useEffect, useState } from 'react';
import { api, type DashboardSummary, type ComponentHealth } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), sections 6-8. Every value here comes from
 * `GET /api/dashboard`, which itself computes counts from real Platform data — there is no hardcoded
 * number in this component, and no single "SYSTEM SAFE" badge (section 8): status is scoped per real
 * component, and an unknown/unrecognized status string renders as UNKNOWN, never defaulted to healthy
 * (section 85/29 — "unknown must never render as safe").
 */
function StatusBadge({ status }: { readonly status: string }) {
  const known = ['AVAILABLE', 'DEGRADED', 'UNAVAILABLE'];
  const cls = known.includes(status) ? status : 'UNKNOWN';
  return <span className={`status-badge status-${cls}`}>{status}</span>;
}
function ComponentRow({ c }: { readonly c: ComponentHealth }) {
  return (
    <tr>
      <td style={{ textTransform: 'capitalize' }}>{c.component.replace(/_/g, ' ')}</td>
      <td><StatusBadge status={c.status} /></td>
      <td className="muted">{c.mandatory ? 'mandatory' : 'optional'}</td>
      <td className="muted">{typeof c.latency_ms === 'number' ? `${c.latency_ms}ms` : '—'}</td>
    </tr>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.dashboard().then(setData).catch(() => setError('Could not load dashboard from the backend.')); }, []);

  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <p className="muted">Loading dashboard…</p>;

  return (
    <div>
      <h1>Overview</h1>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Assurance</h3>
        <table>
          <thead><tr><th>Component</th><th>Status</th><th>Class</th><th>Latency</th></tr></thead>
          <tbody>
            {data.assurance.components.length === 0
              ? <tr><td colSpan={4} className="muted">No component health reported.</td></tr>
              : data.assurance.components.map(c => <ComponentRow key={c.component} c={c} />)}
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0, marginTop: 12 }}>
          Overall backend status: <StatusBadge status={data.assurance.status} />
        </p>
      </div>

      <div className="grid">
        <div className="metric"><div className="label">Actions (24h)</div><div className="value">{data.actions_last_24h}</div></div>
        <div className="metric"><div className="label">Blocked</div><div className="value">{data.blocked}</div></div>
        <div className="metric"><div className="label">Held (pending)</div><div className="value">{data.held}</div></div>
        <div className="metric"><div className="label">Terminated</div><div className="value">{data.terminated}</div></div>
        <div className="metric"><div className="label">Indeterminate</div><div className="value">{data.indeterminate}</div></div>
        <div className="metric"><div className="label">Total known actions</div><div className="value">{data.total_known_actions}</div></div>
      </div>
    </div>
  );
}
