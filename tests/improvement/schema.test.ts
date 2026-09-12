import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ImprovementError, buildImprovementSpec, authorityWithinCeiling, computeAuthorityDelta, computeCapabilityDelta,
  classifyMutation, detectTestManifestTampering, buildRequiredTestManifest, evaluatePromotion, combinePromotionSignals,
  checkRecursionBudget, canTransition, validateImprovementProposal, CLASS_POLICY, IMPROVEMENT_CLASSES,
  type AuthorityCeiling, type CapabilityProfile, type RecursionBudget,
} from '../../packages/improvement-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12). Unit tests for the pure decision functions in
 * `improvement-schema` — no I/O, no store, no HTTP. Each test targets one of the invariants the volume
 * brief calls mandatory (TNA-72 through TNA-81).
 */

function ceiling(overrides: Partial<AuthorityCeiling> = {}): AuthorityCeiling {
  return {
    operations: ['read'], tools: ['tool-a'], resources: ['res-a'], destinations: [], network_access: false,
    filesystem_scope: ['/workspace/**'], credentials: [], max_budget_usd: 10, max_runtime_ms: 60_000,
    max_parallelism: 1, external_side_effects: false, requires_approval_for: [],
    ...overrides,
  };
}
function capability(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    tools: ['tool-a'], operations: ['read'], resources: ['res-a'], destinations: [], filesystem_writes: false,
    network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [],
    ...overrides,
  };
}
function specInput(overrides: Partial<Parameters<typeof buildImprovementSpec>[0]> = {}) {
  return {
    system_id: 'sys_demo', tenant_id: 'ten_demo', parent_generation_id: null, objective: 'improve routing accuracy',
    improvement_class: 'CLASS_1_CODE' as const, allowed_mutation_paths: ['apps/demo-agent/'], forbidden_mutation_paths: [],
    allowed_tool_changes: [], allowed_dependency_changes: [], allowed_model_changes: [],
    authority_ceiling: ceiling(), resource_limits: { max_runtime_ms: 60_000, max_cost_usd: 1, max_tool_calls: 10, max_external_calls: 0, max_changed_files: 10, max_changed_bytes: 100_000 },
    evaluation_profile_id: 'evalprof_demo', required_benchmarks: ['accuracy'], required_security_tests: ['sec-1'],
    promotion_thresholds: { accuracy: 0.01 }, canary_policy: { traffic_percent: 5, max_actions: 100, max_runtime_ms: 60_000, failure_threshold: 0.05, sentinel_terminate_is_failure: true, cost_threshold_usd: 1 },
    rollback_policy: { rollback_generation_id: 'gen_parent', auto_rollback_triggers: ['SECURITY_REGRESSION' as const] },
    max_iterations: 3, max_runtime_ms: 300_000, max_cost_usd: 5, created_by: 'test-actor',
    ...overrides,
  };
}

test('buildImprovementSpec produces a stable hash for identical input and rejects unknown fields', () => {
  const a = buildImprovementSpec(specInput());
  const b = buildImprovementSpec(specInput());
  assert.notEqual(a.spec_id, b.spec_id, 'each spec gets its own identity');
  assert.equal(a.improvement_class, 'CLASS_1_CODE');
  assert.throws(() => buildImprovementSpec({ ...specInput(), extra_field: 'nope' } as never), ImprovementError);
});

test('buildImprovementSpec rejects an empty allowed_mutation_paths (no unbounded mutation scope)', () => {
  assert.throws(() => buildImprovementSpec(specInput({ allowed_mutation_paths: [] })), /allowed_mutation_paths/);
});

test('buildImprovementSpec rejects a secret-shaped field anywhere in the input', () => {
  assert.throws(() => buildImprovementSpec(specInput({ created_by: 'Bearer abcdefghijklmnop' })), ImprovementError);
});

test('authorityWithinCeiling: a child requesting a superset of tools/operations is rejected', () => {
  const parent = ceiling();
  assert.equal(authorityWithinCeiling(ceiling(), parent), true, 'identical profile is always within its own ceiling');
  assert.equal(authorityWithinCeiling(ceiling({ tools: ['tool-a', 'tool-b'] }), parent), false);
  assert.equal(authorityWithinCeiling(ceiling({ network_access: true }), parent), false);
  assert.equal(authorityWithinCeiling(ceiling({ max_budget_usd: 999 }), parent), false);
});

test('authorityWithinCeiling: a child requesting LESS authority than its ceiling is always allowed', () => {
  const parent = ceiling({ tools: ['tool-a', 'tool-b'], network_access: true, max_budget_usd: 100 });
  assert.equal(authorityWithinCeiling(ceiling({ tools: [], network_access: false, max_budget_usd: 1 }), parent), true);
});

test('computeAuthorityDelta detects expansion and reduction independently, and a pure reduction is still recorded', () => {
  const before = ceiling();
  const expanded = ceiling({ tools: ['tool-a', 'tool-b'], network_access: true });
  const deltaExpansion = computeAuthorityDelta(before, expanded);
  assert.equal(deltaExpansion.is_expansion, true);
  assert.deepEqual(deltaExpansion.added_tools, ['tool-b']);
  assert.equal(deltaExpansion.network_access_gained, true);

  const reduced = ceiling({ tools: [] });
  const deltaReduction = computeAuthorityDelta(before, reduced);
  assert.equal(deltaReduction.is_reduction, true);
  assert.equal(deltaReduction.is_expansion, false, 'a pure reduction must never also be reported as an expansion');
});

test('computeCapabilityDelta: any gain is unexpected when no allowedGrowth is declared (conservative default)', () => {
  const parent = capability();
  const candidate = capability({ tools: ['tool-a', 'tool-b'] });
  const delta = computeCapabilityDelta('gen_1', parent, candidate);
  assert.equal(delta.has_unexpected_gain, true);
  assert.deepEqual(delta.added_tools, ['tool-b']);
});

test('computeCapabilityDelta: an explicitly authorized tool addition is not flagged unexpected, but an unlisted one still is', () => {
  const parent = capability();
  const candidate = capability({ tools: ['tool-a', 'tool-b', 'tool-c'] });
  const delta = computeCapabilityDelta('gen_1', parent, candidate, { tools: ['tool-b'] });
  assert.equal(delta.has_unexpected_gain, true, 'tool-c was never authorized');
  assert.ok(delta.unexpected_reasons.some(r => r.includes('tool-c')));
  assert.ok(!delta.unexpected_reasons.some(r => r.includes('tool-b')));
});

test('computeCapabilityDelta: filesystem-write/network/code-execution gains are unexpected unless explicitly allowed', () => {
  const parent = capability();
  const candidate = capability({ filesystem_writes: true, network_access: true, code_execution: true });
  const blocked = computeCapabilityDelta('gen_1', parent, candidate);
  assert.equal(blocked.has_unexpected_gain, true);
  const allowed = computeCapabilityDelta('gen_1', parent, candidate, { allowFilesystemWrites: true, allowNetworkAccess: true, allowCodeExecution: true });
  assert.equal(allowed.has_unexpected_gain, false);
});

test('classifyMutation flags a Gate-path change as control-plane-changed even when the spec never lists it as forbidden', () => {
  const spec = { allowed_mutation_paths: ['apps/demo-agent/'], forbidden_mutation_paths: [] };
  const report = classifyMutation('gen_1', ['apps/demo-agent/index.ts', 'packages/policy-engine/src/index.ts'], spec);
  assert.equal(report.control_plane_changed, true);
  assert.ok(report.forbidden_paths_touched.includes('packages/policy-engine/src/index.ts'));
});

test('classifyMutation flags the improvement evaluator path as changed unconditionally, even if a spec tried to allow it', () => {
  const spec = { allowed_mutation_paths: ['apps/demo-agent/', 'packages/improvement-evaluator/'], forbidden_mutation_paths: [] };
  const report = classifyMutation('gen_1', ['packages/improvement-evaluator/src/index.ts'], spec);
  assert.equal(report.evaluator_changed, true, 'the evaluator path must be flagged regardless of what allowed_mutation_paths claims');
});

test('classifyMutation does not flag control-plane-changed for an ordinary application-only diff', () => {
  const spec = { allowed_mutation_paths: ['apps/demo-agent/'], forbidden_mutation_paths: [] };
  const report = classifyMutation('gen_1', ['apps/demo-agent/router.ts', 'apps/demo-agent/prompt.md'], spec);
  assert.equal(report.control_plane_changed, false);
  assert.equal(report.evaluator_changed, false);
});

test('detectTestManifestTampering catches a removed required test and a hash-changed required test, but ignores optional-test churn', () => {
  const before = buildRequiredTestManifest('m1', 1, [
    { test_id: 't1', path: 'tests/a.test.ts', content_hash: 'h1', required: true, source: 'accepted' },
    { test_id: 't2', path: 'tests/b.test.ts', content_hash: 'h2', required: true, source: 'accepted' },
    { test_id: 't3', path: 'tests/optional.test.ts', content_hash: 'h3', required: false, source: 'accepted' },
  ]);
  const after = buildRequiredTestManifest('m1', 2, [
    { test_id: 't2', path: 'tests/b.test.ts', content_hash: 'h2-modified', required: true, source: 'accepted' },
  ]);
  const report = detectTestManifestTampering(before, after);
  assert.equal(report.tampered, true);
  assert.deepEqual(report.removed_required_tests, ['t1']);
  assert.deepEqual(report.hash_changed_tests, ['t2']);
  assert.equal(report.test_count_decreased, true);
});

test('detectTestManifestTampering reports untampered when only an optional test is removed', () => {
  const before = buildRequiredTestManifest('m1', 1, [
    { test_id: 't1', path: 'tests/a.test.ts', content_hash: 'h1', required: true, source: 'accepted' },
    { test_id: 't2', path: 'tests/optional.test.ts', content_hash: 'h2', required: false, source: 'accepted' },
  ]);
  const after = buildRequiredTestManifest('m1', 2, [
    { test_id: 't1', path: 'tests/a.test.ts', content_hash: 'h1', required: true, source: 'accepted' },
  ]);
  const report = detectTestManifestTampering(before, after);
  assert.equal(report.tampered, false, 'removing an optional test alone is not tampering');
  assert.equal(report.test_count_decreased, true, 'the count-decrease signal is still reported for review');
});

function passingEvidence() {
  const parent = capability();
  return {
    improvementClass: 'CLASS_1_CODE' as const, benchmarksAllPass: true, regressionSuitePassed: true, securityTestsPassed: true,
    capabilityDelta: computeCapabilityDelta('gen_1', parent, parent), authorityWithinCeiling: true,
    mutationDiff: classifyMutation('gen_1', ['apps/demo-agent/router.ts'], { allowed_mutation_paths: ['apps/demo-agent/'], forbidden_mutation_paths: [] }),
    testTamper: detectTestManifestTampering(buildRequiredTestManifest('m', 1, []), buildRequiredTestManifest('m', 1, [])),
    humanApproved: null, independentReviewApproved: null, evidenceComplete: true,
  };
}

test('evaluatePromotion: a clean Class 1 candidate with everything passing promotes without requiring human approval', () => {
  const result = evaluatePromotion(passingEvidence());
  assert.equal(result.status, 'PROMOTE');
});

test('evaluatePromotion: security/control failure outranks a benchmark improvement (section 40)', () => {
  const result = evaluatePromotion({ ...passingEvidence(), securityTestsPassed: false, benchmarksAllPass: true });
  assert.equal(result.status, 'REJECT');
  assert.match(result.reason, /[Ss]ecurity/);
});

test('evaluatePromotion: evaluator tampering forces REJECT unconditionally, even with every other signal clean', () => {
  const evidence = passingEvidence();
  const tamperedMutationDiff = classifyMutation('gen_1', ['packages/improvement-evaluator/src/index.ts'], { allowed_mutation_paths: ['packages/improvement-evaluator/'], forbidden_mutation_paths: [] });
  const result = evaluatePromotion({ ...evidence, mutationDiff: tamperedMutationDiff });
  assert.equal(result.status, 'REJECT');
  assert.match(result.reason, /evaluator/i);
});

test('evaluatePromotion: a Class 1 candidate touching a Gate path is REJECTed even with clean benchmarks', () => {
  const evidence = passingEvidence();
  const controlPlaneDiff = classifyMutation('gen_1', ['packages/policy-engine/src/index.ts'], { allowed_mutation_paths: ['packages/policy-engine/'], forbidden_mutation_paths: [] });
  const result = evaluatePromotion({ ...evidence, mutationDiff: controlPlaneDiff });
  assert.equal(result.status, 'REJECT');
});

test('evaluatePromotion: a Class 4 candidate legitimately touching a Gate path is not auto-rejected for that reason alone, but still requires human approval (HOLD, not PROMOTE)', () => {
  const evidence = passingEvidence();
  const controlPlaneDiff = classifyMutation('gen_1', ['packages/policy-engine/src/index.ts'], { allowed_mutation_paths: ['packages/policy-engine/'], forbidden_mutation_paths: [] });
  const result = evaluatePromotion({ ...evidence, improvementClass: 'CLASS_4_CONTROL_PLANE', mutationDiff: controlPlaneDiff });
  assert.equal(result.status, 'HOLD');
});

test('evaluatePromotion: Class 5 requires independent review even after human approval; and never PROMOTEs without it', () => {
  const evidence = passingEvidence();
  const humanOnly = evaluatePromotion({ ...evidence, improvementClass: 'CLASS_5_AUTHORITY_OR_EVALUATOR', humanApproved: true, independentReviewApproved: null });
  assert.equal(humanOnly.status, 'HOLD');
  const both = evaluatePromotion({ ...evidence, improvementClass: 'CLASS_5_AUTHORITY_OR_EVALUATOR', humanApproved: true, independentReviewApproved: true });
  assert.equal(both.status, 'PROMOTE');
});

test('evaluatePromotion: a benchmark improvement never overrides an authority-ceiling violation', () => {
  const result = evaluatePromotion({ ...passingEvidence(), authorityWithinCeiling: false, benchmarksAllPass: true });
  assert.equal(result.status, 'REJECT');
});

test('evaluatePromotion: incomplete evidence never resolves to PROMOTE by default', () => {
  const result = evaluatePromotion({ ...passingEvidence(), evidenceComplete: false });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
});

test('combinePromotionSignals: INDETERMINATE beats REJECT beats HOLD beats PROMOTE', () => {
  assert.equal(combinePromotionSignals(['PROMOTE', 'HOLD']), 'HOLD');
  assert.equal(combinePromotionSignals(['HOLD', 'REJECT']), 'REJECT');
  assert.equal(combinePromotionSignals(['REJECT', 'INDETERMINATE']), 'INDETERMINATE');
  assert.equal(combinePromotionSignals(['PROMOTE', 'PROMOTE']), 'PROMOTE');
});

function budget(overrides: Partial<RecursionBudget> = {}): RecursionBudget {
  return {
    system_id: 'sys_demo', tenant_id: 'ten_demo',
    limits: { max_generations: 5, max_attempts_per_generation: 3, max_runtime_per_attempt_ms: 60_000, max_total_runtime_ms: 600_000, max_cost_per_attempt_usd: 1, max_total_cost_usd: 10, max_tool_calls: 100, max_external_calls: 10, max_changed_files: 50, max_changed_bytes: 1_000_000 },
    generation_count: 0, attempt_count: 0, runtime_used_ms: 0, cost_used_usd: 0, tool_calls_used: 0, mutation_size_used_bytes: 0, state_version: 1,
    ...overrides,
  };
}

test('checkRecursionBudget: not exhausted below every limit, and reports every reason once at/over any limit', () => {
  assert.equal(checkRecursionBudget(budget()).exhausted, false);
  const atGenLimit = checkRecursionBudget(budget({ generation_count: 5 }));
  assert.equal(atGenLimit.exhausted, true);
  assert.ok(atGenLimit.reasons.some(r => r.includes('max_generations')));
  const multiple = checkRecursionBudget(budget({ generation_count: 5, cost_used_usd: 10 }));
  assert.equal(multiple.reasons.length, 2);
});

test('generation state machine: legal transitions are allowed, illegal ones are not, and terminal states have no outgoing edges', () => {
  assert.equal(canTransition('PROPOSED', 'AUTHORIZED'), true);
  assert.equal(canTransition('PROPOSED', 'PROMOTED'), false, 'cannot skip straight from proposed to promoted');
  assert.equal(canTransition('REJECTED', 'AUTHORIZED'), false, 'REJECTED is terminal');
  assert.equal(canTransition('PROMOTED', 'ROLLED_BACK'), true, 'a promoted generation can still be rolled back later');
  assert.equal(canTransition('ROLLED_BACK', 'PROMOTED'), false, 'ROLLED_BACK is terminal');
});

test('validateImprovementProposal accepts well-formed untrusted input and rejects malformed or secret-bearing input', () => {
  const good = validateImprovementProposal({
    problem: 'p', hypothesis: 'h', target_metric: 'accuracy', expected_benefit: 'b', mutation_scope: ['apps/demo-agent/'],
    risks: 'r', resource_estimate: { runtime_ms: 1000, cost_usd: 0.1 }, evaluation_recommendation: 'e',
  });
  assert.equal(good.target_metric, 'accuracy');
  assert.throws(() => validateImprovementProposal({ problem: '' }), ImprovementError);
  assert.throws(() => validateImprovementProposal({
    problem: 'p', hypothesis: 'h', target_metric: 'm', expected_benefit: 'Bearer sometoken12345', mutation_scope: [],
    risks: 'r', resource_estimate: { runtime_ms: 1, cost_usd: 0 }, evaluation_recommendation: 'e',
  }), ImprovementError);
});

test('every improvement class policy forbids self-promotion (structural invariant, all six classes)', () => {
  for (const cls of IMPROVEMENT_CLASSES) assert.equal(CLASS_POLICY[cls].allow_self_promotion, false);
});

test('Class 4 and Class 5 never allow automated promotion regardless of benchmark outcome', () => {
  assert.equal(CLASS_POLICY.CLASS_4_CONTROL_PLANE.allow_automated_promotion, false);
  assert.equal(CLASS_POLICY.CLASS_5_AUTHORITY_OR_EVALUATOR.allow_automated_promotion, false);
  assert.equal(CLASS_POLICY.CLASS_5_AUTHORITY_OR_EVALUATOR.requires_independent_review, true);
});
