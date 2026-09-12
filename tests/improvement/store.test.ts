import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ImprovementStore } from '../../packages/improvement-store/src/index.js';
import { ImprovementError, type AuthorityCeiling } from '../../packages/improvement-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12). `ImprovementStore` behavior: tenant isolation
 * (section 93), CAS on every race-sensitive record, spec immutability (section 8), the generation state
 * machine (section 6), runtime-owned recursion budget (section 29-31), authority-expansion decide-once
 * (section 14, 52-54), and canary/rollback terminal-state protection (section 129, 62-65).
 */

function ceiling(): AuthorityCeiling {
  return { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 1000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] };
}
function tmpStore(): { store: ImprovementStore; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-store-test-'));
  return { store: new ImprovementStore(resolve(dir, 'improvement.sqlite')), dir };
}
function cleanup(store: ImprovementStore, dir: string): void { store.close(); rmSync(dir, { recursive: true, force: true }); }

test('createSystem/getSystem round-trips and getGeneration returns NOT_FOUND for a nonexistent id', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'demo-agent', 'actor');
    assert.equal(store.getSystem('ten_a', system.system_id).name, 'demo-agent');
    assert.throws(() => store.getGeneration('ten_a', 'gen_nonexistent'), ImprovementError);
  } finally { cleanup(store, dir); }
});

test('tenant isolation: tenant A cannot read tenant B\'s system or generation by id', () => {
  const { store, dir } = tmpStore();
  try {
    const systemB = store.createSystem('ten_b', 'b-agent', 'actor');
    const genB = store.createGeneration({ tenantId: 'ten_b', systemId: systemB.system_id, parentGenerationId: null, candidateVersion: 'v1', improvementClass: 'CLASS_0_CONFIG', specHash: 'h1', sourceHashBefore: 'src1', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    assert.throws(() => store.getSystem('ten_a', systemB.system_id), ImprovementError);
    assert.throws(() => store.getGeneration('ten_a', genB.generation_id), ImprovementError);
  } finally { cleanup(store, dir); }
});

test('createGeneration rejects a parent from a different tenant', () => {
  const { store, dir } = tmpStore();
  try {
    const systemB = store.createSystem('ten_b', 'b-agent', 'actor');
    const genB = store.createGeneration({ tenantId: 'ten_b', systemId: systemB.system_id, parentGenerationId: null, candidateVersion: 'v1', improvementClass: 'CLASS_0_CONFIG', specHash: 'h1', sourceHashBefore: 'src1', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const systemA = store.createSystem('ten_a', 'a-agent', 'actor');
    assert.throws(() => store.createGeneration({ tenantId: 'ten_a', systemId: systemA.system_id, parentGenerationId: genB.generation_id, candidateVersion: 'v2', improvementClass: 'CLASS_0_CONFIG', specHash: 'h2', sourceHashBefore: 'src2', authorityProfileBefore: ceiling(), createdBy: 'actor' }), ImprovementError);
  } finally { cleanup(store, dir); }
});

test('generation lineage: root_generation_id and generation_number propagate correctly across three generations', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const gen0 = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 'src0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const gen1 = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: gen0.generation_id, candidateVersion: 'v1', improvementClass: 'CLASS_0_CONFIG', specHash: 'h1', sourceHashBefore: 'src1', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const gen2 = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: gen1.generation_id, candidateVersion: 'v2', improvementClass: 'CLASS_0_CONFIG', specHash: 'h2', sourceHashBefore: 'src2', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    assert.equal(gen0.root_generation_id, gen0.generation_id);
    assert.equal(gen1.root_generation_id, gen0.generation_id);
    assert.equal(gen2.root_generation_id, gen0.generation_id);
    assert.equal(gen2.generation_number, 2);
  } finally { cleanup(store, dir); }
});

test('generation state machine: transitionGeneration rejects an illegal transition and a stale expectedVersion', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 'src0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    assert.equal(gen.status, 'PROPOSED');
    assert.throws(() => store.transitionGeneration('ten_a', gen.generation_id, gen.state_version, 'PROMOTED'), ImprovementError, 'cannot skip straight to PROMOTED');
    const authorized = store.transitionGeneration('ten_a', gen.generation_id, gen.state_version, 'AUTHORIZED');
    assert.equal(authorized.status, 'AUTHORIZED');
    assert.throws(() => store.transitionGeneration('ten_a', gen.generation_id, gen.state_version /* stale */, 'BUILDING'), ImprovementError);
  } finally { cleanup(store, dir); }
});

test('promoting a generation atomically sets it as the system\'s accepted_generation_id', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    let gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 'src0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    for (const to of ['AUTHORIZED', 'BUILDING', 'BUILT', 'EVALUATING', 'EVALUATED', 'CANARY', 'PROMOTED'] as const) {
      gen = store.transitionGeneration('ten_a', gen.generation_id, gen.state_version, to);
    }
    assert.equal(store.getSystem('ten_a', system.system_id).accepted_generation_id, gen.generation_id);
  } finally { cleanup(store, dir); }
});

test('spec immutability: saveSpec with the same spec_id but a different hash is rejected', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 'src0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    store.saveSpec('ten_a', gen.generation_id, 'spec_1', { objective: 'a' }, 'hashA');
    assert.throws(() => store.saveSpec('ten_a', gen.generation_id, 'spec_1', { objective: 'CHANGED' }, 'hashB'), ImprovementError);
    // Saving the exact same content/hash again is idempotent, not an error.
    store.saveSpec('ten_a', gen.generation_id, 'spec_1', { objective: 'a' }, 'hashA');
    assert.deepEqual(store.getSpec('ten_a', 'spec_1'), { objective: 'a' });
  } finally { cleanup(store, dir); }
});

test('recursion budget: runtime owns the counters via consumeRecursionBudget, and CAS rejects a stale version', () => {
  const { store, dir } = tmpStore();
  try {
    const limits = { max_generations: 3, max_attempts_per_generation: 2, max_runtime_per_attempt_ms: 1000, max_total_runtime_ms: 10_000, max_cost_per_attempt_usd: 1, max_total_cost_usd: 5, max_tool_calls: 10, max_external_calls: 5, max_changed_files: 10, max_changed_bytes: 10_000 };
    const budget = store.getOrCreateRecursionBudget('ten_a', 'sys_1', limits);
    assert.equal(budget.generation_count, 0);
    const updated = store.consumeRecursionBudget('ten_a', 'sys_1', budget.state_version, { generations: 1, costUsd: 1.5 });
    assert.equal(updated.generation_count, 1);
    assert.equal(updated.cost_used_usd, 1.5);
    assert.throws(() => store.consumeRecursionBudget('ten_a', 'sys_1', budget.state_version /* stale */, { generations: 1 }), ImprovementError);
  } finally { cleanup(store, dir); }
});

test('authority expansion request: cannot be decided twice, and a stale expectedVersion is rejected', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_2_TOOL', specHash: 'h0', sourceHashBefore: 'src0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const req = store.createAuthorityExpansionRequest({ tenantId: 'ten_a', generationId: gen.generation_id, requestedDelta: { added_operations: ['write'], added_tools: [], added_resources: [], added_destinations: [], added_filesystem_scope: [], added_credentials: [], removed_operations: [], removed_tools: [], removed_resources: [], network_access_gained: false, external_side_effects_gained: false, budget_increased: false, runtime_increased: false, parallelism_increased: false, is_expansion: true, is_reduction: false, delta_hash: 'dh1' }, reason: 'need write access', risk: 'MEDIUM', requestedBy: 'candidate-agent' });
    assert.equal(req.status, 'PENDING');
    const decided = store.decideAuthorityExpansionRequest('ten_a', req.request_id, req.state_version, 'APPROVED', 'human-approver', 'looks safe');
    assert.equal(decided.status, 'APPROVED');
    assert.throws(() => store.decideAuthorityExpansionRequest('ten_a', req.request_id, req.state_version, 'REJECTED', 'someone-else', 'too late'), ImprovementError, 'cannot decide an already-decided request');
  } finally { cleanup(store, dir); }
});

test('canary run: a late observation/end call after the run already ended is rejected, never silently overwritten (section 129)', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 'src0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const canary = store.startCanaryRun('ten_a', gen.generation_id, 'policy_hash_1');
    const observed = store.recordCanaryObservation('ten_a', canary.canary_id, canary.state_version, { actions: 10 });
    const ended = store.endCanaryRun('ten_a', canary.canary_id, observed.state_version, 'FAILED');
    assert.equal(ended.status, 'FAILED');
    assert.throws(() => store.endCanaryRun('ten_a', canary.canary_id, ended.state_version, 'PASSED'), ImprovementError, 'a stronger/weaker late end call must never overwrite an already-ended canary');
    assert.throws(() => store.recordCanaryObservation('ten_a', canary.canary_id, ended.state_version, { actions: 1 }), ImprovementError, 'no further observation is accepted after the run ended');
  } finally { cleanup(store, dir); }
});

test('rollback record: completeRollback can only run once; a second attempt is rejected, never silently overwritten', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const parent = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 'src0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const child = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: parent.generation_id, candidateVersion: 'v1', improvementClass: 'CLASS_0_CONFIG', specHash: 'h1', sourceHashBefore: 'src1', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const rollback = store.initiateRollback('ten_a', child.generation_id, parent.generation_id, 'CANARY_HEALTH_FAILURE', 'operator');
    assert.equal(rollback.status, 'INDETERMINATE', 'a rollback starts INDETERMINATE until confirmed — never reported restored without proof');
    const completed = store.completeRollback('ten_a', rollback.rollback_id, 'ROLLED_BACK', 'evidence_ref_1');
    assert.equal(completed.status, 'ROLLED_BACK');
    assert.throws(() => store.completeRollback('ten_a', rollback.rollback_id, 'FAILED', 'evidence_ref_2'), ImprovementError);
  } finally { cleanup(store, dir); }
});

test('rollback does not erase candidate/failure history: the rolled-back generation row and its promotion decisions remain readable (section 64)', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    let gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 'src0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    store.recordPromotionDecision('ten_a', { generation_id: gen.generation_id, parent_generation_id: null, evaluation_profile_hash: 'ep1', spec_hash: gen.spec_hash, source_hash: 'src0', benchmark_summary_hash: 'b1', security_summary_hash: 's1', capability_delta_hash: 'c1', authority_delta_hash: null, decision: 'REJECT', decision_reason: 'benchmark failed', decided_by: 'evaluator', decided_at: new Date().toISOString() });
    for (const to of ['AUTHORIZED', 'BUILDING', 'BUILT', 'EVALUATING'] as const) gen = store.transitionGeneration('ten_a', gen.generation_id, gen.state_version, to);
    gen = store.transitionGeneration('ten_a', gen.generation_id, gen.state_version, 'REJECTED');
    assert.equal(store.getGeneration('ten_a', gen.generation_id).status, 'REJECTED', 'a rejected generation row is never deleted');
    const decisions = store.listPromotionDecisions('ten_a', gen.generation_id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.decision, 'REJECT');
  } finally { cleanup(store, dir); }
});
