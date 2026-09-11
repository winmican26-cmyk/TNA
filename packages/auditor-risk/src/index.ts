import { SEVERITY_SCORE, type Severity, type ControlResult, type ControlResultStatus, type AssessmentOutcome } from '../../auditor-schema/src/index.js';

/** One evaluated control's result paired with the *effective* criticality it was evaluated under
 * (profile overrides already applied by the engine — see auditor-controls' `effectiveCriticality`).
 * auditor-risk deliberately does not import auditor-controls: it only needs this pairing, not the
 * catalog itself, keeping the scoring model a pure function of (status, criticality) pairs. */
export interface ScoredControlResult {
  readonly result: ControlResult;
  readonly criticality: Severity;
}

export interface RiskCounts {
  readonly pass: number; readonly partial: number; readonly fail: number;
  readonly insufficient_evidence: number; readonly not_applicable: number; readonly error: number;
}

export interface RiskSummary {
  readonly overall_risk_score: number;
  readonly overall_risk_level: Severity;
  /** Section 33: true iff any applicable CRITICAL-criticality control FAILed or ERRORed — the
   * exact condition that floors overall_risk_score at 100 regardless of how many other controls
   * passed, so a critical failure can never be averaged away. */
  readonly critical_floor_applied: boolean;
  readonly counts: RiskCounts;
  readonly applicable_count: number;
  readonly evaluated_count: number;
  /** Section 35-36: integer percentage, pass / applicable (NOT_APPLICABLE never counts toward the
   * denominator, and never counts as a pass). No false precision. */
  readonly coverage_percentage: number;
}

function bucketSeverity(score: number): Severity {
  if (score >= SEVERITY_SCORE.CRITICAL) return 'CRITICAL';
  if (score >= SEVERITY_SCORE.HIGH) return 'HIGH';
  if (score >= SEVERITY_SCORE.MEDIUM) return 'MEDIUM';
  if (score >= SEVERITY_SCORE.LOW) return 'LOW';
  return 'INFO';
}

function emptyCounts(): { pass: number; partial: number; fail: number; insufficient_evidence: number; not_applicable: number; error: number } {
  return { pass: 0, partial: 0, fail: 0, insufficient_evidence: 0, not_applicable: 0, error: 0 };
}
const COUNT_KEY: Readonly<Record<ControlResultStatus, keyof RiskCounts>> = {
  PASS: 'pass', PARTIAL: 'partial', FAIL: 'fail', INSUFFICIENT_EVIDENCE: 'insufficient_evidence', NOT_APPLICABLE: 'not_applicable', ERROR: 'error',
};

/**
 * Section 32-36: deterministic risk aggregation. No AI, no fuzzy scoring.
 *
 * `overall_risk_score` = round(mean(risk_contribution) across every *applicable* (non-
 * NOT_APPLICABLE) result), where each result's own `risk_contribution` is already
 * `computeRiskContribution(criticality, status)` (0 for PASS, half the criticality score for
 * PARTIAL/INSUFFICIENT_EVIDENCE, the full criticality score for FAIL/ERROR) — so the mean is
 * already implicitly weighted by each control's own criticality, without a second weighting pass.
 * This is then overridden to exactly 100 (CRITICAL) whenever `critical_floor_applied` is true
 * (section 33), regardless of how large the applicable set is. `overall_risk_level` buckets the
 * final score using the same INFO/LOW/MEDIUM/HIGH/CRITICAL thresholds as `SEVERITY_SCORE`.
 */
export function computeRiskSummary(scored: readonly ScoredControlResult[]): RiskSummary {
  const counts = emptyCounts();
  for (const { result } of scored) counts[COUNT_KEY[result.status]] += 1;
  const applicable = scored.filter(s => s.result.status !== 'NOT_APPLICABLE');
  const applicableCount = applicable.length;
  const meanContribution = applicableCount === 0 ? 0 : Math.round(applicable.reduce((sum, s) => sum + s.result.risk_contribution, 0) / applicableCount);
  const criticalFloorApplied = applicable.some(s => s.criticality === 'CRITICAL' && (s.result.status === 'FAIL' || s.result.status === 'ERROR'));
  const overallScore = criticalFloorApplied ? SEVERITY_SCORE.CRITICAL : meanContribution;
  const coverage = applicableCount === 0 ? 0 : Math.round((counts.pass / applicableCount) * 100);
  return {
    overall_risk_score: overallScore, overall_risk_level: bucketSeverity(overallScore), critical_floor_applied: criticalFloorApplied,
    counts, applicable_count: applicableCount, evaluated_count: scored.length, coverage_percentage: coverage,
  };
}

/**
 * Section 38: deterministic overall outcome.
 *
 * `FAIL` — any applicable control with CRITICAL effective criticality has status FAIL.
 * `INSUFFICIENT_EVIDENCE` — no CRITICAL control FAILed, but at least one CRITICAL control could not
 *   be evaluated (INSUFFICIENT_EVIDENCE or ERROR).
 * `ERROR` — the applicable set is empty (a scope/profile combination that evaluated nothing is a
 *   degenerate condition, not a silent PASS).
 * `PASS` — every applicable control is PASS.
 * `PASS_WITH_FINDINGS` — none of the above: no blocking critical failure, but at least one
 *   applicable control is PARTIAL, or a non-critical control FAILed/ERRORed/lacks evidence.
 */
export function computeOutcome(scored: readonly ScoredControlResult[]): AssessmentOutcome {
  const applicable = scored.filter(s => s.result.status !== 'NOT_APPLICABLE');
  if (applicable.length === 0) return 'ERROR';
  if (applicable.some(s => s.criticality === 'CRITICAL' && s.result.status === 'FAIL')) return 'FAIL';
  if (applicable.some(s => s.criticality === 'CRITICAL' && (s.result.status === 'INSUFFICIENT_EVIDENCE' || s.result.status === 'ERROR'))) return 'INSUFFICIENT_EVIDENCE';
  if (applicable.every(s => s.result.status === 'PASS')) return 'PASS';
  return 'PASS_WITH_FINDINGS';
}

/** Section 98: deterministic finding prioritization — severity desc, then control criticality
 * desc, then evidence confidence (PASS-adjacent statuses sort lower risk than FAIL/ERROR) desc,
 * then finding_id for a stable final tiebreak. Exposed here since it is a pure function of the same
 * severity/criticality vocabulary as the rest of the risk model. */
const STATUS_PRIORITY: Readonly<Record<ControlResultStatus, number>> = { ERROR: 5, FAIL: 4, INSUFFICIENT_EVIDENCE: 3, PARTIAL: 2, NOT_APPLICABLE: 1, PASS: 0 };
export function compareFindingPriority(a: { severity: Severity; control_status: ControlResultStatus; finding_id: string }, b: { severity: Severity; control_status: ControlResultStatus; finding_id: string }): number {
  const severityDiff = SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity];
  if (severityDiff !== 0) return severityDiff;
  const statusDiff = STATUS_PRIORITY[b.control_status] - STATUS_PRIORITY[a.control_status];
  if (statusDiff !== 0) return statusDiff;
  return a.finding_id < b.finding_id ? -1 : a.finding_id > b.finding_id ? 1 : 0;
}
