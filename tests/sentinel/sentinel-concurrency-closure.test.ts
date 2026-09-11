import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  SentinelRuntime, observerPrincipal, controllerPrincipal, adminPrincipal,
  type ContainmentController, type ContainmentReason,
} from '../../packages/sentinel-runtime/src/index.js';
import { defaultDemoPolicyInput, validatePolicyInput, finalizePolicy } from '../../packages/sentinel-policy/src/index.js';
import { setup, baseSessionInput, baseObservation } from './fixture.js';

// Concurrency closure pass (docs/sentinel/sentinel-v0.1-concurrency-closure.md). The core invariant
// under test throughout this file: a decision computed against a stale snapshot must never overwrite
// a stronger containment outcome already committed or confirmed for the same session. Before this
// closure, `applyOutcome` wrote the session's final status unconditionally from a stale in-memory
// snapshot; a slow-to-confirm HOLD could commit its status *after* a fast-confirmed TERMINATE had
// already resolved, leaving the persisted record showing HELD despite `containment.terminate()`
// having genuinely fired. That failure is reproduced explicitly below (failing-first evidence) before
// asserting the fix.

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

/** A containment controller whose hold()/terminate() each resolve after their own configured delay,
 * so tests can force a specific commit ordering between two racing evaluations without depending on
 * incidental Node.js scheduling. */
class TimedContainmentController implements ContainmentController {
  public readonly holdCalls: Array<{ sessionId: string; reason: ContainmentReason }> = [];
  public readonly terminateCalls: Array<{ sessionId: string; reason: ContainmentReason }> = [];
  private terminateShouldFail = false;
  public constructor(private readonly holdDelayMs: number, private readonly terminateDelayMs: number) {}
  public failNextTerminate(): void { this.terminateShouldFail = true; }
  public async hold(sessionId: string, reason: ContainmentReason): Promise<void> {
    if (this.holdDelayMs > 0) await sleep(this.holdDelayMs);
    this.holdCalls.push({ sessionId, reason });
  }
  public async terminate(sessionId: string, reason: ContainmentReason): Promise<void> {
    if (this.terminateDelayMs > 0) await sleep(this.terminateDelayMs);
    this.terminateCalls.push({ sessionId, reason });
    if (this.terminateShouldFail) { this.terminateShouldFail = false; throw new Error('Simulated containment failure'); }
  }
}

// These runtimes deliberately use the real system clock (no injected fake clock, since several tests
// below rely on real setTimeout-based delays to force a specific commit ordering), so every session
// input here must carry a genuinely future authority_expiry — the shared fixture's own default is a
// fixed past-relative-to-real-clock literal (the exact class of fixture defect
// sentinel-verification-v0.1.md already documents once for the HTTP test suite).
function futureExpiry(): string { return new Date(Date.now() + 3600_000).toISOString(); }

function makeRuntime(holdDelayMs: number, terminateDelayMs: number) {
  const containment = new TimedContainmentController(holdDelayMs, terminateDelayMs);
  const tenantId = 'tenant_demo';
  const runtime = new SentinelRuntime(':memory:', { containment });
  const admin = adminPrincipal('sentinel-admin', tenantId);
  const ctrl = controllerPrincipal('sentinel-controller', tenantId);
  const bw = observerPrincipal('sentinel-observer-broker', tenantId, ['EXECUTION_BROKER']);
  runtime.setPolicy(admin, defaultDemoPolicyInput(tenantId));
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github', authority_expiry: futureExpiry() }));
  return { runtime, containment, tenantId, ctrl, bw, sessionId: session.sentinel_session_id };
}

function toolDriftObservation(tenantId: string, sessionId: string, observationId: string) {
  return { version: '1.0' as const, observation_id: observationId, tenant_id: tenantId, sentinel_session_id: sessionId, timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER' as const, observation_type: 'TOOL_CALL_REQUESTED' as const, payload: { tool: 'shell' } };
}

// --- Failing-first evidence: the exact originally-reported reproduction, now a permanent regression ---

test('BEFORE/AFTER regression: a slow-to-confirm manual HOLD racing a fast-confirmed rule TERMINATE must resolve to TERMINATED, never HELD', async () => {
  // Before this closure pass, applyOutcome wrote `finalStatus` (computed once, from a stale snapshot)
  // unconditionally; this exact scenario made getSession() report HELD even though
  // containment.terminate() had already fired for real. Reproduced independently in the architectural
  // review (docs/sentinel/sentinel-v0.1-architectural-review-v1.md) with an out-of-tree script; this
  // is that same scenario, now a permanent in-suite assertion.
  const { runtime, containment, ctrl, bw, tenantId, sessionId } = makeRuntime(/* hold */ 150, /* terminate */ 0);

  const holdPromise = runtime.hold(ctrl, sessionId, 'manual hold race');
  const terminatePromise = runtime.submitObservation(bw, sessionId, toolDriftObservation(tenantId, sessionId, 'race-term'));
  await Promise.allSettled([holdPromise, terminatePromise]);

  const final = runtime.getSession(ctrl, sessionId);
  assert.equal(containment.terminateCalls.length, 1, 'terminate() must have been invoked exactly once');
  assert.notEqual(final.status, 'HELD', 'a real containment.terminate() call must never end up hidden behind a later HELD status');
  assert.equal(final.status, 'TERMINATED'); // confirmed termination must win outright
});

test('reverse timing: a fast manual HOLD racing a slow-to-confirm rule TERMINATE must still resolve to TERMINATED once termination confirms', async () => {
  const { runtime, containment, ctrl, bw, tenantId, sessionId } = makeRuntime(/* hold */ 0, /* terminate */ 150);

  const holdPromise = runtime.hold(ctrl, sessionId, 'manual hold race');
  const terminatePromise = runtime.submitObservation(bw, sessionId, toolDriftObservation(tenantId, sessionId, 'race-term'));
  await Promise.allSettled([holdPromise, terminatePromise]);

  const final = runtime.getSession(ctrl, sessionId);
  assert.equal(containment.terminateCalls.length, 1);
  assert.equal(final.status, 'TERMINATED'); // the outcome must not depend on which side's containment call is slower
});

test('HOLD vs TERMINATE never invokes destructive termination twice, in either delay ordering', async () => {
  for (const [holdDelay, terminateDelay] of [[150, 0], [0, 150]] as const) {
    const { runtime, containment, ctrl, bw, tenantId, sessionId } = makeRuntime(holdDelay, terminateDelay);
    await Promise.allSettled([
      runtime.hold(ctrl, sessionId, 'manual hold race'),
      runtime.submitObservation(bw, sessionId, toolDriftObservation(tenantId, sessionId, 'race-term')),
    ]);
    assert.equal(containment.terminateCalls.length, 1, `terminate() must fire exactly once (holdDelay=${holdDelay}, terminateDelay=${terminateDelay})`);
  }
});

test('HOLD vs INDETERMINATE: a stale HOLD must not overwrite an unconfirmed (INDETERMINATE) termination outcome', async () => {
  const { runtime, containment, ctrl, bw, tenantId, sessionId } = makeRuntime(/* hold */ 150, /* terminate */ 0);
  containment.failNextTerminate();

  const holdPromise = runtime.hold(ctrl, sessionId, 'manual hold race');
  const terminatePromise = runtime.submitObservation(bw, sessionId, toolDriftObservation(tenantId, sessionId, 'race-term'));
  await Promise.allSettled([holdPromise, terminatePromise]);

  const final = runtime.getSession(ctrl, sessionId);
  assert.notEqual(final.status, 'HELD');
  assert.equal(final.status, 'INDETERMINATE'); // unconfirmed containment must never be silently upgraded OR downgraded
});

// --- Precedence matrix: WARN / HOLD / TERMINATE boundaries -------------------------------------

function warnOnToolDriftPolicy(tenantId: string) {
  return finalizePolicy(validatePolicyInput({
    version: '1.0', policy_id: 'warn-drift', tenant_id: tenantId, name: 'warn-on-drift', enabled: true, default_behavior: 'OBSERVE',
    rules: [{ rule_id: 'r-warn', rule_type: 'TOOL_NOT_ALLOWED', severity: 'LOW', enabled: true, action: 'WARN' }],
  }));
}

test('WARN vs HOLD race resolves to HELD regardless of which claim commits first', async () => {
  const containment = new TimedContainmentController(0, 0);
  const tenantId = 'tenant_demo';
  const runtime = new SentinelRuntime(':memory:', { containment });
  const admin = adminPrincipal('sentinel-admin', tenantId);
  const ctrl = controllerPrincipal('sentinel-controller', tenantId);
  const bw = observerPrincipal('sentinel-observer-broker', tenantId, ['EXECUTION_BROKER']);
  runtime.setPolicy(admin, warnOnToolDriftPolicy(tenantId));
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github', authority_expiry: futureExpiry() }));

  await Promise.allSettled([
    runtime.submitObservation(bw, session.sentinel_session_id, toolDriftObservation(tenantId, session.sentinel_session_id, 'warn-1')),
    runtime.hold(ctrl, session.sentinel_session_id, 'manual hold race'),
  ]);
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'HELD');
  assert.equal(containment.holdCalls.length, 1); // never invoked twice regardless of ordering
});

test('WARN vs TERMINATE race resolves to TERMINATED regardless of which claim commits first', async () => {
  const containment = new TimedContainmentController(0, 0);
  const tenantId = 'tenant_demo';
  const runtime = new SentinelRuntime(':memory:', { containment });
  const admin = adminPrincipal('sentinel-admin', tenantId);
  const ctrl = controllerPrincipal('sentinel-controller', tenantId);
  const bw = observerPrincipal('sentinel-observer-broker', tenantId, ['EXECUTION_BROKER']);
  runtime.setPolicy(admin, warnOnToolDriftPolicy(tenantId));
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github', authority_expiry: futureExpiry() }));

  await Promise.allSettled([
    runtime.submitObservation(bw, session.sentinel_session_id, toolDriftObservation(tenantId, session.sentinel_session_id, 'warn-1')),
    runtime.terminate(ctrl, session.sentinel_session_id, 'manual terminate race'),
  ]);
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'TERMINATED');
  assert.equal(containment.terminateCalls.length, 1);
});

// --- Emergency stop vs manual HOLD -------------------------------------------------------------

test('emergency-stop TERMINATE vs manual HOLD: the emergency stop must win and never leave the session HELD', async () => {
  const { runtime, containment, ctrl, tenantId, sessionId } = makeRuntime(/* hold */ 150, /* terminate */ 0);
  const admin = adminPrincipal('sentinel-admin', tenantId);
  const bw = observerPrincipal('sentinel-observer-broker', tenantId, ['EXECUTION_BROKER']);
  runtime.activateStop(admin, 'session', sessionId, 'incident');

  const holdPromise = runtime.hold(ctrl, sessionId, 'manual hold race');
  const stopPromise = runtime.submitObservation(bw, sessionId, baseObservation({ tenant_id: tenantId, sentinel_session_id: sessionId, observation_id: 'stop-trigger' }) as never);
  await Promise.allSettled([holdPromise, stopPromise]);

  const final = runtime.getSession(ctrl, sessionId);
  assert.notEqual(final.status, 'HELD');
  assert.equal(final.status, 'TERMINATED');
  assert.equal(containment.terminateCalls.length, 1);
});

// --- TERMINATE vs resume() ----------------------------------------------------------------------

test('resume() cannot succeed once a concurrent TERMINATE has already claimed the session', async () => {
  const { runtime, containment, ctrl, bw, tenantId, sessionId } = makeRuntime(0, 150);
  await runtime.hold(ctrl, sessionId, 'initial hold');
  assert.equal(runtime.getSession(ctrl, sessionId).status, 'HELD');

  // submitObservation's claim phase runs synchronously up to the containment.terminate() await, so by
  // the time control returns here the session is already durably TERMINATING (or resolved) — a
  // deterministic demonstration that resume() checks fresh state, not a snapshot taken earlier.
  const terminatePromise = runtime.submitObservation(bw, sessionId, toolDriftObservation(tenantId, sessionId, 'term-vs-resume'));
  assert.throws(
    () => runtime.resume(ctrl, sessionId, { rationale: 'attempted resume mid-termination' }),
    (e: unknown) => e instanceof Error && e.name === 'SentinelError' && (e as { code?: string }).code === 'INVALID_TRANSITION',
  );
  await terminatePromise;
  assert.equal(runtime.getSession(ctrl, sessionId).status, 'TERMINATED');
  assert.equal(containment.terminateCalls.length, 1);
});

test('a TERMINATE decision still escalates a session that was already resumed out of HELD', async () => {
  const { runtime, containment, ctrl, bw, tenantId, sessionId } = makeRuntime(0, 0);
  await runtime.hold(ctrl, sessionId, 'initial hold');
  runtime.resume(ctrl, sessionId, { rationale: 'cleared for continued monitoring' });
  assert.equal(runtime.getSession(ctrl, sessionId).status, 'MONITORING');

  await runtime.submitObservation(bw, sessionId, toolDriftObservation(tenantId, sessionId, 'post-resume-drift'));
  assert.equal(runtime.getSession(ctrl, sessionId).status, 'TERMINATED');
  assert.equal(containment.terminateCalls.length, 1);
});

// --- TERMINATE vs completion --------------------------------------------------------------------

test('completeSession() cannot succeed once a concurrent TERMINATE has already claimed the session', async () => {
  const { runtime, containment, ctrl, bw, tenantId, sessionId } = makeRuntime(0, 150);
  const terminatePromise = runtime.submitObservation(bw, sessionId, toolDriftObservation(tenantId, sessionId, 'term-vs-complete'));
  assert.throws(
    () => runtime.completeSession(ctrl, sessionId),
    (e: unknown) => e instanceof Error && e.name === 'SentinelError' && (e as { code?: string }).code === 'INVALID_TRANSITION',
  );
  await terminatePromise;
  assert.equal(runtime.getSession(ctrl, sessionId).status, 'TERMINATED');
  assert.equal(containment.terminateCalls.length, 1);
});

// --- Concurrent same-decision TERMINATE (pre-existing guarantee, re-asserted with the new fix) -----

test('two independent TERMINATE-triggering violations still resolve to one logical containment call and a stable terminal status', async () => {
  const { runtime, containment, ctrl, bw, tenantId, sessionId } = makeRuntime(0, 0);
  const [r1, r2] = await Promise.all([
    runtime.submitObservation(bw, sessionId, toolDriftObservation(tenantId, sessionId, 'drift-1')),
    runtime.submitObservation(bw, sessionId, toolDriftObservation(tenantId, sessionId, 'drift-2')),
  ]);
  assert.ok(r1.decision && r2.decision);
  assert.equal(runtime.getSession(ctrl, sessionId).status, 'TERMINATED');
  assert.equal(containment.terminateCalls.length, 1); // exactly one real destructive call
  const violations = runtime.listViolations(ctrl, sessionId);
  assert.equal(violations.items.length, 2); // both violations remain in evidence
});

// --- Cross-runtime-instance durability (requirement: not merely an in-process mutex) --------------

test('two separate SentinelRuntime instances sharing one SQLite file still resolve a HOLD/TERMINATE race correctly via durable CAS, not JS scheduling', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-sentinel-cross-runtime-'));
  const path = resolve(dir, 'sentinel.sqlite');
  const tenantId = 'tenant_demo';

  const containmentA = new TimedContainmentController(150, 0);
  const containmentB = new TimedContainmentController(0, 0);
  const runtimeA = new SentinelRuntime(path, { containment: containmentA });
  const admin = adminPrincipal('sentinel-admin', tenantId);
  runtimeA.installDefaultPolicy(admin);
  const ctrlA = controllerPrincipal('sentinel-controller', tenantId);
  const session = runtimeA.createSession(ctrlA, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github', authority_expiry: futureExpiry() }));

  // A second, fully independent SentinelRuntime — its own DatabaseSync connection, its own
  // containment controller — opened on the exact same file. Correctness here must come from SQLite's
  // own file-level locking (WAL + BEGIN IMMEDIATE + busy_timeout), not from any in-process JS mutex,
  // since these two objects share no JS-level state at all.
  const runtimeB = new SentinelRuntime(path, { containment: containmentB });
  const ctrlB = controllerPrincipal('sentinel-controller', tenantId);
  const bwB = observerPrincipal('sentinel-observer-broker', tenantId, ['EXECUTION_BROKER']);

  const holdPromise = runtimeA.hold(ctrlA, session.sentinel_session_id, 'runtime A slow hold');
  const terminatePromise = runtimeB.submitObservation(bwB, session.sentinel_session_id, toolDriftObservation(tenantId, session.sentinel_session_id, 'cross-runtime-term'));
  await Promise.allSettled([holdPromise, terminatePromise]);

  // Both connections must agree — there is exactly one durable row.
  const finalFromA = runtimeA.getSession(ctrlA, session.sentinel_session_id);
  const finalFromB = runtimeB.getSession(ctrlB, session.sentinel_session_id);
  assert.equal(finalFromA.status, finalFromB.status);
  assert.notEqual(finalFromA.status, 'HELD');
  assert.equal(finalFromA.status, 'TERMINATED');
  assert.equal(containmentB.terminateCalls.length, 1);

  runtimeA.close();
  runtimeB.close();
  for (const suffix of ['', '-wal', '-shm']) { if (existsSync(path + suffix)) unlinkSync(path + suffix); }
});

// --- Regression: pre-existing guarantees must survive the closure pass ----------------------------

test('observation sequencing remains exact and unaffected by the concurrency closure', async () => {
  const { runtime, bw, sessionId } = { ...makeRuntime(0, 0) };
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    runtime.submitObservation(bw, sessionId, baseObservation({ tenant_id: 'tenant_demo', sentinel_session_id: sessionId, observation_id: `seq-${i}` }) as never)));
  const sequences = results.map(r => r.observation.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('the ctx() setup fixture default runtime still exhibits the fixed HOLD/TERMINATE precedence (sanity check against the project-wide test fixture, not just this file\'s local runtimes)', async () => {
  const { runtime, ctrl, bw, containment, tenantId } = setup();
  const session = runtime.createSession(ctrl, baseSessionInput({ tenant_id: tenantId, expected_tool: 'github' }));
  await runtime.hold(ctrl, session.sentinel_session_id, 'manual hold');
  await runtime.submitObservation(bw, session.sentinel_session_id, baseObservation({ tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id, observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' } }));
  assert.equal(runtime.getSession(ctrl, session.sentinel_session_id).status, 'TERMINATED');
  assert.equal(containment.terminateCalls.length, 1);
});
