import { AuditorError, MAX_EXPORT_BYTES, MAX_REPORT_BYTES, canonical, type ManifestTrustClass } from '../../auditor-schema/src/index.js';
import {
  AuditorRuntime, computeAssessmentHash, type AuditorPrincipal, type AssessmentRecord, type RunRecord,
  type ControlResult, type AuditFinding, type RiskSummary, type EvidenceRef,
} from '../../auditor-engine/src/index.js';
import { eventRef } from '../../auditor-evidence/src/index.js';

// ---------------------------------------------------------------------------------------------
// Sections 130-132: mandatory, static limitation boilerplate. Every package and report carries it
// verbatim — never generated, never summarized away.
// ---------------------------------------------------------------------------------------------

export const AUDITOR_LIMITATIONS: readonly string[] = [
  'TNA Auditor evaluates configured controls against available evidence. It does not certify legal, regulatory, contractual, or industry compliance (no ISO 27001, SOC 2, NIST, EU AI Act, DORA, HIPAA, GDPR, NIS2, or PCI DSS status is claimed or implied by any result in this package).',
  'Auditor conclusions cannot be stronger than the integrity, completeness, freshness, and trustworthiness of the evidence supplied. A PASS reflects what the available evidence supports, not an independent guarantee beyond it.',
  'If client infrastructure is not instrumented through TNA Ledger or another trusted evidence provider, the corresponding controls return INSUFFICIENT_EVIDENCE, not fabricated assurance.',
];

export interface AuditPackage {
  readonly manifest: { readonly package_version: '1.0'; readonly generated_at: string };
  readonly assessment: AssessmentRecord;
  readonly run: RunRecord;
  readonly evidence_manifest: readonly EvidenceRef[];
  readonly control_results: readonly ControlResult[];
  readonly findings: readonly AuditFinding[];
  readonly risk_summary: RiskSummary;
  readonly limitations: readonly string[];
  readonly assessment_hash: string;
  /** Trust-closure pass, section 15: exposes the trust classification of the implementation-
   * evidence manifest this run's evaluation actually consulted, so a reviewer can see it directly
   * without cross-referencing anything else. No claim content is duplicated here beyond what
   * individual `IMPLEMENTATION_MANIFEST`-typed evidence refs on manifest-backed control results
   * already carry (`manifest_trust_class`) — this is a package-level summary of the same fact. */
  readonly manifest_trust_summary: { readonly manifest_id: string; readonly manifest_hash: string; readonly trust_class: ManifestTrustClass };
}

function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

/** Section 43: assembles the portable JSON package for one (assessment, run). Reads only through
 * the runtime's own principal-gated accessors — never touches storage directly — so package
 * export carries exactly the same tenant-isolation and access-control guarantees as any other read. */
export function buildAuditPackage(runtime: AuditorRuntime, principal: AuditorPrincipal, assessmentId: string, runNumber?: number): AuditPackage {
  const assessment = runtime.getAssessment(principal, assessmentId);
  const run = runtime.getRun(principal, assessmentId, runNumber ?? assessment.latest_run_number);
  if (run.status !== 'COMPLETED') throw new AuditorError('INVALID_TRANSITION', `Run ${run.run_number} is not COMPLETED (status: ${run.status}) — only a finalized run can be exported`);
  if (run.risk_summary === null || run.assessment_hash === null) throw new AuditorError('INVALID_TRANSITION', `Run ${run.run_number} is missing its finalized risk summary or assessment hash`);

  const controlResults: ControlResult[] = [];
  let cursor: string | undefined;
  for (;;) { const page = runtime.listControlResults(principal, assessmentId, run.run_number, 200, cursor); controlResults.push(...page.items); if (!page.nextCursor) break; cursor = page.nextCursor; }
  const findings: AuditFinding[] = [];
  cursor = undefined;
  for (;;) { const page = runtime.listFindings(principal, assessmentId, run.run_number, 200, cursor); findings.push(...page.items); if (!page.nextCursor) break; cursor = page.nextCursor; }

  const bundle = runtime.getEvidenceBundle(principal, assessmentId, run.run_number);
  // Reuses the same eventRef() the control evaluators used, so integrity_qualification is stamped
  // identically here as in each control result's own evidence_refs (trust-closure pass section 15).
  const evidenceManifest: EvidenceRef[] = bundle.events.map(e => eventRef(e, bundle));
  const builtInManifest = runtime.getBuiltInManifest(principal);

  const pkg: AuditPackage = {
    manifest: { package_version: '1.0', generated_at: new Date().toISOString() },
    assessment, run, evidence_manifest: evidenceManifest, control_results: controlResults, findings,
    risk_summary: run.risk_summary, limitations: AUDITOR_LIMITATIONS, assessment_hash: run.assessment_hash,
    manifest_trust_summary: { manifest_id: builtInManifest.manifest_id, manifest_hash: builtInManifest.manifest_hash, trust_class: builtInManifest.trust_class },
  };
  const size = byteLength(pkg);
  if (size > MAX_EXPORT_BYTES) throw new AuditorError('PAYLOAD_TOO_LARGE', `Audit package (${size} bytes) exceeds the ${MAX_EXPORT_BYTES}-byte export limit`);
  return pkg;
}

export interface PackageVerificationResult { readonly valid: boolean; readonly reason?: string }

/**
 * Section 44-45: independent, self-contained verification — needs no store access, no principal,
 * nothing but the package bytes themselves. Recomputes `assessment_hash` from the package's own
 * declared content and rejects on any mismatch (the tamper test: flip one control_result's status
 * from FAIL to PASS after export, and this must fail).
 */
export function verifyAuditPackage(pkg: unknown): PackageVerificationResult {
  if (!isPlainAuditPackage(pkg)) return { valid: false, reason: 'SCHEMA_INVALID' };
  const recomputed = computeAssessmentHash(
    pkg.assessment.spec_hash, pkg.assessment.control_profile_id, pkg.run.control_catalog_version, pkg.assessment.evidence_cutoff_at,
    pkg.evidence_manifest, pkg.control_results, pkg.risk_summary, pkg.manifest_trust_summary.trust_class,
  );
  if (recomputed !== pkg.assessment_hash) return { valid: false, reason: 'ASSESSMENT_HASH_MISMATCH' };
  const resultControlIds = new Set(pkg.control_results.map(r => r.control_id));
  for (const finding of pkg.findings) if (!resultControlIds.has(finding.control_id)) return { valid: false, reason: 'FINDING_REFERENCES_UNKNOWN_CONTROL' };
  const manifestEventIds = new Set(pkg.evidence_manifest.map(r => r.event_id).filter((v): v is string => v !== undefined));
  for (const result of pkg.control_results) {
    for (const ref of result.evidence_refs) {
      if (ref.source_type === 'LEDGER_EVENT' && ref.event_id !== undefined && !manifestEventIds.has(ref.event_id)) return { valid: false, reason: 'EVIDENCE_REF_NOT_IN_MANIFEST' };
    }
  }
  return { valid: true };
}

function isPlainAuditPackage(value: unknown): value is AuditPackage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.assessment_hash !== 'string' || !Array.isArray(v.control_results) || !Array.isArray(v.findings)) return false;
  if (!Array.isArray(v.evidence_manifest) || typeof v.risk_summary !== 'object' || v.risk_summary === null) return false;
  if (typeof v.assessment !== 'object' || v.assessment === null || typeof v.run !== 'object' || v.run === null) return false;
  const trustSummary = v.manifest_trust_summary;
  if (typeof trustSummary !== 'object' || trustSummary === null || typeof (trustSummary as Record<string, unknown>).trust_class !== 'string') return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Markdown report (sections 95-97). Deterministic, template-based — no LLM prose.
// ---------------------------------------------------------------------------------------------

function pct(n: number): string { return `${n}%`; }

export function buildMarkdownReport(pkg: AuditPackage): string {
  const { assessment, run, risk_summary: risk, control_results: results, findings } = pkg;
  const failed = results.filter(r => r.status === 'FAIL');
  const partial = results.filter(r => r.status === 'PARTIAL');
  const insufficient = results.filter(r => r.status === 'INSUFFICIENT_EVIDENCE');
  const errored = results.filter(r => r.status === 'ERROR');
  const criticalFailures = failed.filter(r => r.risk_contribution >= 100).length;
  const highFindings = findings.filter(f => f.severity === 'HIGH').length;

  const lines: string[] = [];
  lines.push('# TNA Audit Report', '');
  lines.push(`Assessment: ${assessment.name} (${assessment.assessment_id})`);
  lines.push(`Tenant: ${assessment.tenant_id}`);
  lines.push(`Control profile: ${assessment.control_profile_id}`);
  lines.push(`Run: ${run.run_number}${run.is_replay ? ` (replay of run ${String(run.replay_of_run_number)})` : ''}`);
  lines.push(`Evidence cutoff: ${assessment.evidence_cutoff_at}`);
  lines.push(`Control catalog version: ${run.control_catalog_version}${run.catalog_version_mismatch ? ' (MISMATCH vs. current catalog)' : ''}`, '');

  lines.push('## Executive Summary', '');
  lines.push(`Assessment outcome: ${String(run.outcome)}`);
  lines.push(`Overall risk: ${risk.overall_risk_level} (score ${risk.overall_risk_score}/100)${risk.critical_floor_applied ? ' — critical-failure floor applied' : ''}`);
  lines.push(`Critical failures: ${criticalFailures}`);
  lines.push(`High findings: ${highFindings}`);
  lines.push(`Controls passed: ${risk.counts.pass}/${risk.applicable_count}`);
  lines.push(`Controls with insufficient evidence: ${risk.counts.insufficient_evidence}`);
  lines.push(`Coverage: ${pct(risk.coverage_percentage)}`, '');

  lines.push('## Control Summary', '');
  lines.push('| Status | Count |', '|---|---|');
  lines.push(`| PASS | ${risk.counts.pass} |`, `| PARTIAL | ${risk.counts.partial} |`, `| FAIL | ${risk.counts.fail} |`, `| INSUFFICIENT_EVIDENCE | ${risk.counts.insufficient_evidence} |`, `| NOT_APPLICABLE | ${risk.counts.not_applicable} |`, `| ERROR | ${risk.counts.error} |`, '');

  if (failed.length > 0) { lines.push('## Failed Controls', ''); for (const r of failed) lines.push(`- **${r.control_id}** — ${r.observations.join(' ') || '(no observations recorded)'}`); lines.push(''); }
  if (partial.length > 0) { lines.push('## Partial Controls', ''); for (const r of partial) lines.push(`- **${r.control_id}** — ${r.observations.join(' ') || '(no observations recorded)'}`); lines.push(''); }
  if (insufficient.length > 0) { lines.push('## Controls Not Evaluated (Insufficient Evidence)', ''); for (const r of insufficient) lines.push(`- **${r.control_id}** — ${r.limitations.join(' ') || r.observations.join(' ') || '(no evidence available in scope)'}`); lines.push(''); }
  if (errored.length > 0) { lines.push('## Evaluator Errors', ''); for (const r of errored) lines.push(`- **${r.control_id}** — ${r.limitations.join(' ')}`); lines.push(''); }

  lines.push('## Findings', '');
  if (findings.length === 0) lines.push('No findings.', '');
  else { for (const f of findings) lines.push(`- [${f.severity}] **${f.control_id}** — ${f.title}`); lines.push(''); }

  lines.push('## Limitations', '');
  for (const l of pkg.limitations) lines.push(`- ${l}`);
  lines.push('');

  lines.push('## Replay Metadata', '');
  lines.push(`- Evaluator version: ${run.evaluator_version}`);
  lines.push(`- Is replay: ${String(run.is_replay)}`);
  lines.push(`- Assessment hash: \`${pkg.assessment_hash}\``, '');

  const report = lines.join('\n');
  const size = Buffer.byteLength(report, 'utf8');
  if (size > MAX_REPORT_BYTES) throw new AuditorError('PAYLOAD_TOO_LARGE', `Markdown report (${size} bytes) exceeds the ${MAX_REPORT_BYTES}-byte limit`);
  return report;
}

export { canonical };
