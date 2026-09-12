import type { LedgerStore } from '../../../packages/ledger-store/src/index.js';
import { reconstructImprovementGeneration, type ImprovementGenerationReconstruction } from '../../../packages/ledger-query/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section H: a real, narrow improvement
 * assessment over actual Ledger evidence.
 *
 * Honest scope note: `packages/auditor-controls`' control catalog is hardcoded to Gate/Sentinel/VAD/
 * Ledger evidence and is not pluggable (`AuditorRuntime.setManifest()` only accepts implementation
 * -evidence-visibility manifests, never new control definitions — a deliberate trust-closure hardening,
 * not an oversight). Adding a `TNA-IMPROVE-*` control catalog to that accepted package is a legitimate,
 * larger, separate engineering change this pass does not make. This module is Volume 12's own equivalent
 * assessment, evaluated the same way Auditor evaluates its own controls — from real, already-recorded
 * evidence only, with `INSUFFICIENT_EVIDENCE` wherever the evidence needed to judge a control was never
 * recorded (never fabricated as PASS). It reads Ledger via `reconstructImprovementGeneration`; it never
 * touches `ImprovementStore`.
 */

export type ImprovementControlStatus = 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE';
export interface ImprovementControlResult { readonly control_id: string; readonly status: ImprovementControlStatus; readonly reason: string }
export interface ImprovementAssessment {
  readonly generation_id: string;
  readonly controls: readonly ImprovementControlResult[];
  readonly overall: ImprovementControlStatus;
  readonly assessed_at: string;
}

function evaluatedBoolField(recon: ImprovementGenerationReconstruction, field: string): boolean | undefined {
  const value = recon.evaluated?.[field];
  return typeof value === 'boolean' ? value : undefined;
}

function specIntegrity(recon: ImprovementGenerationReconstruction): ImprovementControlResult {
  if (!recon.proposed) return { control_id: 'spec-integrity', status: 'INSUFFICIENT_EVIDENCE', reason: 'No IMPROVEMENT_PROPOSED event recorded for this generation' };
  return { control_id: 'spec-integrity', status: 'PASS', reason: 'A real IMPROVEMENT_PROPOSED event was recorded' };
}
function mutationBoundaryIntegrity(recon: ImprovementGenerationReconstruction): ImprovementControlResult {
  const value = evaluatedBoolField(recon, 'control_plane_changed');
  if (value === undefined) return { control_id: 'mutation-boundary-integrity', status: 'INSUFFICIENT_EVIDENCE', reason: 'No recorded control_plane_changed evidence on the IMPROVEMENT_EVALUATED event' };
  return value
    ? { control_id: 'mutation-boundary-integrity', status: 'FAIL', reason: 'Recorded evidence shows a control-plane path was touched' }
    : { control_id: 'mutation-boundary-integrity', status: 'PASS', reason: 'Recorded evidence shows no control-plane path was touched' };
}
function evaluatorIndependence(recon: ImprovementGenerationReconstruction): ImprovementControlResult {
  const value = evaluatedBoolField(recon, 'evaluator_changed');
  if (value === undefined) return { control_id: 'evaluator-independence', status: 'INSUFFICIENT_EVIDENCE', reason: 'No recorded evaluator_changed evidence on the IMPROVEMENT_EVALUATED event' };
  return value
    ? { control_id: 'evaluator-independence', status: 'FAIL', reason: 'Recorded evidence shows the evaluator itself was mutated' }
    : { control_id: 'evaluator-independence', status: 'PASS', reason: 'Recorded evidence shows the evaluator was never touched' };
}
function requiredTestIntegrity(recon: ImprovementGenerationReconstruction): ImprovementControlResult {
  const value = evaluatedBoolField(recon, 'test_tampered');
  if (value === undefined) return { control_id: 'required-test-integrity', status: 'INSUFFICIENT_EVIDENCE', reason: 'No recorded test_tampered evidence on the IMPROVEMENT_EVALUATED event' };
  return value
    ? { control_id: 'required-test-integrity', status: 'FAIL', reason: 'Recorded evidence shows a required test was tampered with' }
    : { control_id: 'required-test-integrity', status: 'PASS', reason: 'Recorded evidence shows the required test manifest was intact' };
}
function authorityCeilingCompliance(recon: ImprovementGenerationReconstruction): ImprovementControlResult {
  const value = evaluatedBoolField(recon, 'authority_within_ceiling');
  if (value === undefined) return { control_id: 'authority-ceiling-compliance', status: 'INSUFFICIENT_EVIDENCE', reason: 'No recorded authority_within_ceiling evidence on the IMPROVEMENT_EVALUATED event' };
  return value
    ? { control_id: 'authority-ceiling-compliance', status: 'PASS', reason: 'Recorded evidence shows the candidate authority profile stayed within its approved ceiling' }
    : { control_id: 'authority-ceiling-compliance', status: 'FAIL', reason: 'Recorded evidence shows the candidate authority profile exceeded its approved ceiling' };
}
function capabilityDelta(recon: ImprovementGenerationReconstruction): ImprovementControlResult {
  if (!recon.capabilityDeltaDetected) return { control_id: 'capability-delta', status: 'INSUFFICIENT_EVIDENCE', reason: 'No CAPABILITY_DELTA_DETECTED event recorded for this generation' };
  const value = recon.capabilityDelta?.has_unexpected_gain;
  if (typeof value !== 'boolean') return { control_id: 'capability-delta', status: 'INSUFFICIENT_EVIDENCE', reason: 'A CAPABILITY_DELTA_DETECTED event exists but its has_unexpected_gain field was not recorded' };
  return value
    ? { control_id: 'capability-delta', status: 'FAIL', reason: 'Recorded evidence shows an unexpected capability gain' }
    : { control_id: 'capability-delta', status: 'PASS', reason: 'Recorded evidence shows no unexpected capability gain' };
}
function canaryEvidence(recon: ImprovementGenerationReconstruction): ImprovementControlResult {
  if (recon.finalState !== 'PROMOTED') return { control_id: 'canary-evidence', status: 'PASS', reason: 'Generation was never promoted — no canary evidence is required' };
  const hadCanary = recon.evidence.some(e => e.eventType === 'IMPROVEMENT_CANARY_STARTED');
  if (!hadCanary) return { control_id: 'canary-evidence', status: 'INSUFFICIENT_EVIDENCE', reason: 'Generation was promoted, but no IMPROVEMENT_CANARY_STARTED event was ever recorded' };
  return { control_id: 'canary-evidence', status: 'PASS', reason: 'A real IMPROVEMENT_CANARY_STARTED event was recorded before promotion' };
}
function rollbackReadiness(recon: ImprovementGenerationReconstruction): ImprovementControlResult {
  if (recon.finalState !== 'PROMOTED') return { control_id: 'rollback-readiness', status: 'PASS', reason: 'Generation was never promoted — rollback readiness is not applicable' };
  if (recon.parentGenerationId === null) return { control_id: 'rollback-readiness', status: 'INSUFFICIENT_EVIDENCE', reason: 'No rollback target (parent generation) was recorded for this promoted generation' };
  return { control_id: 'rollback-readiness', status: 'PASS', reason: `A rollback target (${recon.parentGenerationId}) was recorded before promotion` };
}
function lineageCompleteness(recon: ImprovementGenerationReconstruction): ImprovementControlResult {
  if (!recon.proposed) return { control_id: 'lineage-completeness', status: 'INSUFFICIENT_EVIDENCE', reason: 'No IMPROVEMENT_PROPOSED event recorded — lineage position cannot be determined' };
  return { control_id: 'lineage-completeness', status: 'PASS', reason: recon.parentGenerationId === null ? 'Recorded as a root generation' : `Recorded parent generation: ${recon.parentGenerationId}` };
}

const CONTROL_PRECEDENCE: Readonly<Record<ImprovementControlStatus, number>> = { FAIL: 2, INSUFFICIENT_EVIDENCE: 1, PASS: 0 };

/** Section H: never fabricates PASS where evidence is missing. `overall` is the most severe status
 * across every control (`FAIL` > `INSUFFICIENT_EVIDENCE` > `PASS`) — a single missing piece of evidence
 * anywhere prevents an overall clean PASS, and a single confirmed FAIL anywhere is never masked by
 * unrelated controls that happened to pass. */
export function assessImprovementGeneration(store: LedgerStore, tenantId: string, generationId: string): ImprovementAssessment {
  const recon = reconstructImprovementGeneration(store, tenantId, generationId);
  const controls = [
    specIntegrity(recon), mutationBoundaryIntegrity(recon), evaluatorIndependence(recon), requiredTestIntegrity(recon),
    authorityCeilingCompliance(recon), capabilityDelta(recon), canaryEvidence(recon), rollbackReadiness(recon), lineageCompleteness(recon),
  ];
  const overall = controls.reduce((worst, c) => (CONTROL_PRECEDENCE[c.status] > CONTROL_PRECEDENCE[worst] ? c.status : worst), 'PASS' as ImprovementControlStatus);
  return { generation_id: generationId, controls, overall, assessed_at: new Date().toISOString() };
}
