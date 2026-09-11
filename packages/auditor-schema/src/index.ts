import { createHash } from 'node:crypto';

export const AUDITOR_ASSESSMENT_VERSION = '1.0' as const;

export const MAX_CONTROLS_PER_ASSESSMENT = 100;
export const MAX_EVIDENCE_REFS_PER_CONTROL = 200;
export const MAX_FINDINGS_PER_RESPONSE = 200;
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
export const MAX_REPORT_BYTES = 8 * 1024 * 1024;
export const MAX_QUERY_PAGE_SIZE = 200;
export const DEFAULT_QUERY_PAGE_SIZE = 50;
export const MAX_OBSERVATIONS_PER_RESULT = 50;
export const MAX_LIMITATIONS_PER_RESULT = 50;
export const MAX_REASON_CODES_PER_RESULT = 20;
export const MAX_SCOPE_LIST_ENTRIES = 200;
export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;

export class AuditorError extends Error {
  public constructor(public readonly code:
    'INVALID_INPUT' | 'UNSUPPORTED_VERSION' | 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_TRANSITION'
    | 'ASSESSMENT_TERMINAL' | 'CATALOG_VERSION_MISMATCH' | 'SCOPE_INVALID' | 'PAYLOAD_TOO_LARGE'
    | 'UNKNOWN_CONTROL' | 'UNKNOWN_PROFILE' | 'MANIFEST_INVALID' | 'EVIDENCE_UNAVAILABLE' | 'CONFLICT',
  message: string) {
    super(message);
    this.name = 'AuditorError';
  }
}

// ---------------------------------------------------------------------------------------------
// Controlled vocabularies
// ---------------------------------------------------------------------------------------------

/** Section 8: fixed category vocabulary — no arbitrary category strings. */
export const CONTROL_CATEGORIES = [
  'IDENTITY', 'AUTHORITY', 'APPROVAL', 'CAPABILITY', 'EXECUTION', 'ISOLATION', 'SECRETS', 'EGRESS',
  'VERIFICATION', 'EVIDENCE', 'INTEGRITY', 'RUNTIME_DEFENSE', 'REVOCATION', 'CONTAINMENT',
  'TENANT_ISOLATION', 'HUMAN_OVERSIGHT', 'RECOVERY',
] as const;
export type ControlCategory = typeof CONTROL_CATEGORIES[number];
const CONTROL_CATEGORY_SET = new Set<string>(CONTROL_CATEGORIES);
export function isControlCategory(value: unknown): value is ControlCategory { return typeof value === 'string' && CONTROL_CATEGORY_SET.has(value); }

/** Severity, shared numeric scale with the accepted Sentinel milestone (section 31). */
export const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = typeof SEVERITIES[number];
const SEVERITY_SET = new Set<string>(SEVERITIES);
export function isSeverity(value: unknown): value is Severity { return typeof value === 'string' && SEVERITY_SET.has(value); }
export const SEVERITY_SCORE: Readonly<Record<Severity, number>> = { INFO: 0, LOW: 10, MEDIUM: 30, HIGH: 60, CRITICAL: 100 };

/** Section 9: every evaluated control returns exactly one of these — never collapsed into each other. */
export const CONTROL_RESULT_STATUSES = ['PASS', 'PARTIAL', 'FAIL', 'NOT_APPLICABLE', 'INSUFFICIENT_EVIDENCE', 'ERROR'] as const;
export type ControlResultStatus = typeof CONTROL_RESULT_STATUSES[number];
const CONTROL_RESULT_STATUS_SET = new Set<string>(CONTROL_RESULT_STATUSES);
export function isControlResultStatus(value: unknown): value is ControlResultStatus { return typeof value === 'string' && CONTROL_RESULT_STATUS_SET.has(value); }

/** Section 11: controlled reason codes — never depend only on prose. */
export const REASON_CODES = [
  'CONTROL_SATISFIED', 'PARTIAL_EVIDENCE', 'MISSING_REQUIRED_EVIDENCE', 'EVIDENCE_INTEGRITY_INVALID',
  'EVIDENCE_STALE', 'EVIDENCE_CONFLICT', 'AUTHORITY_SCOPE_TOO_BROAD', 'REVOCATION_NOT_ENFORCED',
  'NO_RUNTIME_MONITORING', 'NO_INDEPENDENT_VERIFICATION', 'TENANT_ISOLATION_NOT_PROVEN',
  'CONTAINMENT_UNCONFIRMED', 'CONTAINMENT_NOT_TRUTHFUL', 'SECRET_EXPOSURE_RISK', 'SCOPE_NOT_APPLICABLE',
  'IMPLEMENTATION_MANIFEST_SATISFIED', 'IMPLEMENTATION_MANIFEST_MISSING', 'DEPENDENCY_NOT_SATISFIED',
  'SELF_REPORT_NOT_TRUSTED', 'EVALUATOR_ERROR', 'NEGATIVE_EVIDENCE_SATISFIED',
  // Trust-closure pass: distinguishes "confirmed corrupt" from "never confirmed either way" — both
  // disqualify evidence from supporting PASS, but they are not the same claim (section 2).
  'EVIDENCE_INTEGRITY_UNVERIFIED', 'MANIFEST_NOT_AUTHENTIC',
] as const;
export type ReasonCode = typeof REASON_CODES[number];
const REASON_CODE_SET = new Set<string>(REASON_CODES);
export function isReasonCode(value: unknown): value is ReasonCode { return typeof value === 'string' && REASON_CODE_SET.has(value); }

/** Section 14: evidence source trust classification. A self-report never satisfies a control that
 * requires system-generated evidence — evaluators must check this before crediting evidence. */
export const EVIDENCE_SOURCE_TRUST_LEVELS = [
  'TRUSTED_SYSTEM', 'VERIFIED_LEDGER', 'SIGNED_EXPORT', 'CONFIGURATION_SNAPSHOT', 'OPERATOR_ASSERTION', 'UNTRUSTED_SELF_REPORT',
] as const;
export type EvidenceSourceTrust = typeof EVIDENCE_SOURCE_TRUST_LEVELS[number];
const EVIDENCE_SOURCE_TRUST_SET = new Set<string>(EVIDENCE_SOURCE_TRUST_LEVELS);
export function isEvidenceSourceTrust(value: unknown): value is EvidenceSourceTrust { return typeof value === 'string' && EVIDENCE_SOURCE_TRUST_SET.has(value); }

export const EVIDENCE_SOURCE_TYPES = ['LEDGER_EVENT', 'LEDGER_STREAM_INTEGRITY', 'CONFIGURATION_SNAPSHOT', 'IMPLEMENTATION_MANIFEST'] as const;
export type EvidenceSourceType = typeof EVIDENCE_SOURCE_TYPES[number];

/**
 * Trust-closure pass (see docs/auditor/auditor-v0.1-trust-closure.md): the qualification of one
 * piece of Ledger-derived evidence, determined centrally at evidence-collection time — never left to
 * an individual control evaluator to check (or forget to check).
 * - `VALID` — the originating stream's hash chain independently re-verified.
 * - `INVALID` — the originating stream's hash chain failed re-verification (confirmed corruption).
 * - `UNVERIFIED` — no integrity check was ever performed for the originating stream.
 * - `UNAVAILABLE` — an integrity check was attempted but could not be completed (e.g. the check
 *   itself errored) — distinct from `INVALID`: this is "we don't know," not "we know it's bad."
 * Evidence that is not `VALID` can never, by itself, support an unqualified PASS/PARTIAL result
 * (TNA-41: evidence integrity is transitive to the conclusion).
 */
export const EVIDENCE_QUALIFICATIONS = ['VALID', 'INVALID', 'UNVERIFIED', 'UNAVAILABLE'] as const;
export type EvidenceQualification = typeof EVIDENCE_QUALIFICATIONS[number];
const EVIDENCE_QUALIFICATION_SET = new Set<string>(EVIDENCE_QUALIFICATIONS);
export function isEvidenceQualification(value: unknown): value is EvidenceQualification { return typeof value === 'string' && EVIDENCE_QUALIFICATION_SET.has(value); }

/**
 * Trust-closure pass: the *provenance* classification of an implementation-evidence manifest —
 * deliberately separate from `manifest_hash` (content integrity). A hash proves a manifest was not
 * corrupted after it was built; it proves nothing about whether its claims are authentic
 * (TNA-42: integrity does not imply authenticity). Only `BUILT_IN_ACCEPTED_BASELINE` — produced
 * exclusively by trusted, compiled code from the pinned accepted tag/commit anchors, never from
 * caller input — automatically satisfies an implementation-level control claim in v0.1. An
 * `ADMIN_PROVIDED` manifest may be installed and stored, but does not automatically become
 * equivalent to accepted-baseline evidence, no matter how internally hash-consistent it is
 * (section 11). `VERIFIED_EXTERNAL` and `UNTRUSTED` are reserved for future work (see
 * `auditor-evidence-model-v0.1.md`) — nothing in v0.1 produces them.
 */
export const MANIFEST_TRUST_CLASSES = ['BUILT_IN_ACCEPTED_BASELINE', 'ADMIN_PROVIDED', 'VERIFIED_EXTERNAL', 'UNTRUSTED'] as const;
export type ManifestTrustClass = typeof MANIFEST_TRUST_CLASSES[number];
const MANIFEST_TRUST_CLASS_SET = new Set<string>(MANIFEST_TRUST_CLASSES);
export function isManifestTrustClass(value: unknown): value is ManifestTrustClass { return typeof value === 'string' && MANIFEST_TRUST_CLASS_SET.has(value); }

/** Section 30. v0.1 only ever creates OPEN — the enum exists so the field is future-proof, not so a
 * full finding-management workflow ships now. */
export const FINDING_STATUSES = ['OPEN', 'ACCEPTED_RISK', 'REMEDIATED', 'FALSE_POSITIVE', 'NOT_APPLICABLE'] as const;
export type FindingStatus = typeof FINDING_STATUSES[number];

/** Section 57: assessment lifecycle. */
export const ASSESSMENT_STATUSES = ['CREATED', 'COLLECTING_EVIDENCE', 'EVALUATING', 'COMPLETED', 'FAILED', 'INDETERMINATE'] as const;
export type AssessmentStatus = typeof ASSESSMENT_STATUSES[number];
const TERMINAL_ASSESSMENT_STATUSES: ReadonlySet<AssessmentStatus> = new Set(['COMPLETED', 'FAILED', 'INDETERMINATE']);
export function isTerminalAssessmentStatus(status: AssessmentStatus): boolean { return TERMINAL_ASSESSMENT_STATUSES.has(status); }

/** Section 38: overall business outcome, meaningful only once an assessment reaches COMPLETED. */
export const ASSESSMENT_OUTCOMES = ['PASS', 'PASS_WITH_FINDINGS', 'FAIL', 'INSUFFICIENT_EVIDENCE', 'ERROR'] as const;
export type AssessmentOutcome = typeof ASSESSMENT_OUTCOMES[number];

export const CONTROL_PROFILE_IDS = ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'] as const;
export type ControlProfileId = typeof CONTROL_PROFILE_IDS[number];
const CONTROL_PROFILE_ID_SET = new Set<string>(CONTROL_PROFILE_IDS);
export function isControlProfileId(value: unknown): value is ControlProfileId { return typeof value === 'string' && CONTROL_PROFILE_ID_SET.has(value); }

// ---------------------------------------------------------------------------------------------
// Shared validation / canonicalization primitives (same algorithm as the accepted Ledger's and
// Sentinel's, duplicated locally per this project's established convention).
// ---------------------------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function safeId(value: unknown, maxLen = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
export function isHex64(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
function assertStringArray(value: unknown, max: number, check: (v: unknown) => boolean): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(check);
}

/** Deterministic canonical serialization: key order never affects the result. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|secret|password|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|authorization)/i;
const SECRET_VALUE_PATTERN = /Bearer\s+\S+/i;
/** Section 47: raw secrets must never enter an audit package. Same fixed rule set as the accepted
 * Ledger/Sentinel detectors — not general DLP. */
export function findSecretShapedField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) return 'value matches a bearer-token pattern';
  if (Array.isArray(value)) { for (const entry of value) { const found = findSecretShapedField(entry); if (found) return found; } return null; }
  if (typeof value === 'object') {
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) return `field name "${key}" is a disallowed secret-shaped field`;
      const found = findSecretShapedField(entryValue);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Evidence reference (section 46)
// ---------------------------------------------------------------------------------------------

/** Enough to identify one piece of evidence immutably, regardless of its source type. */
export interface EvidenceRef {
  readonly source_type: EvidenceSourceType;
  readonly source_trust: EvidenceSourceTrust;
  // Ledger evidence:
  readonly event_id?: string;
  readonly stream_id?: string;
  readonly sequence?: number;
  readonly event_hash?: string;
  readonly tenant_id?: string;
  // Configuration snapshot / implementation manifest evidence:
  readonly snapshot_id?: string;
  readonly snapshot_hash?: string;
  readonly manifest_id?: string;
  readonly manifest_hash?: string;
  // Freshness, for stale-evidence evaluation (section 17):
  readonly observed_at?: string;
  // Trust-closure pass: carried directly on the ref (not merely derivable from a separate map) so a
  // reviewer — human or automated — can see why this exact piece of evidence was allowed to support
  // a control result, without cross-referencing anything else (section 15 of the closure brief).
  readonly integrity_qualification?: EvidenceQualification;   // for LEDGER_EVENT refs
  readonly manifest_trust_class?: ManifestTrustClass;          // for IMPLEMENTATION_MANIFEST refs
}

export function validateEvidenceRef(input: unknown): EvidenceRef {
  if (!isPlainObject(input)) throw new AuditorError('INVALID_INPUT', 'Evidence reference must be an object');
  if (!EVIDENCE_SOURCE_TYPES.includes(input.source_type as EvidenceSourceType)) throw new AuditorError('INVALID_INPUT', `Unknown evidence source_type: ${String(input.source_type)}`);
  if (!isEvidenceSourceTrust(input.source_trust)) throw new AuditorError('INVALID_INPUT', `Unknown evidence source_trust: ${String(input.source_trust)}`);
  const ref: Record<string, unknown> = { source_type: input.source_type, source_trust: input.source_trust };
  if (input.event_id !== undefined) { if (!safeId(input.event_id, 300)) throw new AuditorError('INVALID_INPUT', 'event_id must be a safe identifier'); ref.event_id = input.event_id; }
  if (input.stream_id !== undefined) { if (!safeId(input.stream_id, 300)) throw new AuditorError('INVALID_INPUT', 'stream_id must be a safe identifier'); ref.stream_id = input.stream_id; }
  if (input.sequence !== undefined) { if (typeof input.sequence !== 'number' || !Number.isInteger(input.sequence) || input.sequence < 0) throw new AuditorError('INVALID_INPUT', 'sequence must be a non-negative integer'); ref.sequence = input.sequence; }
  if (input.event_hash !== undefined) { if (!isHex64(input.event_hash)) throw new AuditorError('INVALID_INPUT', 'event_hash must be a sha256 hex digest'); ref.event_hash = input.event_hash; }
  if (input.tenant_id !== undefined) { if (!safeId(input.tenant_id, 100)) throw new AuditorError('INVALID_INPUT', 'tenant_id must be a safe identifier'); ref.tenant_id = input.tenant_id; }
  if (input.snapshot_id !== undefined) { if (!safeId(input.snapshot_id, 300)) throw new AuditorError('INVALID_INPUT', 'snapshot_id must be a safe identifier'); ref.snapshot_id = input.snapshot_id; }
  if (input.snapshot_hash !== undefined) { if (!isHex64(input.snapshot_hash)) throw new AuditorError('INVALID_INPUT', 'snapshot_hash must be a sha256 hex digest'); ref.snapshot_hash = input.snapshot_hash; }
  if (input.manifest_id !== undefined) { if (!safeId(input.manifest_id, 300)) throw new AuditorError('INVALID_INPUT', 'manifest_id must be a safe identifier'); ref.manifest_id = input.manifest_id; }
  if (input.manifest_hash !== undefined) { if (!isHex64(input.manifest_hash)) throw new AuditorError('INVALID_INPUT', 'manifest_hash must be a sha256 hex digest'); ref.manifest_hash = input.manifest_hash; }
  if (input.observed_at !== undefined) { if (!isIsoTimestamp(input.observed_at)) throw new AuditorError('INVALID_INPUT', 'observed_at must be a valid ISO-8601 UTC timestamp'); ref.observed_at = input.observed_at; }
  if (input.integrity_qualification !== undefined) { if (!isEvidenceQualification(input.integrity_qualification)) throw new AuditorError('INVALID_INPUT', 'integrity_qualification must be a controlled value'); ref.integrity_qualification = input.integrity_qualification; }
  if (input.manifest_trust_class !== undefined) { if (!isManifestTrustClass(input.manifest_trust_class)) throw new AuditorError('INVALID_INPUT', 'manifest_trust_class must be a controlled value'); ref.manifest_trust_class = input.manifest_trust_class; }
  return ref as unknown as EvidenceRef;
}

// ---------------------------------------------------------------------------------------------
// Assessment scope (section 6). Must never default silently to "everything."
// ---------------------------------------------------------------------------------------------

export interface TimeRange { readonly from: string; readonly to: string }

export interface AssessmentScope {
  /** Explicit opt-in required to assess an entire tenant with no agent/correlation filter (section 6:
   * "An empty or ambiguous scope should fail unless explicitly allowed"). Defaults to false. */
  readonly tenant_wide: boolean;
  readonly agent_ids?: readonly string[];
  readonly correlation_ids?: readonly string[];
  readonly tool_ids?: readonly string[];
  readonly policy_ids?: readonly string[];
  readonly time_range: TimeRange;
  readonly environment?: string;
}

/** Validates a caller-supplied scope. `evidenceCutoffAt` bounds `time_range.to` — a scope cannot
 * reach past the assessment's own evidence cutoff. Throws AuditorError('SCOPE_INVALID', ...). */
export function validateAssessmentScope(input: unknown, evidenceCutoffAt: string): AssessmentScope {
  if (!isPlainObject(input)) throw new AuditorError('SCOPE_INVALID', 'scope must be an object');
  if (!isPlainObject(input.time_range) || !isIsoTimestamp(input.time_range.from) || !isIsoTimestamp(input.time_range.to)) {
    throw new AuditorError('SCOPE_INVALID', 'scope.time_range.{from,to} are required valid ISO-8601 UTC timestamps');
  }
  const from = input.time_range.from, to = input.time_range.to;
  if (Date.parse(from) >= Date.parse(to)) throw new AuditorError('SCOPE_INVALID', 'scope.time_range.from must be strictly before scope.time_range.to');
  if (Date.parse(to) > Date.parse(evidenceCutoffAt)) throw new AuditorError('SCOPE_INVALID', 'scope.time_range.to must not be after evidence_cutoff_at');

  const tenantWide = input.tenant_wide === true;
  const agentIds = input.agent_ids;
  const correlationIds = input.correlation_ids;
  if (agentIds !== undefined && !assertStringArray(agentIds, MAX_SCOPE_LIST_ENTRIES, v => safeId(v, 200))) throw new AuditorError('SCOPE_INVALID', 'scope.agent_ids must be a bounded array of safe identifiers');
  if (correlationIds !== undefined && !assertStringArray(correlationIds, MAX_SCOPE_LIST_ENTRIES, v => safeId(v, 200))) throw new AuditorError('SCOPE_INVALID', 'scope.correlation_ids must be a bounded array of safe identifiers');
  const hasAgents = Array.isArray(agentIds) && agentIds.length > 0;
  const hasCorrelations = Array.isArray(correlationIds) && correlationIds.length > 0;
  if (!tenantWide && !hasAgents && !hasCorrelations) {
    throw new AuditorError('SCOPE_INVALID', 'scope must specify agent_ids and/or correlation_ids, or explicitly set tenant_wide: true');
  }
  if (input.tool_ids !== undefined && !assertStringArray(input.tool_ids, MAX_SCOPE_LIST_ENTRIES, v => safeId(v, 200))) throw new AuditorError('SCOPE_INVALID', 'scope.tool_ids must be a bounded array of safe identifiers');
  if (input.policy_ids !== undefined && !assertStringArray(input.policy_ids, MAX_SCOPE_LIST_ENTRIES, v => safeId(v, 200))) throw new AuditorError('SCOPE_INVALID', 'scope.policy_ids must be a bounded array of safe identifiers');
  if (input.environment !== undefined && !safeId(input.environment, 100)) throw new AuditorError('SCOPE_INVALID', 'scope.environment must be a safe identifier');

  const scope: Record<string, unknown> = { tenant_wide: tenantWide, time_range: { from, to } };
  if (hasAgents) scope.agent_ids = agentIds;
  if (hasCorrelations) scope.correlation_ids = correlationIds;
  if (input.tool_ids !== undefined) scope.tool_ids = input.tool_ids;
  if (input.policy_ids !== undefined) scope.policy_ids = input.policy_ids;
  if (input.environment !== undefined) scope.environment = input.environment;
  return scope as unknown as AssessmentScope;
}

// ---------------------------------------------------------------------------------------------
// Assessment spec (section 5)
// ---------------------------------------------------------------------------------------------

/** Caller-supplied fields at assessment creation. Only a trusted `runner`/`admin` principal may
 * create an assessment — see auditor-engine's role model; this package validates shape only. */
export interface AssessmentSpecInput {
  readonly version: '1.0';
  readonly tenant_id: string;
  readonly name: string;
  readonly description?: string;
  readonly scope: AssessmentScope;
  readonly control_profile_id: ControlProfileId;
  readonly evidence_cutoff_at: string;
}

/**
 * Fully identified spec, as returned once the runtime accepts it. `assessment_id`/`created_at`/
 * `created_by` are runtime-owned. `spec_hash` is a lightweight, immediate hash over the
 * caller-meaningful spec fields (computed at creation, the same instant the spec becomes
 * immutable) — distinct from the comprehensive `assessment_hash` computed once at completion over
 * spec + catalog version + evidence manifest + control results + risk result (sections 42-43; see
 * `auditor-assessment-spec-v1.md` for why these are two different hashes, not one field reused).
 */
export interface AssessmentSpec extends AssessmentSpecInput {
  readonly assessment_id: string;
  readonly created_at: string;
  readonly created_by: string;
  readonly spec_hash: string;
}

/** Validates and normalizes a caller-supplied assessment spec input (section 5). Throws AuditorError. */
export function validateAssessmentSpecInput(input: unknown): AssessmentSpecInput {
  if (!isPlainObject(input)) throw new AuditorError('INVALID_INPUT', 'Assessment spec input must be an object');
  if (input.version !== AUDITOR_ASSESSMENT_VERSION) throw new AuditorError('UNSUPPORTED_VERSION', `Unsupported assessment version: ${String(input.version)}`);
  if (!safeId(input.tenant_id, 100)) throw new AuditorError('INVALID_INPUT', 'tenant_id is required');
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > MAX_NAME_LENGTH) throw new AuditorError('INVALID_INPUT', 'name is required');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > MAX_DESCRIPTION_LENGTH)) throw new AuditorError('INVALID_INPUT', 'description must be a bounded string');
  if (!isControlProfileId(input.control_profile_id)) throw new AuditorError('UNKNOWN_PROFILE', `Unknown control_profile_id: ${String(input.control_profile_id)}`);
  if (!isIsoTimestamp(input.evidence_cutoff_at)) throw new AuditorError('INVALID_INPUT', 'evidence_cutoff_at must be a valid ISO-8601 UTC timestamp');
  const scope = validateAssessmentScope(input.scope, input.evidence_cutoff_at);
  const secretHit = findSecretShapedField({ name: input.name, description: input.description });
  if (secretHit) throw new AuditorError('INVALID_INPUT', `Rejected: ${secretHit}`);

  const normalized: Record<string, unknown> = {
    version: AUDITOR_ASSESSMENT_VERSION, tenant_id: input.tenant_id, name: input.name,
    scope, control_profile_id: input.control_profile_id, evidence_cutoff_at: input.evidence_cutoff_at,
  };
  if (input.description !== undefined) normalized.description = input.description;
  return normalized as unknown as AssessmentSpecInput;
}

/** The `spec_hash` covers exactly the caller-meaningful spec content — never runtime bookkeeping
 * fields (`assessment_id`, `created_at`, `created_by`). */
export function computeSpecHash(input: AssessmentSpecInput): string { return hash(input as unknown as Record<string, unknown>); }

// ---------------------------------------------------------------------------------------------
// Control result (section 10) and finding (section 29)
// ---------------------------------------------------------------------------------------------

export interface ControlResult {
  readonly control_id: string;
  readonly control_version: string;
  readonly status: ControlResultStatus;
  readonly evaluated_at: string;
  readonly assessment_id: string;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly reason_codes: readonly ReasonCode[];
  readonly observations: readonly string[];
  readonly limitations: readonly string[];
  readonly risk_contribution: number;
  readonly remediation?: readonly string[];
}

/** Section 32: the one universal, deterministic mapping from (control criticality, result status)
 * to a numeric risk contribution — applied uniformly by every evaluator via auditor-controls'
 * `buildControlResult`, never decided ad hoc per control. PASS/NOT_APPLICABLE contribute nothing;
 * PARTIAL and INSUFFICIENT_EVIDENCE contribute half of the control's criticality score (uncertainty
 * is risk, not zero); FAIL and ERROR contribute the full criticality score (section 101: an
 * evaluator error is never treated as passing). */
export function computeRiskContribution(criticality: Severity, status: ControlResultStatus): number {
  const base = SEVERITY_SCORE[criticality];
  switch (status) {
    case 'PASS': case 'NOT_APPLICABLE': return 0;
    case 'PARTIAL': case 'INSUFFICIENT_EVIDENCE': return Math.round(base * 0.5);
    case 'FAIL': case 'ERROR': return base;
  }
}

export interface AuditFinding {
  readonly finding_id: string;
  readonly assessment_id: string;
  readonly control_id: string;
  readonly severity: Severity;
  readonly status: FindingStatus;
  readonly title: string;
  readonly description: string;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly reason_codes: readonly ReasonCode[];
  readonly remediation: readonly string[];
  readonly created_at: string;
}
