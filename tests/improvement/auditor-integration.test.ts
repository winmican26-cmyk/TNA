import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LedgerStore, Ledger } from '../../packages/ledger-core/src/index.js';
import { appendImprovementEvent } from '../../packages/improvement-core/src/ledger-integration.js';
import { assessImprovementGeneration } from '../../packages/improvement-core/src/auditor-integration.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section H: real, narrow improvement assessment
 * over actual Ledger evidence. Every assertion here is about a real assessment computed from real
 * appended events — never a fabricated PASS.
 */

const TENANT = 'ten_auditor_test';

function tmpLedger(): { ledger: Ledger; store: LedgerStore; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-auditor-test-'));
  const store = new LedgerStore(resolve(dir, 'ledger.sqlite'));
  const ledger = new Ledger(store);
  return { ledger, store, dir };
}
function cleanup(store: LedgerStore, dir: string): void { store.close(); rmSync(dir, { recursive: true, force: true }); }

test('a generation with no recorded evidence at all is INSUFFICIENT_EVIDENCE overall, never a fabricated PASS', () => {
  const { store, dir } = tmpLedger();
  try {
    const assessment = assessImprovementGeneration(store, TENANT, 'gen_nonexistent');
    assert.equal(assessment.overall, 'INSUFFICIENT_EVIDENCE');
    assert.ok(assessment.controls.every(c => c.status !== 'PASS' || c.control_id === 'canary-evidence' || c.control_id === 'rollback-readiness'), 'controls requiring real evidence must never PASS with none recorded');
  } finally { cleanup(store, dir); }
});

test('a fully clean, well-evidenced, promoted generation assesses PASS on every control', () => {
  const { ledger, store, dir } = tmpLedger();
  try {
    const genId = 'gen_clean';
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: genId, correlationId: genId, parentGenerationId: 'gen_parent', payload: {} });
    appendImprovementEvent(ledger, TENANT, 'CAPABILITY_DELTA_DETECTED', { generationId: genId, correlationId: genId, payload: { has_unexpected_gain: false } });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_EVALUATED', { generationId: genId, correlationId: genId, payload: { decision: 'PROMOTE', control_plane_changed: false, evaluator_changed: false, test_tampered: false, authority_within_ceiling: true } });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_CANARY_STARTED', { generationId: genId, correlationId: genId, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROMOTED', { generationId: genId, correlationId: genId, payload: {} });

    const assessment = assessImprovementGeneration(store, TENANT, genId);
    assert.equal(assessment.overall, 'PASS');
    assert.ok(assessment.controls.every(c => c.status === 'PASS'));
    assert.equal(assessment.controls.length, 9);
  } finally { cleanup(store, dir); }
});

test('a control-plane violation is FAILed, never masked by other passing controls', () => {
  const { ledger, store, dir } = tmpLedger();
  try {
    const genId = 'gen_control_plane_violation';
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: genId, correlationId: genId, parentGenerationId: null, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_EVALUATED', { generationId: genId, correlationId: genId, payload: { decision: 'REJECT', control_plane_changed: true, evaluator_changed: false, test_tampered: false, authority_within_ceiling: true } });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_REJECTED', { generationId: genId, correlationId: genId, payload: {} });

    const assessment = assessImprovementGeneration(store, TENANT, genId);
    assert.equal(assessment.overall, 'FAIL');
    const mutationControl = assessment.controls.find(c => c.control_id === 'mutation-boundary-integrity');
    assert.equal(mutationControl?.status, 'FAIL');
  } finally { cleanup(store, dir); }
});

test('a promoted generation with no recorded canary evidence is INSUFFICIENT_EVIDENCE for canary-evidence and rollback-readiness controls specifically', () => {
  const { ledger, store, dir } = tmpLedger();
  try {
    const genId = 'gen_promoted_no_canary';
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: genId, correlationId: genId, parentGenerationId: null, payload: {} });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_EVALUATED', { generationId: genId, correlationId: genId, payload: { decision: 'PROMOTE', control_plane_changed: false, evaluator_changed: false, test_tampered: false, authority_within_ceiling: true } });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROMOTED', { generationId: genId, correlationId: genId, payload: {} });

    const assessment = assessImprovementGeneration(store, TENANT, genId);
    const canaryControl = assessment.controls.find(c => c.control_id === 'canary-evidence');
    assert.equal(canaryControl?.status, 'INSUFFICIENT_EVIDENCE');
    const rollbackControl = assessment.controls.find(c => c.control_id === 'rollback-readiness');
    assert.equal(rollbackControl?.status, 'INSUFFICIENT_EVIDENCE', 'a root generation (no parent recorded) promoted with no rollback target is a real evidence gap, not a clean pass');
    assert.equal(assessment.overall, 'INSUFFICIENT_EVIDENCE');
  } finally { cleanup(store, dir); }
});

test('evaluator independence violation FAILs even when every other control would otherwise pass', () => {
  const { ledger, store, dir } = tmpLedger();
  try {
    const genId = 'gen_evaluator_violation';
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_PROPOSED', { generationId: genId, correlationId: genId, parentGenerationId: 'gen_parent', payload: {} });
    appendImprovementEvent(ledger, TENANT, 'CAPABILITY_DELTA_DETECTED', { generationId: genId, correlationId: genId, payload: { has_unexpected_gain: false } });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_EVALUATED', { generationId: genId, correlationId: genId, payload: { decision: 'REJECT', control_plane_changed: false, evaluator_changed: true, test_tampered: false, authority_within_ceiling: true } });
    appendImprovementEvent(ledger, TENANT, 'IMPROVEMENT_REJECTED', { generationId: genId, correlationId: genId, payload: {} });

    const assessment = assessImprovementGeneration(store, TENANT, genId);
    assert.equal(assessment.controls.find(c => c.control_id === 'evaluator-independence')?.status, 'FAIL');
    assert.equal(assessment.overall, 'FAIL');
  } finally { cleanup(store, dir); }
});
