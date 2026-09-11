import test from 'node:test';
import assert from 'node:assert/strict';
import { SentinelError, type SentinelSession } from '../../packages/sentinel-schema/src/index.js';
import { finalizePolicy, validatePolicyInput } from '../../packages/sentinel-policy/src/index.js';
import { evaluateSession, assertValidTransition, nextStatusForDecision } from '../../packages/sentinel-engine/src/index.js';
import { baseSessionInput } from './fixture.js';

function session(overrides: Record<string, unknown> = {}): SentinelSession {
  const input = baseSessionInput({ tenant_id: 't1', ...overrides } as never);
  return {
    ...input, sentinel_session_id: 's1', started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    status: (overrides.status as never) ?? 'MONITORING', observation_sequence: 0,
    tool_call_count: (overrides.tool_call_count as number | undefined) ?? 0,
    network_request_count: (overrides.network_request_count as number | undefined) ?? 0,
    process_spawn_count: (overrides.process_spawn_count as number | undefined) ?? 0,
    session_cost: (overrides.session_cost as number | undefined) ?? 0,
    last_heartbeat_at: (overrides.last_heartbeat_at as string | null | undefined) ?? null,
  };
}
function policyWith(rules: unknown[]) {
  return finalizePolicy(validatePolicyInput({ version: '1.0', policy_id: 'p1', tenant_id: 't1', name: 'p', enabled: true, default_behavior: 'OBSERVE', rules }));
}

test('valid session transitions are accepted; invalid ones throw INVALID_TRANSITION', () => {
  assert.doesNotThrow(() => assertValidTransition('CREATED', 'MONITORING'));
  assert.doesNotThrow(() => assertValidTransition('MONITORING', 'HELD'));
  assert.doesNotThrow(() => assertValidTransition('HELD', 'TERMINATING'));
  assert.doesNotThrow(() => assertValidTransition('TERMINATING', 'INDETERMINATE'));
  assert.throws(() => assertValidTransition('CREATED', 'TERMINATED'), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_TRANSITION');
  assert.throws(() => assertValidTransition('TERMINATED', 'MONITORING'), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_TRANSITION');
  assert.throws(() => assertValidTransition('HELD', 'WARNED'), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_TRANSITION');
});

test('a HOLD decision while already HELD stays HELD — only resume() may leave HELD for MONITORING', () => {
  assert.equal(nextStatusForDecision('HELD', 'CONTINUE'), 'HELD');
  assert.equal(nextStatusForDecision('HELD', 'WARN'), 'HELD');
  assert.equal(nextStatusForDecision('HELD', 'TERMINATE'), 'TERMINATING');
  assert.equal(nextStatusForDecision('MONITORING', 'CONTINUE'), 'MONITORING');
  assert.equal(nextStatusForDecision('MONITORING', 'WARN'), 'WARNED');
});

test('decision precedence: TERMINATE beats HOLD beats WARN beats CONTINUE when multiple rules fire', () => {
  const policy = policyWith([
    { rule_id: 'r-warn', rule_type: 'TOO_MANY_TOOL_CALLS', severity: 'LOW', enabled: true, action: 'WARN', params: { max_tool_calls: 1 } },
    { rule_id: 'r-hold', rule_type: 'POLICY_CHANGED', severity: 'MEDIUM', enabled: true, action: 'HOLD' },
    { rule_id: 'r-terminate', rule_type: 'AGENT_REVOKED', severity: 'CRITICAL', enabled: true, action: 'TERMINATE' },
  ]);
  const s = session({ tool_call_count: 5 });
  const outcome = evaluateSession({ session: s, policy, now: Date.parse('2026-01-01T00:00:00.000Z'), authorityStatus: { status: 'REVOKED', revokedScope: 'agent' } });
  assert.equal(outcome.decision.decision, 'TERMINATE');
  // POLICY_CHANGED does not match here — authorityStatus is REVOKED, not POLICY_CHANGED — so only the
  // volumetric breach and the agent-revocation match contribute violations.
  assert.equal(outcome.violations.length, 2);
  assert.deepEqual([...outcome.decision.triggered_rules].sort(), ['r-terminate', 'r-warn']);
  assert.equal(outcome.nextStatus, 'TERMINATING');
});

test('risk score is the highest active severity score, deterministically', () => {
  const policy = policyWith([
    { rule_id: 'r1', rule_type: 'TOO_MANY_TOOL_CALLS', severity: 'LOW', enabled: true, action: 'WARN', params: { max_tool_calls: 1 } },
    { rule_id: 'r2', rule_type: 'RUNTIME_EXCEEDED', severity: 'MEDIUM', enabled: true, action: 'HOLD' },
  ]);
  const s = session({ tool_call_count: 5, runtime_limits: { max_runtime_seconds: 1 } });
  const outcome = evaluateSession({ session: s, policy, now: Date.parse('2026-01-01T00:10:00.000Z') });
  assert.equal(outcome.decision.risk_score, 30); // MEDIUM
});

test('the same inputs always produce the same decision (TNA-32 replayability)', () => {
  const policy = policyWith([{ rule_id: 'r1', rule_type: 'AUTHORITY_EXPIRED', severity: 'CRITICAL', enabled: true, action: 'TERMINATE' }]);
  const s = session({ authority_expiry: '2026-01-01T00:00:00.000Z' });
  const now = Date.parse('2026-01-01T00:01:00.000Z');
  const first = evaluateSession({ session: s, policy, now, newId: () => 'fixed-id' });
  const second = evaluateSession({ session: s, policy, now, newId: () => 'fixed-id' });
  assert.deepEqual(first.decision, second.decision);
});

test('no matched rules yields CONTINUE with zero risk and an unchanged MONITORING status', () => {
  const policy = policyWith([{ rule_id: 'r1', rule_type: 'AUTHORITY_EXPIRED', severity: 'CRITICAL', enabled: true, action: 'TERMINATE' }]);
  const outcome = evaluateSession({ session: session(), policy, now: Date.parse('2026-01-01T00:00:01.000Z') });
  assert.equal(outcome.decision.decision, 'CONTINUE');
  assert.equal(outcome.decision.risk_score, 0);
  assert.equal(outcome.nextStatus, 'MONITORING');
});

test('a disabled rule never contributes a violation even if its condition holds', () => {
  const policy = policyWith([{ rule_id: 'r1', rule_type: 'AUTHORITY_EXPIRED', severity: 'CRITICAL', enabled: false, action: 'TERMINATE' }]);
  const s = session({ authority_expiry: '2026-01-01T00:00:00.000Z' });
  const outcome = evaluateSession({ session: s, policy, now: Date.parse('2026-01-01T00:10:00.000Z') });
  assert.equal(outcome.decision.decision, 'CONTINUE');
});

test('an emergency stop overrides ordinary rule evaluation and forces TERMINATE', () => {
  const policy = policyWith([]);
  const outcome = evaluateSession({ session: session(), policy, now: Date.parse('2026-01-01T00:00:01.000Z'), emergencyStopActive: true });
  assert.equal(outcome.decision.decision, 'TERMINATE');
  assert.equal(outcome.violations[0]?.rule_type, 'EMERGENCY_STOP');
});

test('evaluating an already-terminal session throws SESSION_TERMINAL', () => {
  const policy = policyWith([]);
  const terminated = session({ status: 'TERMINATED' });
  assert.throws(() => evaluateSession({ session: terminated, policy, now: Date.parse('2026-01-01T00:00:01.000Z') }), (e: unknown) => e instanceof SentinelError && e.code === 'SESSION_TERMINAL');
});

test('a rule evaluation ERROR (UNKNOWN authority) fails safe to at least HOLD, never silently ignored', () => {
  const policy = policyWith([{ rule_id: 'r1', rule_type: 'AGENT_REVOKED', severity: 'CRITICAL', enabled: true, action: 'TERMINATE' }]);
  const outcome = evaluateSession({ session: session(), policy, now: Date.parse('2026-01-01T00:00:01.000Z'), authorityStatus: { status: 'UNKNOWN' } });
  assert.equal(outcome.decision.decision, 'HOLD');
  assert.equal(outcome.violations.length, 1);
});

test('risk_thresholds escalate but never de-escalate a decision', () => {
  const policy = { ...policyWith([{ rule_id: 'r1', rule_type: 'TOO_MANY_TOOL_CALLS', severity: 'LOW', enabled: true, action: 'WARN', params: { max_tool_calls: 1 } }]), risk_thresholds: { hold_at: 5 } };
  const outcome = evaluateSession({ session: session({ tool_call_count: 5 }), policy, now: Date.parse('2026-01-01T00:00:01.000Z') });
  assert.equal(outcome.decision.decision, 'HOLD'); // escalated from WARN because risk_score (10) >= hold_at (5)
});
