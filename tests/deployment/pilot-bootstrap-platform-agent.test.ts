import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Gate, HttpError } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { registerPilotAgent } from '../../scripts/pilot-bootstrap-platform-agent.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * TNA Pilot Deployment v0.1 — pilot bootstrap hardening. Proves `registerPilotAgent()` (the logic
 * `deploy/compose/bootstrap-platform-agent.js` mirrors) tolerates ONLY Gate's own real, well-typed
 * "Agent already registered" 409 — never a blanket `catch {}` — and fails closed (envelope never
 * written) on any other registration error.
 */

const ADMIN = { kind: 'admin' as const, role: 'administrator' };
const AGENT_ID = 'pilot-bootstrap-test-agent';

function tmpGate(): { gate: Gate; store: Store; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-pilot-bootstrap-test-'));
  const store = new Store(resolve(dir, 'gate.sqlite'));
  const gate = new Gate(store);
  return { gate, store, dir };
}
function cleanup(store: Store, dir: string): void { store.close(); rmSync(dir, { recursive: true, force: true }); }

function minimalEnvelope(agentId: string) {
  return {
    version: '1.0' as const,
    agent: { id: agentId, name: `Pilot Agent (${agentId})`, role: 'pilot', owner: 'pilot-operator', environment: 'pilot', expires_at: new Date(Date.now() + 3600_000).toISOString() },
    objective: { task_id: 'pilot-bootstrap-test', goal: 'Prove fail-closed bootstrap', allowed_outcomes: ['test outcome'], forbidden_outcomes: [] },
    resources: { repositories: { read: [], write: [] }, files: { read: [], write: [] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
    tools: { allow: ['pilot.test.tool'], deny: [] },
    network: { allow: [], deny: ['*'] }, secrets: { allow: [], deny: ['*'] },
    agents: { communicate_with: [], communication_mode: 'authenticated' as const, shared_memory: false as const, deny_unknown_agents: true as const },
    limits: { max_runtime_seconds: 60, max_tool_calls: 10, max_external_requests: 0, max_cost_usd: 1, max_retries_per_action: 5 },
    approvals: { required_for: [] },
    risk: { level: 'low' as const, blast_radius: 'none', rollback_required: false },
    evidence: { capture: ['agent_identity'] as const, retention_days: 1 },
    violation_policy: { unknown_tool: 'block' as const, undeclared_resource: 'block' as const, unauthorized_agent_contact: 'terminate' as const, network_violation: 'terminate' as const, secret_violation: 'terminate_and_rotate' as const, cost_limit_exceeded: 'pause_and_escalate' as const, runtime_limit_exceeded: 'terminate' as const },
    action_bindings: [{ action: 'pilot.test.action', outcome: 'test outcome', tool: 'pilot.test.tool', resource_kind: 'files' as const, operation: 'read' as const, destination_required: false }],
  };
}

test('A. fresh bootstrap: registers the agent and installs the envelope', () => {
  const { gate, store, dir } = tmpGate();
  try {
    const outcome = registerPilotAgent(gate, ADMIN, AGENT_ID, 'Pilot Agent', () => minimalEnvelope(AGENT_ID));
    assert.equal(outcome, 'registered');
    const policy = gate.getEnvelope(ADMIN, AGENT_ID) as { envelope: { agent: { id: string } } };
    assert.equal(policy.envelope.agent.id, AGENT_ID, 'the envelope must actually be installed after a fresh registration');
  } finally { cleanup(store, dir); }
});

test('B. expected duplicate registration: tolerated, logged as already-registered, envelope still (re-)installed', () => {
  const { gate, store, dir } = tmpGate();
  try {
    const first = registerPilotAgent(gate, ADMIN, AGENT_ID, 'Pilot Agent', () => minimalEnvelope(AGENT_ID));
    assert.equal(first, 'registered');
    const second = registerPilotAgent(gate, ADMIN, AGENT_ID, 'Pilot Agent', () => minimalEnvelope(AGENT_ID));
    assert.equal(second, 'already-registered');
    const policy = gate.getEnvelope(ADMIN, AGENT_ID) as { envelope: { agent: { id: string } } };
    assert.equal(policy.envelope.agent.id, AGENT_ID, 'the envelope must still be installed on the expected-duplicate path');
  } finally { cleanup(store, dir); }
});

test('B2. expected duplicate registration remains idempotent across repeated invocations', () => {
  const { gate, store, dir } = tmpGate();
  try {
    registerPilotAgent(gate, ADMIN, AGENT_ID, 'Pilot Agent', () => minimalEnvelope(AGENT_ID));
    for (let i = 0; i < 4; i++) {
      const outcome = registerPilotAgent(gate, ADMIN, AGENT_ID, 'Pilot Agent', () => minimalEnvelope(AGENT_ID));
      assert.equal(outcome, 'already-registered', `invocation ${i + 2} must still be tolerated as the expected duplicate`);
    }
  } finally { cleanup(store, dir); }
});

test('C. unexpected Gate registration error fails closed: rethrown, never swallowed', () => {
  const { gate, store, dir } = tmpGate();
  try {
    const originalRegister = gate.register.bind(gate);
    let calls = 0;
    // Simulate a genuine, unrelated Gate failure (not the expected 409) — e.g. a store-level fault.
    gate.register = () => { calls++; throw new HttpError(500, 'Simulated store failure'); };
    try {
      assert.throws(
        () => registerPilotAgent(gate, ADMIN, AGENT_ID, 'Pilot Agent', () => minimalEnvelope(AGENT_ID)),
        (error: unknown) => error instanceof HttpError && error.status === 500 && error.message === 'Simulated store failure',
        'an unexpected registration error must propagate unchanged, never be swallowed as if it were the expected duplicate',
      );
      assert.equal(calls, 1);
    } finally { gate.register = originalRegister; }
  } finally { cleanup(store, dir); }
});

test('D. envelope is NOT written after an unexpected registration failure', () => {
  const { gate, store, dir } = tmpGate();
  try {
    const originalRegister = gate.register.bind(gate);
    gate.register = () => { throw new HttpError(500, 'Simulated store failure'); };
    try {
      assert.throws(() => registerPilotAgent(gate, ADMIN, AGENT_ID, 'Pilot Agent', () => minimalEnvelope(AGENT_ID)));
    } finally { gate.register = originalRegister; }
    let envelopeExists = true;
    try { gate.getEnvelope(ADMIN, AGENT_ID); }
    catch (error) { envelopeExists = !(error instanceof HttpError && error.status === 404); }
    assert.equal(envelopeExists, false, 'setEnvelope must never run when registration failed for an unexpected reason');
  } finally { cleanup(store, dir); }
});

test('a real, unrelated conflict message on the same 409 status is still treated as unexpected (status+message must both match)', () => {
  const { gate, store, dir } = tmpGate();
  try {
    const originalRegister = gate.register.bind(gate);
    gate.register = () => { throw new HttpError(409, 'Some other real conflict, not a duplicate agent'); };
    try {
      assert.throws(
        () => registerPilotAgent(gate, ADMIN, AGENT_ID, 'Pilot Agent', () => minimalEnvelope(AGENT_ID)),
        (error: unknown) => error instanceof HttpError && error.status === 409 && error.message === 'Some other real conflict, not a duplicate agent',
      );
    } finally { gate.register = originalRegister; }
    let envelopeExists = true;
    try { gate.getEnvelope(ADMIN, AGENT_ID); }
    catch (error) { envelopeExists = !(error instanceof HttpError && error.status === 404); }
    assert.equal(envelopeExists, false, 'a same-status-but-different-message 409 must not be silently tolerated');
  } finally { cleanup(store, dir); }
});

test('CLI entry-point guard actually runs main() when invoked directly (Windows-path regression) — the six tests above only ever call registerPilotAgent() in-process and never exercise this guard at all', () => {
  // This is the exact defect discovered during local pilot bootstrap: `import.meta.url ===
  // \`file://${process.argv[1]}\`` silently never matches on Windows, where `process.argv[1]` is a raw
  // Windows path (backslashes, a drive letter, e.g. `C:\Users\...\pilot-bootstrap-platform-agent.js`)
  // while `import.meta.url` is already a canonical, percent-encoded `file:///C:/Users/...` URL — so the
  // naive comparison is always false there, `main()` never runs, and the script exits 0 having silently
  // done nothing. Spawning the REAL compiled CLI as a real child process is the only way to prove the fix
  // (`pathToFileURL(process.argv[1]).href`) actually works on the real, currently-running platform,
  // Windows included — a synthetic string-comparison unit test would only prove the intended algorithm,
  // not that Node's actual `import.meta.url` encoding agrees with it on this OS.
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-pilot-bootstrap-cli-test-'));
  const gateDbPath = resolve(dir, 'gate.sqlite');
  const cliPath = resolve(repoRoot, 'dist', 'scripts', 'pilot-bootstrap-platform-agent.js');
  try {
    const stdout = execFileSync(process.execPath, [cliPath, 'cli-regression-agent', 'CLI Regression Agent'], {
      cwd: repoRoot, encoding: 'utf8', env: { ...process.env, TNA_PILOT_GATE_DB_PATH: gateDbPath },
    });
    assert.match(stdout, /registered agent cli-regression-agent/, 'main() must actually have run and registered the agent — not silently exited 0 having done nothing');

    // Real side-effect proof, independent of stdout: the agent is genuinely present in the Gate database
    // the CLI process opened, readable by a fresh Gate instance over the same file.
    const store = new Store(gateDbPath);
    const gate = new Gate(store);
    try {
      const policy = gate.getEnvelope(ADMIN, 'cli-regression-agent') as { envelope: { agent: { id: string } } };
      assert.equal(policy.envelope.agent.id, 'cli-regression-agent');
    } finally { store.close(); }

    // And the guard is genuinely conditional, not just "always run" — invoking the exact same compiled
    // file as an IMPORTED module (via a wrapper, so `process.argv[1]` is the WRAPPER's path, not this
    // module's own), must not run `main()` at all. If the guard were broken the other way (always true,
    // e.g. a stray `true` left behind by a bad edit), `main()` would run with no CLI args and print its
    // "usage: ..." message to stderr and exit non-zero — this asserts none of that happens, not merely
    // that a couple of specific success strings are absent from stdout.
    const wrapperPath = resolve(dir, 'import-wrapper.mjs');
    writeFileSync(wrapperPath, `import ${JSON.stringify(pathToFileURL(cliPath).href)};\nconsole.log('wrapper ran, CLI module was only imported');\n`);
    const wrapperResult = execFileSync(process.execPath, [wrapperPath], {
      cwd: repoRoot, encoding: 'utf8', env: { ...process.env, TNA_PILOT_GATE_DB_PATH: gateDbPath }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(wrapperResult.trim(), 'wrapper ran, CLI module was only imported', 'importing the module must produce exactly the wrapper\'s own output — no usage message, no registration, main() must not have run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
