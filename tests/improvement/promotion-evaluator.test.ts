import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execPath } from 'node:process';
import { runPromotionEvaluation, type EvaluationInputs } from '../../packages/improvement-evaluator/src/index.js';
import { ImprovementStore } from '../../packages/improvement-store/src/index.js';
import { hashDirectoryTree } from '../../packages/improvement-core/src/index.js';
import { buildImprovementSpec, buildRequiredTestManifest, type AuthorityCeiling, type CapabilityProfile } from '../../packages/improvement-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12). Real end-to-end tests for
 * `runPromotionEvaluation` — every regression/security/benchmark "command" here is a REAL spawned Node
 * process (a small inline script), and every workspace is a real temp directory on disk. No mocked
 * evidence anywhere in these tests.
 */

function ceiling(overrides: Partial<AuthorityCeiling> = {}): AuthorityCeiling {
  return { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 60_000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [], ...overrides };
}
function capability(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return { tools: [], operations: ['read'], resources: [], destinations: [], filesystem_writes: false, network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [], ...overrides };
}
function writeScoreScript(dir: string, name: string, score: number): string {
  const path = resolve(dir, name);
  writeFileSync(path, `process.stdout.write(String(${score}));\n`);
  return path;
}
function writeExitScript(dir: string, name: string, code: number): string {
  const path = resolve(dir, name);
  writeFileSync(path, `process.exitCode = ${code};\n`);
  return path;
}

function setup() {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-eval-test-'));
  const store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  const parentWorkspace = resolve(dir, 'parent');
  mkdirSync(parentWorkspace, { recursive: true });
  writeFileSync(resolve(parentWorkspace, 'app.ts'), 'export const version = 1;');
  const system = store.createSystem('ten_a', 'demo-agent', 'actor');
  const spec = buildImprovementSpec({
    system_id: system.system_id, tenant_id: 'ten_a', parent_generation_id: null, objective: 'improve routing',
    improvement_class: 'CLASS_1_CODE', allowed_mutation_paths: ['app.ts'], forbidden_mutation_paths: [],
    allowed_tool_changes: [], allowed_dependency_changes: [], allowed_model_changes: [], authority_ceiling: ceiling(),
    resource_limits: { max_runtime_ms: 60_000, max_cost_usd: 1, max_tool_calls: 10, max_external_calls: 0, max_changed_files: 10, max_changed_bytes: 100_000 },
    evaluation_profile_id: 'evalprof_1', required_benchmarks: ['accuracy'], required_security_tests: [],
    promotion_thresholds: { accuracy: 0.01 }, canary_policy: { traffic_percent: 5, max_actions: 10, max_runtime_ms: 1000, failure_threshold: 0.1, sentinel_terminate_is_failure: true, cost_threshold_usd: 1 },
    rollback_policy: { rollback_generation_id: null, auto_rollback_triggers: [] }, max_iterations: 3, max_runtime_ms: 60_000, max_cost_usd: 1, created_by: 'actor',
  });
  const generation = store.createGeneration({
    tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v1',
    improvementClass: 'CLASS_1_CODE', specHash: spec.spec_hash, sourceHashBefore: hashDirectoryTree(parentWorkspace),
    authorityProfileBefore: ceiling(), createdBy: 'actor',
  });
  const manifest = buildRequiredTestManifest('m1', 1, [{ test_id: 't1', path: 'tests/a.test.ts', content_hash: 'h1', required: true, source: 'accepted' }]);
  return { dir, store, parentWorkspace, system, spec, generation, manifest };
}
function cleanup(store: ImprovementStore, dir: string): void { store.close(); rmSync(dir, { recursive: true, force: true }); }

function baseInputs(ctx: ReturnType<typeof setup>, candidateWorkspace: string, overrides: Partial<EvaluationInputs> = {}): EvaluationInputs {
  return {
    tenantId: 'ten_a', generationId: ctx.generation.generation_id, parentGenerationId: null, improvementClass: 'CLASS_1_CODE',
    parentWorkspace: ctx.parentWorkspace, candidateWorkspace, spec: ctx.spec,
    parentCapabilityProfile: capability(), candidateCapabilityProfile: capability(),
    regressionTestCommand: null, securityTestCommand: null, benchmarks: [],
    requiredTestManifestBefore: ctx.manifest, requiredTestManifestAfter: ctx.manifest,
    candidateAuthorityProfile: ceiling(), humanApproved: null, independentReviewApproved: null,
    evaluationProfileHash: 'evalhash1', decidedBy: 'evaluator',
    ...overrides,
  };
}

test('runPromotionEvaluation: a clean candidate with a real passing benchmark and real passing regression/security commands PROMOTEs', () => {
  const ctx = setup();
  try {
    const candidateWorkspace = resolve(ctx.dir, 'candidate-clean');
    mkdirSync(candidateWorkspace, { recursive: true });
    writeFileSync(resolve(candidateWorkspace, 'app.ts'), 'export const version = 2; // improved');
    const benchmarkScript = writeScoreScript(ctx.dir, 'benchmark.js', 0.9);
    const regressionScript = writeExitScript(ctx.dir, 'regression.js', 0);
    const securityScript = writeExitScript(ctx.dir, 'security.js', 0);
    const result = runPromotionEvaluation(ctx.store, baseInputs(ctx, candidateWorkspace, {
      regressionTestCommand: [execPath, regressionScript], securityTestCommand: [execPath, securityScript],
      benchmarks: [{ benchmarkId: 'accuracy', command: [execPath, benchmarkScript], threshold: 0.01, parentScore: 0.8 }],
    }));
    assert.equal(result.status, 'PROMOTE', result.reason);
    assert.equal(result.benchmarkResults[0]!.status, 'PASS');
  } finally { cleanup(ctx.store, ctx.dir); }
});

test('runPromotionEvaluation: a real failing regression command REJECTs even with a passing benchmark', () => {
  const ctx = setup();
  try {
    const candidateWorkspace = resolve(ctx.dir, 'candidate-regression-fail');
    mkdirSync(candidateWorkspace, { recursive: true });
    writeFileSync(resolve(candidateWorkspace, 'app.ts'), 'export const version = 2;');
    const benchmarkScript = writeScoreScript(ctx.dir, 'benchmark2.js', 0.99);
    const regressionScript = writeExitScript(ctx.dir, 'regression-fail.js', 1);
    const result = runPromotionEvaluation(ctx.store, baseInputs(ctx, candidateWorkspace, {
      regressionTestCommand: [execPath, regressionScript],
      benchmarks: [{ benchmarkId: 'accuracy', command: [execPath, benchmarkScript], threshold: 0.01, parentScore: 0.8 }],
    }));
    assert.equal(result.status, 'REJECT');
    assert.equal(result.regressionSuitePassed, false);
  } finally { cleanup(ctx.store, ctx.dir); }
});

test('runPromotionEvaluation: a candidate authority profile exceeding the spec ceiling REJECTs regardless of clean tests', () => {
  const ctx = setup();
  try {
    const candidateWorkspace = resolve(ctx.dir, 'candidate-authority');
    mkdirSync(candidateWorkspace, { recursive: true });
    writeFileSync(resolve(candidateWorkspace, 'app.ts'), 'export const version = 2;');
    const result = runPromotionEvaluation(ctx.store, baseInputs(ctx, candidateWorkspace, {
      candidateAuthorityProfile: ceiling({ operations: ['read', 'write'] }),
    }));
    assert.equal(result.status, 'REJECT');
    assert.match(result.reason, /authority/i);
  } finally { cleanup(ctx.store, ctx.dir); }
});

test('runPromotionEvaluation: a candidate that touches the evaluator\'s own path is REJECTed unconditionally', () => {
  const ctx = setup();
  try {
    const candidateWorkspace = resolve(ctx.dir, 'candidate-evaluator-tamper');
    mkdirSync(resolve(candidateWorkspace, 'packages', 'improvement-evaluator', 'src'), { recursive: true });
    writeFileSync(resolve(candidateWorkspace, 'app.ts'), 'export const version = 1;');
    writeFileSync(resolve(candidateWorkspace, 'packages', 'improvement-evaluator', 'src', 'index.ts'), 'export const evaluatorTampered = true;');
    const specWithEvaluatorPath = { ...ctx.spec, allowed_mutation_paths: ['app.ts', 'packages/improvement-evaluator/'] };
    const result = runPromotionEvaluation(ctx.store, baseInputs(ctx, candidateWorkspace, { spec: specWithEvaluatorPath }));
    assert.equal(result.status, 'REJECT');
    assert.match(result.reason, /evaluator/i);
  } finally { cleanup(ctx.store, ctx.dir); }
});

test('runPromotionEvaluation: a candidate that removes a required test is REJECTed even with everything else clean', () => {
  const ctx = setup();
  try {
    const candidateWorkspace = resolve(ctx.dir, 'candidate-test-removal');
    mkdirSync(candidateWorkspace, { recursive: true });
    writeFileSync(resolve(candidateWorkspace, 'app.ts'), 'export const version = 2;');
    const emptyManifest = buildRequiredTestManifest('m1', 2, []);
    const result = runPromotionEvaluation(ctx.store, baseInputs(ctx, candidateWorkspace, { requiredTestManifestAfter: emptyManifest }));
    assert.equal(result.status, 'REJECT');
    assert.match(result.reason, /tampered/i);
  } finally { cleanup(ctx.store, ctx.dir); }
});

test('runPromotionEvaluation: a stale parent (accepted baseline changed since generation creation) reports INDETERMINATE, never a silent promotion', () => {
  const ctx = setup();
  try {
    // Mutate the parent workspace AFTER the generation's source_hash_before was already recorded.
    writeFileSync(resolve(ctx.parentWorkspace, 'app.ts'), 'export const version = 1; // parent changed after generation creation');
    const candidateWorkspace = resolve(ctx.dir, 'candidate-stale-parent');
    mkdirSync(candidateWorkspace, { recursive: true });
    writeFileSync(resolve(candidateWorkspace, 'app.ts'), 'export const version = 2;');
    const result = runPromotionEvaluation(ctx.store, baseInputs(ctx, candidateWorkspace));
    assert.equal(result.status, 'INDETERMINATE');
    assert.match(result.reason, /[Ss]tale parent/);
  } finally { cleanup(ctx.store, ctx.dir); }
});

test('runPromotionEvaluation: an evaluation-infrastructure failure (a command that cannot even be spawned) reports INSUFFICIENT_EVIDENCE, never a candidate PASS', () => {
  const ctx = setup();
  try {
    const candidateWorkspace = resolve(ctx.dir, 'candidate-infra-fail');
    mkdirSync(candidateWorkspace, { recursive: true });
    writeFileSync(resolve(candidateWorkspace, 'app.ts'), 'export const version = 2;');
    const result = runPromotionEvaluation(ctx.store, baseInputs(ctx, candidateWorkspace, {
      regressionTestCommand: ['this-executable-does-not-exist-anywhere'],
    }));
    assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
    assert.equal(result.evidenceComplete, false);
  } finally { cleanup(ctx.store, ctx.dir); }
});

test('runPromotionEvaluation: an unexpected capability gain (e.g. gained filesystem writes) REJECTs even with every test passing', () => {
  const ctx = setup();
  try {
    const candidateWorkspace = resolve(ctx.dir, 'candidate-capability-gain');
    mkdirSync(candidateWorkspace, { recursive: true });
    writeFileSync(resolve(candidateWorkspace, 'app.ts'), 'export const version = 2;');
    const result = runPromotionEvaluation(ctx.store, baseInputs(ctx, candidateWorkspace, {
      candidateCapabilityProfile: capability({ filesystem_writes: true }),
    }));
    assert.equal(result.status, 'REJECT');
    assert.match(result.reason, /[Cc]apability/);
  } finally { cleanup(ctx.store, ctx.dir); }
});
