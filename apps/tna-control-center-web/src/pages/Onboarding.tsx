import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type ServiceIdentity, type McpServerRegistration, type GovernedTool } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Client onboarding wizard.
 *
 * Honest scope note (read before extending): three of the ten steps the kickoff brief names have NO real,
 * client-facing HTTP capability anywhere in the accepted backend today, and this page says so explicitly
 * rather than faking one:
 *   - Registering a NEW MCP connection and triggering discovery are real Client Gateway admin capabilities
 *     (`POST .../mcp-servers`, `POST .../mcp-servers/:id/discover`), but neither is in the Volume 13 client
 *     permission matrix (`permissions.ts` only grants `connection.read`) — registering new infrastructure a
 *     TNA agent will later run is treated as an operator-level action, not a client-self-service one. This
 *     mirrors Platform's own agent-token/operator-token split; it is a considered boundary, not a bug.
 *   - Submitting a real "test action" requires an AGENT-token-authenticated identity calling Platform
 *     directly — the Control Center's browser session is a human client identity and structurally never
 *     holds or can mint an agent token (same reason `platform_operator_token` never reaches the browser).
 *   - "Bypass assessment" is real only as a free-text field in the operator CLI's handoff document
 *     (`apps/tna-operator/src/handoff.ts`) — there is no queryable bypass-assessment computation or HTTP
 *     route in any accepted backend to surface here.
 * Every OTHER step below calls a real, already-tested BFF route.
 */

function StepPanel({ n, title, children }: { readonly n: number; readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>{n}. {title}</h3>
      {children}
    </div>
  );
}
function NotAvailableNote({ children }: { readonly children: ReactNode }) {
  return <p className="muted" style={{ fontSize: 12, border: '1px dashed var(--border)', padding: 8, borderRadius: 4 }}>{children}</p>;
}

export default function Onboarding({ role }: { readonly role: string }) {
  const [org, setOrg] = useState<Record<string, unknown> | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [identities, setIdentities] = useState<readonly ServiceIdentity[] | null>(null);
  const [connections, setConnections] = useState<readonly McpServerRegistration[] | null>(null);
  const [tools, setTools] = useState<readonly GovernedTool[] | null>(null);
  const [readiness, setReadiness] = useState<{ readiness: string; checks: readonly { check: string; passed: boolean; detail: string }[] } | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);

  useEffect(() => {
    api.organization().then(setOrg).catch((e: unknown) => setOrgError(e instanceof ApiError ? e.message : 'Organization data is not available (Client Gateway may not be configured for this tenant).'));
    api.identities().then(p => setIdentities(p.items)).catch(() => setIdentities([]));
    api.connections().then(setConnections).catch(() => setConnections([]));
    api.tools().then(setTools).catch(() => setTools([]));
    api.readiness().then(setReadiness).catch((e: unknown) => setReadinessError(e instanceof ApiError ? e.message : 'Readiness is not available.'));
  }, []);

  const discovered = tools?.filter(t => t.review_status === 'DISCOVERED') ?? [];
  const reviewRequired = tools?.filter(t => t.review_status === 'POLICY_REVIEW_REQUIRED') ?? [];
  const enabled = tools?.filter(t => t.enabled) ?? [];

  return (
    <div>
      <h1>Client Onboarding</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Discovery never implies authorization — a newly discovered tool starts in <code>DISCOVERED</code>, disabled, and requires an
        explicit risk classification and policy before it can ever be enabled. There is no "enable all discovered tools" action anywhere
        in this console.
      </p>

      <StepPanel n={1} title="Organization">
        {orgError ? <p className="error-text">{orgError}</p> : !org ? <p className="muted">Loading…</p> : (
          <table><tbody>
            <tr><td className="muted">Tenant</td><td>{String(org.tenant_id ?? '—')}</td></tr>
            <tr><td className="muted">Display name</td><td>{String(org.display_name ?? '—')}</td></tr>
            <tr><td className="muted">Environment</td><td>{String(org.environment ?? '—')}</td></tr>
            <tr><td className="muted">Status</td><td><span className={`status-badge ${org.status === 'ACTIVE' ? 'status-AVAILABLE' : 'status-UNAVAILABLE'}`}>{String(org.status)}</span></td></tr>
          </tbody></table>
        )}
      </StepPanel>

      <StepPanel n={2} title="Service identity">
        {!identities ? <p className="muted">Loading…</p> : (
          <>
            <p>{identities.length} identit{identities.length === 1 ? 'y' : 'ies'} registered ({identities.filter(i => i.status === 'ACTIVE').length} active).</p>
            <Link to="/identities">Manage service identities →</Link>
          </>
        )}
      </StepPanel>

      <StepPanel n={3} title="Connection / MCP">
        {!connections ? <p className="muted">Loading…</p> : (
          <>
            <p>{connections.length} connection(s) registered.</p>
            <Link to="/connections">View connections →</Link>
            <NotAvailableNote>
              Registering a new MCP connection and running discovery are real Client Gateway operator-level capabilities, not exposed
              to any client role in this console (deliberate — see this page's own scope note).
            </NotAvailableNote>
          </>
        )}
      </StepPanel>

      <StepPanel n={4} title="Tool discovery">
        {!tools ? <p className="muted">Loading…</p> : (
          <p>{discovered.length} tool(s) newly discovered and awaiting review (never auto-enabled).</p>
        )}
      </StepPanel>

      <StepPanel n={5} title="Tool review">
        {!tools ? <p className="muted">Loading…</p> : (
          <>
            <p>{reviewRequired.length} tool(s) require policy review (schema drift or newly discovered).</p>
            <Link to="/tools">Review tools →</Link>
          </>
        )}
      </StepPanel>

      <StepPanel n={6} title="Risk / policy">
        {!tools ? <p className="muted">Loading…</p> : (
          <p>{enabled.length} tool(s) currently enabled, each with a real, backend-recorded risk classification and policy id (set at the moment of enabling — see the Tools page).</p>
        )}
      </StepPanel>

      <StepPanel n={7} title="Test action">
        <NotAvailableNote>
          Submitting a real test action requires an AGENT-token identity calling Platform directly. This browser console
          authenticates a human client identity and structurally cannot mint or hold an agent token — use your integrated agent's
          own SDK/credential to submit a real test action, then review it on the <Link to="/actions">Actions</Link> page.
        </NotAvailableNote>
      </StepPanel>

      <StepPanel n={8} title="Evidence verification">
        <p>Verify that real actions are producing real, hash-chained Ledger evidence.</p>
        <Link to="/evidence">Open Evidence Explorer →</Link>
      </StepPanel>

      <StepPanel n={9} title="Bypass assessment">
        <NotAvailableNote>
          No accepted backend exposes a queryable bypass assessment today — it exists only as a free-text field in the operator CLI's
          handoff document. This step is not yet real in this console and is not rendered as if it were.
        </NotAvailableNote>
      </StepPanel>

      <StepPanel n={10} title="Readiness">
        {readinessError ? <p className="error-text">{readinessError}</p> : !readiness ? <p className="muted">Loading…</p> : (
          <>
            <p>Overall: <span className={`status-badge ${readiness.readiness === 'READY' ? 'status-AVAILABLE' : readiness.readiness === 'READY_WITH_LIMITATIONS' ? 'status-READY_WITH_LIMITATIONS' : readiness.readiness === 'NOT_READY' ? 'status-NOT_READY' : 'status-UNKNOWN'}`}>{readiness.readiness}</span></p>
            <table>
              <thead><tr><th>Check</th><th>Passed</th><th>Detail</th></tr></thead>
              <tbody>
                {readiness.checks.map(c => (
                  <tr key={c.check}><td>{c.check}</td><td>{c.passed ? <span className="status-badge status-AVAILABLE">YES</span> : <span className="status-badge status-UNAVAILABLE">NO</span>}</td><td className="muted">{c.detail}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </StepPanel>
      <p className="muted" style={{ fontSize: 12 }}>Signed in as {role}.</p>
    </div>
  );
}
