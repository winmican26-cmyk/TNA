import type { LedgerEventInput } from '../../../packages/ledger-schema/src/index.js';
import type { AssessmentRecord, RunRecord, AuditFinding } from '../../../packages/auditor-engine/src/index.js';

/**
 * Maps Auditor runtime activity into Ledger event inputs (sections 115-118). Pure translation layer
 * — never calls into AuditorRuntime and never alters Ledger's own validation or hash-chain behavior.
 * Uses the `auditor` source component and the five `AUDIT_*` event types added to ledger-schema for
 * this milestone. Auditor never rewrites prior Ledger evidence (section 115) — this adapter only
 * ever appends its own lifecycle events on its own stream.
 *
 * Stream partitioning: one stream per assessment (`auditor:<assessmentId>`), so one assessment's
 * full lifecycle — who ran it, against what scope, with what outcome — is independently
 * reconstructible later, without trusting the Auditor process's own local database alone.
 *
 * Deliberately does not emit one event per control evaluation (~27 events per run): that volume is
 * out of proportion to what this evidence is for. Findings — the non-PASS/NOT_APPLICABLE results —
 * are individually evidenced; a full per-control trail remains queryable from AuditorRuntime itself
 * and from the exported audit package.
 */
export class AuditorLedgerAdapter {
  public constructor(private readonly tenantId: string) {}
  private streamOf(assessmentId: string): string { return `auditor:${assessmentId}`; }

  public assessmentCreated(assessment: AssessmentRecord): LedgerEventInput {
    return {
      version: '1.0', event_id: `${this.streamOf(assessment.assessment_id)}.AUDIT_ASSESSMENT_CREATED`, event_type: 'AUDIT_ASSESSMENT_CREATED',
      tenant_id: this.tenantId, stream_id: this.streamOf(assessment.assessment_id), correlation_id: assessment.assessment_id,
      actor: { type: 'SYSTEM', id: 'auditor' }, source_component: 'auditor',
      payload: { name: assessment.name, control_profile_id: assessment.control_profile_id, evidence_cutoff_at: assessment.evidence_cutoff_at, created_by: assessment.created_by, spec_hash: assessment.spec_hash },
    };
  }

  public assessmentStarted(assessment: AssessmentRecord, run: RunRecord): LedgerEventInput {
    return {
      version: '1.0', event_id: `${this.streamOf(assessment.assessment_id)}.AUDIT_ASSESSMENT_STARTED.${run.run_number}`, event_type: 'AUDIT_ASSESSMENT_STARTED',
      tenant_id: this.tenantId, stream_id: this.streamOf(assessment.assessment_id), correlation_id: assessment.assessment_id,
      actor: { type: 'SYSTEM', id: 'auditor' }, source_component: 'auditor',
      payload: { run_number: run.run_number, control_catalog_version: run.control_catalog_version, is_replay: run.is_replay },
    };
  }

  public findingCreated(assessment: AssessmentRecord, run: RunRecord, finding: AuditFinding): LedgerEventInput {
    return {
      version: '1.0', event_id: `${this.streamOf(assessment.assessment_id)}.AUDIT_FINDING_CREATED.${finding.finding_id}`, event_type: 'AUDIT_FINDING_CREATED',
      tenant_id: this.tenantId, stream_id: this.streamOf(assessment.assessment_id), correlation_id: assessment.assessment_id,
      actor: { type: 'SYSTEM', id: 'auditor' }, source_component: 'auditor',
      payload: { run_number: run.run_number, control_id: finding.control_id, severity: finding.severity, reason_codes: finding.reason_codes },
    };
  }

  public assessmentCompleted(assessment: AssessmentRecord, run: RunRecord): LedgerEventInput {
    return {
      version: '1.0', event_id: `${this.streamOf(assessment.assessment_id)}.AUDIT_ASSESSMENT_COMPLETED.${run.run_number}`, event_type: 'AUDIT_ASSESSMENT_COMPLETED',
      tenant_id: this.tenantId, stream_id: this.streamOf(assessment.assessment_id), correlation_id: assessment.assessment_id,
      actor: { type: 'SYSTEM', id: 'auditor' }, source_component: 'auditor',
      payload: { run_number: run.run_number, outcome: run.outcome, assessment_hash: run.assessment_hash, risk_summary: run.risk_summary },
    };
  }

  public assessmentFailed(assessment: AssessmentRecord, run: RunRecord): LedgerEventInput {
    return {
      version: '1.0', event_id: `${this.streamOf(assessment.assessment_id)}.AUDIT_ASSESSMENT_FAILED.${run.run_number}`, event_type: 'AUDIT_ASSESSMENT_FAILED',
      tenant_id: this.tenantId, stream_id: this.streamOf(assessment.assessment_id), correlation_id: assessment.assessment_id,
      actor: { type: 'SYSTEM', id: 'auditor' }, source_component: 'auditor',
      payload: { run_number: run.run_number, status: run.status },
    };
  }
}
