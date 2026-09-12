import { useEffect, useMemo, useState } from 'react';
import { api, type McpServerRegistration, type GovernedTool } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Connections / MCP page. Every field here
 * comes from the real `apps/tna-client-gateway` admin API (`GET /api/connections`, `GET /api/tools`) —
 * tool count and schema-drift state are real, computed-here aggregates OVER those two real responses
 * (same discipline as Dashboard.tsx's own aggregates), never independently invented numbers. A server's
 * own `credential_ref` (an opaque reference, never the credential value itself) is the only credential
 * -related field ever rendered — the real bearer token is never returned by this backend to this UI at
 * all, so there is no path by which this page could leak one.
 */

type DisplayStatus = 'CONNECTED' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';

/** Real backend status -> display status. `UNREACHABLE`/`DISABLED` are real, distinct failure states —
 * both render as clearly non-healthy, never collapsed into a single ambiguous "down". An unrecognized
 * status string (a future backend value this UI does not yet know about) renders as UNKNOWN, which itself
 * is styled as NOT healthy (section 85/29: "unknown must never render as safe"). */
function toDisplayStatus(status: string): DisplayStatus {
  if (status === 'REACHABLE') return 'CONNECTED';
  if (status === 'REGISTERED') return 'DEGRADED';
  if (status === 'UNREACHABLE' || status === 'DISABLED') return 'UNAVAILABLE';
  return 'UNKNOWN';
}
const DISPLAY_STATUS_CLASS: Record<DisplayStatus, string> = {
  CONNECTED: 'status-AVAILABLE', DEGRADED: 'status-DEGRADED', UNAVAILABLE: 'status-UNAVAILABLE', UNKNOWN: 'status-UNKNOWN',
};
function StatusBadge({ status }: { readonly status: string }) {
  const display = toDisplayStatus(status);
  return <span className={`status-badge ${DISPLAY_STATUS_CLASS[display]}`}>{display}</span>;
}

export default function Connections() {
  const [connections, setConnections] = useState<readonly McpServerRegistration[] | null>(null);
  const [tools, setTools] = useState<readonly GovernedTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.connections(), api.tools()])
      .then(([c, t]) => { setConnections(c); setTools(t); })
      .catch(() => setError('Could not load connections from the backend.'));
  }, []);

  const perConnection = useMemo(() => {
    if (!tools) return new Map<string, { count: number; driftCount: number; lastActivity: string | null }>();
    const map = new Map<string, { count: number; driftCount: number; lastActivity: string | null }>();
    for (const tool of tools) {
      const entry = map.get(tool.provider_id) ?? { count: 0, driftCount: 0, lastActivity: null };
      entry.count += 1;
      if (tool.review_status === 'POLICY_REVIEW_REQUIRED') entry.driftCount += 1;
      if (!entry.lastActivity || tool.updated_at > entry.lastActivity) entry.lastActivity = tool.updated_at;
      map.set(tool.provider_id, entry);
    }
    return map;
  }, [tools]);

  if (error) return <p className="error-text">{error}</p>;
  if (!connections) return <p className="muted">Loading connections…</p>;

  return (
    <div>
      <h1>Connections</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Real MCP server registrations from the client gateway. Tool count and schema-drift state are computed here from the real,
        separately-fetched governed-tools list — never a backend-invented rollup.
      </p>
      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Name</th><th>Status</th><th>Transport</th><th>Tools</th><th>Schema drift</th><th>Last tool activity</th><th>Credential</th></tr></thead>
          <tbody>
            {connections.length === 0
              ? <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>No MCP servers registered for this tenant.</td></tr>
              : connections.map(c => {
                const agg = perConnection.get(c.mcp_server_id) ?? { count: 0, driftCount: 0, lastActivity: null };
                return (
                  <tr key={c.mcp_server_id}>
                    <td>{c.name}</td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="muted">{c.transport}</td>
                    <td>{agg.count}</td>
                    <td>{agg.driftCount > 0
                      ? <span className="status-badge status-DEGRADED">{agg.driftCount} DRIFTED</span>
                      : <span className="muted">none</span>}
                    </td>
                    <td className="muted">{agg.lastActivity ?? '— (no tool activity recorded)'}</td>
                    <td className="muted">{c.credential_ref ? `configured (${c.credential_ref})` : 'none configured'}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Note: the real backend does not track a discovery timestamp for a connection. "Last tool activity" above is the most recent
        `updated_at` among that connection's own real governed tools — an honest derived proxy, never a fabricated discovery time.
      </p>
    </div>
  );
}
