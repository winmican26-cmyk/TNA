/**
 * TNA Pilot Deployment v0.1 — pilot bootstrap hardening. This is the canonical, typechecked, unit-tested
 * source of the fail-closed idempotent registration logic that `deploy/compose/bootstrap-platform-agent.js`
 * (the actual artifact piped into the read-only Platform pilot container, since that container's image
 * cannot carry a new `dist/scripts` file without modifying the accepted, frozen `deploy/docker/Dockerfile`)
 * mirrors self-contained. Any change here must be mirrored there — the two are kept structurally identical
 * on purpose so a reviewer can trivially confirm equivalence.
 *
 * Replaces the previous, too-broad `try { gate.register(...) } catch (e) { log(e.message) }` pattern, which
 * treated every registration failure — a genuine store error, a schema violation, anything — as if it were
 * the one expected "this pilot agent already exists" case. That pattern is not used here or in the mirror.
 */
import { pathToFileURL } from 'node:url';
import { Gate, HttpError } from '../apps/tna-gate-api/src/gate.js';
import type { Principal } from '../packages/agent-identity/src/index.js';

export type BootstrapOutcome = 'registered' | 'already-registered';

/**
 * Registers `agentId` with Gate if absent, or tolerates the one specific, well-typed "already registered"
 * conflict if not — then (only in either of those two cases) installs the deterministic pilot envelope
 * `buildEnvelope()` produces. Any OTHER error from `gate.register()` propagates unchanged: `setEnvelope`
 * is never reached, so a genuine failure never results in a partially-bootstrapped, silently-continued
 * agent identity.
 */
export function registerPilotAgent(gate: Gate, admin: Principal, agentId: string, agentName: string, buildEnvelope: () => unknown): BootstrapOutcome {
  let outcome: BootstrapOutcome;
  try {
    gate.register(admin, { id: agentId, name: agentName });
    outcome = 'registered';
  } catch (error) {
    if (error instanceof HttpError && error.status === 409 && error.message === 'Agent already registered') {
      outcome = 'already-registered';
    } else {
      throw error;
    }
  }
  gate.setEnvelope(admin, buildEnvelope());
  return outcome;
}

// --- CLI entry point (mirrors deploy/compose/bootstrap-platform-agent.js's own pilotEnvelope()) ---------

function nowIso(offsetMs = 0): string { return new Date(Date.now() + offsetMs).toISOString(); }

function pilotEnvelope(agentId: string, agentName: string) {
  return {
    version: '1.0' as const,
    agent: { id: agentId, name: agentName, role: 'pilot', owner: 'pilot-operator', environment: 'pilot', expires_at: nowIso(365 * 24 * 3600_000) },
    objective: { task_id: 'pilot-verification', goal: 'Demonstrate end-to-end pilot governed action', allowed_outcomes: ['echo a pilot verification message'], forbidden_outcomes: [] },
    resources: { repositories: { read: [], write: [] }, files: { read: ['/pilot/verification/**'], write: [] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
    tools: { allow: ['demo.echo'], deny: ['shell.unrestricted'] },
    network: { allow: [], deny: ['*'] },
    secrets: { allow: [], deny: ['*'] },
    agents: { communicate_with: [], communication_mode: 'authenticated' as const, shared_memory: false as const, deny_unknown_agents: true as const },
    limits: { max_runtime_seconds: 600, max_tool_calls: 40, max_external_requests: 0, max_cost_usd: 3, max_retries_per_action: 5 },
    approvals: { required_for: [] },
    risk: { level: 'low' as const, blast_radius: 'none', rollback_required: false },
    evidence: { capture: ['agent_identity', 'policy_hash', 'tool_calls', 'timestamps'] as const, retention_days: 365 },
    violation_policy: { unknown_tool: 'block' as const, undeclared_resource: 'block' as const, unauthorized_agent_contact: 'terminate' as const, network_violation: 'terminate' as const, secret_violation: 'terminate_and_rotate' as const, cost_limit_exceeded: 'pause_and_escalate' as const, runtime_limit_exceeded: 'terminate' as const },
    action_bindings: [
      { action: 'demo.echo.execute', outcome: 'echo a pilot verification message', tool: 'demo.echo', resource_kind: 'files' as const, operation: 'read' as const, destination_required: false },
    ],
  };
}

async function main(): Promise<void> {
  const { Store } = await import('../packages/evidence-core/src/index.js');
  const agentId = process.argv[2];
  if (!agentId) { console.error('usage: node pilot-bootstrap-platform-agent.js <agentId> <agentName>'); process.exit(1); }
  const agentName = process.argv[3] ?? agentId;
  const admin: Principal = { kind: 'admin', role: 'administrator' };
  const store = new Store(process.env.TNA_PILOT_GATE_DB_PATH ?? '/data/tna-platform-gate.sqlite');
  const gate = new Gate(store);
  try {
    const outcome = registerPilotAgent(gate, admin, agentId, agentName, () => pilotEnvelope(agentId, agentName));
    console.log(outcome === 'registered' ? `registered agent ${agentId}` : `agent ${agentId} already exists — reconciling its envelope`);
    console.log(`envelope set for agent ${agentId}`);
  } finally {
    store.close();
  }
}

// Only run the CLI when this module is the direct entry point (not when imported for testing). Compared
// as real file URLs (via `pathToFileURL`), not a naive `file://${...}` string concatenation — the latter
// silently never matches on Windows, where `process.argv[1]` uses backslashes and drive letters while
// `import.meta.url` is already a properly encoded `file:///C:/...` URL; this was caught by actually
// running the compiled CLI locally, not just its unit tests (which import `registerPilotAgent` directly
// and never exercise this guard at all).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exit(1); });
}
