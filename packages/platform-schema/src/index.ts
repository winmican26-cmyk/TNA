import { createHash, randomUUID } from 'node:crypto';

export const PLATFORM_ACTION_REQUEST_VERSION = '1.0' as const;

export const MAX_NAME_LENGTH = 200;
export const MAX_METADATA_BYTES = 4096;
export const MAX_INPUT_BYTES = 65536;
export const MAX_BODY_BYTES = 262144;
export const MAX_RESULT_BYTES = 65536;
export const MAX_ACTION_PAGE_SIZE = 200;
export const DEFAULT_ACTION_PAGE_SIZE = 50;
export const MAX_EVIDENCE_REFS = 200;
export const MAX_OUTBOX_DISPATCH_ATTEMPTS = 8;
export const DEFAULT_MAX_RUNTIME_SECONDS = 60;
export const DEFAULT_MAX_COST_USD = 1;

/**
 * Section 67: controlled platform error codes. `PlatformError` is thrown by every package in this
 * milestone; callers (HTTP layer, tests) switch on `.code`, never on `.message` text.
 */
export type PlatformErrorCode =
  | 'INVALID_INPUT' | 'UNSUPPORTED_VERSION' | 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_TRANSITION'
  | 'CONFLICT' | 'PAYLOAD_TOO_LARGE'
  | 'AUTHORIZATION_BLOCKED' | 'APPROVAL_REQUIRED' | 'CAPABILITY_FAILURE'
  | 'SENTINEL_UNAVAILABLE' | 'SENTINEL_HOLD' | 'SENTINEL_TERMINATED'
  | 'EXECUTION_FAILED' | 'VERIFICATION_REJECTED' | 'VERIFICATION_ESCALATED'
  | 'EVIDENCE_DEGRADED' | 'AUDIT_UNAVAILABLE' | 'PLATFORM_INDETERMINATE'
  | 'CONNECTOR_UNKNOWN' | 'COMPONENT_UNAVAILABLE';

export class PlatformError extends Error {
  public constructor(public readonly code: PlatformErrorCode, message: string) {
    super(message);
    this.name = 'PlatformError';
  }
}

// ---------------------------------------------------------------------------------------------
// Canonicalization / hashing / secret detection — same algorithm as every other TNA package,
// duplicated locally per this project's established convention (see auditor-schema, section 92).
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

const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|secret|password|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|authorization)/i;
const SECRET_VALUE_PATTERN = /Bearer\s+\S+/i;
/** Section 73: platform requests/outbox payloads/results must never carry a raw secret. Same fixed
 * rule set as the accepted Ledger/Sentinel/Auditor detectors — not general DLP. */
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
// Principals (section 12). An agent may request an action; it never decides its own result.
// ---------------------------------------------------------------------------------------------

export const PLATFORM_ROLES = ['platform-agent', 'platform-user', 'platform-operator', 'platform-admin', 'platform-service'] as const;
export type PlatformRole = typeof PLATFORM_ROLES[number];

export interface PlatformPrincipal {
  readonly id: string;
  readonly role: PlatformRole;
  readonly tenantId: string;
  /** Bound only for `platform-agent` principals — the one agent identity this credential may act as. */
  readonly agentId?: string;
}
export function agentPrincipal(id: string, tenantId: string, agentId: string): PlatformPrincipal { return { id, role: 'platform-agent', tenantId, agentId }; }
export function userPrincipal(id: string, tenantId: string): PlatformPrincipal { return { id, role: 'platform-user', tenantId }; }
export function operatorPrincipal(id: string, tenantId: string): PlatformPrincipal { return { id, role: 'platform-operator', tenantId }; }
export function adminPrincipal(id: string, tenantId: string): PlatformPrincipal { return { id, role: 'platform-admin', tenantId }; }
export function servicePrincipal(id: string, tenantId: string): PlatformPrincipal { return { id, role: 'platform-service', tenantId }; }

export function assertCanRead(principal: PlatformPrincipal): void { void principal; /* every role may read within its own tenant scope */ }
export function assertCanSubmit(principal: PlatformPrincipal): void {
  if (principal.role !== 'platform-agent' && principal.role !== 'platform-service' && principal.role !== 'platform-user') {
    throw new PlatformError('FORBIDDEN', `Role ${principal.role} may not submit a platform action`);
  }
}
export function assertCanApprove(principal: PlatformPrincipal): void {
  if (principal.role !== 'platform-operator' && principal.role !== 'platform-admin') throw new PlatformError('FORBIDDEN', `Role ${principal.role} may not approve/resume a held action`);
}
export function assertCanTerminate(principal: PlatformPrincipal): void {
  if (principal.role !== 'platform-operator' && principal.role !== 'platform-admin') throw new PlatformError('FORBIDDEN', `Role ${principal.role} may not terminate a platform action`);
}
export function assertIsAdmin(principal: PlatformPrincipal): void {
  if (principal.role !== 'platform-admin') throw new PlatformError('FORBIDDEN', `Role ${principal.role} requires platform-admin`);
}

// ---------------------------------------------------------------------------------------------
// Platform action lifecycle (sections 9-10)
// ---------------------------------------------------------------------------------------------

export const PLATFORM_ACTION_STATES = [
  'RECEIVED', 'AUTHORIZING', 'BLOCKED', 'HELD', 'AUTHORIZED', 'CAPABILITY_ISSUED',
  'MONITORING', 'EXECUTING', 'VERIFYING', 'COMPLETED', 'FAILED', 'TERMINATED', 'INDETERMINATE',
] as const;
export type PlatformActionState = typeof PLATFORM_ACTION_STATES[number];
const PLATFORM_ACTION_STATE_SET = new Set<string>(PLATFORM_ACTION_STATES);
export function isPlatformActionState(value: unknown): value is PlatformActionState { return typeof value === 'string' && PLATFORM_ACTION_STATE_SET.has(value); }

const TERMINAL_STATES: ReadonlySet<PlatformActionState> = new Set(['BLOCKED', 'COMPLETED', 'FAILED', 'TERMINATED', 'INDETERMINATE']);
export function isTerminalState(state: PlatformActionState): boolean { return TERMINAL_STATES.has(state); }

/**
 * Section 9-10: the only transitions this milestone's orchestrator is permitted to make. Any
 * transition attempted outside this table is an `INVALID_TRANSITION` programming error, not a
 * caller-triggerable outcome — enforced by `PlatformRuntime`'s own transition helper, not by this
 * table being consulted per call (kept here as the single documented source of truth; see
 * `platform-state-machine-v0.1.md`).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<PlatformActionState, readonly PlatformActionState[]>> = {
  RECEIVED: ['AUTHORIZING'],
  AUTHORIZING: ['BLOCKED', 'HELD', 'AUTHORIZED', 'INDETERMINATE'],
  BLOCKED: [],
  HELD: ['AUTHORIZING', 'TERMINATED'],
  AUTHORIZED: ['CAPABILITY_ISSUED', 'INDETERMINATE', 'FAILED'],
  CAPABILITY_ISSUED: ['MONITORING', 'INDETERMINATE', 'FAILED'],
  MONITORING: ['EXECUTING', 'TERMINATED', 'INDETERMINATE', 'FAILED'],
  EXECUTING: ['VERIFYING', 'COMPLETED', 'FAILED', 'TERMINATED', 'INDETERMINATE'],
  VERIFYING: ['COMPLETED', 'FAILED', 'INDETERMINATE'],
  COMPLETED: [],
  FAILED: [],
  TERMINATED: [],
  INDETERMINATE: [],
};
export function isAllowedTransition(from: PlatformActionState, to: PlatformActionState): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly PlatformActionState[]).includes(to);
}

// ---------------------------------------------------------------------------------------------
// PlatformActionRequest v1.0 (section 6). Caller-supplied fields only — every authoritative
// downstream fact (decision, capability, Sentinel result, execution outcome, VAD result, Ledger
// hash, Auditor result) is runtime-owned and never accepted from this shape.
// ---------------------------------------------------------------------------------------------

export interface RuntimeLimits { readonly max_runtime_seconds: number }
export interface CostLimits { readonly max_cost_usd: number }

export interface PlatformActionRequestInput {
  readonly version: '1.0';
  readonly request_id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly action: string;
  readonly tool: string;
  readonly operation: string;
  readonly resource: string;
  readonly input: Record<string, unknown>;
  readonly requested_runtime_limits?: RuntimeLimits;
  readonly requested_cost_limits?: CostLimits;
  readonly requires_verification: boolean;
  readonly verification_spec_id?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Runtime-owned fields bound at RECEIVED time (section 7). */
export interface PlatformActionIdentity {
  readonly platform_action_id: string;
  readonly correlation_id: string;
  readonly created_at: string;
  readonly created_by: string;
  readonly input_hash: string;
}

const FORBIDDEN_CALLER_FIELDS = [
  'platform_action_id', 'correlation_id', 'decision_id', 'capability_id', 'sentinel_session_id',
  'execution_id', 'status', 'state_version', 'result', 'result_hash', 'sentinel_decision',
  'vad_result', 'vad_final_state', 'ledger_hash', 'ledger_event_id', 'audit_result', 'evidence_status',
  'input_hash', 'created_at', 'created_by',
];
const REQUEST_TOP_LEVEL_FIELDS = new Set([
  'version', 'request_id', 'tenant_id', 'agent_id', 'action', 'tool', 'operation', 'resource', 'input',
  'requested_runtime_limits', 'requested_cost_limits', 'requires_verification', 'verification_spec_id', 'metadata',
]);

/** Validates and normalizes a caller-supplied platform action request. Throws PlatformError. Any
 * field shaped like a runtime-owned authoritative fact (section 6's explicit list) is rejected
 * outright rather than silently dropped, so a forging attempt fails loudly (abuse case, section 115). */
export function validatePlatformActionRequestInput(input: unknown): PlatformActionRequestInput {
  if (!isPlainObject(input)) throw new PlatformError('INVALID_INPUT', 'Platform action request must be an object');
  for (const field of Object.keys(input)) {
    if (!REQUEST_TOP_LEVEL_FIELDS.has(field)) throw new PlatformError('INVALID_INPUT', `Unknown platform action request field "${field}"`);
  }
  if (input.version !== PLATFORM_ACTION_REQUEST_VERSION) throw new PlatformError('UNSUPPORTED_VERSION', `Unsupported request version: ${String(input.version)}`);
  for (const field of FORBIDDEN_CALLER_FIELDS) {
    if (field in input) throw new PlatformError('INVALID_INPUT', `Field "${field}" is runtime-owned and may not be supplied by the caller`);
  }
  if (!safeId(input.request_id, 200)) throw new PlatformError('INVALID_INPUT', 'request_id is required and must be a safe identifier');
  if (!safeId(input.tenant_id, 100)) throw new PlatformError('INVALID_INPUT', 'tenant_id is required');
  if (!safeId(input.agent_id, 200)) throw new PlatformError('INVALID_INPUT', 'agent_id is required');
  if (!safeId(input.action, 200)) throw new PlatformError('INVALID_INPUT', 'action is required');
  if (!safeId(input.tool, 200)) throw new PlatformError('INVALID_INPUT', 'tool is required');
  if (!safeId(input.operation, 100)) throw new PlatformError('INVALID_INPUT', 'operation is required');
  if (typeof input.resource !== 'string' || input.resource.length === 0 || input.resource.length > 512) throw new PlatformError('INVALID_INPUT', 'resource is required');
  if (!isPlainObject(input.input)) throw new PlatformError('INVALID_INPUT', 'input must be an object');
  if (byteLength(input.input) > MAX_INPUT_BYTES) throw new PlatformError('PAYLOAD_TOO_LARGE', `input exceeds ${MAX_INPUT_BYTES} bytes`);
  if (typeof input.requires_verification !== 'boolean') throw new PlatformError('INVALID_INPUT', 'requires_verification is required and must be a boolean');
  if (input.requires_verification && input.verification_spec_id !== undefined && !safeId(input.verification_spec_id, 200)) throw new PlatformError('INVALID_INPUT', 'verification_spec_id must be a safe identifier');
  let runtimeLimits: RuntimeLimits | undefined;
  if (input.requested_runtime_limits !== undefined) {
    const rl = input.requested_runtime_limits;
    if (!isPlainObject(rl) || typeof rl.max_runtime_seconds !== 'number' || !Number.isFinite(rl.max_runtime_seconds) || rl.max_runtime_seconds <= 0 || rl.max_runtime_seconds > 3600) throw new PlatformError('INVALID_INPUT', 'requested_runtime_limits.max_runtime_seconds must be a positive number <= 3600');
    runtimeLimits = { max_runtime_seconds: rl.max_runtime_seconds };
  }
  let costLimits: CostLimits | undefined;
  if (input.requested_cost_limits !== undefined) {
    const cl = input.requested_cost_limits;
    if (!isPlainObject(cl) || typeof cl.max_cost_usd !== 'number' || !Number.isFinite(cl.max_cost_usd) || cl.max_cost_usd < 0 || cl.max_cost_usd > 1_000_000) throw new PlatformError('INVALID_INPUT', 'requested_cost_limits.max_cost_usd must be a non-negative number');
    costLimits = { max_cost_usd: cl.max_cost_usd };
  }
  if (input.metadata !== undefined) {
    if (!isPlainObject(input.metadata)) throw new PlatformError('INVALID_INPUT', 'metadata must be an object');
    if (byteLength(input.metadata) > MAX_METADATA_BYTES) throw new PlatformError('PAYLOAD_TOO_LARGE', `metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  const secretHit = findSecretShapedField(input.input) ?? findSecretShapedField(input.metadata);
  if (secretHit) throw new PlatformError('INVALID_INPUT', `Rejected: ${secretHit}`);

  const normalized: Record<string, unknown> = {
    version: PLATFORM_ACTION_REQUEST_VERSION, request_id: input.request_id, tenant_id: input.tenant_id,
    agent_id: input.agent_id, action: input.action, tool: input.tool, operation: input.operation,
    resource: input.resource, input: input.input, requires_verification: input.requires_verification,
  };
  if (runtimeLimits) normalized.requested_runtime_limits = runtimeLimits;
  if (costLimits) normalized.requested_cost_limits = costLimits;
  if (input.requires_verification && input.verification_spec_id !== undefined) normalized.verification_spec_id = input.verification_spec_id;
  if (input.metadata !== undefined) normalized.metadata = input.metadata;
  return normalized as unknown as PlatformActionRequestInput;
}

/** `input_hash` covers exactly the (tool, operation, resource, input) binding — this is what is
 * checked for drift between authorization time and execution time (section 19). */
export function computeInputHash(request: Pick<PlatformActionRequestInput, 'tool' | 'operation' | 'resource' | 'input'>): string {
  return hash({ tool: request.tool, operation: request.operation, resource: request.resource, input: request.input });
}

export function newPlatformActionId(): string { return `pa_${randomUUID()}`; }
export function newCorrelationId(): string { return `corr_${randomUUID()}`; }

// ---------------------------------------------------------------------------------------------
// Evidence reference (mirrors auditor-schema's EvidenceRef shape for cross-package consistency;
// used only for the platform's own reconstruction/evidence-summary views, not for hashing parity
// with Auditor — Auditor computes its own refs independently from the same underlying Ledger events).
// ---------------------------------------------------------------------------------------------

export interface PlatformEvidenceRef {
  readonly event_id: string;
  readonly event_type: string;
  readonly stream_id: string;
  readonly sequence: number;
  readonly event_hash: string;
  readonly observed_at: string;
}

// ---------------------------------------------------------------------------------------------
// Pagination helper (shared bounded-list-query shape)
// ---------------------------------------------------------------------------------------------
export interface Page<T> { readonly items: readonly T[]; readonly nextCursor?: string }
