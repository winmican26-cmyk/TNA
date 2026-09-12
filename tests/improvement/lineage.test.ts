import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ImprovementStore } from '../../packages/improvement-store/src/index.js';
import { ImprovementError, type AuthorityCeiling } from '../../packages/improvement-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section 92: "the generation graph must be
 * acyclic — mandatory test." A legitimate `createGeneration` call cannot itself produce a cycle (a child
 * always names an already-existing parent, so the graph is a DAG by construction — see
 * `ImprovementStore.createGeneration`'s own doc comment). This file tests the DEFENSE-IN-DEPTH cycle
 * guard in `getLineage` directly, using hand-crafted pathological rows written straight to the
 * underlying SQLite database — the same "simulate a forged/corrupted row" technique already used
 * elsewhere in this project (e.g. Volume 11's evidence-less forged-PASSED-progress-row test) to prove a
 * defense actually fires rather than merely existing in prose.
 */

function ceiling(): AuthorityCeiling {
  return { operations: [], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 1000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] };
}

test('getLineage reconstructs a real multi-generation ancestor chain and descendant tree correctly', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-lineage-test-'));
  const store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const gen0 = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 'src0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const gen1 = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: gen0.generation_id, candidateVersion: 'v1', improvementClass: 'CLASS_0_CONFIG', specHash: 'h1', sourceHashBefore: 'src1', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const gen2a = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: gen1.generation_id, candidateVersion: 'v2a', improvementClass: 'CLASS_0_CONFIG', specHash: 'h2a', sourceHashBefore: 'src2a', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const gen2b = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: gen1.generation_id, candidateVersion: 'v2b', improvementClass: 'CLASS_0_CONFIG', specHash: 'h2b', sourceHashBefore: 'src2b', authorityProfileBefore: ceiling(), createdBy: 'actor' });

    const lineageOfGen1 = store.getLineage('ten_a', gen1.generation_id);
    assert.deepEqual(lineageOfGen1.ancestors.map(g => g.generation_id), [gen0.generation_id], 'root-first ancestor chain');
    const descendantIds = lineageOfGen1.descendants.map(g => g.generation_id).sort();
    assert.deepEqual(descendantIds, [gen2a.generation_id, gen2b.generation_id].sort(), 'both branches from a fork must be found');

    const lineageOfGen2a = store.getLineage('ten_a', gen2a.generation_id);
    assert.deepEqual(lineageOfGen2a.ancestors.map(g => g.generation_id), [gen0.generation_id, gen1.generation_id]);
    assert.equal(lineageOfGen2a.descendants.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('getLineage throws LINEAGE_CYCLE when the ancestor chain is corrupted into a cycle (defense-in-depth guard fires for real)', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-lineage-cycle-test-'));
  const store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const genA = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'vA', improvementClass: 'CLASS_0_CONFIG', specHash: 'hA', sourceHashBefore: 'srcA', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const genB = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: genA.generation_id, candidateVersion: 'vB', improvementClass: 'CLASS_0_CONFIG', specHash: 'hB', sourceHashBefore: 'srcB', authorityProfileBefore: ceiling(), createdBy: 'actor' });

    // Forge a cycle directly against the database: point genA's parent at genB, which is genA's own
    // child — something no legitimate call to createGeneration can ever produce, since a child always
    // names an ALREADY-EXISTING parent at creation time. This simulates row-level corruption/tampering
    // to prove the ancestor-walk cycle guard actually fires, not merely that it looks correct in prose.
    const rawDb = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    rawDb.prepare('UPDATE improvement_generations SET parent_generation_id = ? WHERE generation_id = ?').run(genB.generation_id, genA.generation_id);

    assert.throws(() => store.getLineage('ten_a', genB.generation_id), (error: unknown) => error instanceof ImprovementError && error.code === 'LINEAGE_CYCLE');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('getLineage throws LINEAGE_CYCLE for a forged self-parent row (generation is its own parent)', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-lineage-self-cycle-test-'));
  const store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  try {
    const system = store.createSystem('ten_a', 'agent', 'actor');
    const gen = store.createGeneration({ tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v0', improvementClass: 'CLASS_0_CONFIG', specHash: 'h0', sourceHashBefore: 'src0', authorityProfileBefore: ceiling(), createdBy: 'actor' });
    const rawDb = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    rawDb.prepare('UPDATE improvement_generations SET parent_generation_id = ? WHERE generation_id = ?').run(gen.generation_id, gen.generation_id);
    assert.throws(() => store.getLineage('ten_a', gen.generation_id), (error: unknown) => error instanceof ImprovementError && error.code === 'LINEAGE_CYCLE');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
