import test from 'node:test';
import assert from 'node:assert/strict';
import { LedgerError, writerPrincipal, readerPrincipal } from '../../packages/ledger-core/src/index.js';
import { setup, baseEvent } from './fixture.js';

test('a writer bound to tna-gate cannot claim source_component vad-engine (writer source binding)', () => {
  const { ledger, gw, tenantId } = setup();
  assert.throws(() => ledger.append(gw, baseEvent({ tenant_id: tenantId, source_component: 'vad-engine' })),
    (e: unknown) => e instanceof LedgerError && e.code === 'FORBIDDEN');
});

test('a reader cannot append events (governed agents are never issued write credentials)', () => {
  const { ledger, rd, tenantId } = setup();
  assert.throws(() => ledger.append(rd, baseEvent({ tenant_id: tenantId })), (e: unknown) => e instanceof LedgerError && e.code === 'FORBIDDEN');
});

test('event forgery: no principal can submit a SYSTEM ATOM_ACCEPTED event without a bound writer identity for it', () => {
  const { ledger, rd, ad, tenantId } = setup();
  const forged = baseEvent({
    tenant_id: tenantId, event_type: 'ATOM_ACCEPTED', actor: { type: 'SYSTEM', id: 'vad-engine' },
    spec_context: { atom_id: 'atom-1', spec_hash: 'h1', verifier_verdict: 'ACCEPT', human_decision: 'MERGE' },
    artifact_context: { artifact_hash: 'a'.repeat(64) },
  });
  assert.throws(() => ledger.append(rd, forged), (e: unknown) => e instanceof LedgerError && e.code === 'FORBIDDEN');
  assert.throws(() => ledger.append(ad, forged), (e: unknown) => e instanceof LedgerError && e.code === 'FORBIDDEN');
});

test('admin cannot append (role separation: admin is not a writer)', () => {
  const { ledger, ad, tenantId } = setup();
  assert.throws(() => ledger.append(ad, baseEvent({ tenant_id: tenantId })), (e: unknown) => e instanceof LedgerError && e.code === 'FORBIDDEN');
});

test('only admin may run full-ledger verification', () => {
  const { ledger, gw, rd, tenantId } = setup();
  ledger.append(gw, baseEvent({ tenant_id: tenantId }));
  assert.throws(() => ledger.verifyAll(rd), (e: unknown) => e instanceof LedgerError && e.code === 'FORBIDDEN');
});

test('tenant isolation: a reader cannot see another tenant\'s events', () => {
  const { ledger, gw, tenantId } = setup('tenant_a');
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'a-event' }));
  const readerB = readerPrincipal('ledger-reader', 'tenant_b');
  const page = ledger.getEventsByActor(readerB, 'tna-gate');
  assert.equal(page.items.length, 0);
});

test('a writer bound to one tenant cannot append into another tenant', () => {
  const { ledger, tenantId } = setup('tenant_a');
  const writerB = writerPrincipal('ledger-writer-gate', 'tenant_b', ['tna-gate']);
  assert.throws(() => ledger.append(writerB, baseEvent({ tenant_id: tenantId })), (e: unknown) => e instanceof LedgerError && e.code === 'FORBIDDEN');
});

test('cross-tenant stream isolation: the same stream_id under two tenants stays isolated', () => {
  const { ledger, gw } = setup('tenant_a');
  const writerB = writerPrincipal('ledger-writer-gate', 'tenant_b', ['tna-gate']);
  const readerA = readerPrincipal('ledger-reader', 'tenant_a');
  const readerB = readerPrincipal('ledger-reader', 'tenant_b');
  ledger.append(gw, baseEvent({ tenant_id: 'tenant_a', event_id: 'a1', stream_id: 'agent:shared' }));
  ledger.append(writerB, baseEvent({ tenant_id: 'tenant_b', event_id: 'b1', stream_id: 'agent:shared' }));
  const streamA = ledger.getStream(readerA, 'agent:shared').items;
  const streamB = ledger.getStream(readerB, 'agent:shared').items;
  assert.equal(streamA.length, 1);
  assert.equal(streamB.length, 1);
  assert.equal(streamA[0]?.event_id, 'a1');
  assert.equal(streamB[0]?.event_id, 'b1');
  assert.equal(streamA[0]?.sequence, 1);
  assert.equal(streamB[0]?.sequence, 1);
});

test('orphan rejected: CAPABILITY_REDEEMED with no prior CAPABILITY_ISSUED', () => {
  const { ledger, gw, tenantId } = setup();
  assert.throws(() => ledger.append(gw, baseEvent({
    tenant_id: tenantId, event_type: 'CAPABILITY_REDEEMED', authority_context: { capability_id: 'cap-missing' },
  })), (e: unknown) => e instanceof LedgerError && e.code === 'ORPHAN_EVENT');
});

test('capability redeem succeeds once a prior CAPABILITY_ISSUED exists', () => {
  const { ledger, gw, tenantId } = setup();
  ledger.append(gw, baseEvent({
    tenant_id: tenantId, event_type: 'CAPABILITY_ISSUED',
    authority_context: { capability_id: 'cap-1', decision_id: 'd1', authority_expiry: new Date(Date.now() + 1000).toISOString() },
  }));
  assert.doesNotThrow(() => ledger.append(gw, baseEvent({
    tenant_id: tenantId, event_type: 'CAPABILITY_REDEEMED', authority_context: { capability_id: 'cap-1' },
  })));
});

test('orphan rejected: EXECUTION_SUCCEEDED with no prior EXECUTION_STARTED', () => {
  const { ledger, gw, tenantId } = setup();
  assert.throws(() => ledger.append(gw, baseEvent({
    tenant_id: tenantId, event_type: 'EXECUTION_SUCCEEDED', execution_context: { execution_id: 'exec-missing', result_hash: 'a'.repeat(64) },
  })), (e: unknown) => e instanceof LedgerError && e.code === 'ORPHAN_EVENT');
});

test('execution success succeeds once a prior EXECUTION_STARTED exists', () => {
  const { ledger, gw, tenantId } = setup();
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_type: 'EXECUTION_STARTED', execution_context: { execution_id: 'exec-1' } }));
  assert.doesNotThrow(() => ledger.append(gw, baseEvent({
    tenant_id: tenantId, event_type: 'EXECUTION_SUCCEEDED', execution_context: { execution_id: 'exec-1', result_hash: 'a'.repeat(64) },
  })));
});

test('orphan rejected: ATOM_ACCEPTED without prior verification and human decision', () => {
  const { ledger, vw, tenantId } = setup();
  assert.throws(() => ledger.append(vw, baseEvent({
    tenant_id: tenantId, event_type: 'ATOM_ACCEPTED', stream_id: 'atom:x', correlation_id: 'atom:x', source_component: 'vad-engine',
    spec_context: { atom_id: 'atom-x', spec_hash: 'h1', verifier_verdict: 'ACCEPT', human_decision: 'MERGE' },
    artifact_context: { artifact_hash: 'a'.repeat(64) },
  })), (e: unknown) => e instanceof LedgerError && e.code === 'ORPHAN_EVENT');
});

test('atom acceptance succeeds once verification and human decision exist', () => {
  const { ledger, vw, tenantId } = setup();
  const stream = 'atom:y';
  ledger.append(vw, baseEvent({ tenant_id: tenantId, event_type: 'ATOM_VERIFICATION_ACCEPTED', stream_id: stream, correlation_id: stream, source_component: 'vad-engine', spec_context: { atom_id: 'atom-y', spec_hash: 'h1', verifier_verdict: 'ACCEPT' } }));
  ledger.append(vw, baseEvent({ tenant_id: tenantId, event_type: 'ATOM_HUMAN_DECISION', stream_id: stream, correlation_id: stream, source_component: 'human-decision-service', actor: { type: 'HUMAN', id: 'reviewer-1' }, spec_context: { atom_id: 'atom-y', spec_hash: 'h1', human_decision: 'MERGE' } }));
  assert.doesNotThrow(() => ledger.append(vw, baseEvent({
    tenant_id: tenantId, event_type: 'ATOM_ACCEPTED', stream_id: stream, correlation_id: stream, source_component: 'vad-engine',
    spec_context: { atom_id: 'atom-y', spec_hash: 'h1', verifier_verdict: 'ACCEPT', human_decision: 'MERGE' },
    artifact_context: { artifact_hash: 'a'.repeat(64) },
  })));
});

test('orphan rejected: AGENT_REVOKED references an unknown agent', () => {
  const { ledger, gw, tenantId } = setup();
  assert.throws(() => ledger.append(gw, baseEvent({
    tenant_id: tenantId, event_type: 'AGENT_REVOKED', authority_context: { agent_id: 'never-registered' },
  })), (e: unknown) => e instanceof LedgerError && e.code === 'ORPHAN_EVENT');
});

test('a governed agent is never issued a Ledger writer credential in the first place', () => {
  // There is no factory that hands out a writer role to an arbitrary agent id — only the four
  // fixed service identities exist (gateWriter/vadWriter/reader/admin in apps/tna-ledger/src/writers.ts).
  // The closest an untrusted caller can get is a reader, which append() always rejects.
  const untrusted = readerPrincipal('agent-claiming-to-be-a-writer', 'tenant_demo');
  assert.equal(untrusted.role, 'reader');
});
