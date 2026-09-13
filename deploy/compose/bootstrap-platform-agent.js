// TNA Pilot Deployment v0.1 — one-time operator bootstrap step.
//
// HONEST GAP this script exists to cover (see docs/deployment/pilot-deployment-security-checklist-v0.1.md):
// `apps/tna-platform`'s accepted HTTP API (`apps/tna-platform/src/server.ts`) has NO route to register a
// Gate agent or set its authority envelope — the accepted product only does this in-process, directly
// against Gate's own SQLite file, exactly the way `scripts/demo-platform-v01.ts` already does (see that
// file's `buildGate()`). There is no way to complete this step remotely over HTTP with the accepted
// product as shipped; it requires exec access into the Platform container (or its /data volume) once,
// at pilot bootstrap time. This script calls only Gate's own existing public methods (`register`,
// `setEnvelope`) — it adds no new capability and modifies no accepted code.
//
// Usage (inside the tna-platform pilot container, which already has dist/apps/tna-gate-api and
// dist/packages built in):
//   node bootstrap-platform-agent.js <agentId> <agentName>
//
// Run once per pilot agent identity, after the tna-platform container is healthy and before any
// governed action is submitted for that agent.
//
// PILOT BOOTSTRAP HARDENING: registration is idempotent for exactly one expected condition — Gate's own
// real HttpError(409, "Agent already registered") — detected by type and status, never by loosely
// matching an arbitrary caught error's message. Any OTHER registration failure (a store error, a schema
// violation, anything) is rethrown, the process exits non-zero, and `setEnvelope` is never reached — a
// genuine failure never results in a partially-bootstrapped, silently-continued agent identity. This
// mirrors `scripts/pilot-bootstrap-platform-agent.ts`'s `registerPilotAgent()`, the canonical,
// typechecked, unit-tested source of this same logic (see `tests/deployment/pilot-bootstrap-platform-
// agent.test.ts`) — kept structurally identical here only because Platform's accepted, frozen
// `deploy/docker/Dockerfile` cannot be changed to carry a new `dist/scripts` file into the container, so
// this self-contained copy is what is actually piped in via stdin (see the runbook).
import { Gate, HttpError } from '/app/dist/apps/tna-gate-api/src/gate.js';
import { Store } from '/app/dist/packages/evidence-core/src/index.js';

const agentId = process.argv[2];
const agentName = process.argv[3] ?? agentId;
if (!agentId) { console.error('usage: node bootstrap-platform-agent.js <agentId> <agentName>'); process.exit(1); }

const ADMIN = { kind: 'admin', role: 'administrator' };
const store = new Store('/data/tna-platform-gate.sqlite');
const gate = new Gate(store);

function nowIso(offsetMs = 0) { return new Date(Date.now() + offsetMs).toISOString(); }

// Modeled directly on scripts/demo-platform-v01.ts's own `demoEnvelope()` — same shape, scoped to the
// pilot's own verification tool/resource rather than the demo's `log.write` binding.
function pilotEnvelope() {
  return {
    version: '1.0',
    agent: { id: agentId, name: agentName, role: 'pilot', owner: 'pilot-operator', environment: 'pilot', expires_at: nowIso(365 * 24 * 3600_000) },
    objective: { task_id: 'pilot-verification', goal: 'Demonstrate end-to-end pilot governed action', allowed_outcomes: ['echo a pilot verification message'], forbidden_outcomes: [] },
    resources: { repositories: { read: [], write: [] }, files: { read: ['/pilot/verification/**'], write: [] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
    tools: { allow: ['demo.echo'], deny: ['shell.unrestricted'] },
    network: { allow: [], deny: ['*'] },
    secrets: { allow: [], deny: ['*'] },
    agents: { communicate_with: [], communication_mode: 'authenticated', shared_memory: false, deny_unknown_agents: true },
    limits: { max_runtime_seconds: 600, max_tool_calls: 40, max_external_requests: 0, max_cost_usd: 3, max_retries_per_action: 5 },
    approvals: { required_for: [] },
    risk: { level: 'low', blast_radius: 'none', rollback_required: false },
    evidence: { capture: ['agent_identity', 'policy_hash', 'tool_calls', 'timestamps'], retention_days: 365 },
    violation_policy: { unknown_tool: 'block', undeclared_resource: 'block', unauthorized_agent_contact: 'terminate', network_violation: 'terminate', secret_violation: 'terminate_and_rotate', cost_limit_exceeded: 'pause_and_escalate', runtime_limit_exceeded: 'terminate' },
    action_bindings: [
      { action: 'demo.echo.execute', outcome: 'echo a pilot verification message', tool: 'demo.echo', resource_kind: 'files', operation: 'read', destination_required: false },
    ],
  };
}

let outcome;
try {
  gate.register(ADMIN, { id: agentId, name: agentName });
  outcome = 'registered';
} catch (error) {
  if (error instanceof HttpError && error.status === 409 && error.message === 'Agent already registered') {
    outcome = 'already-registered';
  } else {
    // Fail closed: NOT the expected duplicate-registration condition — rethrow so the process exits
    // non-zero and `setEnvelope` below is never reached.
    store.close();
    throw error;
  }
}
console.log(outcome === 'registered' ? `registered agent ${agentId}` : `agent ${agentId} already exists — reconciling its envelope`);
gate.setEnvelope(ADMIN, pilotEnvelope());
console.log('envelope set for agent', agentId);
store.close();
