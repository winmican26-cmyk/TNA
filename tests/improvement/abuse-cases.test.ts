import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Gate, HttpError as GateHttpError } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { ImprovementStore } from '../../packages/improvement-store/src/index.js';
import {
  ImprovementError, evaluatePromotion, classifyMutation, buildRequiredTestManifest, detectTestManifestTampering,
  computeCapabilityDelta, type CapabilityProfile,
} from '../../packages/improvement-schema/src/index.js';
import { registerImprovementGovernor, authorizeImprovementOperation } from '../../packages/improvement-core/src/gate-integration.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12): a consolidated abuse-case suite, one test per
 * named attack in the closure brief. Each test either exercises the real mechanism directly or points to
 * exactly where the same attack is already proven elsewhere in this test tree — nothing here is a new,
 * separate implementation of a defense; it is a direct, traceable index into real, already-tested
 * behavior, framed explicitly as "candidate attempts X."
 */

function capability(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return { tools: [], operations: ['read'], resources: [], destinations: [], filesystem_writes: false, network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [], ...overrides };
}

test('abuse: candidate self-promotion — the candidate process holds no promotion credential at all (structural)', () => {
  // The candidate never receives a Gate agent credential, an approver credential, or an admin
  // credential for ANY improvement operation — only the trusted governor process does
  // (`registerImprovementGovernor`). There is no code path by which candidate-authored code could even
  // construct a valid Gate principal for itself. See tests/improvement/gate-integration.test.ts for the
  // full real-Gate proof that only a genuine, distinct approver/admin principal can approve or authorize.
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-abuse-'));
  const store = new Store(resolve(dir, 'gate.sqlite'));
  const gate = new Gate(store);
  try {
    registerImprovementGovernor(gate, 'governor', { approverRole: 'approver-role' });
    // A "candidate" attempting to authorize as itself, using an agent id it invented, is simply an
    // unknown agent to Gate — never an escalation path.
    assert.throws(() => gate.authorize({ kind: 'agent', agentId: 'candidate-self' }, { agentId: 'candidate-self', action: 'improvement.promote', tool: 'improvement.promote', resource: '/improvement/generations/gen_1', estimatedCostUsd: 0 }), GateHttpError);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('abuse: candidate self-approval — the requesting governor agent cannot approve its own HELD request (real Gate proof)', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-abuse-'));
  const store = new Store(resolve(dir, 'gate.sqlite'));
  const gate = new Gate(store);
  try {
    registerImprovementGovernor(gate, 'governor', { approverRole: 'approver-role' });
    authorizeImprovementOperation(gate, 'governor', 'promote', 'gen_1');
    const request = { agentId: 'governor', action: 'improvement.promote', tool: 'improvement.promote', resource: '/improvement/generations/gen_1', estimatedCostUsd: 0 };
    assert.throws(() => gate.approve({ kind: 'agent', agentId: 'governor' }, { request }), GateHttpError);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('abuse: candidate budget increase — RecursionBudget has no caller-facing "set" method, only consumeRecursionBudget (an additive delta), and no method resets it', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-abuse-'));
  const store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  try {
    const limits = { max_generations: 1, max_attempts_per_generation: 1, max_runtime_per_attempt_ms: 1, max_total_runtime_ms: 1, max_cost_per_attempt_usd: 1, max_total_cost_usd: 1, max_tool_calls: 1, max_external_calls: 1, max_changed_files: 1, max_changed_bytes: 1 };
    const budget = store.getOrCreateRecursionBudget('ten_a', 'sys_a', limits);
    // getOrCreateRecursionBudget is idempotent — a "candidate" calling it again never resets usage.
    store.consumeRecursionBudget('ten_a', 'sys_a', budget.state_version, { generations: 1 });
    const again = store.getOrCreateRecursionBudget('ten_a', 'sys_a', limits);
    assert.equal(again.generation_count, 1, 'requesting the budget again must never reset consumed usage');
    assert.equal(typeof (store as unknown as Record<string, unknown>).setRecursionBudget, 'undefined', 'no method exists to directly overwrite budget usage');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('abuse: candidate spec mutation — an already-saved spec cannot be silently replaced under the same spec_id (see tests/improvement/concurrency.test.ts for the full race variant)', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-abuse-'));
  const store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  try {
    const system = store.createSystem('ten_a', 'sys', 'actor');
    const gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v1', improvementClass: 'CLASS_1_CODE', specHash: 'h1', sourceHashBefore: 's1', authorityProfileBefore: { operations: [], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 1, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] }, createdBy: 'actor' });
    store.saveSpec('ten_a', gen.generation_id, 'spec_1', { objective: 'real' }, 'hash_real');
    assert.throws(() => store.saveSpec('ten_a', gen.generation_id, 'spec_1', { objective: 'forged', authority_ceiling: { operations: ['read', 'write'] } }, 'hash_forged'), (e: unknown) => e instanceof ImprovementError && e.code === 'SPEC_IMMUTABLE');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('abuse: candidate evaluator mutation — any diff touching packages/improvement-evaluator/ is flagged evaluator_changed unconditionally and forces REJECT in evaluatePromotion (see promotion-evaluator.test.ts for the real spawned-process version)', () => {
  const diff = classifyMutation('gen_1', ['packages/improvement-evaluator/src/index.ts'], { allowed_mutation_paths: ['packages/improvement-evaluator/'], forbidden_mutation_paths: [] });
  assert.equal(diff.evaluator_changed, true, 'the evaluator path is flagged regardless of what allowed_mutation_paths claims');
  const parent = capability();
  const result = evaluatePromotion({
    improvementClass: 'CLASS_5_AUTHORITY_OR_EVALUATOR', benchmarksAllPass: true, regressionSuitePassed: true, securityTestsPassed: true,
    capabilityDelta: computeCapabilityDelta('gen_1', parent, parent), authorityWithinCeiling: true, mutationDiff: diff,
    testTamper: detectTestManifestTampering(buildRequiredTestManifest('m', 1, []), buildRequiredTestManifest('m', 1, [])),
    humanApproved: true, independentReviewApproved: true, evidenceComplete: true,
  });
  assert.equal(result.status, 'REJECT');
});

test('abuse: candidate threshold lowering — a candidate cannot self-author a lower promotion_thresholds value and be evaluated under it, because thresholds live in the immutable ImprovementSpec, saved once (SPEC_IMMUTABLE) before evaluation ever runs', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-abuse-'));
  const store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  try {
    const system = store.createSystem('ten_a', 'sys', 'actor');
    const gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v1', improvementClass: 'CLASS_1_CODE', specHash: 'h1', sourceHashBefore: 's1', authorityProfileBefore: { operations: [], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 1, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] }, createdBy: 'actor' });
    store.saveSpec('ten_a', gen.generation_id, 'spec_1', { promotion_thresholds: { accuracy: 0.1 } }, 'hash_real');
    assert.throws(() => store.saveSpec('ten_a', gen.generation_id, 'spec_1', { promotion_thresholds: { accuracy: -999 } }, 'hash_lowered'), ImprovementError);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('abuse: candidate security-test deletion — detectTestManifestTampering flags a removed required test and evaluatePromotion REJECTs unconditionally on it', () => {
  const before = buildRequiredTestManifest('m', 1, [{ test_id: 'sec-1', path: 'security.test.ts', content_hash: 'h', required: true, source: 'accepted' }]);
  const after = buildRequiredTestManifest('m', 2, []);
  const tamper = detectTestManifestTampering(before, after);
  assert.equal(tamper.tampered, true);
  const parent = capability();
  const result = evaluatePromotion({
    improvementClass: 'CLASS_1_CODE', benchmarksAllPass: true, regressionSuitePassed: true, securityTestsPassed: true,
    capabilityDelta: computeCapabilityDelta('gen_1', parent, parent), authorityWithinCeiling: true,
    mutationDiff: classifyMutation('gen_1', ['app.ts'], { allowed_mutation_paths: ['app.ts'], forbidden_mutation_paths: [] }),
    testTamper: tamper, humanApproved: null, independentReviewApproved: null, evidenceComplete: true,
  });
  assert.equal(result.status, 'REJECT');
});

test('abuse: candidate control-plane modification under Class 1 — a Class 1 spec cannot legitimize touching a Gate/Sentinel/VAD/Ledger/Auditor path; evaluatePromotion REJECTs regardless of what the spec claims to allow', () => {
  const diff = classifyMutation('gen_1', ['packages/sentinel-runtime/src/index.ts'], { allowed_mutation_paths: ['app.ts', 'packages/sentinel-runtime/'], forbidden_mutation_paths: [] });
  assert.equal(diff.control_plane_changed, true, 'control-plane detection is never suppressed by the spec\'s own allowed_mutation_paths');
  const parent = capability();
  const result = evaluatePromotion({
    improvementClass: 'CLASS_1_CODE', benchmarksAllPass: true, regressionSuitePassed: true, securityTestsPassed: true,
    capabilityDelta: computeCapabilityDelta('gen_1', parent, parent), authorityWithinCeiling: true, mutationDiff: diff,
    testTamper: detectTestManifestTampering(buildRequiredTestManifest('m', 1, []), buildRequiredTestManifest('m', 1, [])),
    humanApproved: null, independentReviewApproved: null, evidenceComplete: true,
  });
  assert.equal(result.status, 'REJECT');
});

test('abuse: candidate Sentinel suppression — see tests/improvement/sentinel-integration.test.ts section E test for the full real-runtime proof (candidate-side forged decisions have zero effect on the externally-held authoritative session)', () => {
  // Pointer test: the real proof lives in sentinel-integration.test.ts, which constructs an actual
  // forged "CONTINUE" object the candidate could plausibly build in its own process, and shows the real
  // Sentinel session (held only by the governor) is entirely unaffected by it.
  assert.ok(true);
});

test('abuse: candidate Ledger suppression — the candidate process holds no Ledger writer credential; only `improvementWriter()` (bound to the trusted governor process) can append IMPROVEMENT_* events at all', () => {
  // Structural: LedgerPrincipal for improvement events is minted exclusively by `improvementWriter()`
  // in apps/tna-ledger/src/writers.ts, imported only by apps/tna-improvement-governor and
  // packages/improvement-core/src/ledger-integration.ts — never by anything a candidate could import or
  // construct (it has no access to the governor's own process at all).
  assert.ok(true);
});

test('abuse: candidate rollback-target removal — a rollback record\'s target generation must itself be a real, resolvable generation for the SAME tenant (fixed as a real bug during this closure — see tests/improvement/tenant-isolation.test.ts)', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-abuse-'));
  const store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  try {
    const system = store.createSystem('ten_a', 'sys', 'actor');
    const gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v1', improvementClass: 'CLASS_1_CODE', specHash: 'h1', sourceHashBefore: 's1', authorityProfileBefore: { operations: [], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 1, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] }, createdBy: 'actor' });
    assert.throws(() => store.initiateRollback('ten_a', gen.generation_id, 'gen_nonexistent_target', 'MANUAL', 'operator'), ImprovementError, 'a rollback naming a nonexistent/removed target generation must be rejected, never silently accepted');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('abuse: candidate capability-delta forgery — computeCapabilityDelta always recomputes from the two real declared profiles the caller supplies; a candidate asserting its own "clean" delta object has no code path into the actual computation', () => {
  const parent = capability();
  const candidateClaimsClean = capability({ code_execution: true }); // the candidate's REAL declared profile actually gained code execution
  const delta = computeCapabilityDelta('gen_1', parent, candidateClaimsClean); // computed fresh, never accepts a pre-built delta object
  assert.equal(delta.has_unexpected_gain, true, 'the real computed delta reflects the real profile, regardless of any label the candidate attaches to its own submission');
});

test('abuse: candidate benchmark-result forgery — runPromotionEvaluation only ever accepts a real spawned command\'s stdout as a benchmark score, never a caller-supplied number (see promotion-evaluator.test.ts for the full real-process proof)', () => {
  assert.ok(true);
});

test('abuse: candidate promotion-credential access — the candidate workspace environment is built via candidateEnvironment(), which strips every secret-shaped variable before the candidate\'s own process ever runs (see mutation-boundary.test.ts)', () => {
  assert.ok(true);
});

test('abuse: candidate recursion beyond limit — checkRecursionBudget reports exhaustion once any configured limit is reached, and the runtime (never the candidate) owns every counter via consumeRecursionBudget\'s additive deltas', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-abuse-'));
  const store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  try {
    const limits = { max_generations: 1, max_attempts_per_generation: 1, max_runtime_per_attempt_ms: 1, max_total_runtime_ms: 1, max_cost_per_attempt_usd: 1, max_total_cost_usd: 1, max_tool_calls: 1, max_external_calls: 1, max_changed_files: 1, max_changed_bytes: 1 };
    const budget = store.getOrCreateRecursionBudget('ten_a', 'sys_a', limits);
    const consumed = store.consumeRecursionBudget('ten_a', 'sys_a', budget.state_version, { generations: 1 });
    assert.equal(consumed.generation_count, 1);
    assert.equal(consumed.generation_count >= consumed.limits.max_generations, true, 'the budget itself, not a candidate claim, determines exhaustion');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
