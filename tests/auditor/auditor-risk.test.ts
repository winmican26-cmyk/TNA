import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRiskSummary, computeOutcome, compareFindingPriority, type ScoredControlResult } from '../../packages/auditor-risk/src/index.js';
import type { ControlResult, ControlResultStatus } from '../../packages/auditor-schema/src/index.js';

function result(status: ControlResultStatus, riskContribution: number): ControlResult {
  return { control_id: `c-${Math.random()}`, control_version: '1.0', status, evaluated_at: '2026-06-02T00:00:00.000Z', assessment_id: 'a1', evidence_refs: [], reason_codes: [], observations: [], limitations: [], risk_contribution: riskContribution };
}

test('coverage_percentage counts only applicable controls; NOT_APPLICABLE never counts as pass nor toward the denominator', () => {
  const scored: ScoredControlResult[] = [
    { result: result('PASS', 0), criticality: 'MEDIUM' },
    { result: result('PASS', 0), criticality: 'MEDIUM' },
    { result: result('FAIL', 30), criticality: 'MEDIUM' },
    { result: result('NOT_APPLICABLE', 0), criticality: 'MEDIUM' },
  ];
  const summary = computeRiskSummary(scored);
  assert.equal(summary.applicable_count, 3);
  assert.equal(summary.coverage_percentage, 67); // 2/3 rounded
  assert.equal(summary.counts.not_applicable, 1);
});

test('overall risk score is the mean of applicable risk_contribution values when no critical floor applies', () => {
  const scored: ScoredControlResult[] = [
    { result: result('FAIL', 30), criticality: 'MEDIUM' },
    { result: result('PASS', 0), criticality: 'MEDIUM' },
  ];
  const summary = computeRiskSummary(scored);
  assert.equal(summary.overall_risk_score, 15);
  assert.equal(summary.critical_floor_applied, false);
  assert.equal(summary.overall_risk_level, 'LOW');
});

test('TNA-33/section-33: a single CRITICAL FAIL floors overall risk at 100 regardless of how many low-risk controls pass', () => {
  const scored: ScoredControlResult[] = [
    { result: result('FAIL', 100), criticality: 'CRITICAL' },
    ...Array.from({ length: 25 }, () => ({ result: result('PASS', 0), criticality: 'LOW' as const })),
  ];
  const summary = computeRiskSummary(scored);
  assert.equal(summary.critical_floor_applied, true);
  assert.equal(summary.overall_risk_score, 100);
  assert.equal(summary.overall_risk_level, 'CRITICAL');
});
test('a CRITICAL control that is only PARTIAL or INSUFFICIENT_EVIDENCE (not FAIL/ERROR) does not trigger the critical floor', () => {
  const scored: ScoredControlResult[] = [{ result: result('PARTIAL', 50), criticality: 'CRITICAL' }, { result: result('PASS', 0), criticality: 'LOW' }];
  const summary = computeRiskSummary(scored);
  assert.equal(summary.critical_floor_applied, false);
});
test('a CRITICAL control that ERRORs (not FAILs) still triggers the critical floor — ERROR is never treated as safer than FAIL', () => {
  const scored: ScoredControlResult[] = [{ result: result('ERROR', 100), criticality: 'CRITICAL' }];
  assert.equal(computeRiskSummary(scored).critical_floor_applied, true);
});

test('overall outcome: FAIL when a mandatory CRITICAL control FAILs', () => {
  const scored: ScoredControlResult[] = [{ result: result('FAIL', 100), criticality: 'CRITICAL' }, { result: result('PASS', 0), criticality: 'LOW' }];
  assert.equal(computeOutcome(scored), 'FAIL');
});
test('overall outcome: INSUFFICIENT_EVIDENCE when a CRITICAL control cannot be evaluated but none FAILed', () => {
  const scored: ScoredControlResult[] = [{ result: result('INSUFFICIENT_EVIDENCE', 50), criticality: 'CRITICAL' }, { result: result('PASS', 0), criticality: 'LOW' }];
  assert.equal(computeOutcome(scored), 'INSUFFICIENT_EVIDENCE');
});
test('overall outcome: FAIL takes precedence over INSUFFICIENT_EVIDENCE when both occur among critical controls', () => {
  const scored: ScoredControlResult[] = [{ result: result('FAIL', 100), criticality: 'CRITICAL' }, { result: result('INSUFFICIENT_EVIDENCE', 50), criticality: 'CRITICAL' }];
  assert.equal(computeOutcome(scored), 'FAIL');
});
test('overall outcome: PASS only when every applicable control is PASS', () => {
  const scored: ScoredControlResult[] = [{ result: result('PASS', 0), criticality: 'CRITICAL' }, { result: result('NOT_APPLICABLE', 0), criticality: 'LOW' }];
  assert.equal(computeOutcome(scored), 'PASS');
});
test('overall outcome: PASS_WITH_FINDINGS when no blocking critical failure but a non-critical control is not PASS', () => {
  const scored: ScoredControlResult[] = [{ result: result('PASS', 0), criticality: 'CRITICAL' }, { result: result('PARTIAL', 15), criticality: 'MEDIUM' }];
  assert.equal(computeOutcome(scored), 'PASS_WITH_FINDINGS');
});
test('overall outcome: ERROR (degenerate) when the applicable set is empty', () => {
  assert.equal(computeOutcome([]), 'ERROR');
  assert.equal(computeOutcome([{ result: result('NOT_APPLICABLE', 0), criticality: 'CRITICAL' }]), 'ERROR');
});

test('finding priority ordering: severity desc, then control status desc, then finding_id as a stable tiebreak', () => {
  const items = [
    { severity: 'LOW' as const, control_status: 'FAIL' as const, finding_id: 'z' },
    { severity: 'CRITICAL' as const, control_status: 'PARTIAL' as const, finding_id: 'a' },
    { severity: 'CRITICAL' as const, control_status: 'FAIL' as const, finding_id: 'b' },
  ];
  const sorted = [...items].sort(compareFindingPriority);
  assert.deepEqual(sorted.map(i => i.finding_id), ['b', 'a', 'z']);
});
