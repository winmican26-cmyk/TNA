import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type ImprovementGeneration } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Recursive-improvement generation list.
 *
 * Honest gap: the real, accepted `apps/tna-improvement-governor` (Volume 12) has no "list systems for a
 * tenant" HTTP route — `GET /v1/improvements` requires a specific, already-known system id. This page
 * therefore asks the operator/reviewer for that id rather than inventing a fabricated systems directory.
 * The system id is kept only in this component's own in-memory state for the lifetime of the page — this
 * project's frontend never uses `localStorage`/`sessionStorage` for anything, even non-sensitive UI
 * convenience, so nothing is remembered across a reload or a new tab.
 */

const STATUS_CLASS: Record<string, string> = {
  PROMOTED: 'status-AVAILABLE', REJECTED: 'status-UNAVAILABLE', ROLLED_BACK: 'status-DEGRADED',
  INDETERMINATE: 'status-UNKNOWN', PROPOSED: 'status-UNKNOWN', AUTHORIZED: 'status-UNKNOWN',
  BUILDING: 'status-UNKNOWN', BUILT: 'status-UNKNOWN', EVALUATING: 'status-UNKNOWN', EVALUATED: 'status-DEGRADED', CANARY: 'status-DEGRADED',
};
function StatusBadge({ status }: { readonly status: string }) {
  return <span className={`status-badge ${STATUS_CLASS[status] ?? 'status-UNKNOWN'}`}>{status}</span>;
}

export default function Improvements() {
  const [systemId, setSystemId] = useState('');
  const [items, setItems] = useState<readonly ImprovementGeneration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    if (systemId.trim().length === 0) { setError('A system ID is required.'); return; }
    setLoading(true);
    setError(null);
    api.improvements(systemId.trim())
      .then(page => setItems(page.items))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load generations from the backend.'))
      .finally(() => setLoading(false));
  };

  return (
    <div>
      <h1>Recursive Improvement</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        A successor can become better without automatically becoming more powerful. Every generation below, and its promotion/rejection
        outcome, is the real, unmodified state recorded by the governing backend.
      </p>

      <div className="panel">
        <label>System ID<input type="text" value={systemId} onChange={e => setSystemId(e.target.value)} placeholder="e.g. the internal system_id from a generation record" /></label>
        <button style={{ marginTop: 8 }} onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Load generations'}</button>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          The governor's real API has no "list all systems" route — paste a known system id (visible on any generation record) to list
          its generations.
        </p>
      </div>

      {error && <p className="error-text">{error}</p>}

      {items && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Generation</th><th>Parent</th><th>Class</th><th>Status</th><th>Candidate version</th><th>Created</th></tr></thead>
            <tbody>
              {items.length === 0
                ? <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>No generations recorded for this system.</td></tr>
                : items.map(g => (
                  <tr key={g.generation_id}>
                    <td><Link to={`/improvements/${encodeURIComponent(g.generation_id)}`}>{g.generation_id}</Link></td>
                    <td className="muted">{g.parent_generation_id ? <Link to={`/improvements/${encodeURIComponent(g.parent_generation_id)}`}>{g.parent_generation_id}</Link> : '(root)'}</td>
                    <td className="muted">{g.improvement_class}</td>
                    <td><StatusBadge status={g.status} /></td>
                    <td className="muted">{g.candidate_version}</td>
                    <td className="muted">{g.created_at}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
