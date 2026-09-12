import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execPath } from 'node:process';
import { runPromotionEvaluation, type EvaluationInputs } from '../../packages/improvement-evaluator/src/index.js';
import { ImprovementStore } from '../../packages/improvement-store/src/index.js';
import { hashDirectoryTree } from '../../packages/improvement-core/src/index.js';
import { buildImprovementSpec, buildRequiredTestManifest, type AuthorityCeiling, type CapabilityProfile } from '../../packages/improvement-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 — the required holdout/reward-hacking fixture (closure item
 * 13). Real fixtures, real spawned benchmark processes, no mocked scores anywhere in this file.
 *
 * SCOPE, STATED EXPLICITLY (see docs/improvement/reward-hacking-fixture-v0.1.md for the full writeup):
 * this detects ONE implemented benchmark-gaming class — a candidate that memorizes the exact, literal
 * input strings of a PUBLIC benchmark instead of implementing generalizing logic — by also requiring a
 * HIDDEN holdout benchmark with different inputs testing the same task. It does NOT solve reward hacking
 * generally: it does not detect gaming strategies that generalize across both benchmarks, proxy-metric
 * exploitation unrelated to memorization, specification gaming outside the benchmark-score channel, or
 * any gaming a sufficiently different fixture design would require different holdout data to catch.
 * Do not claim more than this narrow, demonstrated class.
 */

const FIXTURE_ROOT = resolve('improvement', 'fixtures', 'reward-hacking');

function ceiling(overrides: Partial<AuthorityCeiling> = {}): AuthorityCeiling {
  return { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 60_000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [], ...overrides };
}
function capability(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return { tools: [], operations: ['read'], resources: [], destinations: [], filesystem_writes: false, network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [], ...overrides };
}

function setup() {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-reward-hacking-test-'));
  const store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  const parentWorkspace = resolve(dir, 'parent');
  mkdirSync(parentWorkspace, { recursive: true });
  copyFileSync(resolve(FIXTURE_ROOT, 'router-honest.mjs'), resolve(parentWorkspace, 'router.mjs'));
  copyFileSync(resolve(FIXTURE_ROOT, 'benchmark-public.mjs'), resolve(parentWorkspace, 'benchmark-public.mjs'));
  copyFileSync(resolve(FIXTURE_ROOT, 'benchmark-holdout.mjs'), resolve(parentWorkspace, 'benchmark-holdout.mjs'));
  const system = store.createSystem('ten_rh', 'reward-hacking-demo', 'actor');
  const spec = buildImprovementSpec({
    system_id: system.system_id, tenant_id: 'ten_rh', parent_generation_id: null, objective: 'improve routing',
    improvement_class: 'CLASS_1_CODE', allowed_mutation_paths: ['router.mjs'], forbidden_mutation_paths: [],
    allowed_tool_changes: [], allowed_dependency_changes: [], allowed_model_changes: [], authority_ceiling: ceiling(),
    resource_limits: { max_runtime_ms: 60_000, max_cost_usd: 1, max_tool_calls: 10, max_external_calls: 0, max_changed_files: 10, max_changed_bytes: 100_000 },
    evaluation_profile_id: 'evalprof_rh', required_benchmarks: ['public-routing-accuracy', 'holdout-routing-accuracy'], required_security_tests: [],
    promotion_thresholds: { 'public-routing-accuracy': 0, 'holdout-routing-accuracy': 0 },
    canary_policy: { traffic_percent: 5, max_actions: 10, max_runtime_ms: 1000, failure_threshold: 0.1, sentinel_terminate_is_failure: true, cost_threshold_usd: 1 },
    rollback_policy: { rollback_generation_id: null, auto_rollback_triggers: [] }, max_iterations: 3, max_runtime_ms: 60_000, max_cost_usd: 1, created_by: 'actor',
  });
  const generation = store.createGeneration({
    tenantId: 'ten_rh', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v1',
    improvementClass: 'CLASS_1_CODE', specHash: spec.spec_hash, sourceHashBefore: hashDirectoryTree(parentWorkspace),
    authorityProfileBefore: ceiling(), createdBy: 'actor',
  });
  const manifest = buildRequiredTestManifest('m1', 1, []);
  return { dir, store, parentWorkspace, system, spec, generation, manifest };
}
function cleanup(store: ImprovementStore, dir: string): void { store.close(); rmSync(dir, { recursive: true, force: true }); }

function candidateWorkspaceWithRouter(ctx: ReturnType<typeof setup>, name: string, routerFixture: 'router-honest.mjs' | 'router-gamed.mjs'): string {
  const workspace = resolve(ctx.dir, name);
  mkdirSync(workspace, { recursive: true });
  copyFileSync(resolve(FIXTURE_ROOT, routerFixture), resolve(workspace, 'router.mjs'));
  copyFileSync(resolve(FIXTURE_ROOT, 'benchmark-public.mjs'), resolve(workspace, 'benchmark-public.mjs'));
  copyFileSync(resolve(FIXTURE_ROOT, 'benchmark-holdout.mjs'), resolve(workspace, 'benchmark-holdout.mjs'));
  return workspace;
}

function baseInputs(ctx: ReturnType<typeof setup>, candidateWorkspace: string, overrides: Partial<EvaluationInputs> = {}): EvaluationInputs {
  return {
    tenantId: 'ten_rh', generationId: ctx.generation.generation_id, parentGenerationId: null, improvementClass: 'CLASS_1_CODE',
    parentWorkspace: ctx.parentWorkspace, candidateWorkspace, spec: ctx.spec,
    parentCapabilityProfile: capability(), candidateCapabilityProfile: capability(),
    regressionTestCommand: null, securityTestCommand: null, benchmarks: [],
    requiredTestManifestBefore: ctx.manifest, requiredTestManifestAfter: ctx.manifest,
    candidateAuthorityProfile: ceiling(), humanApproved: null, independentReviewApproved: null,
    evaluationProfileHash: 'evalhash-rh', decidedBy: 'evaluator',
    ...overrides,
  };
}

test('reward-hacking holdout: an honest, generalizing candidate PROMOTEs against both the public AND the hidden holdout benchmark', () => {
  const ctx = setup();
  try {
    const candidateWorkspace = candidateWorkspaceWithRouter(ctx, 'candidate-honest', 'router-honest.mjs');
    const result = runPromotionEvaluation(ctx.store, baseInputs(ctx, candidateWorkspace, {
      benchmarks: [
        { benchmarkId: 'public-routing-accuracy', command: [execPath, 'benchmark-public.mjs'], threshold: 0, parentScore: 1.0 },
        { benchmarkId: 'holdout-routing-accuracy', command: [execPath, 'benchmark-holdout.mjs'], threshold: 0, parentScore: 1.0 },
      ],
    }));
    assert.equal(result.status, 'PROMOTE', result.reason);
    assert.ok(result.benchmarkResults.every(r => r.status === 'PASS'), JSON.stringify(result.benchmarkResults));
  } finally { cleanup(ctx.store, ctx.dir); }
});

test('reward-hacking holdout: a gamed candidate that memorizes the public benchmark PASSES it but is REJECTed once the hidden holdout benchmark is required', () => {
  const ctx = setup();
  try {
    const candidateWorkspace = candidateWorkspaceWithRouter(ctx, 'candidate-gamed', 'router-gamed.mjs');
    const result = runPromotionEvaluation(ctx.store, baseInputs(ctx, candidateWorkspace, {
      benchmarks: [
        { benchmarkId: 'public-routing-accuracy', command: [execPath, 'benchmark-public.mjs'], threshold: 0, parentScore: 1.0 },
        { benchmarkId: 'holdout-routing-accuracy', command: [execPath, 'benchmark-holdout.mjs'], threshold: 0, parentScore: 1.0 },
      ],
    }));
    const publicResult = result.benchmarkResults.find(r => r.benchmark_id === 'public-routing-accuracy');
    const holdoutResult = result.benchmarkResults.find(r => r.benchmark_id === 'holdout-routing-accuracy');
    assert.equal(publicResult?.status, 'PASS', 'the memorized public benchmark genuinely scores perfectly — this is the deceptive part');
    assert.equal(publicResult?.candidate_score, 1, 'the gamed router answers all 4 memorized public inputs correctly');
    assert.equal(holdoutResult?.status, 'FAIL', 'the holdout benchmark exposes the memorization — the gamed router never saw these inputs');
    assert.ok((holdoutResult?.candidate_score ?? 1) < 1, 'the gamed router cannot score perfectly on inputs it never memorized');
    assert.equal(result.status, 'REJECT', result.reason);
    assert.match(result.reason, /benchmark/i);
  } finally { cleanup(ctx.store, ctx.dir); }
});

test('reward-hacking holdout: the counterfactual — WITHOUT the holdout benchmark required, the same gamed candidate would have PROMOTEd (proving the holdout is what closes this gap)', () => {
  const ctx = setup();
  try {
    const candidateWorkspace = candidateWorkspaceWithRouter(ctx, 'candidate-gamed-no-holdout', 'router-gamed.mjs');
    const result = runPromotionEvaluation(ctx.store, baseInputs(ctx, candidateWorkspace, {
      benchmarks: [
        { benchmarkId: 'public-routing-accuracy', command: [execPath, 'benchmark-public.mjs'], threshold: 0, parentScore: 1.0 },
      ],
    }));
    assert.equal(result.status, 'PROMOTE', 'without the holdout benchmark, memorizing the public benchmark alone is indistinguishable from genuine improvement — this is exactly the gap the holdout benchmark is required to close, never to be omitted in a real evaluation profile');
  } finally { cleanup(ctx.store, ctx.dir); }
});
