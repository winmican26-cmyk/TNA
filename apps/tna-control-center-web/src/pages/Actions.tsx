import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type PlatformActionSummary } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), section 9. Every row is a real Platform
 * action, rendered as plain React text content (never `dangerouslySetInnerHTML`) — a malicious/candidate
 * -controlled string in any field renders as inert text, never executes (section 55-56).
 */
// TNA-85 (Unknown Must Never Render as Safe): an action state this frontend does not recognize renders
// with the neutral/UNKNOWN styling, never with whatever CSS classes an unrecognized string might
// accidentally collide with — the raw real value is still shown as text, only the STYLING is guarded.
const KNOWN_ACTION_STATES = new Set(['RECEIVED', 'AUTHORIZING', 'BLOCKED', 'HELD', 'AUTHORIZED', 'CAPABILITY_ISSUED', 'MONITORING', 'EXECUTING', 'VERIFYING', 'COMPLETED', 'FAILED', 'TERMINATED', 'INDETERMINATE']);
function StatusBadge({ status }: { readonly status: string }) {
  const cls = KNOWN_ACTION_STATES.has(status) ? status : 'UNKNOWN';
  return <span className={`status-badge status-${cls}`}>{status}</span>;
}

export default function Actions() {
  const [items, setItems] = useState<readonly PlatformActionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.actions({ limit: 100 }).then(page => setItems(page.items)).catch(() => setError('Could not load actions from the backend.')); }, []);

  if (error) return <p className="error-text">{error}</p>;
  if (!items) return <p className="muted">Loading actions…</p>;

  return (
    <div>
      <h1>Actions</h1>
      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Action ID</th><th>Tool</th><th>Agent</th><th>State</th><th>Created</th></tr></thead>
          <tbody>
            {items.length === 0
              ? <tr><td colSpan={5} className="muted" style={{ padding: 16 }}>No actions found.</td></tr>
              : items.map(a => (
                <tr key={a.platform_action_id}>
                  <td><Link to={`/actions/${encodeURIComponent(a.platform_action_id)}`}>{a.platform_action_id}</Link></td>
                  <td>{a.tool ?? '—'}</td>
                  <td>{a.agent_id ?? '—'}</td>
                  <td><StatusBadge status={a.state} /></td>
                  <td className="muted">{a.created_at ?? '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
