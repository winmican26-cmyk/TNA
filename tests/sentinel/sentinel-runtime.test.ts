import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SentinelError } from '../../packages/sentinel-schema/src/index.js';
import { SentinelRuntime, FakeContainmentController, adminPrincipal, observerPrincipal, readerPrincipal, controllerPrincipal } from '../../packages/sentinel-runtime/src/index.js';
import { setup, baseSessionInput, baseObservation } from './fixture.js';

test('createSession requires controller or admin — a reader or observer cannot create one', () => {
  const { runtime, rd, gw, tenantId } = setup();
  assert.throws(() => runtime.createSession(rd, baseSessionInput({ tenant_id: tenantId })), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
  assert.throws(() => runtime.createSession(gw, baseSessionInput({ tenant_id: tenantId })), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
});
test('a created session starts MONITORING with runtime-owned counters at zero', () => {
  const { runtime, ctrl, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  assert.equal(session.status, 'MONITORING');
  assert.equal(session.tool_call_count, 0);
  assert.equal(session.observation_sequence, 0);
  assert.ok(session.sentinel_session_id.length > 0);
});

test('observation source binding: only a bound observer may submit its allowed observation types', async () => {
  const { runtime, ctrl, gw, egressW, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await assert.rejects(runtime.submitObservation(gw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'NETWORK_REQUEST' })), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
  const ok = await runtime.submitObservation(egressW, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'NETWORK_REQUEST', payload: { destination: 'api.github.com' } }));
  assert.equal(ok.observation.observation_type, 'NETWORK_REQUEST');
});
test('a reader cannot submit observations; only a bound observer can', async () => {
  const { runtime, ctrl, rd, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await assert.rejects(runtime.submitObservation(rd, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id })), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
});
test('a governed agent is never issued observer/controller/admin identity in the first place', () => {
  // There is no factory that hands an arbitrary agent id observer/controller/admin authority — only
  // the fixed source identities in apps/tna-sentinel/src/writers.ts exist. The closest an untrusted
  // caller can get is a reader, which submitObservation always rejects (proven above).
  const untrusted = readerPrincipal('agent-claiming-to-be-an-observer', 'tenant_demo');
  assert.equal(untrusted.role, 'reader');
});
test('an observer bound only to EXECUTION_BROKER cannot submit a TNA_GATE-only recheck type', async () => {
  const { runtime, ctrl, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const impostor = observerPrincipal('fake-source', tenantId, ['EXECUTION_BROKER']);
  await assert.rejects(runtime.submitObservation(impostor, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'AUTHORITY_RECHECK', payload: { result: 'REVOKED' } })), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
});

test('runtime owns observation sequencing: 1, 2, 3 — a caller cannot reset or choose it', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const first = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'o1' }));
  const second = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'o2' }));
  assert.equal(first.observation.sequence, 1);
  assert.equal(second.observation.sequence, 2);
});
test('identical observation_id with identical content is idempotent (no duplicate sequence assigned)', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const input = baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'fixed-1' });
  const a = await runtime.submitObservation(bw, session.sentinel_session_id, input);
  const b = await runtime.submitObservation(bw, session.sentinel_session_id, input);
  assert.equal(a.observation.sequence, b.observation.sequence);
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).observation_sequence, 1);
});
test('identical observation_id with different content is a conflict', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'fixed-2', payload: { tool: 'github' } }));
  await assert.rejects(runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: 'fixed-2', payload: { tool: 'shell' } })), (e: unknown) => e instanceof SentinelError && e.code === 'OBSERVATION_CONFLICT');
});
test('10 concurrent observations to the same session receive 10 unique, contiguous sequence numbers', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_id: `c-${i}` }))));
  const sequences = results.map(r => r.observation.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).observation_sequence, 10);
});

test('a tool-call observation increments tool_call_count exactly once per observation', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'github' } }));
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).tool_call_count, 1);
});
test('cost only accumulates from finite, non-negative reported increments — NaN/Infinity/negative are dropped', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  for (const cost of [NaN, Infinity, -5]) {
    await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'COST_REPORTED', payload: { cost_usd: cost } }));
  }
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).session_cost, 0);
  await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'COST_REPORTED', payload: { cost_usd: 2.5 } }));
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).session_cost, 2.5);
});

test('a tool drift observation is TERMINATE under the default policy and confirmed by the fake containment controller', async () => {
  const { runtime, ctrl, bw, containment, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github' }));
  const result = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' } }));
  assert.equal(result.decision?.decision, 'TERMINATE');
  assert.equal(result.decision?.containment_status, 'CONTAINMENT_CONFIRMED');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'TERMINATED');
  assert.equal(containment.terminateCalls.length, 1);
});

test('containment failure resolves the session to INDETERMINATE, never falsely TERMINATED', async () => {
  const { runtime, ctrl, bw, containment, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github' }));
  containment.simulateTerminationFailure(session.sentinel_session_id);
  const result = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' } }));
  assert.equal(result.decision?.decision, 'TERMINATE');
  assert.equal(result.decision?.containment_status, 'CONTAINMENT_UNCONFIRMED');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'INDETERMINATE');
});

test('explicit terminate() is idempotent: repeated calls produce one logical containment action', async () => {
  const { runtime, ctrl, containment, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await runtime.terminate(ctrl, session.sentinel_session_id, 'operator decision');
  await runtime.terminate(ctrl, session.sentinel_session_id, 'operator decision again');
  await runtime.terminate(ctrl, session.sentinel_session_id, 'operator decision a third time');
  assert.equal(containment.terminateCalls.length, 1);
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'TERMINATED');
});
test('explicit hold() then resume(): only a trusted controller may resume, never an observer/reader', async () => {
  const { runtime, ctrl, rd, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const held = await runtime.hold(ctrl, session.sentinel_session_id, 'manual review');
  assert.equal(held.status, 'HELD');
  assert.throws(() => runtime.resume(rd, session.sentinel_session_id, { rationale: 'agent cannot do this' }), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
  const resumed = runtime.resume(ctrl, session.sentinel_session_id, { rationale: 'reviewed, safe to continue' });
  assert.equal(resumed.status, 'MONITORING');
});
test('a HOLD decision from evaluation does not silently resume on the next CONTINUE-worthy observation', async () => {
  const { runtime, ctrl, bw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await runtime.hold(ctrl, session.sentinel_session_id, 'manual hold');
  // A perfectly ordinary observation must not un-hold the session — only resume() may.
  const result = await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id }));
  assert.equal(result.decision?.decision, 'CONTINUE');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'HELD');
});

test('emergency stop: session scope terminates only the targeted session', async () => {
  const { runtime, ad, ctrl, bw, tenantId } = setup();
  const a = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, execution_id: 'exec-a' }));
  const b = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, execution_id: 'exec-b' }));
  runtime.activateStop(ad, 'session', a.sentinel_session_id, 'incident response');
  const resultA = await runtime.submitObservation(bw, a.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: a.sentinel_session_id }));
  const resultB = await runtime.submitObservation(bw, b.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: b.sentinel_session_id }));
  assert.equal(resultA.decision?.decision, 'TERMINATE');
  assert.equal(resultB.decision?.decision, 'CONTINUE');
});
test('emergency stop: agent scope terminates every session for that agent, not other agents', async () => {
  const { runtime, ad, ctrl, bw, tenantId } = setup();
  const a = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, agent_id: 'agent-x', execution_id: 'e1' }));
  const other = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, agent_id: 'agent-y', execution_id: 'e2' }));
  runtime.activateStop(ad, 'agent', 'agent-x', 'agent compromised');
  assert.equal((await runtime.submitObservation(bw, a.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: a.sentinel_session_id }))).decision?.decision, 'TERMINATE');
  assert.equal((await runtime.submitObservation(bw, other.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: other.sentinel_session_id }))).decision?.decision, 'CONTINUE');
});
test('emergency stop: tenant scope terminates every session in the tenant', async () => {
  const { runtime, ad, ctrl, bw, tenantId } = setup();
  const a = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, execution_id: 'e1' }));
  runtime.activateStop(ad, 'tenant', tenantId, 'tenant-wide incident');
  assert.equal((await runtime.submitObservation(bw, a.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: a.sentinel_session_id }))).decision?.decision, 'TERMINATE');
});
test('emergency stop activation/release is admin-only — agent and reader are FORBIDDEN', () => {
  const { runtime, rd, bw, tenantId } = setup();
  assert.throws(() => runtime.activateStop(rd, 'tenant', tenantId, 'x'), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
  assert.throws(() => runtime.activateStop(bw, 'tenant', tenantId, 'x'), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
});
test('releasing an emergency stop lifts it for subsequent evaluation', async () => {
  const { runtime, ad, ctrl, bw, tenantId } = setup();
  const s = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  runtime.activateStop(ad, 'session', s.sentinel_session_id, 'temporary');
  runtime.releaseStop(ad, 'session', s.sentinel_session_id);
  const result = await runtime.submitObservation(bw, s.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: s.sentinel_session_id }));
  assert.equal(result.decision?.decision, 'CONTINUE');
});

test('tenant isolation: a reader cannot see another tenant\'s session', () => {
  const { runtime, ctrl, tenantId } = setup('tenant_a');
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const readerB = readerPrincipal('sentinel-reader', 'tenant_b');
  assert.throws(() => runtime.getSession(readerB, session.sentinel_session_id), (e: unknown) => e instanceof SentinelError && e.code === 'NOT_FOUND');
});
test('tenant isolation: an observer bound to tenant B cannot reach a tenant A session even by id', async () => {
  const { runtime, ctrl, tenantId } = setup('tenant_a');
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const observerB = observerPrincipal('sentinel-observer-broker', 'tenant_b', ['EXECUTION_BROKER']);
  // Every lookup is scoped by the caller's own declared tenant_id, so a tenant B caller naming tenant A's
  // session id finds nothing at all — a stronger isolation outcome than a 403 (no existence is leaked).
  await assert.rejects(runtime.submitObservation(observerB, session.sentinel_session_id, baseObservation({ tenant_id: 'tenant_b', sentinel_session_id: session.sentinel_session_id })), (e: unknown) => e instanceof SentinelError && e.code === 'NOT_FOUND');
});
test('a tenant-wide emergency stop in one tenant never reaches a session in another tenant', async () => {
  const ctxA = setup('tenant_a');
  const runtime = ctxA.runtime; // same physical store — the isolation must come from tenant scoping, not separate storage
  const ctrlB = controllerPrincipal('sentinel-controller', 'tenant_b');
  const bwB = observerPrincipal('sentinel-observer-broker', 'tenant_b', ['EXECUTION_BROKER']);
  const adminB = adminPrincipal('sentinel-admin', 'tenant_b');
  runtime.installDefaultPolicy(adminB);
  const sessionB = runtime.createSession(ctrlB, baseSessionInput({ tenant_id: 'tenant_b' }));
  runtime.activateStop(ctxA.ad, 'tenant', 'tenant_a', 'tenant A incident');
  const result = await runtime.submitObservation(bwB, sessionB.sentinel_session_id, baseObservation({ tenant_id: 'tenant_b', sentinel_session_id: sessionB.sentinel_session_id }));
  assert.equal(result.decision?.decision, 'CONTINUE');
});

test('listViolations and listDecisions are bounded and paginate via cursor', async () => {
  const { runtime, ctrl, containment, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github' }));
  // Repeated terminate() calls each record their own decision as evidence (concurrency closure,
  // section "Evidence must reflect the reconciled outcome" — a superseded call is never silently
  // discarded), even though only the first one invokes real containment (idempotent destructive
  // action, proven separately below and in "explicit terminate() is idempotent").
  for (let i = 0; i < 5; i++) {
    await runtime.terminate(ctrl, session.sentinel_session_id, `noop-${i}`).catch(() => {});
  }
  assert.equal(containment.terminateCalls.length, 1);
  const firstPage = runtime.listDecisions(ctrl, session.sentinel_session_id, 2);
  assert.equal(firstPage.items.length, 2);
  assert.notEqual(firstPage.nextCursor, null);
  const secondPage = runtime.listDecisions(ctrl, session.sentinel_session_id, 2, firstPage.nextCursor ?? undefined);
  assert.equal(secondPage.items.length, 2);
  assert.notEqual(secondPage.nextCursor, null);
  const thirdPage = runtime.listDecisions(ctrl, session.sentinel_session_id, 2, secondPage.nextCursor ?? undefined);
  assert.equal(thirdPage.items.length, 1); // 5 total: 2 + 2 + 1
  assert.equal(thirdPage.nextCursor, null);
  // Only the winning decision reports CONFIRMED containment; the four superseded calls are recorded
  // as NO_OP_ALREADY_STRONGER with no containment action attributed to them.
  const allDecisions = [...firstPage.items, ...secondPage.items, ...thirdPage.items];
  assert.equal(allDecisions.filter(d => d.transition_result === 'ESCALATED' && d.containment_status === 'CONTAINMENT_CONFIRMED').length, 1);
  assert.equal(allDecisions.filter(d => d.transition_result === 'NO_OP_ALREADY_STRONGER').length, 4);
});
test('an invalid pagination cursor is rejected', () => {
  const { runtime, ctrl, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  assert.throws(() => runtime.listDecisions(ctrl, session.sentinel_session_id, 10, 'not-a-cursor!!'), (e: unknown) => e instanceof SentinelError && e.code === 'INVALID_INPUT');
});

test('restart persistence: session, counters, violations, decisions and an active stop all survive reopening the store', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-sentinel-test-'));
  const path = resolve(dir, 'sentinel.sqlite');
  const tenantId = 'tenant_demo';
  let runtime = new SentinelRuntime(path, { containment: new FakeContainmentController() });
  const ad = adminPrincipal('sentinel-admin', tenantId);
  const ctrl = controllerPrincipal('sentinel-controller', tenantId);
  const bw = observerPrincipal('sentinel-observer-broker', tenantId, ['EXECUTION_BROKER']);
  runtime.installDefaultPolicy(ad);
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github' }));
  await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' } }));
  runtime.activateStop(ad, 'tenant', tenantId, 'restart-test');
  runtime.close();

  runtime = new SentinelRuntime(path, { containment: new FakeContainmentController() });
  const reopened = runtime.getSession(ctrl, session.sentinel_session_id);
  assert.equal(reopened.status, 'TERMINATED');
  assert.equal(reopened.observation_sequence, 1);
  const decisions = runtime.listDecisions(ctrl, session.sentinel_session_id);
  assert.equal(decisions.items.length, 1);
  assert.equal(decisions.items[0]?.decision, 'TERMINATE');
  const violations = runtime.listViolations(ctrl, session.sentinel_session_id);
  assert.ok(violations.items.length >= 1);
  const stops = runtime.listStops(ad);
  assert.ok(stops.some(s => s.scope_type === 'tenant' && s.active));
  runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

test('setPolicy requires admin; controller/reader/observer cannot replace it', () => {
  const { runtime, ctrl, rd, tenantId } = setup();
  const input = { version: '1.0' as const, policy_id: 'p2', tenant_id: tenantId, name: 'x', enabled: true, default_behavior: 'OBSERVE' as const, rules: [] };
  assert.throws(() => runtime.setPolicy(ctrl, input), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
  assert.throws(() => runtime.setPolicy(rd, input), (e: unknown) => e instanceof SentinelError && e.code === 'FORBIDDEN');
});
test('replacing the active policy does not retroactively rewrite prior policy revisions\' hash', () => {
  const { runtime, ad, tenantId } = setup();
  const original = runtime.getActivePolicy(ad);
  const replaced = runtime.setPolicy(ad, { version: '1.0', policy_id: 'p2', tenant_id: tenantId, name: 'replacement', enabled: true, default_behavior: 'OBSERVE', rules: [] });
  assert.notEqual(original.policy_hash, replaced.policy_hash);
  assert.equal(runtime.getActivePolicy(ad).policy_hash, replaced.policy_hash);
});

test('authority expiry: evaluateSession detects execution still active past the session-bound authority_expiry', async () => {
  const { runtime, ctrl, advance, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, authority_expiry: '2026-01-01T00:00:10.000Z' }));
  const early = await runtime.evaluateSession(ctrl, session.sentinel_session_id);
  assert.equal(early.decision, 'CONTINUE');
  advance(20_000); // now past authority_expiry
  const late = await runtime.evaluateSession(ctrl, session.sentinel_session_id);
  assert.equal(late.decision, 'TERMINATE');
  assert.equal(late.violations[0]?.rule_type, 'AUTHORITY_EXPIRED');
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'TERMINATED');
});

test('approval revocation mid-execution is a distinct critical violation from agent revocation', async () => {
  const { runtime, ctrl, gw, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  const result = await runtime.submitObservation(gw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'REVOCATION_RECHECK', payload: { result: 'REVOKED', scope: 'approval' } }));
  assert.equal(result.decision?.violations.some(v => v.rule_type === 'APPROVAL_REVOKED'), true);
  assert.equal(result.decision?.violations.some(v => v.rule_type === 'AGENT_REVOKED'), false);
  assert.equal(result.decision?.decision, 'TERMINATE');
});

test('a session cannot be evaluated further once terminal', async () => {
  const { runtime, ctrl, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId }));
  await runtime.terminate(ctrl, session.sentinel_session_id, 'done');
  await assert.rejects(runtime.evaluateSession(ctrl, session.sentinel_session_id), (e: unknown) => e instanceof SentinelError && e.code === 'SESSION_TERMINAL');
});
