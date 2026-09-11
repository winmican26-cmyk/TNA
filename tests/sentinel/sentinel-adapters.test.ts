import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../packages/evidence-core/src/index.js';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { hash as envelopeHash } from '../../packages/authority-envelope/src/index.js';
import { LedgerStore, Ledger } from '../../packages/ledger-core/src/index.js';
import { sentinelWriter, reader as ledgerReader } from '../../apps/tna-ledger/src/writers.js';
import { GateAuthorityRevalidator } from '../../apps/tna-sentinel/src/gate-revalidator.js';
import { ExecutionBrokerContainmentAdapter } from '../../apps/tna-sentinel/src/broker-containment-adapter.js';
import { SentinelLedgerAdapter } from '../../apps/tna-sentinel/src/ledger-adapter.js';
import { hash, type SentinelSession } from '../../packages/sentinel-schema/src/index.js';
import { envelope } from '../fixture.js';
import { baseSessionInput } from './fixture.js';

const ADMIN = { kind: 'admin' as const, role: 'root' };
const NOW = Date.parse('2026-09-08T12:00:00Z');

function gateFixture() {
  const store = new Store(':memory:');
  const gate = new Gate(store, () => NOW);
  gate.register(ADMIN, { id: 'deployment-agent-17', name: 'Deployment Agent' });
  gate.setEnvelope(ADMIN, envelope());
  return { store, gate, policyHash: envelopeHash(envelope()) };
}
function fullSession(overrides: Record<string, unknown> = {}): SentinelSession {
  const input = baseSessionInput({ tenant_id: 't1', agent_id: 'deployment-agent-17', ...overrides } as never);
  return { ...input, sentinel_session_id: 's1', started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', status: 'MONITORING', observation_sequence: 0, tool_call_count: 0, network_request_count: 0, process_spawn_count: 0, session_cost: 0, last_heartbeat_at: null };
}

test('GateAuthorityRevalidator: VALID when the agent is active and the policy hash matches', () => {
  const { gate, policyHash } = gateFixture();
  const revalidator = new GateAuthorityRevalidator(gate, ADMIN);
  const status = revalidator.validate(fullSession({ policy_snapshot_hash: policyHash }));
  assert.equal(status.status, 'VALID');
  assert.equal(status.currentPolicyHash, policyHash);
});
test('GateAuthorityRevalidator: REVOKED once the agent is revoked in Gate', () => {
  const { gate, policyHash } = gateFixture();
  gate.revoke(ADMIN, { agentId: 'deployment-agent-17', reason: 'compromised' });
  const revalidator = new GateAuthorityRevalidator(gate, ADMIN);
  const status = revalidator.validate(fullSession({ policy_snapshot_hash: policyHash }));
  assert.equal(status.status, 'REVOKED');
  assert.equal(status.revokedScope, 'agent');
});
test('GateAuthorityRevalidator: POLICY_CHANGED when Gate\'s current envelope hash diverges from the session snapshot', () => {
  const { gate } = gateFixture();
  const revalidator = new GateAuthorityRevalidator(gate, ADMIN);
  const status = revalidator.validate(fullSession({ policy_snapshot_hash: hash('a-stale-snapshot') }));
  assert.equal(status.status, 'POLICY_CHANGED');
});
test('GateAuthorityRevalidator: UNKNOWN (fail-closed) when no envelope is on file for the agent', () => {
  const store = new Store(':memory:');
  const gate = new Gate(store, () => NOW);
  gate.register(ADMIN, { id: 'no-envelope-agent', name: 'x' });
  const revalidator = new GateAuthorityRevalidator(gate, ADMIN);
  const status = revalidator.validate(fullSession({ agent_id: 'no-envelope-agent', policy_snapshot_hash: hash('x') }));
  assert.equal(status.status, 'UNKNOWN');
});

test('ExecutionBrokerContainmentAdapter honestly reports it cannot confirm hold or terminate (documented limitation, section 46)', () => {
  const adapter = new ExecutionBrokerContainmentAdapter();
  assert.throws(() => adapter.hold('s1', { message: 'x' }));
  assert.throws(() => adapter.terminate('s1', { message: 'x' }));
});

test('SentinelLedgerAdapter produces events the accepted Ledger facade accepts, chains, and can retrieve', () => {
  const store = new LedgerStore(':memory:');
  const ledger = new Ledger(store);
  const writer = sentinelWriter('tenant_demo');
  const rd = ledgerReader('tenant_demo');
  const adapter = new SentinelLedgerAdapter('tenant_demo');
  const session = fullSession({ tenant_id: 'tenant_demo', decision_id: 'dec-1' });

  ledger.append(writer, adapter.sessionStarted(session));
  const violation = { violation_id: 'v1', rule_id: 'r1', rule_type: 'TOOL_NOT_ALLOWED' as const, severity: 'HIGH' as const, observed_at: '2026-01-01T00:00:01.000Z', observation_id: 'o1', sentinel_session_id: 's1', message_code: 'SENTINEL_TOOL_NOT_ALLOWED', message: 'drift', evidence: {}, prevention_status: 'PREVENTED' as const };
  ledger.append(writer, adapter.violationDetected(session, violation));
  const decision = { decision_id: 'd1', sentinel_session_id: 's1', timestamp: '2026-01-01T00:00:02.000Z', decision: 'TERMINATE' as const, triggered_rules: ['r1'], violations: [violation], risk_score: 60, policy_hash: session.policy_snapshot_hash, authority_snapshot_hash: session.authority_snapshot_hash, containment_status: 'CONTAINMENT_CONFIRMED' as const, transition_result: 'APPLIED' as const };
  ledger.append(writer, adapter.terminationRequested(session, decision));
  ledger.append(writer, adapter.terminated(session, decision));
  ledger.append(writer, adapter.sessionCompleted({ ...session, status: 'TERMINATED' }));

  const stream = ledger.getStream(rd, 'sentinel:s1').items;
  assert.equal(stream.length, 5);
  assert.equal(stream[0]?.event_type, 'SENTINEL_SESSION_STARTED');
  assert.equal(stream[0]?.correlation_id, 'dec-1');
  const verification = ledger.verifyStream(rd, 'sentinel:s1');
  assert.equal(verification.valid, true);
  store.close();
});
test('a governed agent cannot write Sentinel-sourced Ledger events — only the sentinel writer identity is bound to source_component "sentinel"', () => {
  const store = new LedgerStore(':memory:');
  const ledger = new Ledger(store);
  const rd = ledgerReader('tenant_demo');
  const adapter = new SentinelLedgerAdapter('tenant_demo');
  assert.throws(() => ledger.append(rd, adapter.sessionStarted(fullSession({ tenant_id: 'tenant_demo' }))));
  store.close();
});
