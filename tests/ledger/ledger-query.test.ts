import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUERY_PAGE_SIZE } from '../../packages/ledger-schema/src/index.js';
import { GateLedgerAdapter } from '../../apps/tna-ledger/src/gate-adapter.js';
import { VadLedgerAdapter } from '../../apps/tna-ledger/src/vad-adapter.js';
import { setup, baseEvent } from './fixture.js';

test('pagination is bounded and cursors advance deterministically', () => {
  const { ledger, gw, rd, tenantId } = setup();
  for (let i = 0; i < 25; i++) ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: `e${i}`, stream_id: 'agent:a1' }));
  const first = ledger.getEventsByActor(rd, 'tna-gate', 10);
  assert.equal(first.items.length, 10);
  assert.ok(first.nextCursor);
  const second = ledger.getEventsByActor(rd, 'tna-gate', 10, first.nextCursor ?? undefined);
  assert.equal(second.items.length, 10);
  assert.notEqual(first.items[0]?.event_id, second.items[0]?.event_id);
  const third = ledger.getEventsByActor(rd, 'tna-gate', 10, second.nextCursor ?? undefined);
  assert.equal(third.items.length, 5);
  assert.equal(third.nextCursor, null);
});

test('requested page size is capped at the maximum page size', () => {
  const { ledger, gw, rd, tenantId } = setup();
  for (let i = 0; i < 5; i++) ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: `e${i}` }));
  const page = ledger.getEventsByActor(rd, 'tna-gate', MAX_QUERY_PAGE_SIZE * 10);
  assert.equal(page.items.length, 5);
});

test('deterministic ordering: received_at, then stream_id, then sequence, then event_id', () => {
  const { ledger, gw, rd, tenantId } = setup();
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'z-last', stream_id: 'agent:a1' }));
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'a-second', stream_id: 'agent:a1' }));
  const page = ledger.getEventsByActor(rd, 'tna-gate', 50);
  assert.deepEqual(page.items.map(e => e.event_id), ['z-last', 'a-second']);
});

test('query by decision, execution, atom, and type', () => {
  const { ledger, gw, vw, rd, tenantId } = setup();
  const gateAdapter = new GateLedgerAdapter(tenantId);
  const vadAdapter = new VadLedgerAdapter(tenantId);
  ledger.append(gw, gateAdapter.authorizationAllowed({ agentId: 'a1', decisionId: 'd1', policyHash: 'p1', action: 'x' }));
  ledger.append(gw, gateAdapter.executionStarted({ agentId: 'a1', decisionId: 'd1', executionId: 'exec-1', tool: 't', resource: 'r' }));
  ledger.append(vw, vadAdapter.atomCreated({ atomId: 'atom-1', specHash: 'h1', riskLevel: 'low' }));

  assert.equal(ledger.getEventsByDecision(rd, 'd1').length, 1);
  assert.equal(ledger.getEventsByExecution(rd, 'exec-1').length, 1);
  assert.equal(ledger.getEventsByAtom(rd, 'atom-1').length, 1);
  assert.equal(ledger.getEventsByType(rd, 'AUTHORIZATION_ALLOWED').items.length, 1);
  assert.equal(ledger.getEventsByType(rd, 'EXECUTION_STARTED').items.length, 1);
});

test('search combines multiple filters', () => {
  const { ledger, gw, rd, tenantId } = setup();
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'a', event_type: 'AGENT_REGISTERED', correlation_id: 'agent:a1', authority_context: { agent_id: 'a1' } }));
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'b', event_type: 'AGENT_REVOKED', correlation_id: 'agent:a1', authority_context: { agent_id: 'a1' } }));
  const page = ledger.search(rd, { correlationId: 'agent:a1', eventType: 'AGENT_REVOKED' });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.event_id, 'b');
});

test('reconstructs a full Gate action from evidence alone', () => {
  const { ledger, gw, rd, tenantId } = setup();
  const adapter = new GateLedgerAdapter(tenantId);
  ledger.append(gw, adapter.agentRegistered('agent-17'));
  ledger.append(gw, adapter.authorizationAllowed({ agentId: 'agent-17', decisionId: 'dec-123', policyHash: 'policy-xyz', action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.release' }));
  ledger.append(gw, adapter.capabilityIssued({ agentId: 'agent-17', decisionId: 'dec-123', capabilityId: 'cap-456', expiresAt: new Date(Date.now() + 1000).toISOString() }));
  ledger.append(gw, adapter.capabilityRedeemed({ agentId: 'agent-17', decisionId: 'dec-123', capabilityId: 'cap-456', executionId: 'exec-789' }));
  ledger.append(gw, adapter.executionStarted({ agentId: 'agent-17', decisionId: 'dec-123', executionId: 'exec-789', tool: 'deploy.execute', resource: 'prod.release' }));
  ledger.append(gw, adapter.executionSucceeded({ agentId: 'agent-17', decisionId: 'dec-123', executionId: 'exec-789', resultHash: 'a'.repeat(64) }));

  const reconstruction = ledger.reconstructGateAction(rd, 'dec-123');
  assert.equal(reconstruction.who?.actorId, 'tna-gate');
  assert.equal(reconstruction.authorizedUnder?.decisionId, 'dec-123');
  assert.equal(reconstruction.what, 'production.deploy');
  assert.equal(reconstruction.tool, 'deploy.execute');
  assert.equal(reconstruction.resource, 'prod.release');
  assert.equal(reconstruction.capability?.capabilityId, 'cap-456');
  assert.equal(reconstruction.execution?.executionId, 'exec-789');
  assert.equal(reconstruction.outcome, 'SUCCEEDED');
  assert.equal(reconstruction.truncated, false);
  // AGENT_REGISTERED is correlated to the agent's own lifecycle (agent:agent-17), not this decision — correctly excluded.
  assert.equal(reconstruction.evidence.length, 5);
});

test('reconstructs a full VAD atom lifecycle from evidence alone', () => {
  const { ledger, vw, rd, tenantId } = setup();
  const adapter = new VadLedgerAdapter(tenantId);
  ledger.append(vw, adapter.atomCreated({ atomId: 'atom-9', specHash: 'h9', riskLevel: 'medium' }));
  ledger.append(vw, adapter.attemptStarted({ atomId: 'atom-9', specHash: 'h9', attemptNumber: 1 }));
  ledger.append(vw, adapter.attemptFailed({ atomId: 'atom-9', specHash: 'h9', attemptNumber: 1, artifactHash: 'a'.repeat(64) }));
  ledger.append(vw, adapter.attemptStarted({ atomId: 'atom-9', specHash: 'h9', attemptNumber: 2 }));
  ledger.append(vw, adapter.validationPassed({ atomId: 'atom-9', specHash: 'h9', attemptNumber: 2, artifactHash: 'b'.repeat(64) }));
  ledger.append(vw, adapter.verificationAccepted({ atomId: 'atom-9', specHash: 'h9', verifierId: 'default-verifier' }));
  ledger.append(vw, adapter.humanDecision({ atomId: 'atom-9', specHash: 'h9', actorId: 'reviewer-1', decision: 'MERGE' }));
  ledger.append(vw, adapter.atomAccepted({ atomId: 'atom-9', specHash: 'h9', artifactHash: 'b'.repeat(64), verifierVerdict: 'ACCEPT', humanDecision: 'MERGE' }));

  const reconstruction = ledger.reconstructVadAtom(rd, 'atom:atom-9');
  assert.equal(reconstruction.atom?.atomId, 'atom-9');
  assert.equal(reconstruction.attempts.length, 3);
  assert.deepEqual(reconstruction.validation, { passed: true });
  assert.equal(reconstruction.verification?.verdict, 'ACCEPT');
  assert.equal(reconstruction.humanDecision?.decision, 'MERGE');
  assert.equal(reconstruction.finalState, 'ACCEPTED');
});

test('export generates a self-contained bundle that verifies, and tampering the export is detected', () => {
  const { ledger, gw, rd, tenantId } = setup();
  const adapter = new GateLedgerAdapter(tenantId);
  ledger.append(gw, adapter.authorizationAllowed({ agentId: 'a1', decisionId: 'dec-export', policyHash: 'p1', action: 'x' }));
  ledger.append(gw, adapter.capabilityIssued({ agentId: 'a1', decisionId: 'dec-export', capabilityId: 'cap-1', expiresAt: new Date(Date.now() + 1000).toISOString() }));

  const bundle = ledger.exportEvidence(rd, 'dec-export');
  assert.equal(bundle.events.length, 2);
  const verification = ledger.verifyExportedBundle(rd, bundle);
  assert.equal(verification.valid, true);

  const tampered = structuredClone(bundle);
  tampered.events[0]!.payload = { injected: true };
  const tamperedVerification = ledger.verifyExportedBundle(rd, tampered);
  assert.equal(tamperedVerification.valid, false);
});

test('reconstruction is bounded and reports truncation rather than silently omitting events', () => {
  const { ledger, gw, rd, tenantId } = setup();
  // MAX_RECONSTRUCTION_EVENTS is 500 in v0.1; exceeding it should truncate rather than crash or hide the fact.
  for (let i = 0; i < 501; i++) {
    ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: `bulk-${i}`, correlation_id: 'dec-bulk', stream_id: 'agent:bulk' }));
  }
  const reconstruction = ledger.reconstructGateAction(rd, 'dec-bulk');
  assert.equal(reconstruction.truncated, true);
  assert.equal(reconstruction.evidence.length, 500);
});
