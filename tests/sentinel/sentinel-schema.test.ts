import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSessionInput, validateObservationInput, SentinelError, MAX_OBSERVATION_PAYLOAD_BYTES, hash, canonical } from '../../packages/sentinel-schema/src/index.js';
import { baseSessionInput, baseObservation } from './fixture.js';

test('unsupported session version is rejected', () => {
  assert.throws(() => validateSessionInput({ ...baseSessionInput({ tenant_id: 't1' }), version: '2.0' }), (e: unknown) => e instanceof SentinelError && e.code === 'UNSUPPORTED_VERSION');
});
test('session missing required fields is rejected', () => {
  assert.throws(() => validateSessionInput({ version: '1.0', tenant_id: 't1' }), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_INPUT');
});
test('session with an untrusted allowed_operations entry is rejected', () => {
  assert.throws(() => validateSessionInput({ ...baseSessionInput({ tenant_id: 't1' }), allowed_operations: ['read', 'sudo'] }), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_INPUT');
});
test('session with a malformed authority_snapshot_hash is rejected', () => {
  assert.throws(() => validateSessionInput({ ...baseSessionInput({ tenant_id: 't1' }), authority_snapshot_hash: 'not-a-hash' }), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_INPUT');
});
test('session with an invalid authority_expiry is rejected', () => {
  assert.throws(() => validateSessionInput({ ...baseSessionInput({ tenant_id: 't1' }), authority_expiry: '2026-01-01' }), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_INPUT');
});
test('a valid session input round-trips through validation unchanged in substance', () => {
  const input = baseSessionInput({ tenant_id: 't1' });
  const validated = validateSessionInput(input);
  assert.equal(validated.tenant_id, 't1');
  assert.equal(validated.expected_tool, input.expected_tool);
});
test('secret-shaped capability_context field is rejected', () => {
  assert.throws(() => validateSessionInput({
    ...baseSessionInput({ tenant_id: 't1' }),
    capability_context: { capability_id: 'cap-1', decision_id: 'd1', agent_id: 'a1', tool: 'github', operation: 'read', resource: 'repo:x/y', expiry: '2026-01-01T00:00:00.000Z', input_hash: hash('x'), api_key: 'sk-abc' },
  }), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_INPUT');
});

test('unsupported observation version is rejected', () => {
  assert.throws(() => validateObservationInput({ ...baseObservation({ tenant_id: 't1', sentinel_session_id: 's1' }), version: '2.0' }), (e: unknown) => e instanceof SentinelError && e.code === 'UNSUPPORTED_VERSION');
});
test('unknown observation type is rejected', () => {
  assert.throws(() => validateObservationInput({ ...baseObservation({ tenant_id: 't1', sentinel_session_id: 's1' }), observation_type: 'SOMETHING_MADE_UP' }), (e: unknown) => e instanceof SentinelError && e.code === 'UNKNOWN_OBSERVATION_TYPE');
});
test('untrusted observation source is rejected', () => {
  assert.throws(() => validateObservationInput({ ...baseObservation({ tenant_id: 't1', sentinel_session_id: 's1' }), source: 'RANDOM_AGENT' }), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_INPUT');
});
test('oversized observation payload is rejected before persistence', () => {
  const payload = { blob: 'x'.repeat(MAX_OBSERVATION_PAYLOAD_BYTES + 1) };
  assert.throws(() => validateObservationInput(baseObservation({ tenant_id: 't1', sentinel_session_id: 's1', payload })), (e: unknown) => e instanceof SentinelError && e.code === 'PAYLOAD_TOO_LARGE');
});
for (const [label, payload] of [
  ['bearer header', { note: 'Authorization: Bearer abc123def456' }],
  ['api_key field', { api_key: 'sk-abcdef' }],
  ['password field', { password: 'hunter2' }],
] as const) {
  test(`secret-shaped observation payload rejected: ${label}`, () => {
    assert.throws(() => validateObservationInput(baseObservation({ tenant_id: 't1', sentinel_session_id: 's1', payload })), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_INPUT');
  });
}
test('a valid observation input round-trips through validation unchanged in substance', () => {
  const input = baseObservation({ tenant_id: 't1', sentinel_session_id: 's1', payload: { tool: 'github' } });
  const validated = validateObservationInput(input);
  assert.equal(validated.observation_type, 'TOOL_CALL_REQUESTED');
  assert.deepEqual(validated.payload, { tool: 'github' });
});

test('canonical hash is stable regardless of key order', () => {
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});
