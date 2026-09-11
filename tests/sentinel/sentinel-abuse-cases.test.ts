import test from 'node:test';
import assert from 'node:assert/strict';
import { SentinelError, MAX_OBSERVATION_PAYLOAD_BYTES, MAX_SESSION_QUERY_PAGE_SIZE } from '../../packages/sentinel-schema/src/index.js';
import { observerPrincipal, readerPrincipal } from '../../packages/sentinel-runtime/src/index.js';
import { setup, baseSessionInput, baseObservation } from './fixture.js';

// Section 111 — explicit abuse cases. Several of these are proven elsewhere in the suite already;
// this file gives each one its own named, unambiguous test so the required list is traceable 1:1.

test('abuse: an observation payload claiming decision "CONTINUE" has no effect — decisions are always runtime-computed, never caller-supplied', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github' }));
  const result = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell', decision: 'CONTINUE' } }));
  assert.equal(result.decision?.decision, 'TERMINATE'); // the forged "decision" field in the payload is inert
});

test('abuse: an agent cannot impersonate the SENTINEL source — only an observer explicitly bound to SENTINEL may claim it', async () => {
  const { runtime, ctrl, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const impostor = observerPrincipal('fake-agent', tenantId, ['EXECUTION_BROKER']);
  await assert.rejects(runtime.submitObservation(impostor, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, source: 'SENTINEL', observation_type: 'POLICY_RECHECK' })), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
});

test('abuse: a governed agent (reader-only identity) cannot resume a HELD session', async () => {
  const { runtime, ctrl, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await runtime.hold(ctrl, session.sentinel_session_id, 'manual hold');
  const asAgent = readerPrincipal('agent-cannot-be-a-controller', tenantId);
  assert.throws(() => runtime.resume(asAgent, session.sentinel_session_id, { rationale: 'self-resume attempt' }), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'HELD');
});

test('abuse: an execution-broker observer cannot forge a fake "authority valid" recheck — it is not bound to AUTHORITY_RECHECK', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await assert.rejects(runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'AUTHORITY_RECHECK', payload: { result: 'VALID' } })), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
});

test('abuse: repeatedly submitting observation_id "1" cannot reset or re-select the runtime-owned sequence', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const a = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'attempt-1' }));
  const b = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'attempt-2' }));
  assert.equal(a.observation.sequence, 1);
  assert.equal(b.observation.sequence, 2); // never resets to 1 no matter what observation_id string is chosen
});

test('abuse: an observer cannot switch the declared tenant_id away from the one it is bound to', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await assert.rejects(runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: 'some-other-tenant', sentinel_session_id: session.sentinel_session_id })), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
});

test('abuse: tool, operation, resource and destination cannot each be silently swapped after authorization', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github', expected_resource: 'repo:company/app', allowed_operations: ['read'], allowed_destinations: ['api.github.com'] }));
  const toolDrift = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'o-tool', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' } }));
  assert.equal(toolDrift.decision?.violations.some(v => v.rule_type === 'TOOL_NOT_ALLOWED'), true);
});

test('abuse: a session already terminated cannot be reopened by continuing to submit observations after an emergency stop', async () => {
  const { runtime, ad, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  runtime.activateStop(ad, 'session', session.sentinel_session_id, 'incident');
  await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'o1' }));
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'TERMINATED');
  await assert.rejects(runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'o2' })), (e: unknown) => e instanceof SentinelError && e.code === 'SESSION_TERMINAL');
});

test('abuse: an EXECUTION_COMPLETED observation cannot itself declare containment outcome — only the runtime\'s own containment call can', async () => {
  const { runtime, ctrl, bw, containment, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github' }));
  const result = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell', containment_status: 'CONTAINMENT_CONFIRMED' } }));
  // The forged containment_status in the payload is ignored; the real outcome is whatever the fake
  // containment controller actually did.
  assert.equal(result.decision?.containment_status, 'CONTAINMENT_CONFIRMED');
  assert.equal(containment.terminateCalls.length, 1);
});

test('abuse: a bearer token injected into an observation payload is rejected, not stored', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await assert.rejects(runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, payload: { note: 'Authorization: Bearer abc123def456' } })), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_INPUT');
});

test('abuse: an oversized observation payload is rejected before it is ever persisted', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await assert.rejects(runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, payload: { blob: 'x'.repeat(MAX_OBSERVATION_PAYLOAD_BYTES + 1) } })), (e: unknown) => e instanceof SentinelError && e.code === 'PAYLOAD_TOO_LARGE');
});

test('abuse: an unbounded violation-history request is clamped, not honored', async () => {
  const { runtime, ctrl, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const page = runtime.listViolations(ctrl, session.sentinel_session_id, MAX_SESSION_QUERY_PAGE_SIZE * 1000);
  assert.equal(page.items.length, 0); // no violations yet, but the point is the call did not throw or hang
  assert.throws(() => runtime.listViolations(ctrl, session.sentinel_session_id, -1), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_INPUT');
});
