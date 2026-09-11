/**
 * TNA Sentinel v0.1 Demo — normal flow, tool-drift termination, revocation mid-run, policy-drift
 * hold/resume, and containment-failure indeterminacy, using only harmless local demo data.
 *
 * Exit 0 on success, non-zero on failure.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash } from '../packages/sentinel-schema/src/index.js';
import { SentinelRuntime, FakeContainmentController, FakeAuthorityRevalidator, type SentinelSessionInput } from '../packages/sentinel-runtime/src/index.js';
import { LedgerStore, Ledger } from '../packages/ledger-core/src/index.js';
import { gateSource, executionBrokerSource, controller, admin } from '../apps/tna-sentinel/src/writers.js';
import { SentinelLedgerAdapter } from '../apps/tna-sentinel/src/ledger-adapter.js';
import { sentinelWriter, reader as ledgerReader } from '../apps/tna-ledger/src/writers.js';

function log(label: string, message: string): void { process.stdout.write(`[${label}] ${message}\n`); }
function separator(title: string): void { process.stdout.write(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}\n\n`); }

const dataDir = resolve('data');
mkdirSync(dataDir, { recursive: true });
const sentinelPath = resolve(dataDir, 'demo-sentinel.sqlite');
const ledgerPath = resolve(dataDir, 'demo-sentinel-ledger.sqlite');
for (const path of [sentinelPath, ledgerPath]) for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });

const tenantId = 'tenant_demo';
const ad = admin(tenantId);
const ctrl = controller(tenantId);
const gate = gateSource(tenantId);
const broker = executionBrokerSource(tenantId);

const containment = new FakeContainmentController();
const revalidator = new FakeAuthorityRevalidator();
const sentinel = new SentinelRuntime(sentinelPath, { containment, revalidator });
sentinel.installDefaultPolicy(ad);
log('SENTINEL', 'Store initialized at ' + sentinelPath);
process.stdout.write('SENTINEL STORE INITIALIZED\n');

const ledgerStore = new LedgerStore(ledgerPath);
const ledger = new Ledger(ledgerStore);
const ledgerAdapter = new SentinelLedgerAdapter(tenantId);
const writer = sentinelWriter(tenantId);
const ledgerReaderPrincipal = ledgerReader(tenantId);

function baseSession(overrides: Partial<SentinelSessionInput> = {}): SentinelSessionInput {
  return {
    version: '1.0', tenant_id: tenantId, agent_id: 'deployment-agent-demo', execution_id: `exec-${Math.random().toString(36).slice(2)}`,
    correlation_id: 'decision-demo', authority_snapshot_hash: hash('authority-v1'), policy_snapshot_hash: hash('policy-v1'),
    expected_action: 'production.deploy', expected_tool: 'demo.deploy.execute', expected_resource: 'release-1',
    allowed_destinations: ['api.github.com'], allowed_operations: ['read', 'write'],
    authority_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    runtime_limits: { max_runtime_seconds: 3600 }, cost_limits: { max_cost_usd: 10 },
    ...overrides,
  };
}

// ── Flow A — Normal ──────────────────────────────────────────────────────────────────────────
separator('TNA Sentinel v0.1 — Flow A: Normal');

let session = sentinel.createSession(ctrl, baseSession());
log('SENTINEL', `session ${session.sentinel_session_id} created, status=${session.status}`);
process.stdout.write('SESSION CREATED\n');
process.stdout.write('AUTHORITY VALID\n');

const observed = await sentinel.submitObservation(broker, session.sentinel_session_id, {
  version: '1.0', observation_id: `${session.sentinel_session_id}.tool-call`, tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id,
  timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'demo.deploy.execute' },
});
process.stdout.write('TOOL CALL OBSERVED\n');
process.stdout.write('RULES EVALUATED\n');
assert.equal(observed.decision?.decision, 'CONTINUE', 'flow A must continue on an authorized tool call');
log('SENTINEL', `decision=${observed.decision?.decision}`);
process.stdout.write('DECISION CONTINUE\n');

const completed = await sentinel.submitObservation(broker, session.sentinel_session_id, {
  version: '1.0', observation_id: `${session.sentinel_session_id}.completed`, tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id,
  timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'EXECUTION_COMPLETED',
});
assert.equal(completed.decision?.decision, 'CONTINUE');
process.stdout.write('EXECUTION COMPLETED\n');
const finishedA = sentinel.completeSession(ctrl, session.sentinel_session_id);
assert.equal(finishedA.status, 'COMPLETED', 'flow A session must complete');
process.stdout.write('SESSION COMPLETED\n');

ledger.append(writer, ledgerAdapter.sessionStarted(session));
ledger.append(writer, ledgerAdapter.sessionCompleted(finishedA));
const flowAStream = ledger.getStream(ledgerReaderPrincipal, `sentinel:${session.sentinel_session_id}`);
assert.equal(flowAStream.items.length, 2, 'flow A must write session-started and session-completed evidence');
process.stdout.write('LEDGER EVIDENCE WRITTEN\n');

// ── Flow B — Tool Drift ──────────────────────────────────────────────────────────────────────
separator('TNA Sentinel v0.1 — Flow B: Tool Drift');

session = sentinel.createSession(ctrl, baseSession({ expected_tool: 'demo.deploy.execute' }));
process.stdout.write('SESSION CREATED\n');
ledger.append(writer, ledgerAdapter.sessionStarted(session));

const drift = await sentinel.submitObservation(broker, session.sentinel_session_id, {
  version: '1.0', observation_id: `${session.sentinel_session_id}.drift`, tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id,
  timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell.unrestricted' },
});
process.stdout.write('UNEXPECTED TOOL OBSERVED\n');
assert.equal(drift.decision?.violations[0]?.rule_type, 'TOOL_NOT_ALLOWED');
log('SENTINEL', `violation=${drift.decision?.violations[0]?.rule_type}`);
process.stdout.write('VIOLATION: TOOL_NOT_ALLOWED\n');
assert.equal(drift.decision?.decision, 'TERMINATE');
process.stdout.write('DECISION: TERMINATE\n');
process.stdout.write('CONTAINMENT REQUESTED\n');
assert.equal(drift.decision?.containment_status, 'CONTAINMENT_CONFIRMED', 'flow B containment must be confirmed by the fake controller');
process.stdout.write('CONTAINMENT CONFIRMED\n');
const terminatedB = sentinel.getSession(ctrl, session.sentinel_session_id);
assert.equal(terminatedB.status, 'TERMINATED');
process.stdout.write('SESSION TERMINATED\n');

ledger.append(writer, ledgerAdapter.violationDetected(session, drift.decision!.violations[0]!));
ledger.append(writer, ledgerAdapter.terminationRequested(session, drift.decision!));
ledger.append(writer, ledgerAdapter.terminated(terminatedB, drift.decision!));
const flowBStream = ledger.getStream(ledgerReaderPrincipal, `sentinel:${session.sentinel_session_id}`);
assert.equal(flowBStream.items.length, 4);
process.stdout.write('LEDGER EVIDENCE WRITTEN\n');

// ── Flow C — Revocation Mid-Run ──────────────────────────────────────────────────────────────
separator('TNA Sentinel v0.1 — Flow C: Revocation Mid-Run');

session = sentinel.createSession(ctrl, baseSession());
log('SENTINEL', `session ${session.sentinel_session_id} monitoring`);
process.stdout.write('SESSION MONITORING\n');
process.stdout.write('AUTHORITY RECHECK\n');
const revoked = await sentinel.submitObservation(gate, session.sentinel_session_id, {
  version: '1.0', observation_id: `${session.sentinel_session_id}.revoked`, tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id,
  timestamp: new Date().toISOString(), source: 'TNA_GATE', observation_type: 'REVOCATION_RECHECK', payload: { result: 'REVOKED', scope: 'agent' },
});
process.stdout.write('AGENT REVOKED\n');
assert.equal(revoked.decision?.violations[0]?.severity, 'CRITICAL');
process.stdout.write('CRITICAL VIOLATION\n');
assert.equal(revoked.decision?.decision, 'TERMINATE');
process.stdout.write('TERMINATE\n');
assert.equal(sentinel.getSession(ctrl, session.sentinel_session_id).status, 'TERMINATED');
process.stdout.write('SESSION TERMINATED\n');

// ── Flow D — Policy Drift ────────────────────────────────────────────────────────────────────
separator('TNA Sentinel v0.1 — Flow D: Policy Drift');

const staleHash = hash('policy-v1');
const renewedHash = hash('policy-v2');
session = sentinel.createSession(ctrl, baseSession({ policy_snapshot_hash: staleHash }));
process.stdout.write('SESSION MONITORING\n');
const drifted = await sentinel.submitObservation(gate, session.sentinel_session_id, {
  version: '1.0', observation_id: `${session.sentinel_session_id}.policy-changed`, tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id,
  timestamp: new Date().toISOString(), source: 'TNA_GATE', observation_type: 'POLICY_RECHECK', payload: { result: 'POLICY_CHANGED', current_policy_hash: renewedHash },
});
process.stdout.write('POLICY HASH CHANGED\n');
assert.equal(drifted.decision?.violations[0]?.rule_type, 'POLICY_CHANGED');
process.stdout.write('VIOLATION: POLICY_CHANGED\n');
assert.equal(drifted.decision?.decision, 'HOLD');
process.stdout.write('DECISION: HOLD\n');
assert.equal(sentinel.getSession(ctrl, session.sentinel_session_id).status, 'HELD');
process.stdout.write('SESSION HELD\n');
const resumed = sentinel.resume(ctrl, session.sentinel_session_id, { rationale: 'policy reviewed by operator', policySnapshotHash: renewedHash });
assert.equal(resumed.status, 'MONITORING');
process.stdout.write('RESUME AUTHORIZED\n');
process.stdout.write('SESSION MONITORING\n');

// ── Flow E — Containment Failure ─────────────────────────────────────────────────────────────
separator('TNA Sentinel v0.1 — Flow E: Containment Failure');

session = sentinel.createSession(ctrl, baseSession());
containment.simulateTerminationFailure(session.sentinel_session_id);
const unconfirmed = await sentinel.submitObservation(gate, session.sentinel_session_id, {
  version: '1.0', observation_id: `${session.sentinel_session_id}.revoked`, tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id,
  timestamp: new Date().toISOString(), source: 'TNA_GATE', observation_type: 'REVOCATION_RECHECK', payload: { result: 'REVOKED', scope: 'agent' },
});
assert.equal(unconfirmed.decision?.violations[0]?.severity, 'CRITICAL');
process.stdout.write('CRITICAL VIOLATION\n');
assert.equal(unconfirmed.decision?.decision, 'TERMINATE');
process.stdout.write('TERMINATE DECISION\n');
assert.equal(unconfirmed.decision?.containment_status, 'CONTAINMENT_UNCONFIRMED');
process.stdout.write('CONTAINMENT REQUEST FAILED / UNKNOWN\n');
const indeterminate = sentinel.getSession(ctrl, session.sentinel_session_id);
assert.equal(indeterminate.status, 'INDETERMINATE', 'a failed containment call must never be reported as a successful TERMINATED');
process.stdout.write('SESSION INDETERMINATE\n');

sentinel.close();
ledgerStore.close();

separator('SUMMARY');
log('RESULT', 'Flow A: ✓ normal execution monitored, evaluated, and completed with Ledger evidence');
log('RESULT', 'Flow B: ✓ tool drift detected, terminated, containment confirmed, Ledger evidence written');
log('RESULT', 'Flow C: ✓ mid-run agent revocation detected and terminated');
log('RESULT', 'Flow D: ✓ policy drift held the session; trusted resume with a renewed hash restored monitoring');
log('RESULT', 'Flow E: ✓ a critical violation whose containment could not be confirmed reported INDETERMINATE, never a false TERMINATED');
process.stdout.write('\nTNA Sentinel v0.1 demo passed.\n');
