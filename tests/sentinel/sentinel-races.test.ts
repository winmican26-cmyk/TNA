import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../../packages/sentinel-schema/src/index.js';
import { setup, baseSessionInput, baseObservation } from './fixture.js';

test('race — revocation vs. tool call (Sentinel G2): revalidation reflects the current state, not a stale snapshot from session start', async () => {
  const { runtime, ctrl, bw, revalidator, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  // Nothing has revoked anything yet — an ordinary tool call proceeds.
  const before = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'o1', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'github' } }));
  assert.equal(before.decision?.decision, 'CONTINUE');
  // Revocation happens "concurrently" with the next tool call being requested.
  revalidator.set(session.sentinel_session_id, { status: 'REVOKED', revokedScope: 'agent' });
  const after = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'o2', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'github' } }));
  assert.equal(after.decision?.decision, 'TERMINATE');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'TERMINATED');
});

test('race — policy change vs. execution: a policy hash drift observed mid-session forces HOLD, never silent continuation', async () => {
  const { runtime, ctrl, bw, revalidator, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, policy_snapshot_hash: hash('policy-v1') }));
  revalidator.set(session.sentinel_session_id, { status: 'POLICY_CHANGED', currentPolicyHash: hash('policy-v2') });
  const result = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id }));
  assert.equal(result.decision?.decision, 'HOLD');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'HELD');
});

test('race — emergency stop: a stop activated between observations is honored on the very next evaluation, with no window to keep continuing', async () => {
  const { runtime, ad, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const first = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'o1' }));
  assert.equal(first.decision?.decision, 'CONTINUE');
  runtime.activateStop(ad, 'tenant', tenantId, 'incident response');
  const second = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'o2' }));
  assert.equal(second.decision?.decision, 'TERMINATE');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'TERMINATED');
});

test('concurrent terminating violations resolve to one stable final state with all violation evidence retained', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github', runtime_limits: { max_runtime_seconds: 3600 } }));
  const results = await Promise.all([
    runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'drift-1', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' } })),
    runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'drift-2', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' } })),
  ]);
  assert.ok(results.every(r => r.decision?.decision === 'TERMINATE'));
  const final = runtime.getSession(ctrl, session.sentinel_session_id);
  assert.equal(final.status, 'TERMINATED');
  const violations = runtime.listViolations(ctrl, session.sentinel_session_id);
  assert.equal(violations.items.length, 2);
});
