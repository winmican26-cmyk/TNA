import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LedgerStore, Ledger } from '../../packages/ledger-core/src/index.js';
import { reconstructImprovementGeneration, reconstructImprovementLineage } from '../../packages/ledger-query/src/index.js';
import { appendImprovementEvent } from '../../packages/improvement-core/src/ledger-integration.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section F-G: real Ledger integration and
 * lineage reconstruction. Every event here is appended to and read back from a real, hash-chained
 * `Ledger`/`LedgerStore` — never a fabricated event object.
 */

const TENANT = 'ten_ledger_test';

function tmpLedger(): { ledger: Ledger; store: LedgerStore; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-ledger-test-'));
  const store = new LedgerStore(resolve(dir, 'ledger.sqlite'));
  const ledger = new Ledger(store);
  return { ledger, store, dir };
}
function cleanup(store: LedgerStore, dir: string): void { store.close(); rmSync(dir, { recursive: true, force: true }); }

test('a full generation lifecycle is reconstructible from real Ledger events alone', () => {
  const { ledger, store, dir } = tmpLedger();
  try {
    const genId = 'gen_ledger_1';
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: genId, correlationId: genId, parentGenerationId: null, payload: { objective: 'improve routing' } });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_AUTHORIZED', { generationId: genId, correlationId: genId, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_BUILD_STARTED', { generationId: genId, correlationId: genId, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_BUILT', { generationId: genId, correlationId: genId, payload: { source_hash_after: 'hash123' } });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_EVALUATION_STARTED', { generationId: genId, correlationId: genId, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_EVALUATED', { generationId: genId, correlationId: genId, payload: { decision: 'PROMOTE' } });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROMOTED', { generationId: genId, correlationId: genId, payload: {} });

    const recon = reconstructImprovementGeneration(store, TENANT, genId);
    assert.equal(recon.proposed, true);
    assert.equal(recon.authorized, true);
    assert.equal(recon.built, true);
    assert.equal(recon.evaluated?.decision, 'PROMOTE');
    assert.equal(recon.finalState, 'PROMOTED');
    assert.equal(recon.parentGenerationId, null);
    assert.ok(recon.evidence.length >= 7);
  } finally { cleanup(store, dir); }
});

test('capability delta and authority expansion events are reconstructible', () => {
  const { ledger, store, dir } = tmpLedger();
  try {
    const genId = 'gen_ledger_2';
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: genId, correlationId: genId, parentGenerationId: null, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'CAPABILITY_DELTA_DETECTED', { generationId: genId, correlationId: genId, payload: { has_unexpected_gain: true } });
    appendImprovementEvent(ledger, TENANT, 'AUTHORITY_EXPANSION_REQUESTED', { generationId: genId, correlationId: genId, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'AUTHORITY_EXPANSION_APPROVED', { generationId: genId, correlationId: genId, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_REJECTED', { generationId: genId, correlationId: genId, payload: {} });

    const recon = reconstructImprovementGeneration(store, TENANT, genId);
    assert.equal(recon.capabilityDeltaDetected, true);
    assert.equal(recon.authorityExpansion?.status, 'APPROVED');
    assert.equal(recon.finalState, 'REJECTED');
  } finally { cleanup(store, dir); }
});

test('recursion budget exhaustion is a distinct, reconstructible final state', () => {
  const { ledger, store, dir } = tmpLedger();
  try {
    const genId = 'gen_ledger_budget';
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: genId, correlationId: genId, parentGenerationId: null, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'RECURSION_BUDGET_EXHAUSTED', { generationId: genId, correlationId: genId, payload: { reasons: ['max_generations reached'] } });
    const recon = reconstructImprovementGeneration(store, TENANT, genId);
    assert.equal(recon.finalState, 'BUDGET_EXHAUSTED');
  } finally { cleanup(store, dir); }
});

test('section G: full lineage reconstruction from Ledger alone — Gen0 -> Gen1 REJECTED, Gen0 -> Gen2 PROMOTED, Gen2 -> Gen3 CANARY FAILED -> ROLLED BACK', () => {
  const { ledger, store, dir } = tmpLedger();
  try {
    const gen0 = 'gen_lineage_0', gen1 = 'gen_lineage_1', gen2 = 'gen_lineage_2', gen3 = 'gen_lineage_3';

    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: gen0, correlationId: gen0, parentGenerationId: null, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROMOTED', { generationId: gen0, correlationId: gen0, payload: {} });

    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: gen1, correlationId: gen1, parentGenerationId: gen0, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_EVALUATED', { generationId: gen1, correlationId: gen1, payload: { decision: 'REJECT' } });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_REJECTED', { generationId: gen1, correlationId: gen1, payload: {} });

    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: gen2, correlationId: gen2, parentGenerationId: gen0, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_EVALUATED', { generationId: gen2, correlationId: gen2, payload: { decision: 'PROMOTE' } });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROMOTED', { generationId: gen2, correlationId: gen2, payload: {} });

    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: gen3, correlationId: gen3, parentGenerationId: gen2, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_CANARY_STARTED', { generationId: gen3, correlationId: gen3, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_CANARY_FAILED', { generationId: gen3, correlationId: gen3, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_ROLLBACK_STARTED', { generationId: gen3, correlationId: gen3, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_ROLLED_BACK', { generationId: gen3, correlationId: gen3, payload: {} });

    const lineage = reconstructImprovementLineage(store, TENANT, [gen0, gen1, gen2, gen3]);
    assert.deepEqual(lineage.roots, [gen0]);
    const byId = new Map(lineage.nodes.map(n => [n.generationId, n]));
    assert.equal(byId.get(gen0)!.finalState, 'PROMOTED');
    assert.equal(byId.get(gen1)!.parentGenerationId, gen0);
    assert.equal(byId.get(gen1)!.finalState, 'REJECTED');
    assert.equal(byId.get(gen2)!.parentGenerationId, gen0);
    assert.equal(byId.get(gen2)!.finalState, 'PROMOTED');
    assert.equal(byId.get(gen3)!.parentGenerationId, gen2);
    assert.equal(byId.get(gen3)!.finalState, 'ROLLED_BACK');

    // Prove this reconstruction genuinely came from Ledger's own hash-chained events, not from any
    // external bookkeeping — recompute directly from a raw store query on gen3's own stream.
    const rawGen3Events = store.query(TENANT, { streamId: `improvement:${gen3}` }, 100);
    assert.ok(rawGen3Events.some(e => e.event_type === 'IMPROVEMENT_ROLLED_BACK'));
    assert.ok(rawGen3Events.every(e => e.tenant_id === TENANT));
  } finally { cleanup(store, dir); }
});

test('improvement events use the additive improvement-governance source component and improvement-writer identity, never an existing volume\'s writer identity', () => {
  const { ledger, store, dir } = tmpLedger();
  try {
    const genId = 'gen_ledger_writer_check';
    const appended = appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: genId, correlationId: genId, parentGenerationId: null, payload: {} });
    assert.equal(appended.source_component, 'improvement-governance');
    assert.equal(appended.actor.id, 'improvement-governor');
  } finally { cleanup(store, dir); }
});
