import { useEffect, useState, useCallback } from 'react';
import { api, ApiError, type GovernedTool, type McpServerRegistration } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Governed Tools + schema-drift page. Every
 * field is the real `GovernedToolDefinition` from Volume 10's `governed_tools` table (via the real Client
 * Gateway admin API) — risk classification, review status, enabled flag, and schema hash are all rendered
 * exactly as the backend reports them. The drift banner below is driven ENTIRELY by the real
 * `review_status`/`enabled` fields the backend already sets when it detects a schema change
 * (`recordDiscovery` in `packages/client-core`) — this component contains no
 * `if (oldHash !== newHash) status = 'DISABLED'`-style client-side authorization logic of its own; it only
 * displays what the backend has already decided.
 */

const CAN_MUTATE = new Set(['client-admin']);

function ProviderDescription({ text }: { readonly text: string }) {
  // Untrusted, provider-supplied text. Rendered as plain text (React escapes it automatically — never
  // `dangerouslySetInnerHTML`) inside a clearly-labeled, visually distinct block so it can never be
  // mistaken for a TNA-issued classification or decision, no matter what the string itself claims to say.
  return (
    <div>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Provider-supplied description (untrusted)</div>
      <div style={{ fontStyle: 'italic', border: '1px dashed var(--border)', padding: '6px 8px', borderRadius: 4, marginTop: 2 }}>{text || <span className="muted">(none provided)</span>}</div>
    </div>
  );
}
function RiskBadge({ risk }: { readonly risk: string | null }) {
  const cls = risk === 'CRITICAL' || risk === 'HIGH' ? 'status-UNAVAILABLE' : risk === 'MEDIUM' ? 'status-DEGRADED' : risk === 'LOW' ? 'status-AVAILABLE' : 'status-UNKNOWN';
  return <span className={`status-badge ${cls}`}>{risk ?? 'UNCLASSIFIED'}</span>;
}
function DriftBanner({ tool }: { readonly tool: GovernedTool }) {
  if (tool.review_status !== 'POLICY_REVIEW_REQUIRED') return null;
  return (
    <div className="panel" style={{ borderColor: 'var(--bad)', marginTop: 8, marginBottom: 8 }}>
      <div style={{ color: 'var(--bad)', fontWeight: 700, letterSpacing: '0.03em' }}>TOOL CONTRACT CHANGED</div>
      <p style={{ margin: '6px 0' }}>
        Current schema hash: <code>{tool.schema_hash}</code><br />
        <span className="muted">The backend does not persist the previous schema hash — only the current one is available for comparison here.</span>
      </p>
      <p style={{ margin: 0 }}>
        Execution state: <span className="status-badge status-UNAVAILABLE">{tool.enabled ? 'ENABLED (unexpected)' : 'DISABLED'}</span>{' '}
        Review: <span className="status-badge status-DEGRADED">REQUIRED</span>
      </p>
    </div>
  );
}

export default function Tools({ role, environment }: { readonly role: string; readonly environment: string }) {
  const [tools, setTools] = useState<readonly GovernedTool[] | null>(null);
  const [connections, setConnections] = useState<readonly McpServerRegistration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [enabling, setEnabling] = useState<string | null>(null);
  const [form, setForm] = useState({ risk_class: 'LOW', policy_id: '', requires_human_approval: false, requires_vad: false });

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.tools(), api.connections()]).then(([t, c]) => { setTools(t); setConnections(c); }).catch(() => setError('Could not load governed tools from the backend.'));
  }, []);
  useEffect(load, [load]);

  if (error) return <p className="error-text">{error}</p>;
  if (!tools || !connections) return <p className="muted">Loading governed tools…</p>;
  const connectionName = (providerId: string) => connections.find(c => c.mcp_server_id === providerId)?.name ?? providerId;
  const canMutate = CAN_MUTATE.has(role);

  const runEnable = (tool: GovernedTool) => {
    if (form.policy_id.trim().length === 0) { setError('policy_id is required to enable a tool.'); return; }
    setBusyId(tool.tool_id);
    api.enableTool(tool.tool_id, {
      state_version: tool.state_version, risk_class: form.risk_class, policy_id: form.policy_id,
      allowed_operations: tool.allowed_operations.length > 0 ? tool.allowed_operations : ['read'],
      resource_patterns: tool.resource_patterns.length > 0 ? tool.resource_patterns : ['*'],
      requires_human_approval: form.requires_human_approval, requires_vad: form.requires_vad,
    }).then(() => { setEnabling(null); load(); }).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Enable failed')).finally(() => setBusyId(null));
  };
  const runDisable = (tool: GovernedTool) => {
    setBusyId(tool.tool_id);
    api.disableTool(tool.tool_id, tool.state_version).then(load).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Disable failed')).finally(() => setBusyId(null));
  };

  return (
    <div>
      <h1>Governed Tools</h1>
      {tools.length === 0 && <p className="muted">No governed tools discovered for this tenant.</p>}
      {tools.map(tool => (
        <div className="panel" key={tool.tool_id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div>
              <h3 style={{ margin: 0 }}>{tool.external_tool_name}</h3>
              <p className="muted" style={{ margin: '2px 0' }}>Connection: {connectionName(tool.provider_id)}</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <RiskBadge risk={tool.risk_class} />
              <div style={{ marginTop: 4 }}><span className="status-badge status-INDETERMINATE">{tool.review_status}</span></div>
            </div>
          </div>

          <DriftBanner tool={tool} />

          <ProviderDescription text={tool.description} />

          <table style={{ marginTop: 8 }}>
            <tbody>
              <tr><td className="muted">Enabled</td><td>{tool.enabled ? <span className="status-badge status-AVAILABLE">ENABLED</span> : <span className="status-badge status-UNAVAILABLE">DISABLED</span>}</td></tr>
              <tr><td className="muted">Approval required</td><td>{tool.requires_human_approval ? 'YES' : 'no'}</td></tr>
              <tr><td className="muted">VAD required</td><td>{tool.requires_vad ? 'YES' : 'no'}</td></tr>
              <tr><td className="muted">Schema hash</td><td><code>{tool.schema_hash}</code></td></tr>
              <tr><td className="muted">Last discovery / update</td><td className="muted">{tool.updated_at}</td></tr>
            </tbody>
          </table>

          {canMutate && tool.review_status !== 'REMOVED' && (
            <div style={{ marginTop: 12 }}>
              {tool.enabled ? (
                <button className="secondary" disabled={busyId === tool.tool_id} onClick={() => runDisable(tool)}>
                  {busyId === tool.tool_id ? 'Disabling…' : 'Disable'}
                </button>
              ) : enabling === tool.tool_id ? (
                <div>
                  <label>Risk class
                    <select value={form.risk_class} onChange={e => setForm({ ...form, risk_class: e.target.value })} style={{ display: 'block', marginBottom: 6 }}>
                      <option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option>
                    </select>
                  </label>
                  <label>Policy ID
                    <input type="text" value={form.policy_id} onChange={e => setForm({ ...form, policy_id: e.target.value })} style={{ display: 'block', marginBottom: 6 }} />
                  </label>
                  <label style={{ display: 'block' }}><input type="checkbox" checked={form.requires_human_approval} onChange={e => setForm({ ...form, requires_human_approval: e.target.checked })} /> Requires human approval</label>
                  <label style={{ display: 'block', marginBottom: 6 }}><input type="checkbox" checked={form.requires_vad} onChange={e => setForm({ ...form, requires_vad: e.target.checked })} /> Requires VAD</label>
                  <p className="muted" style={{ fontSize: 12 }}>This enables the tool in <strong>{environment.toUpperCase()}</strong>.</p>
                  <button disabled={busyId === tool.tool_id} onClick={() => runEnable(tool)}>{busyId === tool.tool_id ? 'Enabling…' : 'Confirm enable'}</button>{' '}
                  <button className="secondary" onClick={() => setEnabling(null)} disabled={busyId === tool.tool_id}>Cancel</button>
                </div>
              ) : (
                <button onClick={() => setEnabling(tool.tool_id)}>Enable…</button>
              )}
            </div>
          )}
          {!canMutate && <p className="muted" style={{ marginBottom: 0 }}>Your role ({role}) cannot enable or disable tools — a client-admin is required.</p>}
        </div>
      ))}
    </div>
  );
}
