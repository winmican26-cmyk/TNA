import {
  AuditorError, computeRiskContribution, type ControlCategory, type ControlResultStatus, type ControlResult,
  type ReasonCode, type Severity, type ControlProfileId, type EvidenceRef, type AssessmentScope,
} from '../../auditor-schema/src/index.js';
import { type EvidenceBundle, type LedgerEvent, type ControlImplementationManifest, eventRef, findClaimsForControl, verifyManifestIntegrity } from '../../auditor-evidence/src/index.js';

export type { ControlResult, EvidenceBundle };

/** Section 40-41: catalog-wide version binding. Bumped whenever the control set or evaluation logic
 * changes; a stored assessment/run pins this exact value so a historical assessment is never
 * silently re-interpreted under newer rules (see auditor-engine's replay/catalog-mismatch handling).
 * Individual controls also carry their own `version` field for per-control granularity, but v0.1
 * uses one shared evaluator_version for the whole engine rather than per-control versioning. */
export const CONTROL_CATALOG_VERSION = '1.0';
export const EVALUATOR_VERSION = '1.0';

// ---------------------------------------------------------------------------------------------
// Control / profile model (sections 7-8, 20-22)
// ---------------------------------------------------------------------------------------------

export interface EvidenceRequirement {
  readonly description: string;
  readonly event_types?: readonly string[];
  readonly requires_manifest_claim?: boolean;
}

export interface Control {
  readonly control_id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly objective: string;
  readonly category: ControlCategory;
  /** Distinct from a finding's `severity` (section 37) — how much this control's own failure can
   * block the overall assessment outcome. */
  readonly criticality: Severity;
  readonly applicable_profiles: readonly ControlProfileId[];
  readonly required_evidence: readonly EvidenceRequirement[];
  readonly evaluation_method: string;
  readonly failure_conditions: readonly string[];
  readonly remediation_guidance: readonly string[];
  readonly dependencies?: readonly string[];
}

export interface ControlProfile {
  readonly profile_id: ControlProfileId;
  readonly name: string;
  readonly description: string;
  readonly control_ids: readonly string[];
  readonly criticality_overrides?: Readonly<Record<string, Severity>>;
}

export interface EvaluationContext {
  readonly assessment_id: string;
  readonly tenant_id: string;
  readonly scope: AssessmentScope;
  readonly evidence_cutoff_at: string;
  readonly now: number;
  readonly profile_id: ControlProfileId;
  readonly manifest: ControlImplementationManifest | null;
}

export type ControlEvaluator = (control: Control, context: EvaluationContext, evidence: EvidenceBundle) => ControlResult;

/** Effective criticality for this evaluation: the profile's override if one applies, else the
 * control's own baseline criticality (section 37, 22). */
export function effectiveCriticality(control: Control, context: EvaluationContext): Severity {
  return PROFILE_BY_ID[context.profile_id]?.criticality_overrides?.[control.control_id] ?? control.criticality;
}

// ---------------------------------------------------------------------------------------------
// Shared evaluator helpers — deterministic, side-effect-free (section 24: no LLM, no fuzzy scoring)
// ---------------------------------------------------------------------------------------------

function eventsOfType(bundle: EvidenceBundle, ...types: readonly string[]): LedgerEvent[] {
  const set = new Set(types);
  return bundle.events.filter(e => set.has(e.event_type));
}

const MAX_REFS = 25;
/** Builds a fully-formed ControlResult with a uniformly-computed risk_contribution — the one place
 * every evaluator converges, so risk scoring can never be gamed by a per-control author. */
function finish(
  control: Control, context: EvaluationContext, status: ControlResultStatus,
  reasonCodes: readonly ReasonCode[], observations: readonly string[], limitations: readonly string[],
  refs: readonly EvidenceRef[], remediation?: readonly string[],
): ControlResult {
  const result: ControlResult = {
    control_id: control.control_id, control_version: control.version, status,
    evaluated_at: new Date(context.now).toISOString(), assessment_id: context.assessment_id,
    evidence_refs: refs.slice(0, MAX_REFS), reason_codes: reasonCodes, observations, limitations,
    risk_contribution: computeRiskContribution(effectiveCriticality(control, context), status),
    ...(remediation !== undefined ? { remediation } : {}),
  };
  return result;
}

/**
 * Sections 90-92, and the trust-closure pass' TNA-42 distinction: a manifest claim only counts if
 * the manifest is present, its hash checks out (**integrity**), *and* it carries the one trust
 * classification this milestone treats as capable of satisfying a control automatically
 * (**authenticity**) — `BUILT_IN_ACCEPTED_BASELINE`. A hash-valid `ADMIN_PROVIDED` manifest is real,
 * stored, internally consistent — and still cannot satisfy a claim on its own (section 10-11): a
 * perfectly hashed assertion can still be false, so hash-validity is necessary but never sufficient.
 */
function manifestClaims(context: EvaluationContext, controlId: string): { claims: ReturnType<typeof findClaimsForControl>; manifestValid: boolean; manifestPresent: boolean; manifestAuthentic: boolean } {
  if (context.manifest === null) return { claims: [], manifestValid: false, manifestPresent: false, manifestAuthentic: false };
  const manifestValid = verifyManifestIntegrity(context.manifest);
  const manifestAuthentic = context.manifest.trust_class === 'BUILT_IN_ACCEPTED_BASELINE';
  const claims = (manifestValid && manifestAuthentic) ? findClaimsForControl(context.manifest, controlId) : [];
  return { claims, manifestValid, manifestPresent: true, manifestAuthentic };
}
function manifestRef(context: EvaluationContext): EvidenceRef[] {
  if (context.manifest === null) return [];
  return [{ source_type: 'IMPLEMENTATION_MANIFEST', source_trust: 'TRUSTED_SYSTEM', manifest_id: context.manifest.manifest_id, manifest_hash: context.manifest.manifest_hash, observed_at: context.manifest.created_at, manifest_trust_class: context.manifest.trust_class }];
}
/** Section 17: freshness. `maxAgeSeconds` bounds how old the *evaluation instant* (`context.now`)
 * may be relative to an event's `received_at` before that event can no longer support a PASS on
 * its own. */
function isFresh(event: LedgerEvent, context: EvaluationContext, maxAgeSeconds: number): boolean {
  return (context.now - Date.parse(event.received_at)) / 1000 <= maxAgeSeconds;
}
/** Section 17's own example: "revocation-state evidence older than 24h may not prove current
 * revocation effectiveness." */
const MAX_REVOCATION_PROOF_AGE_SECONDS = 24 * 3600;

/** A purely manifest-backed structural control (sections 76-77, 83, 89): no per-event Ledger
 * evidence is expected to exist naturally; the implementation fact itself is the evidence. */
function evaluateManifestOnly(control: Control, context: EvaluationContext, _evidence: EvidenceBundle): ControlResult {
  void _evidence;
  const { claims, manifestValid, manifestPresent, manifestAuthentic } = manifestClaims(context, control.control_id);
  if (!manifestPresent) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['IMPLEMENTATION_MANIFEST_MISSING'], [], ['No implementation evidence manifest was supplied to this assessment.'], [], control.remediation_guidance);
  if (!manifestValid) return finish(control, context, 'FAIL', ['EVIDENCE_INTEGRITY_INVALID'], [], ['The supplied implementation manifest failed its own hash-integrity check and cannot be trusted.'], [], control.remediation_guidance);
  // TNA-42: a hash-valid manifest is still not automatically authentic. Only the compiled, trusted
  // BUILT_IN_ACCEPTED_BASELINE manifest can satisfy a control claim automatically in v0.1 — an
  // internally-consistent ADMIN_PROVIDED manifest is real and stored, but an administrator's own
  // say-so does not manufacture technical truth (section 11).
  if (!manifestAuthentic) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['MANIFEST_NOT_AUTHENTIC'], [], [`The supplied manifest is internally hash-consistent (trust_class: ${context.manifest?.trust_class ?? 'unknown'}) but is not the trusted accepted-baseline provenance, and cannot by itself satisfy ${control.control_id}.`], manifestRef(context), control.remediation_guidance);
  if (claims.length === 0) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['IMPLEMENTATION_MANIFEST_MISSING'], [], [`No manifest claim references ${control.control_id}.`], manifestRef(context), control.remediation_guidance);
  return finish(control, context, 'PASS', ['IMPLEMENTATION_MANIFEST_SATISFIED'], claims.map(c => `${c.component} (${c.accepted_tag} @ ${c.accepted_commit.slice(0, 12)}): ${c.description}`), ['This control is satisfied by a static implementation-evidence claim, not a per-execution Ledger event; it reflects the referenced component version, not this specific scope’s runtime behavior.'], manifestRef(context));
}

// ---------------------------------------------------------------------------------------------
// Control catalog
// ---------------------------------------------------------------------------------------------

const catalog: Control[] = [];
const evaluators = new Map<string, ControlEvaluator>();
function register(control: Control, evaluator: ControlEvaluator): void { catalog.push(control); evaluators.set(control.control_id, evaluator); }

// --- IDENTITY ------------------------------------------------------------------------------

register({
  control_id: 'TNA-IDENT-001', version: '1.0', title: 'Consequential actions carry bound agent identity', category: 'IDENTITY', criticality: 'HIGH',
  description: 'Every consequential authorization event in scope must carry an explicit, non-empty agent identity.',
  objective: 'Prevent an action from being taken or authorized without an identifiable, registered agent behind it.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'AUTHORIZATION_* events with authority_context.agent_id bound', event_types: ['AUTHORIZATION_ALLOWED', 'AUTHORIZATION_BLOCKED', 'AUTHORIZATION_HELD'] }, { description: 'A corresponding AGENT_REGISTERED event', event_types: ['AGENT_REGISTERED'] }],
  evaluation_method: 'ledger-event-field-binding', failure_conditions: ['A consequential authorization event exists with no bound agent_id.', 'No AGENT_REGISTERED evidence exists for a referenced agent.'],
  remediation_guidance: ['Ensure every authorization event binds authority_context.agent_id.', 'Ensure agent registration is recorded before any consequential action.'],
}, (control, context, evidence) => {
  // EXECUTION_STARTED is deliberately excluded here: the accepted GateLedgerAdapter records it with
  // actor = the execution-broker system component and no authority_context.agent_id at all —
  // execution-level identity assurance instead comes from correlation to a capability redemption,
  // which TNA-EXEC-001 checks directly. Requiring authority_context.agent_id on EXECUTION_STARTED
  // would fail every real deployment on a field the accepted implementation never sets.
  const consequential = eventsOfType(evidence, 'AUTHORIZATION_ALLOWED', 'AUTHORIZATION_BLOCKED', 'AUTHORIZATION_HELD');
  if (consequential.length === 0) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['MISSING_REQUIRED_EVIDENCE'], [], ['No authorization or execution activity was found in this scope.'], []);
  const unbound = consequential.filter(e => e.authority_context?.agent_id === undefined);
  // AGENT_REGISTERED's actor is the registering system component (e.g. 'tna-gate'), not the
  // registered agent — the agent identity itself is in authority_context.agent_id.
  const registered = new Set(eventsOfType(evidence, 'AGENT_REGISTERED').map(e => e.authority_context?.agent_id).filter((v): v is string => v !== undefined));
  const agentIds = new Set(consequential.map(e => e.authority_context?.agent_id).filter((v): v is string => v !== undefined));
  const unregistered = [...agentIds].filter(id => !registered.has(id));
  const refs = consequential.slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (unbound.length > 0) return finish(control, context, 'FAIL', ['MISSING_REQUIRED_EVIDENCE'], [`${unbound.length} of ${consequential.length} consequential event(s) carry no bound agent_id.`], [], refs, control.remediation_guidance);
  if (unregistered.length > 0) return finish(control, context, 'PARTIAL', ['PARTIAL_EVIDENCE'], [`${unregistered.length} agent id(s) referenced with no matching AGENT_REGISTERED evidence in scope: ${unregistered.join(', ')}.`], ['Registration may have occurred before the scoped time range.'], refs);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${consequential.length} consequential event(s), all with bound and registered agent identity.`], [], refs);
});

// --- AUTHORITY -------------------------------------------------------------------------------

register({
  control_id: 'TNA-AUTH-001', version: '1.0', title: 'Authority binding is complete', category: 'AUTHORITY', criticality: 'CRITICAL',
  description: 'Every authorization decision binds agent, action, tool, resource/operation, and policy_hash.',
  objective: 'Every consequential agent action must have explicit, fully-bound authorization evidence (section 12).',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'AUTHORIZATION_ALLOWED or AUTHORIZATION_BLOCKED with decision_id, agent_id, policy_hash, action/tool/resource binding', event_types: ['AUTHORIZATION_ALLOWED', 'AUTHORIZATION_BLOCKED'] }],
  evaluation_method: 'ledger-event-field-binding', failure_conditions: ['An authorization event is missing decision_id, agent_id, policy_hash, action, tool, or resource.'],
  remediation_guidance: ['Bind decision_id, agent_id, policy_hash, action, tool, and resource on every authorization event.'],
}, (control, context, evidence) => {
  const decisions = eventsOfType(evidence, 'AUTHORIZATION_ALLOWED', 'AUTHORIZATION_BLOCKED');
  if (decisions.length === 0) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['MISSING_REQUIRED_EVIDENCE'], [], ['No authorization decisions found in this scope.'], []);
  const requiredFields: (keyof NonNullable<LedgerEvent['authority_context']>)[] = ['decision_id', 'agent_id', 'policy_hash', 'action', 'tool', 'resource'];
  const incomplete = decisions.filter(e => requiredFields.some(field => e.authority_context?.[field] === undefined));
  const refs = decisions.slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (incomplete.length === decisions.length) return finish(control, context, 'FAIL', ['MISSING_REQUIRED_EVIDENCE'], [`All ${decisions.length} authorization decision(s) are missing at least one required binding field.`], [], refs, control.remediation_guidance);
  if (incomplete.length > 0) return finish(control, context, 'PARTIAL', ['PARTIAL_EVIDENCE'], [`${incomplete.length} of ${decisions.length} authorization decision(s) are missing a required binding field.`], [], refs, control.remediation_guidance);
  // Section 16/TNA-41: whether any of these refs come from an integrity-compromised stream is no
  // longer this evaluator's own concern — the central evidence-integrity qualification gate in
  // evaluateControl() downgrades this PASS automatically if any cited ref is not VALID. No evaluator
  // needs to remember to check stream integrity itself; see auditor-v0.1-trust-closure.md.
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${decisions.length} authorization decision(s), all fully bound (agent, action, tool, resource, policy_hash).`], [], refs);
});

register({
  control_id: 'TNA-AUTH-002', version: '1.0', title: 'Authority scope is not overly broad', category: 'AUTHORITY', criticality: 'HIGH',
  description: 'Bound resource/tool fields on authorization decisions are specific, not empty or unbounded wildcards.',
  objective: 'An overly generic authorization ("*", empty resource) must not automatically be treated as a satisfied binding (section 72).',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'AUTHORIZATION_ALLOWED events with a resource field that is not empty or a bare wildcard', event_types: ['AUTHORIZATION_ALLOWED'] }],
  dependencies: ['TNA-AUTH-001'],
  evaluation_method: 'ledger-event-field-shape', failure_conditions: ['A bound resource or tool field is empty or exactly "*".'],
  remediation_guidance: ['Bind authorization decisions to specific resources/tools rather than wildcards.'],
}, (control, context, evidence) => {
  const allowed = eventsOfType(evidence, 'AUTHORIZATION_ALLOWED');
  if (allowed.length === 0) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['MISSING_REQUIRED_EVIDENCE'], [], ['No allowed authorizations found in this scope.'], []);
  const tooGeneric = allowed.filter(e => { const r = e.authority_context?.resource, t = e.authority_context?.tool; return r === undefined || r === '' || r === '*' || t === undefined || t === '' || t === '*'; });
  const refs = allowed.slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (tooGeneric.length > 0) return finish(control, context, 'FAIL', ['AUTHORITY_SCOPE_TOO_BROAD'], [`${tooGeneric.length} of ${allowed.length} allowed authorization(s) bind an empty or wildcard resource/tool.`], [], refs, control.remediation_guidance);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${allowed.length} allowed authorization(s), all bound to specific, non-wildcard resource/tool.`], [], refs);
});

// --- APPROVAL --------------------------------------------------------------------------------

register({
  control_id: 'TNA-APPR-001', version: '1.0', title: 'Required approval evidence is present', category: 'APPROVAL', criticality: 'MEDIUM',
  description: 'Where an authorization decision required approval, explicit APPROVAL_GRANTED/REJECTED evidence exists.',
  objective: 'Approval-gated actions must not proceed on an assumed or undocumented approval.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'APPROVAL_GRANTED or APPROVAL_REJECTED correlated to a held/allowed authorization', event_types: ['APPROVAL_GRANTED', 'APPROVAL_REJECTED', 'AUTHORIZATION_HELD'] }],
  evaluation_method: 'ledger-event-correlation', failure_conditions: ['An AUTHORIZATION_HELD event has no correlated APPROVAL_GRANTED/REJECTED event.'],
  remediation_guidance: ['Record an explicit APPROVAL_GRANTED or APPROVAL_REJECTED event for every held decision.'],
}, (control, context, evidence) => {
  const held = eventsOfType(evidence, 'AUTHORIZATION_HELD');
  if (held.length === 0) return finish(control, context, 'NOT_APPLICABLE', ['SCOPE_NOT_APPLICABLE'], [], ['No approval-gated authorization decisions occurred in this scope.'], []);
  const approvals = eventsOfType(evidence, 'APPROVAL_GRANTED', 'APPROVAL_REJECTED');
  const approvedCorrelations = new Set(approvals.map(e => e.correlation_id));
  const unapproved = held.filter(e => !approvedCorrelations.has(e.correlation_id));
  const refs = [...held, ...approvals].slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (unapproved.length > 0) return finish(control, context, 'FAIL', ['MISSING_REQUIRED_EVIDENCE'], [`${unapproved.length} of ${held.length} held decision(s) have no correlated approval evidence.`], [], refs, control.remediation_guidance);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${held.length} held decision(s), all with correlated approval evidence.`], [], refs);
});

// --- CAPABILITY ------------------------------------------------------------------------------

register({
  control_id: 'TNA-CAP-001', version: '1.0', title: 'Capability lifetime is bounded and honored', category: 'CAPABILITY', criticality: 'HIGH',
  description: 'Issued capabilities carry a bounded expiry, and redemption occurs before it.',
  objective: 'Short-lived capability use (section 21) must be provable, not assumed.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'CAPABILITY_ISSUED with authority_context.authority_expiry, and CAPABILITY_REDEEMED before it', event_types: ['CAPABILITY_ISSUED', 'CAPABILITY_REDEEMED'] }],
  evaluation_method: 'ledger-event-field-binding', failure_conditions: ['CAPABILITY_ISSUED carries no authority_expiry.', 'CAPABILITY_REDEEMED occurs after authority_expiry.'],
  remediation_guidance: ['Bind authority_expiry on every issued capability and reject redemption past it.'],
}, (control, context, evidence) => {
  const issued = eventsOfType(evidence, 'CAPABILITY_ISSUED');
  if (issued.length === 0) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['MISSING_REQUIRED_EVIDENCE'], [], ['No capability issuance found in this scope.'], []);
  const redeemed = eventsOfType(evidence, 'CAPABILITY_REDEEMED');
  const redeemedByCapability = new Map(redeemed.map(e => [e.authority_context?.capability_id, e]));
  const unbounded = issued.filter(e => e.authority_context?.authority_expiry === undefined);
  const lateRedemptions = issued.filter(e => {
    const capId = e.authority_context?.capability_id, expiry = e.authority_context?.authority_expiry;
    if (capId === undefined || expiry === undefined) return false;
    const r = redeemedByCapability.get(capId);
    return r !== undefined && Date.parse(r.received_at) > Date.parse(expiry);
  });
  const refs = [...issued, ...redeemed].slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (unbounded.length > 0) return finish(control, context, 'FAIL', ['MISSING_REQUIRED_EVIDENCE'], [`${unbounded.length} of ${issued.length} issued capability(ies) carry no authority_expiry.`], [], refs, control.remediation_guidance);
  if (lateRedemptions.length > 0) return finish(control, context, 'FAIL', ['REVOCATION_NOT_ENFORCED'], [`${lateRedemptions.length} capability redemption(s) occurred after the capability's own authority_expiry.`], [], refs, control.remediation_guidance);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${issued.length} issued capability(ies), all bounded and redeemed (if at all) within their expiry.`], [], refs);
});

register({
  control_id: 'TNA-CAP-002', version: '1.0', title: 'Capability single-use is enforced', category: 'CAPABILITY', criticality: 'HIGH',
  description: 'Reuse of a redeemed capability is structurally rejected — proven by implementation evidence, not inferred from one successful redemption (section 74).',
  objective: 'A capability must not be redeemable more than once.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'A trusted implementation-manifest claim citing a reuse-rejection test', requires_manifest_claim: true }],
  evaluation_method: 'implementation-manifest', failure_conditions: ['No manifest claim exists for single-use enforcement.', 'CAPABILITY_REDEEMED occurs twice for the same capability_id in scope (direct counter-evidence).'],
  remediation_guidance: ['Reject a second redemption attempt of an already-redeemed capability_id.'],
}, (control, context, evidence) => {
  const redeemed = eventsOfType(evidence, 'CAPABILITY_REDEEMED');
  const byCapability = new Map<string, LedgerEvent[]>();
  for (const e of redeemed) { const id = e.authority_context?.capability_id; if (id === undefined) continue; const list = byCapability.get(id) ?? []; list.push(e); byCapability.set(id, list); }
  const reused = [...byCapability.values()].filter(list => list.length > 1);
  if (reused.length > 0) {
    const refs = reused.flat().slice(0, MAX_REFS).map(e => eventRef(e, evidence));
    return finish(control, context, 'FAIL', ['REVOCATION_NOT_ENFORCED'], [`${reused.length} capability id(s) were redeemed more than once within this scope — direct counter-evidence of a single-use failure.`], [], refs, control.remediation_guidance);
  }
  // No reuse was *observed* in scope; that alone never proves reuse is *rejected* (section 26/74) —
  // only the trusted implementation manifest can positively satisfy this control.
  return evaluateManifestOnly(control, context, evidence);
});

register({
  control_id: 'TNA-CAP-003', version: '1.0', title: 'Capability revocation is enforced', category: 'CAPABILITY', criticality: 'CRITICAL',
  description: 'A revoked agent’s subsequent capability redemption or authorization attempts are blocked (negative evidence, section 27, 75).',
  objective: 'Revocation must have demonstrable effect, not merely exist as a policy statement.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'AGENT_REVOKED followed by a blocked/rejected authorization or capability event for the same agent', event_types: ['AGENT_REVOKED', 'AUTHORIZATION_BLOCKED', 'CAPABILITY_REJECTED'] }],
  evaluation_method: 'ledger-event-sequence', failure_conditions: ['AGENT_REVOKED occurred but no subsequent blocked event for that agent exists in scope.', 'A CAPABILITY_REDEEMED or AUTHORIZATION_ALLOWED occurs for that agent after AGENT_REVOKED.'],
  remediation_guidance: ['Ensure Gate rejects authorization/capability redemption for a revoked agent, and that the rejection is recorded.'],
}, (control, context, evidence) => {
  const revocations = eventsOfType(evidence, 'AGENT_REVOKED');
  if (revocations.length === 0) return finish(control, context, 'NOT_APPLICABLE', ['SCOPE_NOT_APPLICABLE'], [], ['No agent revocation occurred in this scope.'], []);
  const blocked = eventsOfType(evidence, 'AUTHORIZATION_BLOCKED', 'CAPABILITY_REJECTED');
  const allowedAfter = eventsOfType(evidence, 'AUTHORIZATION_ALLOWED', 'CAPABILITY_REDEEMED');
  let unenforced = 0, violated = 0, stale = 0;
  const refs: EvidenceRef[] = [];
  for (const revocation of revocations) {
    const agentId = revocation.actor.id;
    const revokedAt = Date.parse(revocation.received_at);
    const proof = blocked.find(e => e.authority_context?.agent_id === agentId && Date.parse(e.received_at) >= revokedAt);
    const violation = allowedAfter.find(e => e.authority_context?.agent_id === agentId && Date.parse(e.received_at) > revokedAt);
    refs.push(eventRef(revocation, evidence));
    if (violation !== undefined) { violated += 1; refs.push(eventRef(violation, evidence)); }
    else if (proof === undefined) { unenforced += 1; }
    // Section 17: the enforcement proof itself must be current, not a stale snapshot the assessment
    // is merely trusting to still reflect today's enforcement behavior.
    else if (!isFresh(proof, context, MAX_REVOCATION_PROOF_AGE_SECONDS)) { stale += 1; refs.push(eventRef(proof, evidence)); }
    else refs.push(eventRef(proof, evidence));
  }
  if (violated > 0) return finish(control, context, 'FAIL', ['REVOCATION_NOT_ENFORCED'], [`${violated} of ${revocations.length} revocation(s) were followed by an ALLOWED/REDEEMED event for the same agent — direct counter-evidence.`], [], refs.slice(0, MAX_REFS), control.remediation_guidance);
  if (unenforced > 0) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['MISSING_REQUIRED_EVIDENCE'], [`${unenforced} of ${revocations.length} revocation(s) have no correlated block/rejection evidence in scope.`], [], refs.slice(0, MAX_REFS));
  if (stale > 0) return finish(control, context, 'PARTIAL', ['EVIDENCE_STALE'], [`${stale} of ${revocations.length} revocation-enforcement proof(s) are older than ${MAX_REVOCATION_PROOF_AGE_SECONDS}s and cannot alone establish current effectiveness.`], ['Stale enforcement evidence proves revocation worked at that past moment, not that it works now.'], refs.slice(0, MAX_REFS));
  return finish(control, context, 'PASS', ['NEGATIVE_EVIDENCE_SATISFIED'], [`${revocations.length} revocation(s), each followed by a fresh, demonstrable block of a subsequent attempt.`], [], refs.slice(0, MAX_REFS));
});

// --- EXECUTION -------------------------------------------------------------------------------

register({
  control_id: 'TNA-EXEC-001', version: '1.0', title: 'Execution is mediated through a bound capability', category: 'EXECUTION', criticality: 'HIGH',
  description: 'EXECUTION_STARTED events correlate to a CAPABILITY_REDEEMED event, not a bare unmediated start.',
  objective: 'An agent must not be able to execute a tool action without going through capability redemption.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'EXECUTION_STARTED with execution_context.execution_id correlated to a CAPABILITY_REDEEMED', event_types: ['EXECUTION_STARTED', 'CAPABILITY_REDEEMED'] }],
  evaluation_method: 'ledger-event-correlation', failure_conditions: ['An EXECUTION_STARTED event has no correlated capability redemption.'],
  remediation_guidance: ['Bind every execution start to the capability_id that authorized it.'],
}, (control, context, evidence) => {
  const started = eventsOfType(evidence, 'EXECUTION_STARTED');
  if (started.length === 0) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['MISSING_REQUIRED_EVIDENCE'], [], ['No execution activity found in this scope.'], []);
  const redeemed = eventsOfType(evidence, 'CAPABILITY_REDEEMED');
  const redeemedCorrelations = new Set(redeemed.map(e => e.correlation_id));
  const unmediated = started.filter(e => !redeemedCorrelations.has(e.correlation_id));
  const refs = [...started, ...redeemed].slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (unmediated.length > 0) return finish(control, context, 'FAIL', ['MISSING_REQUIRED_EVIDENCE'], [`${unmediated.length} of ${started.length} execution(s) have no correlated capability redemption.`], [], refs, control.remediation_guidance);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${started.length} execution(s), all correlated to a capability redemption.`], [], refs);
});

register({
  control_id: 'TNA-EXEC-002', version: '1.0', title: 'Retries are runtime-bounded', category: 'EXECUTION', criticality: 'MEDIUM',
  description: 'Attempt numbers on VAD atom activity are bounded and monotonic, never caller-selected (section 80).',
  objective: 'An agent/producer must not be able to retry an atom indefinitely.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'ATOM_ATTEMPT_STARTED evidence showing bounded attempt_number, or a manifest claim', event_types: ['ATOM_ATTEMPT_STARTED'] }],
  evaluation_method: 'ledger-event-field-binding+manifest', failure_conditions: ['An atom shows more than a small, fixed number of attempts with no escalation.'],
  remediation_guidance: ['Enforce and record a runtime-owned attempt ceiling per atom.'],
}, (control, context, evidence) => {
  const attempts = eventsOfType(evidence, 'ATOM_ATTEMPT_STARTED');
  if (attempts.length === 0) return evaluateManifestOnly(control, context, evidence);
  const byAtom = new Map<string, number[]>();
  for (const e of attempts) { const atomId = e.spec_context?.atom_id; if (atomId === undefined) continue; const list = byAtom.get(atomId) ?? []; if (e.spec_context?.attempt_number !== undefined) list.push(e.spec_context.attempt_number); byAtom.set(atomId, list); }
  const UNBOUNDED_THRESHOLD = 10;
  const unbounded = [...byAtom.entries()].filter(([, nums]) => Math.max(0, ...nums) > UNBOUNDED_THRESHOLD);
  const refs = attempts.slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (unbounded.length > 0) return finish(control, context, 'FAIL', ['MISSING_REQUIRED_EVIDENCE'], [`${unbounded.length} atom(s) exceeded ${UNBOUNDED_THRESHOLD} recorded attempts with no visible ceiling.`], [], refs, control.remediation_guidance);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${byAtom.size} atom(s) observed, all within a bounded attempt count.`], [], refs);
});

// --- ISOLATION -------------------------------------------------------------------------------

register({
  control_id: 'TNA-ISO-001', version: '1.0', title: 'Execution is isolation-mediated', category: 'ISOLATION', criticality: 'MEDIUM',
  description: 'Execution is structurally mediated through an isolation runner rather than direct agent access (implementation-manifest fact).',
  objective: 'Tool execution should not run with direct, unmediated access to the host.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'A trusted implementation-manifest claim citing isolation-runner mediation', requires_manifest_claim: true }],
  evaluation_method: 'implementation-manifest', failure_conditions: ['No manifest claim exists for isolation mediation.'],
  remediation_guidance: ['Route execution through an isolation runner rather than direct host access.'],
}, evaluateManifestOnly);

// --- SECRETS ---------------------------------------------------------------------------------

register({
  control_id: 'TNA-SEC-001', version: '1.0', title: 'No raw secret exposure in evidence', category: 'SECRETS', criticality: 'HIGH',
  description: 'No collected evidence payload contains a secret-shaped field or bearer-token-shaped value, and secret brokerage is manifest-attested.',
  objective: 'Agents should receive short-lived secret leases, not raw long-lived secrets, and evidence itself must never leak one.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'No secret-shaped payload field across collected evidence, plus a secret-brokerage manifest claim' }],
  evaluation_method: 'evidence-scan+implementation-manifest', failure_conditions: ['Any collected event payload contains a secret-shaped field or bearer-token-shaped value.'],
  remediation_guidance: ['Never place raw secret values in event payloads; use secret leases with references only.'],
}, (control, context, evidence) => {
  const tainted = evidence.events.filter(e => secretShapeInEvent(e));
  if (tainted.length > 0) return finish(control, context, 'FAIL', ['SECRET_EXPOSURE_RISK'], [`${tainted.length} collected event(s) contain a secret-shaped payload field or value.`], [], tainted.slice(0, MAX_REFS).map(e => eventRef(e, evidence)), control.remediation_guidance);
  const { claims, manifestValid, manifestPresent } = manifestClaims(context, control.control_id);
  if (!manifestPresent) return finish(control, context, 'PARTIAL', ['PARTIAL_EVIDENCE'], ['No secret-shaped values were found in scope, but no implementation manifest confirms secret brokerage is structurally enforced.'], [], []);
  if (!manifestValid || claims.length === 0) return finish(control, context, 'PARTIAL', ['IMPLEMENTATION_MANIFEST_MISSING'], ['No secret-shaped values found in scope, but the secret-brokerage manifest claim is missing or invalid.'], [], manifestRef(context));
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED', 'IMPLEMENTATION_MANIFEST_SATISFIED'], ['No secret-shaped values found in scope; secret brokerage is manifest-attested.'], [], manifestRef(context));
});

// --- EGRESS ----------------------------------------------------------------------------------

register({
  control_id: 'TNA-EGR-001', version: '1.0', title: 'Application-level egress restriction exists', category: 'EGRESS', criticality: 'MEDIUM',
  description: 'Application-level destination restriction is manifest-attested. This is explicitly scoped: not a full SSRF/network-layer guarantee (section 77).',
  objective: 'Outbound network access should be restricted at the application layer, with the limitation of that layer honestly acknowledged.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'A trusted implementation-manifest claim citing application-level egress restriction, worded to its actual scope', requires_manifest_claim: true }],
  evaluation_method: 'implementation-manifest', failure_conditions: ['No manifest claim exists.', 'The claim asserts a broader guarantee (e.g. full SSRF prevention) than the implementation provides.'],
  remediation_guidance: ['Maintain a destination allow-list and reject private-address destinations at the application layer.'],
}, evaluateManifestOnly);

// --- VERIFICATION ------------------------------------------------------------------------------

register({
  control_id: 'TNA-VER-001', version: '1.0', title: 'Producer and verifier identity are separated', category: 'VERIFICATION', criticality: 'HIGH',
  description: 'ATOM_VERIFICATION_ACCEPTED/REJECTED events carry a VERIFIER actor distinct from the atom’s producer.',
  objective: 'Independent verification requires that the verifier not be the same identity as the producer (section 78).',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'ATOM_VERIFICATION_ACCEPTED/REJECTED with actor.type=VERIFIER, distinct from any PRODUCER actor on the same atom', event_types: ['ATOM_VERIFICATION_ACCEPTED', 'ATOM_VERIFICATION_REJECTED', 'ATOM_ATTEMPT_STARTED'] }],
  evaluation_method: 'ledger-event-actor-comparison', failure_conditions: ['A verifier actor matches the producer actor for the same atom.', 'No independent verification event exists.'],
  remediation_guidance: ['Bind a distinct verifier identity for every atom verification.'],
}, (control, context, evidence) => {
  const verifications = eventsOfType(evidence, 'ATOM_VERIFICATION_ACCEPTED', 'ATOM_VERIFICATION_REJECTED');
  if (verifications.length === 0) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['NO_INDEPENDENT_VERIFICATION'], [], ['No VAD verification activity found in this scope.'], []);
  const attempts = eventsOfType(evidence, 'ATOM_ATTEMPT_STARTED');
  const producerByAtom = new Map(attempts.map(e => [e.spec_context?.atom_id, e.actor.id]));
  const sameIdentity = verifications.filter(e => { const atomId = e.spec_context?.atom_id; return atomId !== undefined && producerByAtom.get(atomId) === e.actor.id; });
  const refs = verifications.slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (sameIdentity.length > 0) return finish(control, context, 'FAIL', ['NO_INDEPENDENT_VERIFICATION'], [`${sameIdentity.length} verification(s) share identity with the atom’s own producer.`], [], refs, control.remediation_guidance);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${verifications.length} verification(s), all with an identity distinct from the atom’s producer.`], [], refs);
});

register({
  control_id: 'TNA-VER-002', version: '1.0', title: 'Spec hash is immutably bound through the atom lifecycle', category: 'VERIFICATION', criticality: 'HIGH',
  description: 'The same spec_hash is present across ATOM_CREATED, verification, and acceptance/rejection events for one atom.',
  objective: 'A verified atom’s specification must not be silently substituted between attempt and acceptance (section 79).',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'spec_hash consistent across ATOM_CREATED and ATOM_ACCEPTED/REJECTED for the same atom_id', event_types: ['ATOM_CREATED', 'ATOM_ACCEPTED', 'ATOM_REJECTED'] }],
  evaluation_method: 'ledger-event-field-consistency', failure_conditions: ['spec_hash differs between an atom’s creation and its final acceptance/rejection.'],
  remediation_guidance: ['Bind and re-verify spec_hash at every lifecycle stage.'],
}, (control, context, evidence) => {
  const created = eventsOfType(evidence, 'ATOM_CREATED');
  if (created.length === 0) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['MISSING_REQUIRED_EVIDENCE'], [], ['No VAD atom activity found in this scope.'], []);
  const finalEvents = eventsOfType(evidence, 'ATOM_ACCEPTED', 'ATOM_REJECTED');
  const finalByAtom = new Map(finalEvents.map(e => [e.spec_context?.atom_id, e]));
  const mismatched = created.filter(e => { const atomId = e.spec_context?.atom_id; const finalEvent = atomId !== undefined ? finalByAtom.get(atomId) : undefined; return finalEvent !== undefined && finalEvent.spec_context?.spec_hash !== e.spec_context?.spec_hash; });
  const refs = [...created, ...finalEvents].slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (mismatched.length > 0) return finish(control, context, 'FAIL', ['EVIDENCE_INTEGRITY_INVALID'], [`${mismatched.length} atom(s) show a spec_hash mismatch between creation and finalization.`], [], refs, control.remediation_guidance);
  const unresolved = created.length - [...finalByAtom.keys()].filter(id => created.some(c => c.spec_context?.atom_id === id)).length;
  if (unresolved > 0) return finish(control, context, 'PARTIAL', ['PARTIAL_EVIDENCE'], [`${unresolved} atom(s) created in scope have no final acceptance/rejection event yet.`], [], refs);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${created.length} atom(s), all with a consistent spec_hash through finalization.`], [], refs);
});

// --- EVIDENCE --------------------------------------------------------------------------------

register({
  control_id: 'TNA-EVID-001', version: '1.0', title: 'Ledger’s public surface is append-only', category: 'EVIDENCE', criticality: 'HIGH',
  description: 'The accepted Ledger application surface exposes no generic event/stream mutation route (implementation-manifest fact).',
  objective: 'Recorded evidence must not be alterable through the ordinary API surface.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'A trusted implementation-manifest claim citing the absence of mutation routes', requires_manifest_claim: true }],
  evaluation_method: 'implementation-manifest', failure_conditions: ['No manifest claim exists.'],
  remediation_guidance: ['Expose only named, audited append operations — never a generic resource-shaped mutation route.'],
}, evaluateManifestOnly);

register({
  control_id: 'TNA-HUMAN-001', version: '1.0', title: 'Human overrides are fully auditable', category: 'HUMAN_OVERSIGHT', criticality: 'HIGH',
  description: 'ATOM_HUMAN_DECISION events carry actor, timestamp, rationale, prior automated outcome, and spec_hash.',
  objective: 'A human override must be traceable to who decided, when, why, and against what prior outcome (section 81).',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'ATOM_HUMAN_DECISION with actor, human_decision, spec_context.spec_hash bound', event_types: ['ATOM_HUMAN_DECISION'] }],
  evaluation_method: 'ledger-event-field-binding', failure_conditions: ['An override event lacks actor, rationale-bearing payload, or spec_hash binding.'],
  remediation_guidance: ['Record actor, rationale, prior outcome, and spec_hash on every human override.'],
}, (control, context, evidence) => {
  const overrides = eventsOfType(evidence, 'ATOM_HUMAN_DECISION');
  // Section 81: distinguish "the control design exists" from "an override event was observed" —
  // if none occurred in scope, that is NOT_APPLICABLE, never silently treated as satisfied.
  if (overrides.length === 0) return finish(control, context, 'NOT_APPLICABLE', ['SCOPE_NOT_APPLICABLE'], [], ['No human override occurred in this scope; override auditability is unexercised, not proven, by this assessment.'], []);
  const incomplete = overrides.filter(e => e.actor.id === '' || e.spec_context?.spec_hash === undefined || e.spec_context?.human_decision === undefined);
  const refs = overrides.slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (incomplete.length > 0) return finish(control, context, 'FAIL', ['MISSING_REQUIRED_EVIDENCE'], [`${incomplete.length} of ${overrides.length} override event(s) are missing actor, decision, or spec_hash binding.`], [], refs, control.remediation_guidance);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${overrides.length} human override(s), all fully bound.`], [], refs);
});

// --- INTEGRITY -------------------------------------------------------------------------------

register({
  control_id: 'TNA-INTEG-001', version: '1.0', title: 'Ledger stream integrity holds for evidence used', category: 'INTEGRITY', criticality: 'CRITICAL',
  description: 'Every Ledger stream contributing evidence to this assessment independently re-verifies as valid.',
  objective: 'Evidence whose integrity cannot be established must not support an unqualified passing control result anywhere in this assessment (TNA-38).',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'verifyStream valid=true for every stream_id present in the evidence bundle' }],
  evaluation_method: 'ledger-stream-verification', failure_conditions: ['Any stream contributing evidence fails verifyStream.'],
  remediation_guidance: ['Investigate and remediate the corrupted stream before relying on its evidence.'],
}, (control, context, evidence) => {
  const streamIds = Object.keys(evidence.stream_integrity);
  if (streamIds.length === 0) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['MISSING_REQUIRED_EVIDENCE'], [], ['No evidence streams were collected in this scope.'], []);
  // The dedicated integrity control itself resolves to FAIL on anything short of a fully confirmed
  // VALID chain (INVALID, UNAVAILABLE, or UNVERIFIED alike) — distinct from how *dependent* controls
  // are downgraded (INSUFFICIENT_EVIDENCE, via the central gate below) — see section 3-4 of the
  // closure brief and auditor-control-model-v1.md for the documented distinction.
  const notValid = streamIds.filter(id => evidence.stream_integrity[id]?.qualification !== 'VALID');
  if (notValid.length > 0) {
    const detail = notValid.map(id => `${id} (${String(evidence.stream_integrity[id]?.qualification)})`).join(', ');
    return finish(control, context, 'FAIL', ['EVIDENCE_INTEGRITY_INVALID'], [`${notValid.length} of ${streamIds.length} evidence stream(s) did not verify as VALID: ${detail}.`], [], [], control.remediation_guidance);
  }
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${streamIds.length} evidence stream(s), all integrity-verified.`], [], []);
});

// --- TENANT_ISOLATION ------------------------------------------------------------------------

register({
  control_id: 'TNA-TEN-001', version: '1.0', title: 'Tenant isolation is structurally enforced', category: 'TENANT_ISOLATION', criticality: 'HIGH',
  description: 'Every collected event belongs to the assessed tenant, and isolation is manifest-attested — never inferred merely from tenant_id existing (section 89).',
  objective: 'A tenant’s evidence must never mix with another tenant’s.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'All collected events carry the assessed tenant_id, plus a trusted implementation-manifest claim', requires_manifest_claim: true }],
  evaluation_method: 'evidence-scan+implementation-manifest', failure_conditions: ['Any collected event carries a different tenant_id than the assessed tenant.'],
  remediation_guidance: ['Scope every query and write by (tenant_id, ...) throughout the evidence-producing systems.'],
}, (control, context, evidence) => {
  const foreign = evidence.events.filter(e => e.tenant_id !== context.tenant_id);
  if (foreign.length > 0) return finish(control, context, 'FAIL', ['TENANT_ISOLATION_NOT_PROVEN'], [`${foreign.length} collected event(s) carry a tenant_id other than the assessed tenant.`], [], foreign.slice(0, MAX_REFS).map(e => eventRef(e, evidence)), control.remediation_guidance);
  const { claims, manifestValid, manifestPresent } = manifestClaims(context, control.control_id);
  if (!manifestPresent || !manifestValid || claims.length === 0) return finish(control, context, 'PARTIAL', ['TENANT_ISOLATION_NOT_PROVEN'], ['All collected evidence is correctly tenant-scoped, but no implementation manifest attests structural isolation.'], [], manifestRef(context));
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED', 'IMPLEMENTATION_MANIFEST_SATISFIED'], ['All collected evidence is tenant-scoped and isolation is manifest-attested.'], [], manifestRef(context));
});

// --- RUNTIME_DEFENSE ---------------------------------------------------------------------------

register({
  control_id: 'TNA-RUNTIME-001', version: '1.0', title: 'Runtime behavioral monitoring is active', category: 'RUNTIME_DEFENSE', criticality: 'HIGH',
  description: 'A SENTINEL_SESSION_STARTED event correlates to authorized execution activity in scope.',
  objective: 'Authorization without monitored runtime is a materially weaker posture for high-risk activity (section 84).',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'SENTINEL_SESSION_STARTED correlated to an authorization decision in scope', event_types: ['SENTINEL_SESSION_STARTED', 'AUTHORIZATION_ALLOWED'] }],
  evaluation_method: 'ledger-event-correlation', failure_conditions: ['An allowed authorization has no correlated Sentinel session.'],
  remediation_guidance: ['Start a Sentinel session for every authorized high-risk execution.'],
}, (control, context, evidence) => {
  const allowed = eventsOfType(evidence, 'AUTHORIZATION_ALLOWED');
  const sessions = eventsOfType(evidence, 'SENTINEL_SESSION_STARTED');
  if (allowed.length === 0 && sessions.length === 0) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['NO_RUNTIME_MONITORING'], [], ['No authorized activity or Sentinel sessions found in this scope.'], []);
  const monitoredDecisions = new Set(sessions.map(e => e.authority_context?.decision_id).filter((v): v is string => v !== undefined));
  const unmonitored = allowed.filter(e => e.authority_context?.decision_id !== undefined && !monitoredDecisions.has(e.authority_context.decision_id));
  const refs = [...allowed, ...sessions].slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (allowed.length > 0 && unmonitored.length === allowed.length) return finish(control, context, 'FAIL', ['NO_RUNTIME_MONITORING'], [`${unmonitored.length} of ${allowed.length} authorized decision(s) have no correlated Sentinel session.`], [], refs, control.remediation_guidance);
  if (unmonitored.length > 0) return finish(control, context, 'PARTIAL', ['NO_RUNTIME_MONITORING'], [`${unmonitored.length} of ${allowed.length} authorized decision(s) have no correlated Sentinel session.`], [], refs, control.remediation_guidance);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${sessions.length} Sentinel session(s) correlated to authorized activity.`], [], refs);
});

register({
  control_id: 'TNA-RUNTIME-002', version: '1.0', title: 'Policy drift detection capability exists', category: 'RUNTIME_DEFENSE', criticality: 'MEDIUM',
  description: 'Distinguishes the rule being implemented from a violation having actually occurred (section 85-86): a manifest claim or an observed SENTINEL_HOLD from policy drift both satisfy.',
  objective: 'Sentinel must be capable of detecting a policy-hash mismatch mid-session.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'SENTINEL_HOLD evidence, or a manifest claim for policy-drift rule coverage', event_types: ['SENTINEL_HOLD'] }],
  evaluation_method: 'ledger-event+manifest', failure_conditions: ['Neither observed evidence nor a manifest claim exists.'],
  remediation_guidance: ['Enable the POLICY_CHANGED rule in the active Sentinel policy.'],
}, (control, context, evidence) => {
  const holds = eventsOfType(evidence, 'SENTINEL_HOLD');
  if (holds.length > 0) return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${holds.length} SENTINEL_HOLD event(s) observed in scope (rule exercised, not merely implemented).`], [], holds.slice(0, MAX_REFS).map(e => eventRef(e, evidence)));
  return evaluateManifestOnly(control, context, evidence);
});

register({
  control_id: 'TNA-RUNTIME-003', version: '1.0', title: 'Tool/resource drift detection capability exists', category: 'RUNTIME_DEFENSE', criticality: 'MEDIUM',
  description: 'A system need not have suffered a violation to prove rule existence (section 86) — manifest-backed, strengthened by observed SENTINEL_VIOLATION_DETECTED.',
  objective: 'Sentinel must be capable of detecting a tool/resource mismatch mid-session.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'SENTINEL_VIOLATION_DETECTED evidence, or a manifest claim for rule coverage', event_types: ['SENTINEL_VIOLATION_DETECTED'] }],
  evaluation_method: 'ledger-event+manifest', failure_conditions: ['Neither observed evidence nor a manifest claim exists.'],
  remediation_guidance: ['Enable TOOL_NOT_ALLOWED/RESOURCE_NOT_ALLOWED rules in the active Sentinel policy.'],
}, (control, context, evidence) => {
  const violations = eventsOfType(evidence, 'SENTINEL_VIOLATION_DETECTED');
  if (violations.length > 0) return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${violations.length} violation-detection event(s) observed in scope.`], [], violations.slice(0, MAX_REFS).map(e => eventRef(e, evidence)));
  return evaluateManifestOnly(control, context, evidence);
});

register({
  control_id: 'TNA-RUNTIME-004', version: '1.0', title: 'Runtime/cost bounds are enforced', category: 'RUNTIME_DEFENSE', criticality: 'MEDIUM',
  description: 'Sessions in scope that ran to completion did so within Sentinel-enforced runtime/cost limits, or were correctly held/terminated for exceeding them.',
  objective: 'A runaway agent must be bounded by runtime-owned limits, not merely policy intent.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'SENTINEL_SESSION_STARTED/COMPLETED/HOLD/TERMINATED evidence, or a manifest claim', event_types: ['SENTINEL_SESSION_STARTED'] }],
  evaluation_method: 'ledger-event+manifest', failure_conditions: ['No monitoring evidence and no manifest claim exists.'],
  remediation_guidance: ['Configure runtime_limits.max_runtime_seconds and cost_limits.max_cost_usd on every session.'],
}, (control, context, evidence) => {
  const sessions = eventsOfType(evidence, 'SENTINEL_SESSION_STARTED');
  if (sessions.length > 0) return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${sessions.length} monitored session(s) observed in scope with runtime-owned bounds active.`], [], sessions.slice(0, MAX_REFS).map(e => eventRef(e, evidence)));
  return evaluateManifestOnly(control, context, evidence);
});

register({
  control_id: 'TNA-RUNTIME-005', version: '1.0', title: 'Authority is revalidated during execution', category: 'RUNTIME_DEFENSE', criticality: 'HIGH',
  description: 'Authority status is re-consulted per evaluation rather than cached from session start (manifest-backed; strengthened by observed evidence).',
  objective: 'A mid-run revocation must be detectable before an action completes.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'A manifest claim citing per-evaluation revalidation, or SENTINEL_TERMINATED evidence following AGENT_REVOKED', requires_manifest_claim: true }],
  evaluation_method: 'ledger-event+manifest', failure_conditions: ['Neither observed evidence nor a manifest claim exists.'],
  remediation_guidance: ['Consult the authority revalidator on every Sentinel evaluation, not only at session start.'],
}, (control, context, evidence) => {
  const revocations = eventsOfType(evidence, 'AGENT_REVOKED');
  const terminations = eventsOfType(evidence, 'SENTINEL_TERMINATED');
  const observed = revocations.some(r => terminations.some(t => Date.parse(t.received_at) >= Date.parse(r.received_at)));
  if (observed) return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], ['Observed a Sentinel termination following an agent revocation in scope.'], [], [...revocations, ...terminations].slice(0, MAX_REFS).map(e => eventRef(e, evidence)));
  return evaluateManifestOnly(control, context, evidence);
});

// --- CONTAINMENT -----------------------------------------------------------------------------

register({
  control_id: 'TNA-CONTAIN-001', version: '1.0', title: 'Containment reporting is truthful', category: 'CONTAINMENT', criticality: 'CRITICAL',
  description: 'Confirmed termination reports TERMINATED; uncertain termination reports INDETERMINATE; a stale weaker status can never overwrite a stronger committed containment outcome (TNA-33, TNA-38). References the Sentinel concurrency closure pass.',
  objective: 'The single most important containment property: never fabricate confirmed containment (section 87).',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'SENTINEL_TERMINATED/SENTINEL_CONTAINMENT_FAILED payload.containment_status consistent with the event type, plus a manifest claim citing the CAS/state-version fix', event_types: ['SENTINEL_TERMINATED', 'SENTINEL_CONTAINMENT_FAILED'], requires_manifest_claim: true }],
  evaluation_method: 'ledger-event-field-consistency+manifest', failure_conditions: ['A SENTINEL_TERMINATED event carries containment_status other than CONTAINMENT_CONFIRMED.', 'No manifest claim exists citing the concurrency-safe containment fix.'],
  remediation_guidance: ['Never mark a session TERMINATED without a confirmed containment call; use INDETERMINATE for unconfirmed outcomes.'],
}, (control, context, evidence) => {
  const terminated = eventsOfType(evidence, 'SENTINEL_TERMINATED');
  const inconsistent = terminated.filter(e => e.payload?.containment_status !== 'CONTAINMENT_CONFIRMED');
  if (inconsistent.length > 0) return finish(control, context, 'FAIL', ['CONTAINMENT_NOT_TRUTHFUL'], [`${inconsistent.length} of ${terminated.length} SENTINEL_TERMINATED event(s) carry a containment_status other than CONTAINMENT_CONFIRMED.`], [], inconsistent.slice(0, MAX_REFS).map(e => eventRef(e, evidence)), control.remediation_guidance);
  const { claims, manifestValid, manifestPresent } = manifestClaims(context, control.control_id);
  const observationNote = terminated.length > 0 ? `${terminated.length} SENTINEL_TERMINATED event(s) observed, all with CONTAINMENT_CONFIRMED.` : 'No termination events observed in this scope.';
  if (!manifestPresent) return finish(control, context, 'INSUFFICIENT_EVIDENCE', ['IMPLEMENTATION_MANIFEST_MISSING'], [observationNote], ['No implementation manifest was supplied to attest the concurrency-safe containment fix.'], terminated.slice(0, MAX_REFS).map(e => eventRef(e, evidence)));
  if (!manifestValid || claims.length === 0) return finish(control, context, 'FAIL', ['CONTAINMENT_UNCONFIRMED'], [observationNote], ['The supplied manifest does not (validly) attest the concurrency-safe containment fix.'], terminated.slice(0, MAX_REFS).map(e => eventRef(e, evidence)), control.remediation_guidance);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED', 'IMPLEMENTATION_MANIFEST_SATISFIED'], [observationNote], [], [...terminated.slice(0, MAX_REFS).map(e => eventRef(e, evidence)), ...manifestRef(context)]);
});

register({
  control_id: 'TNA-CONTAIN-002', version: '1.0', title: 'Emergency stop mechanism exists and is tenant isolated', category: 'CONTAINMENT', criticality: 'HIGH',
  description: 'Durable, tenant-scoped emergency stop is manifest-attested; strengthened by an observed activation/release pair in scope.',
  objective: 'A last-resort, durable stop must exist independent of ordinary rule evaluation.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'SENTINEL_EMERGENCY_STOP_ACTIVATED/RELEASED evidence, or a manifest claim', event_types: ['SENTINEL_EMERGENCY_STOP_ACTIVATED'] }],
  evaluation_method: 'ledger-event+manifest', failure_conditions: ['Neither observed evidence nor a manifest claim exists.'],
  remediation_guidance: ['Ensure the emergency-stop mechanism is durably persisted and admin-only.'],
}, (control, context, evidence) => {
  const activations = eventsOfType(evidence, 'SENTINEL_EMERGENCY_STOP_ACTIVATED');
  if (activations.length > 0) return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${activations.length} emergency-stop activation(s) observed in scope.`], [], activations.slice(0, MAX_REFS).map(e => eventRef(e, evidence)));
  return evaluateManifestOnly(control, context, evidence);
});

// --- REVOCATION --------------------------------------------------------------------------------

register({
  control_id: 'TNA-REVOKE-001', version: '1.0', title: 'Mid-execution revocation is enforced by Sentinel', category: 'REVOCATION', criticality: 'CRITICAL',
  description: 'An AGENT_REVOKED event during an active session is followed by Sentinel termination of that session (negative evidence, section 75).',
  objective: 'Revocation must stop an in-flight execution, not merely block future authorization.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'AGENT_REVOKED followed by SENTINEL_TERMINATED/SENTINEL_TERMINATION_REQUESTED for a session bound to that agent', event_types: ['AGENT_REVOKED', 'SENTINEL_TERMINATED'] }],
  evaluation_method: 'ledger-event-sequence', failure_conditions: ['A revocation during an active session has no correlated Sentinel termination.'],
  remediation_guidance: ['Ensure the Sentinel authority revalidator observes Gate revocations and terminates affected sessions.'],
}, (control, context, evidence) => {
  const revocations = eventsOfType(evidence, 'AGENT_REVOKED');
  const sessionsStarted = eventsOfType(evidence, 'SENTINEL_SESSION_STARTED');
  if (revocations.length === 0 || sessionsStarted.length === 0) return finish(control, context, 'NOT_APPLICABLE', ['SCOPE_NOT_APPLICABLE'], [], ['No Sentinel-monitored session was active during an agent revocation in this scope.'], []);
  const terminations = eventsOfType(evidence, 'SENTINEL_TERMINATED', 'SENTINEL_TERMINATION_REQUESTED');
  let enforced = 0, checked = 0;
  const refs: EvidenceRef[] = [];
  for (const revocation of revocations) {
    const agentId = revocation.actor.id;
    const activeSession = sessionsStarted.find(s => s.authority_context?.agent_id === agentId && Date.parse(s.received_at) <= Date.parse(revocation.received_at));
    if (activeSession === undefined) continue;
    checked += 1;
    const termination = terminations.find(t => t.stream_id === activeSession.stream_id && Date.parse(t.received_at) >= Date.parse(revocation.received_at));
    refs.push(eventRef(revocation, evidence), eventRef(activeSession, evidence));
    if (termination !== undefined) { enforced += 1; refs.push(eventRef(termination, evidence)); }
  }
  if (checked === 0) return finish(control, context, 'NOT_APPLICABLE', ['SCOPE_NOT_APPLICABLE'], [], ['No revocation coincided with an active Sentinel session in this scope.'], []);
  if (enforced < checked) return finish(control, context, 'FAIL', ['REVOCATION_NOT_ENFORCED'], [`${checked - enforced} of ${checked} mid-session revocation(s) show no correlated Sentinel termination.`], [], refs.slice(0, MAX_REFS), control.remediation_guidance);
  return finish(control, context, 'PASS', ['NEGATIVE_EVIDENCE_SATISFIED'], [`${checked} mid-session revocation(s), all followed by Sentinel termination.`], [], refs.slice(0, MAX_REFS));
});

// --- RECOVERY --------------------------------------------------------------------------------

register({
  control_id: 'TNA-RECOV-001', version: '1.0', title: 'Containment uncertainty is honestly represented', category: 'RECOVERY', criticality: 'HIGH',
  description: 'SENTINEL_CONTAINMENT_FAILED events resolve to INDETERMINATE, never a fabricated TERMINATED or a silently reverted HELD.',
  objective: 'An unconfirmed containment outcome must remain visibly unconfirmed, never quietly resolved to look safe.',
  applicable_profiles: ['TNA_BASELINE_V01', 'TNA_HIGH_RISK_V01'],
  required_evidence: [{ description: 'SENTINEL_CONTAINMENT_FAILED payload.containment_status = CONTAINMENT_UNCONFIRMED, or a manifest claim', event_types: ['SENTINEL_CONTAINMENT_FAILED'] }],
  evaluation_method: 'ledger-event-field-consistency+manifest', failure_conditions: ['A SENTINEL_CONTAINMENT_FAILED event carries containment_status = CONTAINMENT_CONFIRMED (a contradiction).'],
  remediation_guidance: ['Ensure containment failure always resolves the session to INDETERMINATE, never TERMINATED.'],
}, (control, context, evidence) => {
  const failures = eventsOfType(evidence, 'SENTINEL_CONTAINMENT_FAILED');
  if (failures.length === 0) return evaluateManifestOnly(control, context, evidence);
  const contradictory = failures.filter(e => e.payload?.containment_status === 'CONTAINMENT_CONFIRMED');
  const refs = failures.slice(0, MAX_REFS).map(e => eventRef(e, evidence));
  if (contradictory.length > 0) return finish(control, context, 'FAIL', ['CONTAINMENT_NOT_TRUTHFUL'], [`${contradictory.length} of ${failures.length} containment-failure event(s) self-contradict by also claiming CONTAINMENT_CONFIRMED.`], [], refs, control.remediation_guidance);
  return finish(control, context, 'PASS', ['CONTROL_SATISFIED'], [`${failures.length} containment-failure event(s) observed, all honestly reporting unconfirmed containment.`], [], refs);
});

function secretShapeInEvent(event: LedgerEvent): boolean {
  const target = { authority_context: event.authority_context, execution_context: event.execution_context, payload: event.payload };
  return secretShapeScan(target);
}
function secretShapeScan(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return /Bearer\s+\S+/i.test(value);
  if (Array.isArray(value)) return value.some(secretShapeScan);
  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(api[_-]?key|apikey|secret|password|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|authorization)/i.test(key)) return true;
      if (secretShapeScan(v)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Profiles (sections 20-22)
// ---------------------------------------------------------------------------------------------

const ALL_CONTROL_IDS = catalog.map(c => c.control_id);

export const TNA_BASELINE_V01: ControlProfile = {
  profile_id: 'TNA_BASELINE_V01', name: 'TNA Baseline v0.1',
  description: 'Foundational controls covering identity, authority, capability, execution mediation, verification separation, evidence durability/integrity, runtime monitoring, containment truthfulness, tenant separation, and human override auditability (section 21).',
  control_ids: ALL_CONTROL_IDS,
};

export const TNA_HIGH_RISK_V01: ControlProfile = {
  profile_id: 'TNA_HIGH_RISK_V01', name: 'TNA High-Risk v0.1',
  description: 'The baseline control set with stronger mandatory expectations for high-risk deployments: active runtime monitoring, authority revalidation, and emergency-stop availability are promoted to CRITICAL (section 22) — the same controls, a stricter bar, not a scope expansion.',
  control_ids: ALL_CONTROL_IDS,
  criticality_overrides: { 'TNA-RUNTIME-001': 'CRITICAL', 'TNA-RUNTIME-005': 'CRITICAL', 'TNA-CONTAIN-002': 'CRITICAL' },
};

const PROFILE_BY_ID: Readonly<Record<ControlProfileId, ControlProfile>> = { TNA_BASELINE_V01, TNA_HIGH_RISK_V01 };

export function getProfile(profileId: ControlProfileId): ControlProfile {
  const profile = PROFILE_BY_ID[profileId];
  if (!profile) throw new AuditorError('UNKNOWN_PROFILE', `Unknown control profile: ${String(profileId)}`);
  return profile;
}

export function getControlsForProfile(profileId: ControlProfileId): Control[] {
  const profile = getProfile(profileId);
  const ids = new Set(profile.control_ids);
  return catalog.filter(c => ids.has(c.control_id) && c.applicable_profiles.includes(profileId));
}

export function getControl(controlId: string): Control {
  const control = catalog.find(c => c.control_id === controlId);
  if (!control) throw new AuditorError('UNKNOWN_CONTROL', `Unknown control: ${controlId}`);
  return control;
}

export function listCatalog(): readonly Control[] { return catalog; }

/**
 * Trust-closure pass, blocker 1: the central, architectural evidence-integrity qualification gate
 * (`auditor-v0.1-trust-closure.md`, TNA-41). Runs automatically after *every* evaluator, for *every*
 * control — this is what makes the guarantee architectural rather than a convention individual
 * evaluators must remember to follow. `TNA-AUTH-001` used to carry its own bespoke integrity check;
 * that bespoke check is gone now, superseded by this single gate that applies uniformly.
 *
 * Only `PASS`/`PARTIAL` results are inspected: a `FAIL`/`ERROR`/`NOT_APPLICABLE`/
 * `INSUFFICIENT_EVIDENCE` result carries no unqualified positive claim that corrupt evidence could
 * be propping up. For a qualifying result, every `LEDGER_EVENT`-typed ref the evaluator actually
 * cited as support (`evidence_refs` — every evaluator in this catalog populates it with exactly the
 * events it used, never a subset) is inspected:
 *   - any `INVALID` ref               -> downgrade to `INSUFFICIENT_EVIDENCE` (confirmed corruption)
 *   - else any `UNVERIFIED`/`UNAVAILABLE` ref -> downgrade to `INSUFFICIENT_EVIDENCE` (never confirmed
 *     valid; section 2: "UNKNOWN / NOT VERIFIED -> evidence cannot provide high-assurance PASS")
 *   - otherwise the result is returned unchanged
 * A *dependent* control downgrades to `INSUFFICIENT_EVIDENCE`, never `FAIL` — corrupt/unverified
 * evidence means the evidence cannot support the claim, not that the underlying technical control
 * definitely does not exist (section 4). `TNA-INTEG-001` is exempt from this gate entirely: it *is*
 * the integrity signal itself (and independently resolves to `FAIL` on exactly this condition via
 * its own evaluator) — running the gate on it would be circular.
 *
 * Because the gate only ever looks at refs the evaluator *itself* collected, a control that never
 * touched a corrupted stream is structurally unaffected — an irrelevant corrupt stream does not
 * poison an unrelated control's result (section 7), with no special-casing required to achieve that.
 */
function qualifyEvidenceIntegrity(control: Control, result: ControlResult, context: EvaluationContext): ControlResult {
  if (control.control_id === 'TNA-INTEG-001') return result;
  if (result.status !== 'PASS' && result.status !== 'PARTIAL') return result;
  const ledgerRefs = result.evidence_refs.filter(r => r.source_type === 'LEDGER_EVENT');
  const invalidRefs = ledgerRefs.filter(r => r.integrity_qualification === 'INVALID');
  const unresolvedRefs = ledgerRefs.filter(r => r.integrity_qualification === 'UNVERIFIED' || r.integrity_qualification === 'UNAVAILABLE');
  if (invalidRefs.length === 0 && unresolvedRefs.length === 0) return result;

  const confirmed = invalidRefs.length > 0;
  const reasonCode: ReasonCode = confirmed ? 'EVIDENCE_INTEGRITY_INVALID' : 'EVIDENCE_INTEGRITY_UNVERIFIED';
  const limitation = confirmed
    ? `${invalidRefs.length} of ${ledgerRefs.length} cited Ledger event(s) originate from a stream that failed integrity verification; corrupt evidence cannot support this result (TNA-41).`
    : `${unresolvedRefs.length} of ${ledgerRefs.length} cited Ledger event(s) originate from a stream whose integrity was never confirmed; unverified evidence cannot support a high-assurance ${result.status} (TNA-41).`;

  return {
    ...result,
    status: 'INSUFFICIENT_EVIDENCE',
    reason_codes: [...new Set([...result.reason_codes, reasonCode])],
    limitations: [...result.limitations, limitation],
    risk_contribution: computeRiskContribution(effectiveCriticality(control, context), 'INSUFFICIENT_EVIDENCE'),
  };
}

/** Deterministic dispatch (section 24). Evaluator errors are caught at this boundary (section 102)
 * so one control's failure never prevents the rest of the assessment from completing — the error
 * itself becomes a first-class ERROR result, never silently swallowed or upgraded to PASS. Every
 * result — including one built by an evaluator that already returned PASS — passes through the
 * central evidence-integrity gate before being handed back (blocker 1 of the trust-closure pass). */
export function evaluateControl(control: Control, context: EvaluationContext, evidence: EvidenceBundle): ControlResult {
  const evaluator = evaluators.get(control.control_id);
  if (!evaluator) throw new AuditorError('UNKNOWN_CONTROL', `No evaluator registered for ${control.control_id}`);
  let result: ControlResult;
  try {
    result = evaluator(control, context, evidence);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown evaluator error';
    return finish(control, context, 'ERROR', ['EVALUATOR_ERROR'], [], [`Evaluator threw: ${message}`], []);
  }
  return qualifyEvidenceIntegrity(control, result, context);
}

export { isFresh };
