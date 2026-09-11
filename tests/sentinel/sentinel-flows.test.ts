import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../../packages/sentinel-schema/src/index.js';
import { setup, baseSessionInput, baseObservation } from './fixture.js';

test('flow A — normal: authorized tool call and completion produce CONTINUE throughout and a COMPLETED session', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github' }));
  const called = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'github' } }));
  assert.equal(called.decision?.decision, 'CONTINUE');
  const completed = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'EXECUTION_COMPLETED' }));
  assert.equal(completed.decision?.decision, 'CONTINUE');
  const finalSession = runtime.completeSession(ctrl, session.sentinel_session_id);
  assert.equal(finalSession.status, 'COMPLETED');
});

test('flow B — tool drift: an unexpected tool is detected, terminated, and containment confirmed', async () => {
  const { runtime, ctrl, bw, containment, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github' }));
  const result = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' } }));
  assert.equal(result.decision?.violations[0]?.rule_type, 'TOOL_NOT_ALLOWED');
  assert.equal(result.decision?.decision, 'TERMINATE');
  assert.equal(result.decision?.containment_status, 'CONTAINMENT_CONFIRMED');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'TERMINATED');
  assert.equal(containment.terminateCalls.length, 1);
});

test('flow C — revocation mid-run: a trusted REVOCATION_RECHECK observation from Gate is a critical violation and terminates', async () => {
  const { runtime, ctrl, gw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const result = await runtime.submitObservation(gw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'REVOCATION_RECHECK', payload: { result: 'REVOKED', scope: 'agent' } }));
  assert.equal(result.decision?.violations.some(v => v.rule_type === 'AGENT_REVOKED'), true);
  assert.equal(result.decision?.decision, 'TERMINATE');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'TERMINATED');
});

test('flow D — policy drift: a policy hash change holds the session, and a trusted resume with a renewed hash continues monitoring', async () => {
  const { runtime, ctrl, gw, tenantId } = setup();
  const originalHash = hash('policy-v1');
  const renewedHash = hash('policy-v2');
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, policy_snapshot_hash: originalHash }));
  const held = await runtime.submitObservation(gw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'POLICY_RECHECK', payload: { result: 'POLICY_CHANGED', current_policy_hash: renewedHash } }));
  assert.equal(held.decision?.violations[0]?.rule_type, 'POLICY_CHANGED');
  assert.equal(held.decision?.decision, 'HOLD');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'HELD');

  const resumed = runtime.resume(ctrl, session.sentinel_session_id, { rationale: 'policy reviewed and re-authorized', policySnapshotHash: renewedHash });
  assert.equal(resumed.status, 'MONITORING');
  assert.equal(resumed.policy_snapshot_hash, renewedHash);
});

test('flow E — containment failure: a critical violation whose containment cannot be confirmed reports INDETERMINATE, never a false TERMINATED', async () => {
  const { runtime, ctrl, bw, containment, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github' }));
  containment.simulateTerminationFailure(session.sentinel_session_id);
  const result = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' } }));
  assert.equal(result.decision?.decision, 'TERMINATE');
  assert.equal(result.decision?.containment_status, 'CONTAINMENT_UNCONFIRMED');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'INDETERMINATE');
});
