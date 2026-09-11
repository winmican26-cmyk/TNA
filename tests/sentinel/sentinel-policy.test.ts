import test from 'node:test';
import assert from 'node:assert/strict';
import { SentinelError } from '../../packages/sentinel-schema/src/index.js';
import { validatePolicyInput, finalizePolicy, computePolicyHash, defaultDemoPolicyInput } from '../../packages/sentinel-policy/src/index.js';

function base(tenantId = 't1') {
  return { version: '1.0' as const, policy_id: 'p1', tenant_id: tenantId, name: 'Test policy', enabled: true, default_behavior: 'OBSERVE' as const, rules: [] };
}

test('malformed policy is rejected wholesale before activation', () => {
  assert.throws(() => validatePolicyInput({ ...base(), name: '' }), (e: unknown) => e instanceof SentinelError && e.code === 'POLICY_INVALID');
});
test('unknown rule_type is rejected', () => {
  assert.throws(() => validatePolicyInput({ ...base(), rules: [{ rule_id: 'r1', rule_type: 'MADE_UP', severity: 'HIGH', enabled: true, action: 'HOLD' }] }), (e: unknown) => e instanceof SentinelError && e.code === 'POLICY_INVALID');
});
test('duplicate rule_id is rejected', () => {
  const rule = { rule_id: 'r1', rule_type: 'AGENT_REVOKED', severity: 'CRITICAL', enabled: true, action: 'TERMINATE' };
  assert.throws(() => validatePolicyInput({ ...base(), rules: [rule, rule] }), (e: unknown) => e instanceof SentinelError && e.code === 'POLICY_INVALID');
});
test('TOO_MANY_TOOL_CALLS without params.max_tool_calls is rejected', () => {
  assert.throws(() => validatePolicyInput({ ...base(), rules: [{ rule_id: 'r1', rule_type: 'TOO_MANY_TOOL_CALLS', severity: 'MEDIUM', enabled: true, action: 'HOLD' }] }), (e: unknown) => e instanceof SentinelError && e.code === 'POLICY_INVALID');
});
test('warning_threshold must be strictly below the maximum', () => {
  assert.throws(() => validatePolicyInput({ ...base(), rules: [{ rule_id: 'r1', rule_type: 'TOO_MANY_TOOL_CALLS', severity: 'MEDIUM', enabled: true, action: 'HOLD', params: { max_tool_calls: 5, warning_threshold: 5 } }] }), (e: unknown) => e instanceof SentinelError && e.code === 'POLICY_INVALID');
  assert.doesNotThrow(() => validatePolicyInput({ ...base(), rules: [{ rule_id: 'r1', rule_type: 'TOO_MANY_TOOL_CALLS', severity: 'MEDIUM', enabled: true, action: 'HOLD', params: { max_tool_calls: 5, warning_threshold: 4 } }] }));
});
test('non-decreasing risk_thresholds are required', () => {
  assert.throws(() => validatePolicyInput({ ...base(), risk_thresholds: { warn_at: 50, hold_at: 20 } }), (e: unknown) => e instanceof SentinelError && e.code === 'POLICY_INVALID');
  assert.doesNotThrow(() => validatePolicyInput({ ...base(), risk_thresholds: { warn_at: 10, hold_at: 30, terminate_at: 100 } }));
});
test('Sentinel computes the policy hash — a caller-supplied hash is never trusted', () => {
  const input = validatePolicyInput(base());
  const policy = finalizePolicy(input, () => Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(policy.policy_hash, computePolicyHash(input));
  assert.equal(policy.created_at, '2026-01-01T00:00:00.000Z');
});
test('policy hash is stable across re-validation and changes when content changes', () => {
  const a = finalizePolicy(validatePolicyInput(base()));
  const b = finalizePolicy(validatePolicyInput(base()));
  assert.equal(a.policy_hash, b.policy_hash);
  const c = finalizePolicy(validatePolicyInput({ ...base(), name: 'Different name' }));
  assert.notEqual(a.policy_hash, c.policy_hash);
});
test('the default demo policy validates and enables every rule type', () => {
  const input = validatePolicyInput(defaultDemoPolicyInput('tenant_demo'));
  assert.ok(input.rules.length >= 20);
  assert.ok(input.rules.every(rule => rule.enabled));
});
