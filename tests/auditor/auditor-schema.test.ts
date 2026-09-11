import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditorError, validateAssessmentSpecInput, computeSpecHash, validateAssessmentScope, validateEvidenceRef,
  computeRiskContribution, hash,
} from '../../packages/auditor-schema/src/index.js';

const CUTOFF = '2026-06-02T00:00:00.000Z';
function validScope() { return { tenant_wide: false, agent_ids: ['agent-1'], time_range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' } }; }
function validSpec(overrides: Record<string, unknown> = {}) {
  return { version: '1.0', tenant_id: 't1', name: 'test assessment', scope: validScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF, ...overrides };
}

test('unsupported assessment version is rejected', () => {
  assert.throws(() => validateAssessmentSpecInput(validSpec({ version: '2.0' })), (e: unknown) => e instanceof AuditorError && e.code === 'UNSUPPORTED_VERSION');
});
test('unknown control profile is rejected', () => {
  assert.throws(() => validateAssessmentSpecInput(validSpec({ control_profile_id: 'MADE_UP_PROFILE' })), (e: unknown) => e instanceof AuditorError && e.code === 'UNKNOWN_PROFILE');
});
test('a valid spec input round-trips through validation unchanged in substance', () => {
  const input = validateAssessmentSpecInput(validSpec());
  assert.equal(input.tenant_id, 't1');
  assert.equal(input.control_profile_id, 'TNA_BASELINE_V01');
});
test('secret-shaped name/description is rejected', () => {
  assert.throws(() => validateAssessmentSpecInput(validSpec({ name: 'Authorization: Bearer abcdef123456' })), (e: unknown) => e instanceof AuditorError && e.code === 'INVALID_INPUT');
});

test('assessment spec hash is stable regardless of key order and excludes runtime fields', () => {
  const a = validateAssessmentSpecInput(validSpec());
  const b = validateAssessmentSpecInput({ evidence_cutoff_at: CUTOFF, control_profile_id: 'TNA_BASELINE_V01', scope: validScope(), name: 'test assessment', tenant_id: 't1', version: '1.0' });
  assert.equal(computeSpecHash(a), computeSpecHash(b));
});
test('assessment spec hash changes when meaningful content changes', () => {
  const a = validateAssessmentSpecInput(validSpec());
  const b = validateAssessmentSpecInput(validSpec({ name: 'a different name' }));
  assert.notEqual(computeSpecHash(a), computeSpecHash(b));
});

test('scope requires agent_ids and/or correlation_ids unless tenant_wide is explicitly true', () => {
  assert.throws(() => validateAssessmentScope({ time_range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' } }, CUTOFF), (e: unknown) => e instanceof AuditorError && e.code === 'SCOPE_INVALID');
  assert.doesNotThrow(() => validateAssessmentScope({ tenant_wide: true, time_range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' } }, CUTOFF));
});
test('scope time_range.to cannot be after evidence_cutoff_at', () => {
  assert.throws(() => validateAssessmentScope({ agent_ids: ['a1'], time_range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-03T00:00:00.000Z' } }, CUTOFF), (e: unknown) => e instanceof AuditorError && e.code === 'SCOPE_INVALID');
});
test('scope time_range.from must be strictly before time_range.to', () => {
  assert.throws(() => validateAssessmentScope({ agent_ids: ['a1'], time_range: { from: '2026-06-02T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' } }, CUTOFF), (e: unknown) => e instanceof AuditorError && e.code === 'SCOPE_INVALID');
});
test('an empty agent_ids array with no correlation_ids and no tenant_wide is rejected as ambiguous', () => {
  assert.throws(() => validateAssessmentScope({ agent_ids: [], time_range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' } }, CUTOFF), (e: unknown) => e instanceof AuditorError && e.code === 'SCOPE_INVALID');
});

test('evidence ref validation rejects unknown source_type/source_trust and malformed hashes', () => {
  assert.throws(() => validateEvidenceRef({ source_type: 'NOT_A_TYPE', source_trust: 'VERIFIED_LEDGER' }));
  assert.throws(() => validateEvidenceRef({ source_type: 'LEDGER_EVENT', source_trust: 'NOT_A_TRUST_LEVEL' }));
  assert.throws(() => validateEvidenceRef({ source_type: 'LEDGER_EVENT', source_trust: 'VERIFIED_LEDGER', event_hash: 'not-a-hash' }));
  assert.doesNotThrow(() => validateEvidenceRef({ source_type: 'LEDGER_EVENT', source_trust: 'VERIFIED_LEDGER', event_id: 'evt-1', event_hash: 'a'.repeat(64) }));
});

test('risk contribution: PASS/NOT_APPLICABLE contribute zero; PARTIAL/INSUFFICIENT_EVIDENCE contribute half; FAIL/ERROR contribute full', () => {
  assert.equal(computeRiskContribution('CRITICAL', 'PASS'), 0);
  assert.equal(computeRiskContribution('CRITICAL', 'NOT_APPLICABLE'), 0);
  assert.equal(computeRiskContribution('CRITICAL', 'PARTIAL'), 50);
  assert.equal(computeRiskContribution('CRITICAL', 'INSUFFICIENT_EVIDENCE'), 50);
  assert.equal(computeRiskContribution('CRITICAL', 'FAIL'), 100);
  assert.equal(computeRiskContribution('CRITICAL', 'ERROR'), 100);
  assert.equal(computeRiskContribution('MEDIUM', 'FAIL'), 30);
});

test('canonical hash is a pure function of content, not object identity', () => {
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
  assert.notEqual(hash({ a: 1 }), hash({ a: 2 }));
});
