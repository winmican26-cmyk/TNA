import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEventInput, canonical, hash, LedgerError, MAX_PAYLOAD_BYTES } from '../../packages/ledger-schema/src/index.js';
import { baseEvent } from './fixture.js';

test('unsupported version is rejected', () => {
  assert.throws(() => validateEventInput({ ...baseEvent({ tenant_id: 't1' }), version: '2.0' }), (e: unknown) => e instanceof LedgerError && e.code === 'UNSUPPORTED_VERSION');
});

test('unknown event type is rejected', () => {
  assert.throws(() => validateEventInput({ ...baseEvent({ tenant_id: 't1' }), event_type: 'SOMETHING_MADE_UP' }), (e: unknown) => e instanceof LedgerError && e.code === 'UNKNOWN_EVENT_TYPE');
});

test('unknown actor type is rejected', () => {
  assert.throws(() => validateEventInput({ ...baseEvent({ tenant_id: 't1' }), actor: { type: 'ROBOT', id: 'x' } }), LedgerError);
});

test('untrusted source_component is rejected', () => {
  assert.throws(() => validateEventInput({ ...baseEvent({ tenant_id: 't1' }), source_component: 'random-untrusted-service' }), LedgerError);
});

test('completeness: AUTHORIZATION_ALLOWED requires decision_id, agent_id, policy_hash, action', () => {
  assert.throws(() => validateEventInput(baseEvent({ tenant_id: 't1', event_type: 'AUTHORIZATION_ALLOWED' })), (e: unknown) => e instanceof LedgerError && e.code === 'INVALID_EVENT');
  assert.doesNotThrow(() => validateEventInput(baseEvent({
    tenant_id: 't1', event_type: 'AUTHORIZATION_ALLOWED',
    authority_context: { decision_id: 'd1', agent_id: 'a1', policy_hash: 'p1', action: 'x' },
  })));
});

test('completeness: EXECUTION_SUCCEEDED requires execution_id and result_hash', () => {
  assert.throws(() => validateEventInput(baseEvent({ tenant_id: 't1', event_type: 'EXECUTION_SUCCEEDED', execution_context: { execution_id: 'e1' } })), LedgerError);
  assert.doesNotThrow(() => validateEventInput(baseEvent({ tenant_id: 't1', event_type: 'EXECUTION_SUCCEEDED', execution_context: { execution_id: 'e1', result_hash: 'a'.repeat(64) } })));
});

test('completeness: ATOM_ACCEPTED requires spec, artifact, verifier verdict and human decision', () => {
  assert.throws(() => validateEventInput(baseEvent({
    tenant_id: 't1', event_type: 'ATOM_ACCEPTED',
    spec_context: { atom_id: 'atom-1', spec_hash: 'h1' },
  })), LedgerError);
  assert.doesNotThrow(() => validateEventInput(baseEvent({
    tenant_id: 't1', event_type: 'ATOM_ACCEPTED',
    spec_context: { atom_id: 'atom-1', spec_hash: 'h1', verifier_verdict: 'ACCEPT', human_decision: 'MERGE' },
    artifact_context: { artifact_hash: 'a'.repeat(64) },
  })));
});

for (const [label, payload] of [
  ['bearer header', { note: 'Authorization: Bearer abc123def456' }],
  ['api_key field', { api_key: 'sk-abcdef' }],
  ['password field', { password: 'hunter2' }],
  ['secret field', { secret: 'shh' }],
  ['private_key field', { private_key: '-----BEGIN KEY-----' }],
  ['access_token field', { access_token: 'ya29.abc' }],
] as const) {
  test(`secret-shaped field rejected: ${label}`, () => {
    assert.throws(() => validateEventInput(baseEvent({ tenant_id: 't1', payload })), (e: unknown) => e instanceof LedgerError && e.code === 'INVALID_EVENT');
  });
}

test('oversized payload is rejected before persistence', () => {
  const payload = { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) };
  assert.throws(() => validateEventInput(baseEvent({ tenant_id: 't1', payload })), (e: unknown) => e instanceof LedgerError && e.code === 'PAYLOAD_TOO_LARGE');
});

test('canonical hash is stable regardless of key order', () => {
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});

test('canonical hash changes when a material value changes', () => {
  assert.notEqual(hash({ a: 1, b: 2 }), hash({ a: 1, b: 3 }));
});
