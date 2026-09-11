import test from 'node:test';
import assert from 'node:assert/strict';
import { LedgerStore, Ledger } from '../../packages/ledger-core/src/index.js';
import { auditorWriter, reader as ledgerReader } from '../../apps/tna-ledger/src/writers.js';
import { AuditorLedgerAdapter } from '../../apps/tna-auditor/src/ledger-adapter.js';
import type { AssessmentRecord, RunRecord, AuditFinding } from '../../packages/auditor-engine/src/index.js';
import { TENANT } from './fixture.js';

function fullAssessment(overrides: Partial<AssessmentRecord> = {}): AssessmentRecord {
  return {
    version: '1.0', assessment_id: 'assess-1', tenant_id: TENANT, name: 'adapter test',
    scope: { tenant_wide: false, agent_ids: ['agent-1'], time_range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' } },
    control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: '2026-06-02T00:00:00.000Z',
    created_at: '2026-06-02T00:00:00.000Z', created_by: 'auditor-runner', spec_hash: 'a'.repeat(64),
    status: 'COMPLETED', updated_at: '2026-06-02T00:01:00.000Z', latest_run_number: 1,
    outcome: 'PASS_WITH_FINDINGS', risk_summary: null, assessment_hash: 'b'.repeat(64), control_catalog_version: '1.0',
    ...overrides,
  };
}
function fullRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    assessment_id: 'assess-1', run_number: 1, status: 'COMPLETED', started_at: '2026-06-02T00:00:00.000Z', completed_at: '2026-06-02T00:01:00.000Z',
    outcome: 'PASS_WITH_FINDINGS', risk_summary: null, assessment_hash: 'b'.repeat(64), control_catalog_version: '1.0', evaluator_version: '1.0',
    evidence_cutoff_at: '2026-06-02T00:00:00.000Z', is_replay: false, replay_of_run_number: null, catalog_version_mismatch: false,
    ...overrides,
  };
}
function fullFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    finding_id: 'finding-1', assessment_id: 'assess-1', control_id: 'TNA-AUTH-001', severity: 'HIGH', status: 'OPEN',
    title: 'x', description: 'x', evidence_refs: [], reason_codes: ['MISSING_REQUIRED_EVIDENCE'], remediation: [], created_at: '2026-06-02T00:00:30.000Z',
    ...overrides,
  };
}

test('AuditorLedgerAdapter produces events the accepted Ledger facade accepts, chains, and can retrieve', () => {
  const store = new LedgerStore(':memory:');
  const ledger = new Ledger(store);
  const writer = auditorWriter(TENANT);
  const rd = ledgerReader(TENANT);
  const adapter = new AuditorLedgerAdapter(TENANT);
  const assessment = fullAssessment();
  const run = fullRun();

  ledger.append(writer, adapter.assessmentCreated(assessment));
  ledger.append(writer, adapter.assessmentStarted(assessment, run));
  ledger.append(writer, adapter.findingCreated(assessment, run, fullFinding()));
  ledger.append(writer, adapter.assessmentCompleted(assessment, run));

  const stream = ledger.getStream(rd, `auditor:${assessment.assessment_id}`).items;
  assert.equal(stream.length, 4);
  assert.equal(stream[0]?.event_type, 'AUDIT_ASSESSMENT_CREATED');
  assert.equal(stream[0]?.correlation_id, assessment.assessment_id);
  const verification = ledger.verifyStream(rd, `auditor:${assessment.assessment_id}`);
  assert.equal(verification.valid, true);
  store.close();
});

test('AuditorLedgerAdapter.assessmentFailed produces a valid, chainable event', () => {
  const store = new LedgerStore(':memory:');
  const ledger = new Ledger(store);
  const writer = auditorWriter(TENANT);
  const rd = ledgerReader(TENANT);
  const adapter = new AuditorLedgerAdapter(TENANT);
  const assessment = fullAssessment({ status: 'INDETERMINATE', outcome: null });
  const run = fullRun({ status: 'INDETERMINATE', outcome: null, completed_at: '2026-06-02T00:01:00.000Z' });
  ledger.append(writer, adapter.assessmentCreated(assessment));
  ledger.append(writer, adapter.assessmentFailed(assessment, run));
  const verification = ledger.verifyStream(rd, `auditor:${assessment.assessment_id}`);
  assert.equal(verification.valid, true);
  store.close();
});

test('a governed agent cannot write Auditor-sourced Ledger events — only the auditor writer identity is bound to source_component "auditor"', () => {
  const store = new LedgerStore(':memory:');
  const ledger = new Ledger(store);
  const rd = ledgerReader(TENANT);
  const adapter = new AuditorLedgerAdapter(TENANT);
  assert.throws(() => ledger.append(rd, adapter.assessmentCreated(fullAssessment())));
  store.close();
});
