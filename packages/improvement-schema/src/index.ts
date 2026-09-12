import { createHash, randomUUID } from 'node:crypto';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12). Domain types, validation, canonicalization, and
 * PURE decision functions for the improvement control plane. This package holds no I/O (no SQLite, no
 * HTTP, no filesystem) — exactly like `client-schema`/`mcp-schema` before it — so that every authority/
 * capability/promotion decision function here is trivially unit-testable and cannot itself perform a
 * side effect.
 *
 * TNA-72 through TNA-81 (see `docs/improvement/`) are the principles this package exists to enforce
 * structurally: competence change, authority change, and control-plane change are three different kinds
 * of change, and this file is where that distinction is drawn as actual types and functions, not prose.
 */

// ---------------------------------------------------------------------------------------------
// Shared primitives (deliberately duplicated from client-schema/mcp-schema/deployment-schema rather
// than imported — this project's established convention is per-volume schema independence).
// ---------------------------------------------------------------------------------------------

export type ImprovementErrorCode =
  | 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'PAYLOAD_TOO_LARGE'
  | 'SPEC_IMMUTABLE' | 'CROSS_TENANT_DENIED' | 'LINEAGE_CYCLE' | 'BUDGET_EXHAUSTED'
  | 'AUTHORITY_CEILING_VIOLATION' | 'CONTROL_PLANE_VIOLATION' | 'EVALUATOR_TAMPERED' | 'TEST_TAMPERED';

export class ImprovementError extends Error {
  public constructor(public readonly code: ImprovementErrorCode, message: string) {
    super(message);
    this.name = 'ImprovementError';
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function safeId(value: unknown, maxLen = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
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
export function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|secret|password|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|authorization|credential|signing[_-]?key|token)/i;
const SECRET_VALUE_PATTERN = /Bearer\s+\S+/i;
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

function containsSecretShapedValue(value: unknown): boolean {
  if (typeof value === 'string') return SECRET_VALUE_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsSecretShapedValue);
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(containsSecretShapedValue);
  return false;
}

function idMinter(prefix: string): () => string { return () => `${prefix}_${randomUUID()}`; }
export const newGenerationId = idMinter('gen');
export const newSpecId = idMinter('spec');
export const newExpansionRequestId = idMinter('aexp');
export const newPromotionDecisionId = idMinter('promo');
export const newCanaryRunId = idMinter('canary');
export const newRollbackRecordId = idMinter('rb');
export const newEvaluationRunId = idMinter('eval');
export const newSystemId = idMinter('sys');

// ---------------------------------------------------------------------------------------------
// Section 6: generation states. Section 5: ImprovementGeneration v1.
// ---------------------------------------------------------------------------------------------

export const GENERATION_STATES = [
  'PROPOSED', 'AUTHORIZED', 'BUILDING', 'BUILT', 'EVALUATING', 'EVALUATED', 'REJECTED',
  'AWAITING_APPROVAL', 'CANARY', 'PROMOTED', 'ROLLED_BACK', 'FAILED', 'INDETERMINATE',
] as const;
export type GenerationState = typeof GENERATION_STATES[number];

/** Section 6: deterministic legal transitions — a generation state machine, not an arbitrary string
 * field. Terminal states (REJECTED, PROMOTED, ROLLED_BACK, FAILED) have no outgoing edges except
 * ROLLED_BACK, which a PROMOTED generation can reach, and INDETERMINATE, which is reachable from most
 * in-flight states when evidence becomes uncertain rather than cleanly negative. */
export const GENERATION_TRANSITIONS: Readonly<Record<GenerationState, readonly GenerationState[]>> = {
  PROPOSED: ['AUTHORIZED', 'REJECTED'],
  AUTHORIZED: ['BUILDING', 'REJECTED'],
  BUILDING: ['BUILT', 'FAILED', 'INDETERMINATE'],
  BUILT: ['EVALUATING'],
  EVALUATING: ['EVALUATED', 'REJECTED', 'INDETERMINATE'],
  EVALUATED: ['AWAITING_APPROVAL', 'REJECTED', 'CANARY'],
  AWAITING_APPROVAL: ['CANARY', 'REJECTED'],
  CANARY: ['PROMOTED', 'ROLLED_BACK', 'REJECTED', 'INDETERMINATE'],
  PROMOTED: ['ROLLED_BACK'],
  ROLLED_BACK: [],
  REJECTED: [],
  FAILED: [],
  INDETERMINATE: [],
};
export function canTransition(from: GenerationState, to: GenerationState): boolean {
  return GENERATION_TRANSITIONS[from].includes(to);
}

export interface ImprovementGeneration {
  readonly generation_id: string;
  readonly tenant_id: string;
  readonly system_id: string;
  readonly parent_generation_id: string | null;
  readonly root_generation_id: string;
  readonly generation_number: number;
  readonly candidate_version: string;
  readonly status: GenerationState;
  readonly improvement_class: ImprovementClass;
  readonly spec_hash: string;
  readonly source_hash_before: string;
  readonly source_hash_after: string | null;
  readonly authority_profile_before: AuthorityCeiling;
  readonly authority_profile_after: AuthorityCeiling | null;
  readonly authority_delta: AuthorityDelta | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly state_version: number;
}

// ---------------------------------------------------------------------------------------------
// Section 9: improvement classes. Section 10: risk increases with class.
// ---------------------------------------------------------------------------------------------

export const IMPROVEMENT_CLASSES = [
  'CLASS_0_CONFIG', 'CLASS_1_CODE', 'CLASS_2_TOOL', 'CLASS_3_MODEL', 'CLASS_4_CONTROL_PLANE', 'CLASS_5_AUTHORITY_OR_EVALUATOR',
] as const;
export type ImprovementClass = typeof IMPROVEMENT_CLASSES[number];
const CLASS_RANK: Readonly<Record<ImprovementClass, number>> = {
  CLASS_0_CONFIG: 0, CLASS_1_CODE: 1, CLASS_2_TOOL: 2, CLASS_3_MODEL: 3, CLASS_4_CONTROL_PLANE: 4, CLASS_5_AUTHORITY_OR_EVALUATOR: 5,
};
export function classAtLeast(cls: ImprovementClass, minimum: ImprovementClass): boolean { return CLASS_RANK[cls] >= CLASS_RANK[minimum]; }

export interface ImprovementClassPolicy {
  readonly allow_automated_promotion: boolean;
  readonly requires_human_approval: boolean;
  readonly requires_independent_review: boolean;
  readonly allow_self_promotion: false; // never true for any class — section 52
}
/** Section 10: the deterministic per-class policy table. Class 4/5 always require human approval and
 * forbid automated promotion regardless of benchmark score (section 10, 39-40). No class ever allows
 * self-promotion (section 52) — that field exists only so callers cannot construct a policy value that
 * claims otherwise. */
export const CLASS_POLICY: Readonly<Record<ImprovementClass, ImprovementClassPolicy>> = {
  CLASS_0_CONFIG: { allow_automated_promotion: true, requires_human_approval: false, requires_independent_review: false, allow_self_promotion: false },
  CLASS_1_CODE: { allow_automated_promotion: true, requires_human_approval: false, requires_independent_review: false, allow_self_promotion: false },
  CLASS_2_TOOL: { allow_automated_promotion: false, requires_human_approval: true, requires_independent_review: false, allow_self_promotion: false },
  CLASS_3_MODEL: { allow_automated_promotion: false, requires_human_approval: true, requires_independent_review: false, allow_self_promotion: false },
  CLASS_4_CONTROL_PLANE: { allow_automated_promotion: false, requires_human_approval: true, requires_independent_review: false, allow_self_promotion: false },
  CLASS_5_AUTHORITY_OR_EVALUATOR: { allow_automated_promotion: false, requires_human_approval: true, requires_independent_review: true, allow_self_promotion: false },
};

// ---------------------------------------------------------------------------------------------
// Section 7-8: ImprovementSpec v1, immutable once AUTHORIZED (TNA-15).
// ---------------------------------------------------------------------------------------------

export interface ResourceLimits {
  readonly max_runtime_ms: number;
  readonly max_cost_usd: number;
  readonly max_tool_calls: number;
  readonly max_external_calls: number;
  readonly max_changed_files: number;
  readonly max_changed_bytes: number;
}

export interface CanaryPolicy {
  readonly traffic_percent: number;
  readonly max_actions: number;
  readonly max_runtime_ms: number;
  readonly failure_threshold: number;
  readonly sentinel_terminate_is_failure: boolean;
  readonly cost_threshold_usd: number;
}

export interface RollbackPolicy {
  readonly rollback_generation_id: string | null;
  readonly auto_rollback_triggers: readonly RollbackTrigger[];
}
export const ROLLBACK_TRIGGERS = [
  'SECURITY_REGRESSION', 'SENTINEL_TERMINATE_THRESHOLD', 'ERROR_RATE', 'COST_EXPLOSION',
  'LATENCY_THRESHOLD', 'EVIDENCE_FAILURE', 'UNEXPECTED_CAPABILITY', 'CANARY_HEALTH_FAILURE',
] as const;
export type RollbackTrigger = typeof ROLLBACK_TRIGGERS[number];

export interface ImprovementSpec {
  readonly spec_id: string;
  readonly system_id: string;
  readonly tenant_id: string;
  readonly parent_generation_id: string | null;
  readonly objective: string;
  readonly improvement_class: ImprovementClass;
  readonly allowed_mutation_paths: readonly string[];
  readonly forbidden_mutation_paths: readonly string[];
  readonly allowed_tool_changes: readonly string[];
  readonly allowed_dependency_changes: readonly string[];
  readonly allowed_model_changes: readonly string[];
  readonly authority_ceiling: AuthorityCeiling;
  readonly resource_limits: ResourceLimits;
  readonly evaluation_profile_id: string;
  readonly required_benchmarks: readonly string[];
  readonly required_security_tests: readonly string[];
  readonly promotion_thresholds: Readonly<Record<string, number>>;
  readonly canary_policy: CanaryPolicy;
  readonly rollback_policy: RollbackPolicy;
  readonly max_iterations: number;
  readonly max_runtime_ms: number;
  readonly max_cost_usd: number;
  readonly created_by: string;
  readonly created_at: string;
  readonly spec_hash: string;
}

export type ImprovementSpecInput = Omit<ImprovementSpec, 'spec_id' | 'created_at' | 'spec_hash'>;

const SPEC_INPUT_FIELDS = [
  'system_id', 'tenant_id', 'parent_generation_id', 'objective', 'improvement_class', 'allowed_mutation_paths',
  'forbidden_mutation_paths', 'allowed_tool_changes', 'allowed_dependency_changes', 'allowed_model_changes',
  'authority_ceiling', 'resource_limits', 'evaluation_profile_id', 'required_benchmarks', 'required_security_tests',
  'promotion_thresholds', 'canary_policy', 'rollback_policy', 'max_iterations', 'max_runtime_ms', 'max_cost_usd', 'created_by',
];

/** Section 7: builds and hashes an `ImprovementSpec` from trusted orchestration input. This function
 * itself is the boundary at which a raw `ImprovementProposal` (untrusted, section 26-27) must have
 * already been normalized — it never accepts a `spec_hash`, `spec_id`, or `created_at` from the caller,
 * all three are runtime-owned. */
export function buildImprovementSpec(input: ImprovementSpecInput): ImprovementSpec {
  if (!isPlainObject(input)) throw new ImprovementError('INVALID_INPUT', 'Improvement spec input must be an object');
  for (const key of Object.keys(input)) if (!SPEC_INPUT_FIELDS.includes(key)) throw new ImprovementError('INVALID_INPUT', `Unknown spec field: ${key}`);
  if (!safeId(input.system_id)) throw new ImprovementError('INVALID_INPUT', 'system_id must be a safe identifier');
  if (!safeId(input.tenant_id)) throw new ImprovementError('INVALID_INPUT', 'tenant_id must be a safe identifier');
  if (input.parent_generation_id !== null && !safeId(input.parent_generation_id)) throw new ImprovementError('INVALID_INPUT', 'parent_generation_id must be null or a safe identifier');
  if (typeof input.objective !== 'string' || input.objective.length === 0 || input.objective.length > 4000) throw new ImprovementError('INVALID_INPUT', 'objective must be a non-empty bounded string');
  if (!(IMPROVEMENT_CLASSES as readonly string[]).includes(input.improvement_class)) throw new ImprovementError('INVALID_INPUT', `improvement_class must be one of: ${IMPROVEMENT_CLASSES.join(', ')}`);
  for (const field of ['allowed_mutation_paths', 'forbidden_mutation_paths', 'allowed_tool_changes', 'allowed_dependency_changes', 'allowed_model_changes', 'required_benchmarks', 'required_security_tests'] as const) {
    if (!Array.isArray(input[field]) || !(input[field] as unknown[]).every(v => typeof v === 'string')) throw new ImprovementError('INVALID_INPUT', `${field} must be an array of strings`);
  }
  if (input.allowed_mutation_paths.length === 0) throw new ImprovementError('INVALID_INPUT', 'allowed_mutation_paths must declare at least one path — an unbounded mutation scope is never valid');
  // A scoped value-only scan, deliberately NOT `findSecretShapedField`'s key-name scan: `authority_ceiling`
  // legitimately has a field literally named `credentials` (a list of credential-reference identifiers,
  // never secret material) — key-name scanning the whole spec object would reject that legitimate field.
  // Scanning every string LEAF for a bearer-token-shaped VALUE still catches an actual pasted secret
  // anywhere in the spec without that false positive.
  if (containsSecretShapedValue(input)) throw new ImprovementError('INVALID_INPUT', 'Improvement spec input rejected: a field contains a secret-shaped value');
  const withoutHash: Omit<ImprovementSpec, 'spec_hash'> = { ...input, spec_id: newSpecId(), created_at: new Date().toISOString() };
  return { ...withoutHash, spec_hash: hash(withoutHash) };
}

// ---------------------------------------------------------------------------------------------
// Section 11-14: AuthorityCeiling v1, containment, delta, AuthorityExpansionRequest v1.
// ---------------------------------------------------------------------------------------------

export interface AuthorityCeiling {
  readonly operations: readonly string[];
  readonly tools: readonly string[];
  readonly resources: readonly string[];
  readonly destinations: readonly string[];
  readonly network_access: boolean;
  readonly filesystem_scope: readonly string[];
  readonly credentials: readonly string[];
  readonly max_budget_usd: number;
  readonly max_runtime_ms: number;
  readonly max_parallelism: number;
  readonly external_side_effects: boolean;
  readonly requires_approval_for: readonly string[];
}

function isSubset(child: readonly string[], parent: readonly string[]): boolean {
  const parentSet = new Set(parent);
  return child.every(v => parentSet.has(v));
}

/** Section 12: `successor_authority ⊆ approved_authority_ceiling`. Every array-shaped field of `child`
 * must be a subset of the same field on `ceiling`; every numeric field must not exceed it; a boolean
 * field on `child` may only be `true` if it is also `true` on `ceiling`. */
export function authorityWithinCeiling(child: AuthorityCeiling, ceiling: AuthorityCeiling): boolean {
  return isSubset(child.operations, ceiling.operations)
    && isSubset(child.tools, ceiling.tools)
    && isSubset(child.resources, ceiling.resources)
    && isSubset(child.destinations, ceiling.destinations)
    && isSubset(child.filesystem_scope, ceiling.filesystem_scope)
    && isSubset(child.credentials, ceiling.credentials)
    && (!child.network_access || ceiling.network_access)
    && (!child.external_side_effects || ceiling.external_side_effects)
    && child.max_budget_usd <= ceiling.max_budget_usd
    && child.max_runtime_ms <= ceiling.max_runtime_ms
    && child.max_parallelism <= ceiling.max_parallelism;
}

export interface AuthorityDelta {
  readonly added_operations: readonly string[];
  readonly added_tools: readonly string[];
  readonly added_resources: readonly string[];
  readonly added_destinations: readonly string[];
  readonly added_filesystem_scope: readonly string[];
  readonly added_credentials: readonly string[];
  readonly removed_operations: readonly string[];
  readonly removed_tools: readonly string[];
  readonly removed_resources: readonly string[];
  readonly network_access_gained: boolean;
  readonly external_side_effects_gained: boolean;
  readonly budget_increased: boolean;
  readonly runtime_increased: boolean;
  readonly parallelism_increased: boolean;
  readonly is_expansion: boolean;
  readonly is_reduction: boolean;
  readonly delta_hash: string;
}
function added<T>(before: readonly T[], after: readonly T[]): readonly T[] { const b = new Set(before); return after.filter(v => !b.has(v)); }
function removed<T>(before: readonly T[], after: readonly T[]): readonly T[] { const a = new Set(after); return before.filter(v => !a.has(v)); }

/** Section 76-77: any non-empty delta must be computed and surfaced — never buried. A candidate MAY
 * reduce its own authority (section 77); the reduction is still recorded, not treated as "no delta". */
export function computeAuthorityDelta(before: AuthorityCeiling, after: AuthorityCeiling): AuthorityDelta {
  const addedOps = added(before.operations, after.operations);
  const addedTools = added(before.tools, after.tools);
  const addedResources = added(before.resources, after.resources);
  const addedDestinations = added(before.destinations, after.destinations);
  const addedFs = added(before.filesystem_scope, after.filesystem_scope);
  const addedCreds = added(before.credentials, after.credentials);
  const removedOps = removed(before.operations, after.operations);
  const removedTools = removed(before.tools, after.tools);
  const removedResources = removed(before.resources, after.resources);
  const networkGained = !before.network_access && after.network_access;
  const sideEffectsGained = !before.external_side_effects && after.external_side_effects;
  const budgetIncreased = after.max_budget_usd > before.max_budget_usd;
  const runtimeIncreased = after.max_runtime_ms > before.max_runtime_ms;
  const parallelismIncreased = after.max_parallelism > before.max_parallelism;
  const isExpansion = addedOps.length > 0 || addedTools.length > 0 || addedResources.length > 0 || addedDestinations.length > 0
    || addedFs.length > 0 || addedCreds.length > 0 || networkGained || sideEffectsGained || budgetIncreased || runtimeIncreased || parallelismIncreased;
  const isReduction = removedOps.length > 0 || removedTools.length > 0 || removedResources.length > 0
    || (before.network_access && !after.network_access) || (before.external_side_effects && !after.external_side_effects)
    || after.max_budget_usd < before.max_budget_usd || after.max_runtime_ms < before.max_runtime_ms || after.max_parallelism < before.max_parallelism;
  const withoutHash = {
    added_operations: addedOps, added_tools: addedTools, added_resources: addedResources, added_destinations: addedDestinations,
    added_filesystem_scope: addedFs, added_credentials: addedCreds, removed_operations: removedOps, removed_tools: removedTools,
    removed_resources: removedResources, network_access_gained: networkGained, external_side_effects_gained: sideEffectsGained,
    budget_increased: budgetIncreased, runtime_increased: runtimeIncreased, parallelism_increased: parallelismIncreased,
    is_expansion: isExpansion, is_reduction: isReduction,
  };
  return { ...withoutHash, delta_hash: hash(withoutHash) };
}

export const AUTHORITY_EXPANSION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type AuthorityExpansionStatus = typeof AUTHORITY_EXPANSION_STATUSES[number];
export interface AuthorityExpansionRequest {
  readonly request_id: string;
  readonly generation_id: string;
  readonly tenant_id: string;
  readonly requested_delta: AuthorityDelta;
  readonly reason: string;
  readonly risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly requested_by: string;
  readonly status: AuthorityExpansionStatus;
  readonly approved_by: string | null;
  readonly decision_reason: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
  readonly state_version: number;
}

// ---------------------------------------------------------------------------------------------
// Section 41-43, 78: CapabilityProfile / CapabilityDeltaReport, unexpected-gain detection.
// ---------------------------------------------------------------------------------------------

export interface CapabilityProfile {
  readonly tools: readonly string[];
  readonly operations: readonly string[];
  readonly resources: readonly string[];
  readonly destinations: readonly string[];
  readonly filesystem_writes: boolean;
  readonly network_access: boolean;
  readonly credential_access: readonly string[];
  readonly code_execution: boolean;
  readonly max_parallelism: number;
  readonly side_effect_classes: readonly string[];
}

export interface CapabilityDeltaReport {
  readonly generation_id: string;
  readonly added_tools: readonly string[];
  readonly added_operations: readonly string[];
  readonly added_resources: readonly string[];
  readonly added_destinations: readonly string[];
  readonly added_credential_access: readonly string[];
  readonly added_side_effect_classes: readonly string[];
  readonly filesystem_writes_gained: boolean;
  readonly network_access_gained: boolean;
  readonly code_execution_gained: boolean;
  readonly parallelism_increased: boolean;
  readonly has_unexpected_gain: boolean;
  readonly unexpected_reasons: readonly string[];
  readonly report_hash: string;
}

/** Section 41-42: compares parent vs candidate capability profiles. `allowedGrowth`, when supplied, is
 * whatever the spec/class explicitly authorized (e.g. a Class 2 spec's `allowed_tool_changes`) — any
 * capability gained OUTSIDE that explicit allowance is flagged as unexpected (section 42: "Do not reward
 * emergent capability blindly"). With no `allowedGrowth` supplied, ANY gain at all is unexpected — the
 * conservative default for a Class 0/1 candidate, which should not be gaining capability at all. */
export function computeCapabilityDelta(
  generationId: string, parent: CapabilityProfile, candidate: CapabilityProfile,
  allowedGrowth?: { readonly tools?: readonly string[]; readonly operations?: readonly string[]; readonly resources?: readonly string[]; readonly destinations?: readonly string[]; readonly allowFilesystemWrites?: boolean; readonly allowNetworkAccess?: boolean; readonly allowCodeExecution?: boolean },
): CapabilityDeltaReport {
  const addedTools = added(parent.tools, candidate.tools);
  const addedOperations = added(parent.operations, candidate.operations);
  const addedResources = added(parent.resources, candidate.resources);
  const addedDestinations = added(parent.destinations, candidate.destinations);
  const addedCredentialAccess = added(parent.credential_access, candidate.credential_access);
  const addedSideEffectClasses = added(parent.side_effect_classes, candidate.side_effect_classes);
  const filesystemWritesGained = !parent.filesystem_writes && candidate.filesystem_writes;
  const networkAccessGained = !parent.network_access && candidate.network_access;
  const codeExecutionGained = !parent.code_execution && candidate.code_execution;
  const parallelismIncreased = candidate.max_parallelism > parent.max_parallelism;

  const allowedTools = new Set(allowedGrowth?.tools ?? []);
  const allowedOperations = new Set(allowedGrowth?.operations ?? []);
  const allowedResources = new Set(allowedGrowth?.resources ?? []);
  const allowedDestinations = new Set(allowedGrowth?.destinations ?? []);

  const unexpectedReasons: string[] = [];
  const unlistedTools = addedTools.filter(t => !allowedTools.has(t));
  if (unlistedTools.length > 0) unexpectedReasons.push(`unauthorized new tool(s): ${unlistedTools.join(', ')}`);
  const unlistedOps = addedOperations.filter(o => !allowedOperations.has(o));
  if (unlistedOps.length > 0) unexpectedReasons.push(`unauthorized new operation(s): ${unlistedOps.join(', ')}`);
  const unlistedResources = addedResources.filter(r => !allowedResources.has(r));
  if (unlistedResources.length > 0) unexpectedReasons.push(`unauthorized new resource(s): ${unlistedResources.join(', ')}`);
  const unlistedDestinations = addedDestinations.filter(d => !allowedDestinations.has(d));
  if (unlistedDestinations.length > 0) unexpectedReasons.push(`unauthorized new destination(s): ${unlistedDestinations.join(', ')}`);
  if (addedCredentialAccess.length > 0) unexpectedReasons.push(`unauthorized new credential access: ${addedCredentialAccess.join(', ')}`);
  if (filesystemWritesGained && !allowedGrowth?.allowFilesystemWrites) unexpectedReasons.push('unauthorized filesystem-write capability gained');
  if (networkAccessGained && !allowedGrowth?.allowNetworkAccess) unexpectedReasons.push('unauthorized network-access capability gained');
  if (codeExecutionGained && !allowedGrowth?.allowCodeExecution) unexpectedReasons.push('unauthorized code-execution capability gained');

  const withoutHash = {
    generation_id: generationId, added_tools: addedTools, added_operations: addedOperations, added_resources: addedResources,
    added_destinations: addedDestinations, added_credential_access: addedCredentialAccess, added_side_effect_classes: addedSideEffectClasses,
    filesystem_writes_gained: filesystemWritesGained, network_access_gained: networkAccessGained, code_execution_gained: codeExecutionGained,
    parallelism_increased: parallelismIncreased, has_unexpected_gain: unexpectedReasons.length > 0, unexpected_reasons: unexpectedReasons,
  };
  return { ...withoutHash, report_hash: hash(withoutHash) };
}

// ---------------------------------------------------------------------------------------------
// Section 15-16, 78-80: control-plane mutation boundary. The evaluator must sit OUTSIDE the mutation
// boundary (section 16) — enforced here as a fixed, non-candidate-configurable path list.
// ---------------------------------------------------------------------------------------------

/** Section 15: default forbidden mutation paths — the accepted control components. A Class 4/5 spec may
 * explicitly override a subset via its own `allowed_mutation_paths`, but the evaluator's own path
 * (`packages/improvement-evaluator/`) can NEVER be listed as allowed for ANY class, by construction
 * (section 16) — see `classifyMutation`, which checks this unconditionally, before consulting the spec. */
export const DEFAULT_FORBIDDEN_MUTATION_PATH_PREFIXES: readonly string[] = [
  'apps/tna-gate-api/', 'packages/shared-schema/', 'packages/policy-engine/', 'packages/capability-core/',
  'packages/authority-envelope/', 'packages/execution-broker/', 'packages/isolation-runner/', 'packages/egress-guard/',
  'apps/tna-sentinel/', 'packages/sentinel-engine/', 'packages/sentinel-policy/', 'packages/sentinel-runtime/',
  'packages/sentinel-schema/', 'packages/sentinel-signals/',
  'packages/vad-core/', 'packages/vad-runtime/', 'packages/verifier-core/', 'packages/validation-gate/', 'packages/evidence-core/',
  'packages/ledger-core/', 'packages/ledger-integrity/', 'packages/ledger-query/', 'packages/ledger-schema/', 'packages/ledger-store/',
  'apps/tna-auditor/', 'packages/auditor-controls/', 'packages/auditor-engine/', 'packages/auditor-evidence/',
  'packages/auditor-report/', 'packages/auditor-risk/', 'packages/auditor-schema/',
  'packages/deployment-ops/', 'packages/deployment-health/', 'packages/deployment-schema/',
  'tests/',
];
/** The evaluator's own path is never mutable by any candidate of any class — this is the structural
 * enforcement of section 16 ("the candidate may not modify the evaluator that decides whether that same
 * candidate passes"), and it is checked unconditionally in `classifyMutation`, never overridable by a
 * spec's `allowed_mutation_paths`. */
export const EVALUATOR_PATH_PREFIX = 'packages/improvement-evaluator/';

export type MutationArea = 'application' | 'test' | 'config' | 'tool' | 'model' | 'policy' | 'gate' | 'sentinel' | 'vad' | 'ledger' | 'auditor' | 'deployment' | 'evaluation' | 'other';

function classifyArea(path: string): MutationArea {
  if (path.startsWith('tests/')) return 'test';
  if (path.startsWith('apps/tna-gate-api/') || path.startsWith('packages/shared-schema/') || path.startsWith('packages/policy-engine/') || path.startsWith('packages/capability-core/') || path.startsWith('packages/authority-envelope/')) return 'gate';
  if (path.startsWith('apps/tna-sentinel/') || path.startsWith('packages/sentinel-')) return 'sentinel';
  if (path.startsWith('packages/vad-') || path.startsWith('packages/verifier-core/') || path.startsWith('packages/validation-gate/') || path.startsWith('packages/evidence-core/')) return 'vad';
  if (path.startsWith('packages/ledger-')) return 'ledger';
  if (path.startsWith('apps/tna-auditor/') || path.startsWith('packages/auditor-')) return 'auditor';
  if (path.startsWith('packages/deployment-')) return 'deployment';
  if (path.startsWith(EVALUATOR_PATH_PREFIX) || path.startsWith('packages/improvement-')) return 'evaluation';
  if (path.startsWith('academy/') || path.includes('config')) return 'config';
  if (path.includes('/tools/') || path.includes('mcp-')) return 'tool';
  if (path.includes('model')) return 'model';
  return 'application';
}

export interface MutationDiffReport {
  readonly generation_id: string;
  readonly touched_areas: readonly MutationArea[];
  readonly control_plane_changed: boolean;
  readonly evaluator_changed: boolean;
  readonly out_of_scope_paths: readonly string[];
  readonly forbidden_paths_touched: readonly string[];
  readonly report_hash: string;
}

const CONTROL_PLANE_AREAS: readonly MutationArea[] = ['gate', 'sentinel', 'vad', 'ledger', 'auditor', 'evaluation'];

/** Section 15, 78-80, 86-90: classifies every changed path. `control_plane_changed` and
 * `forbidden_paths_touched` are computed from `DEFAULT_FORBIDDEN_MUTATION_PATH_PREFIXES` alone —
 * deliberately NOT suppressed by anything `spec.allowed_mutation_paths` claims. Whether a Class 4/5 spec
 * legitimately explicitly authorized touching a control-plane path is a CLASS-based judgment made later,
 * by `evaluatePromotion` (which has both this report and the candidate's class available) — never
 * silenced here before that governance even runs (that would let a low-class spec simply declare the
 * forbidden path "allowed" in its own `allowed_mutation_paths` and erase the signal entirely). The
 * evaluator path is additionally always flagged regardless of any spec field, for the same reason.
 * `out_of_scope_paths` is a separate, unrelated signal: paths the spec's own declared editing area never
 * covers at all, regardless of control-plane sensitivity. */
export function classifyMutation(generationId: string, changedPaths: readonly string[], spec: Pick<ImprovementSpec, 'allowed_mutation_paths' | 'forbidden_mutation_paths'>): MutationDiffReport {
  const touchedAreas = Array.from(new Set(changedPaths.map(classifyArea)));
  const evaluatorChanged = changedPaths.some(p => p.startsWith(EVALUATOR_PATH_PREFIX));
  const explicitlyForbidden = changedPaths.filter(p => spec.forbidden_mutation_paths.some(f => p.startsWith(f)));
  const defaultForbidden = changedPaths.filter(p => DEFAULT_FORBIDDEN_MUTATION_PATH_PREFIXES.some(f => p.startsWith(f)));
  const forbiddenPathsTouched = Array.from(new Set([...explicitlyForbidden, ...defaultForbidden]));
  const outOfScope = changedPaths.filter(p => !spec.allowed_mutation_paths.some(a => p.startsWith(a)));
  const controlPlaneChanged = touchedAreas.some(a => CONTROL_PLANE_AREAS.includes(a));
  const withoutHash = {
    generation_id: generationId, touched_areas: touchedAreas, control_plane_changed: controlPlaneChanged,
    evaluator_changed: evaluatorChanged, out_of_scope_paths: outOfScope, forbidden_paths_touched: forbiddenPathsTouched,
  };
  return { ...withoutHash, report_hash: hash(withoutHash) };
}

// ---------------------------------------------------------------------------------------------
// Section 17-19, 35-37: RequiredTestManifest v1 and tamper detection.
// ---------------------------------------------------------------------------------------------

export interface RequiredTestEntry {
  readonly test_id: string;
  readonly path: string;
  readonly content_hash: string | null;
  readonly required: boolean;
  readonly source: string;
}
export interface RequiredTestManifest {
  readonly manifest_id: string;
  readonly manifest_version: number;
  readonly entries: readonly RequiredTestEntry[];
  readonly manifest_hash: string;
}
export function buildRequiredTestManifest(manifestId: string, version: number, entries: readonly RequiredTestEntry[]): RequiredTestManifest {
  const withoutHash = { manifest_id: manifestId, manifest_version: version, entries };
  return { ...withoutHash, manifest_hash: hash(withoutHash) };
}

export interface TestManifestTamperReport {
  readonly removed_required_tests: readonly string[];
  readonly hash_changed_tests: readonly string[];
  readonly test_count_decreased: boolean;
  readonly tampered: boolean;
}
/** Section 35-37, 80: a candidate cannot pass by deleting or weakening a required test. Compares two
 * manifest snapshots (before mutation, after mutation) and flags any REQUIRED entry that disappeared or
 * whose content hash changed — the test-count-decrease signal (section 37) is reported but does not
 * alone make `tampered:true`; only a removed/changed REQUIRED entry does, since a legitimate new
 * optional test could lower nothing while an unrelated optional test removal is not itself malicious. */
export function detectTestManifestTampering(before: RequiredTestManifest, after: RequiredTestManifest): TestManifestTamperReport {
  const beforeRequired = before.entries.filter(e => e.required);
  const afterById = new Map(after.entries.map(e => [e.test_id, e]));
  const removedRequiredTests = beforeRequired.filter(e => !afterById.has(e.test_id)).map(e => e.test_id);
  const hashChangedTests = beforeRequired.filter(e => {
    const afterEntry = afterById.get(e.test_id);
    return afterEntry !== undefined && e.content_hash !== null && afterEntry.content_hash !== e.content_hash;
  }).map(e => e.test_id);
  return {
    removed_required_tests: removedRequiredTests, hash_changed_tests: hashChangedTests,
    test_count_decreased: after.entries.length < before.entries.length,
    tampered: removedRequiredTests.length > 0 || hashChangedTests.length > 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Section 18, 38-40: EvaluationProfile v1, BenchmarkResult v1.
// ---------------------------------------------------------------------------------------------

export interface EvaluationProfile {
  readonly profile_id: string;
  readonly profile_version: number;
  readonly required_test_commands: readonly string[];
  readonly benchmark_definitions: readonly string[];
  readonly security_tests: readonly string[];
  readonly regression_baseline: number;
  readonly quality_thresholds: Readonly<Record<string, number>>;
  readonly performance_thresholds: Readonly<Record<string, number>>;
  readonly control_thresholds: Readonly<Record<string, number>>;
  readonly maximum_regressions: number;
  readonly required_evidence: readonly string[];
  readonly profile_hash: string;
}
export function buildEvaluationProfile(input: Omit<EvaluationProfile, 'profile_hash'>): EvaluationProfile {
  return { ...input, profile_hash: hash(input) };
}

export interface BenchmarkResult {
  readonly benchmark_id: string;
  readonly generation_id: string;
  readonly parent_score: number;
  readonly candidate_score: number;
  readonly delta: number;
  readonly threshold: number;
  readonly status: 'PASS' | 'FAIL';
  readonly evidence_ref: string;
}
export function evaluateBenchmark(benchmarkId: string, generationId: string, parentScore: number, candidateScore: number, threshold: number, evidenceRef: string): BenchmarkResult {
  const delta = candidateScore - parentScore;
  return { benchmark_id: benchmarkId, generation_id: generationId, parent_score: parentScore, candidate_score: candidateScore, delta, threshold, status: delta >= threshold ? 'PASS' : 'FAIL', evidence_ref: evidenceRef };
}

// ---------------------------------------------------------------------------------------------
// Section 39-41, 49-51, 78: PromotionDecision v1 and the deterministic PromotionEvaluator precedence.
// ---------------------------------------------------------------------------------------------

export const PROMOTION_STATUSES = ['PROMOTE', 'REJECT', 'HOLD', 'INSUFFICIENT_EVIDENCE', 'INDETERMINATE'] as const;
export type PromotionStatus = typeof PROMOTION_STATUSES[number];
const PROMOTION_PRECEDENCE: Readonly<Record<PromotionStatus, number>> = {
  INDETERMINATE: 4, REJECT: 3, HOLD: 2, INSUFFICIENT_EVIDENCE: 1, PROMOTE: 0,
};
/** Section 50: INDETERMINATE > REJECT > HOLD > PROMOTE — fail conservatively. Combines every individual
 * evaluation signal (benchmark, security, capability delta, authority delta, control-plane delta,
 * evaluator delta, test-manifest tamper, class policy) into the single most-conservative status. */
export function combinePromotionSignals(signals: readonly PromotionStatus[]): PromotionStatus {
  if (signals.length === 0) return 'INSUFFICIENT_EVIDENCE';
  return signals.reduce((worst, s) => (PROMOTION_PRECEDENCE[s] > PROMOTION_PRECEDENCE[worst] ? s : worst));
}

export interface PromotionDecision {
  readonly decision_id: string;
  readonly generation_id: string;
  readonly parent_generation_id: string | null;
  readonly evaluation_profile_hash: string;
  readonly spec_hash: string;
  readonly source_hash: string;
  readonly benchmark_summary_hash: string;
  readonly security_summary_hash: string;
  readonly capability_delta_hash: string;
  readonly authority_delta_hash: string | null;
  readonly decision: PromotionStatus;
  readonly decision_reason: string;
  readonly decided_by: string;
  readonly decided_at: string;
}

/**
 * Section 39-41, 78-80, 52-54: the deterministic core of `PromotionEvaluator`. Pure — takes already
 * -computed evidence and returns a decision; performs no I/O and cannot be talked into anything (no LLM
 * anywhere in this function). Security/control failure always outranks a benchmark improvement (section
 * 40), Class 4/5 never auto-promotes (section 10, 39-40), and any control-plane/evaluator/test-manifest
 * tampering signal forces REJECT unconditionally, regardless of every other input (section 78-80).
 */
export function evaluatePromotion(input: {
  readonly improvementClass: ImprovementClass;
  readonly benchmarksAllPass: boolean;
  readonly regressionSuitePassed: boolean;
  readonly securityTestsPassed: boolean;
  readonly capabilityDelta: CapabilityDeltaReport;
  readonly authorityWithinCeiling: boolean;
  readonly mutationDiff: MutationDiffReport;
  readonly testTamper: TestManifestTamperReport;
  readonly humanApproved: boolean | null; // null = not yet required to have an answer
  readonly independentReviewApproved: boolean | null;
  readonly evidenceComplete: boolean;
}): { readonly status: PromotionStatus; readonly reason: string } {
  if (!input.evidenceComplete) return { status: 'INSUFFICIENT_EVIDENCE', reason: 'Required evaluation evidence is incomplete' };
  if (input.testTamper.tampered) return { status: 'REJECT', reason: `Required test manifest was tampered: removed=${input.testTamper.removed_required_tests.join(',')} changed=${input.testTamper.hash_changed_tests.join(',')}` };
  if (input.mutationDiff.evaluator_changed) return { status: 'REJECT', reason: 'Candidate mutated the promotion evaluator itself — evaluator independence violated' };
  if (input.mutationDiff.control_plane_changed && !classAtLeast(input.improvementClass, 'CLASS_4_CONTROL_PLANE')) {
    return { status: 'REJECT', reason: `Control-plane path(s) touched by a ${input.improvementClass} candidate: ${input.mutationDiff.forbidden_paths_touched.join(', ')}` };
  }
  if (!input.regressionSuitePassed) return { status: 'REJECT', reason: 'Accepted regression suite did not pass' };
  if (!input.securityTestsPassed) return { status: 'REJECT', reason: 'Security regression suite did not pass' };
  if (!input.authorityWithinCeiling) return { status: 'REJECT', reason: 'Candidate authority profile exceeds its approved ceiling' };
  if (input.capabilityDelta.has_unexpected_gain) return { status: 'REJECT', reason: `Unexpected capability gain: ${input.capabilityDelta.unexpected_reasons.join('; ')}` };
  if (!input.benchmarksAllPass) return { status: 'REJECT', reason: 'One or more required benchmarks did not meet threshold' };

  const policy = CLASS_POLICY[input.improvementClass];
  if (policy.requires_independent_review && input.independentReviewApproved !== true) {
    return { status: input.independentReviewApproved === false ? 'REJECT' : 'HOLD', reason: `${input.improvementClass} requires independent review before promotion` };
  }
  if (policy.requires_human_approval && input.humanApproved !== true) {
    return { status: input.humanApproved === false ? 'REJECT' : 'HOLD', reason: `${input.improvementClass} requires human approval before promotion` };
  }
  return { status: 'PROMOTE', reason: 'All required checks passed and all required approvals for this class are satisfied' };
}

// ---------------------------------------------------------------------------------------------
// Section 28-30: RecursionBudget v1 — runtime-owned counters, hard stop, no candidate self-report.
// ---------------------------------------------------------------------------------------------

export interface RecursionLimits {
  readonly max_generations: number;
  readonly max_attempts_per_generation: number;
  readonly max_runtime_per_attempt_ms: number;
  readonly max_total_runtime_ms: number;
  readonly max_cost_per_attempt_usd: number;
  readonly max_total_cost_usd: number;
  readonly max_tool_calls: number;
  readonly max_external_calls: number;
  readonly max_changed_files: number;
  readonly max_changed_bytes: number;
}
export interface RecursionBudget {
  readonly system_id: string;
  readonly tenant_id: string;
  readonly limits: RecursionLimits;
  readonly generation_count: number;
  readonly attempt_count: number;
  readonly runtime_used_ms: number;
  readonly cost_used_usd: number;
  readonly tool_calls_used: number;
  readonly mutation_size_used_bytes: number;
  readonly state_version: number;
}
export interface RecursionBudgetExhaustion { readonly exhausted: boolean; readonly reasons: readonly string[] }
/** Section 30-31: a hard stop, not a candidate decision. Returns every reason the budget is exhausted
 * (there can be more than one simultaneously) so the caller never has to guess which limit was hit. */
export function checkRecursionBudget(budget: RecursionBudget): RecursionBudgetExhaustion {
  const reasons: string[] = [];
  if (budget.generation_count >= budget.limits.max_generations) reasons.push('max_generations reached');
  if (budget.attempt_count >= budget.limits.max_attempts_per_generation) reasons.push('max_attempts_per_generation reached');
  if (budget.runtime_used_ms >= budget.limits.max_total_runtime_ms) reasons.push('max_total_runtime_ms reached');
  if (budget.cost_used_usd >= budget.limits.max_total_cost_usd) reasons.push('max_total_cost_usd reached');
  if (budget.tool_calls_used >= budget.limits.max_tool_calls) reasons.push('max_tool_calls reached');
  return { exhausted: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------------------------
// Section 26-27: ImprovementProposal v1 — untrusted candidate input, never itself an authority object.
// ---------------------------------------------------------------------------------------------

export interface ImprovementProposal {
  readonly problem: string;
  readonly hypothesis: string;
  readonly target_metric: string;
  readonly expected_benefit: string;
  readonly mutation_scope: readonly string[];
  readonly risks: string;
  readonly resource_estimate: { readonly runtime_ms: number; readonly cost_usd: number };
  readonly evaluation_recommendation: string;
}
const PROPOSAL_FIELDS = ['problem', 'hypothesis', 'target_metric', 'expected_benefit', 'mutation_scope', 'risks', 'resource_estimate', 'evaluation_recommendation'];
/** Section 27: "Proposal does not grant mutation authority" — this function only shape-validates
 * untrusted candidate/agent input. It returns an `ImprovementProposal`, never an `ImprovementSpec`; only
 * trusted orchestration policy (`buildImprovementSpec`, called separately) can produce the latter. */
export function validateImprovementProposal(raw: unknown): ImprovementProposal {
  if (!isPlainObject(raw)) throw new ImprovementError('INVALID_INPUT', 'Improvement proposal must be an object');
  for (const key of Object.keys(raw)) if (!PROPOSAL_FIELDS.includes(key)) throw new ImprovementError('INVALID_INPUT', `Unknown proposal field: ${key}`);
  for (const field of ['problem', 'hypothesis', 'target_metric', 'expected_benefit', 'risks', 'evaluation_recommendation'] as const) {
    if (typeof raw[field] !== 'string' || (raw[field] as string).length === 0 || (raw[field] as string).length > 4000) throw new ImprovementError('INVALID_INPUT', `${field} must be a non-empty bounded string`);
  }
  if (!Array.isArray(raw.mutation_scope) || !raw.mutation_scope.every(v => typeof v === 'string')) throw new ImprovementError('INVALID_INPUT', 'mutation_scope must be an array of strings');
  if (!isPlainObject(raw.resource_estimate) || typeof raw.resource_estimate.runtime_ms !== 'number' || typeof raw.resource_estimate.cost_usd !== 'number') throw new ImprovementError('INVALID_INPUT', 'resource_estimate must be {runtime_ms, cost_usd}');
  const found = findSecretShapedField(raw);
  if (found) throw new ImprovementError('INVALID_INPUT', `Improvement proposal rejected: ${found}`);
  return raw as unknown as ImprovementProposal;
}

// ---------------------------------------------------------------------------------------------
// Section 62-65: rollback records.
// ---------------------------------------------------------------------------------------------

export const ROLLBACK_STATUSES = ['ROLLED_BACK', 'INDETERMINATE', 'FAILED'] as const;
export type RollbackStatus = typeof ROLLBACK_STATUSES[number];
export interface RollbackRecord {
  readonly rollback_id: string;
  readonly generation_id: string;
  readonly rollback_target_generation_id: string;
  readonly trigger: RollbackTrigger | 'MANUAL';
  readonly status: RollbackStatus;
  readonly evidence_ref: string | null;
  readonly initiated_by: string;
  readonly initiated_at: string;
  readonly completed_at: string | null;
}

// ---------------------------------------------------------------------------------------------
// Section 56, 63: canary run records.
// ---------------------------------------------------------------------------------------------

export const CANARY_STATUSES = ['RUNNING', 'PASSED', 'FAILED', 'INDETERMINATE'] as const;
export type CanaryStatus = typeof CANARY_STATUSES[number];
export interface CanaryRun {
  readonly canary_id: string;
  readonly generation_id: string;
  readonly policy_hash: string;
  readonly status: CanaryStatus;
  readonly actions_executed: number;
  readonly failures_observed: number;
  readonly sentinel_terminations: number;
  readonly cost_incurred_usd: number;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly state_version: number;
}

export interface Page<T> { readonly items: readonly T[]; readonly nextCursor?: string }
export const MAX_IMPROVEMENT_PAGE_SIZE = 200;
export const DEFAULT_IMPROVEMENT_PAGE_SIZE = 50;
export function readPageOptions(limit: number | undefined, maxSize: number = MAX_IMPROVEMENT_PAGE_SIZE): number {
  const effective = limit ?? DEFAULT_IMPROVEMENT_PAGE_SIZE;
  if (!Number.isInteger(effective) || effective <= 0 || effective > maxSize) throw new ImprovementError('INVALID_INPUT', `limit must be a positive integer <= ${maxSize}`);
  return effective;
}
