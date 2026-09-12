import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ImprovementStore } from '../../packages/improvement-store/src/index.js';
import { ImprovementError, type AuthorityCeiling } from '../../packages/improvement-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section Y-Z: a dedicated race suite. Every
 * race here is modeled the standard way for optimistic-concurrency-controlled stores (the same pattern
 * every prior TNA volume's own CAS races use): two callers read the SAME starting `state_version`; the
 * first write to actually commit advances the version, and the second — still holding the now-stale
 * version — must be rejected with CONFLICT, never silently applied on top. TNA-33 ("stronger safety
 * state must not be overwritten by a stale weaker one") is checked explicitly wherever a terminal/strong
 * state (ROLLED_BACK, a decided approval, a resolved canary) could otherwise be raced against a
 * weaker/stale one.
 *
 * Honest scope note: "evaluate vs evaluator-profile change" has no dedicated, independently-versioned
 * "current EvaluationProfile" store entity in this implementation to race against (the profile hash is
 * recorded per-decision, immutably, but is not itself a live, CAS-protected resource) — see
 * `tests/improvement/http.test.ts`/`auditor-integration.test.ts` for how a recorded `evaluation_profile_hash`
 * is read back as evidence instead. That specific pairing is not claimed as covered here.
 */

function ceiling(): AuthorityCeiling {
  return { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 1000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] };
}
function tmpStore(): { store: ImprovementStore; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-concurrency-'));
  return { store: new ImprovementStore(resolve(dir, 'improvement.sqlite')), dir };
}
function cleanup(store: ImprovementStore, dir: string): void { store.close(); rmSync(dir, { recursive: true, force: true }); }

test('race: promote vs promote — two concurrent promotion attempts against the same state_version; only one wins', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    let gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 's0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    for (const to of ['AUTHORIZED', 'BUILDING', 'BUILT', 'EVALUATING', 'EVALUATED', 'CANARY'] as const) gen = store.transitionGeneration('ten_a', gen.generation_id, gen.state_version, to);
    const racedVersion = gen.state_version; // both "concurrent" callers hold this same version

    const first = store.transitionGeneration('ten_a', gen.generation_id, racedVersion, 'PROMOTED');
    assert.equal(first.status, 'PROMOTED');
    assert.throws(() => store.transitionGeneration('ten_a', gen.generation_id, racedVersion, 'PROMOTED'), (e: unknown) => e instanceof ImprovementError && e.code === 'CONFLICT');
  } finally { cleanup(store, dir); }
});

test('race: promote vs rollback — a stale promote attempt must never overwrite a genuinely-committed rollback (TNA-33: stronger safety state wins)', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    let gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 's0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    for (const to of ['AUTHORIZED', 'BUILDING', 'BUILT', 'EVALUATING', 'EVALUATED', 'CANARY'] as const) gen = store.transitionGeneration('ten_a', gen.generation_id, gen.state_version, to);
    const racedVersion = gen.state_version;

    // The rollback (triggered by a real Sentinel/canary-health signal) commits first.
    const rolledBack = store.transitionGeneration('ten_a', gen.generation_id, racedVersion, 'ROLLED_BACK');
    assert.equal(rolledBack.status, 'ROLLED_BACK');
    // A stale promote attempt — still holding the pre-rollback version — must be rejected, never silently
    // resurrecting a rolled-back generation to PROMOTED.
    assert.throws(() => store.transitionGeneration('ten_a', gen.generation_id, racedVersion, 'PROMOTED'), (e: unknown) => e instanceof ImprovementError && e.code === 'CONFLICT');
    assert.equal(store.getGeneration('ten_a', gen.generation_id).status, 'ROLLED_BACK', 'the committed ROLLED_BACK state must remain, never overwritten by the losing stale request');
  } finally { cleanup(store, dir); }
});

test('race: authorize vs spec mutation — a spec already saved cannot be silently replaced by a concurrent "mutation" attempt under the same spec_id', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 's0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    store.saveSpec('ten_a', gen.generation_id, 'spec_race', { objective: 'original' }, 'hash_original');
    // A concurrent authorize proceeds reading the original spec...
    const authorized = store.transitionGeneration('ten_a', gen.generation_id, gen.state_version, 'AUTHORIZED');
    assert.equal(authorized.status, 'AUTHORIZED');
    // ...while a racing "mutation" attempt tries to silently replace the spec content under the same id.
    assert.throws(() => store.saveSpec('ten_a', gen.generation_id, 'spec_race', { objective: 'mutated after authorization' }, 'hash_mutated'), (e: unknown) => e instanceof ImprovementError && e.code === 'SPEC_IMMUTABLE');
    assert.deepEqual(store.getSpec('ten_a', 'spec_race'), { objective: 'original' }, 'the original spec content must remain exactly as authorized');
  } finally { cleanup(store, dir); }
});

test('race: budget consume vs budget consume — two concurrent consumers against the same state_version; only one commits, the loser must retry against fresh state, never silently lose or double-count', () => {
  const { store, dir } = tmpStore();
  try {
    const limits = { max_generations: 10, max_attempts_per_generation: 10, max_runtime_per_attempt_ms: 1000, max_total_runtime_ms: 100_000, max_cost_per_attempt_usd: 5, max_total_cost_usd: 20, max_tool_calls: 100, max_external_calls: 10, max_changed_files: 10, max_changed_bytes: 10_000 };
    const budget = store.getOrCreateRecursionBudget('ten_a', 'sys_race', limits);
    const racedVersion = budget.state_version;

    const first = store.consumeRecursionBudget('ten_a', 'sys_race', racedVersion, { costUsd: 2 });
    assert.equal(first.cost_used_usd, 2);
    assert.throws(() => store.consumeRecursionBudget('ten_a', 'sys_race', racedVersion, { costUsd: 3 }), (e: unknown) => e instanceof ImprovementError && e.code === 'CONFLICT');
    // The loser retries against the fresh version — this is the correct, expected recovery, not a bug.
    const retried = store.consumeRecursionBudget('ten_a', 'sys_race', first.state_version, { costUsd: 3 });
    assert.equal(retried.cost_used_usd, 5, 'no cost was lost or double-counted across the race');
  } finally { cleanup(store, dir); }
});

test('race: authority-expansion approve vs reject — whichever decision commits first wins; the second, stale decision attempt is rejected, never silently overriding the first', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_2_TOOL', specHash: 'h0', sourceHashBefore: 's0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const req = store.createAuthorityExpansionRequest({
      tenantId: 'ten_a', generationId: gen.generation_id,
      requestedDelta: { added_operations: ['write'], added_tools: [], added_resources: [], added_destinations: [], added_filesystem_scope: [], added_credentials: [], removed_operations: [], removed_tools: [], removed_resources: [], network_access_gained: false, external_side_effects_gained: false, budget_increased: false, runtime_increased: false, parallelism_increased: false, is_expansion: true, is_reduction: false, delta_hash: 'd1' },
      reason: 'need write', risk: 'MEDIUM', requestedBy: 'candidate',
    });
    const racedVersion = req.state_version;

    const approved = store.decideAuthorityExpansionRequest('ten_a', req.request_id, racedVersion, 'APPROVED', 'approver-1', 'looks fine');
    assert.equal(approved.status, 'APPROVED');
    // A racing REJECT decision, still holding the pre-decision version, must never override the committed APPROVED.
    assert.throws(() => store.decideAuthorityExpansionRequest('ten_a', req.request_id, racedVersion, 'REJECTED', 'approver-2', 'too late'), (e: unknown) => e instanceof ImprovementError && e.code === 'CONFLICT');
    assert.equal(store.getAuthorityExpansionRequest('ten_a', req.request_id).status, 'APPROVED');
  } finally { cleanup(store, dir); }
});

test('race: canary success vs Sentinel-driven termination/failure — a late "success" observation must never overwrite a committed FAILED canary result', () => {
  const { store, dir } = tmpStore();
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 's0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const canary = store.startCanaryRun('ten_a', gen.generation_id, 'policy_hash');
    const racedVersion = canary.state_version;

    // Sentinel-driven termination commits FAILED first.
    const failed = store.endCanaryRun('ten_a', canary.canary_id, racedVersion, 'FAILED');
    assert.equal(failed.status, 'FAILED');
    // A late, stale "success" (PASSED) attempt — still holding the pre-failure version — must be rejected.
    assert.throws(() => store.endCanaryRun('ten_a', canary.canary_id, racedVersion, 'PASSED'), (e: unknown) => e instanceof ImprovementError && e.code === 'CONFLICT');
    assert.equal(store.getCanaryRun('ten_a', canary.canary_id).status, 'FAILED', 'the committed FAILED result must remain — a late success can never overwrite it');
  } finally { cleanup(store, dir); }
});
