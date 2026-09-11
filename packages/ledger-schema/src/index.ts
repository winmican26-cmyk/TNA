import { createHash } from 'node:crypto';

export const LEDGER_EVENT_VERSION = '1.0' as const;
export const MAX_PAYLOAD_BYTES = 8192;
export const MAX_QUERY_PAGE_SIZE = 200;
export const DEFAULT_QUERY_PAGE_SIZE = 50;
export const MAX_RECONSTRUCTION_EVENTS = 500;
export const MAX_EXPORT_EVENTS = 5000;

export class LedgerError extends Error {
  public constructor(public readonly code:
    'INVALID_EVENT' | 'UNKNOWN_EVENT_TYPE' | 'EVENT_CONFLICT' | 'STREAM_CONFLICT' | 'INTEGRITY_FAILURE'
    | 'NOT_FOUND' | 'FORBIDDEN' | 'PAYLOAD_TOO_LARGE' | 'ORPHAN_EVENT' | 'UNSUPPORTED_VERSION',
  message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export type ActorType = 'AGENT' | 'HUMAN' | 'SYSTEM' | 'SERVICE' | 'VERIFIER' | 'PRODUCER' | 'ADMIN' | 'APPROVER';
export const ACTOR_TYPES: readonly ActorType[] = ['AGENT', 'HUMAN', 'SYSTEM', 'SERVICE', 'VERIFIER', 'PRODUCER', 'ADMIN', 'APPROVER'];

/**
 * Controlled origin registry. An untrusted source name must never be accepted verbatim.
 *
 * `'sentinel'` was added in the TNA Sentinel v0.1 milestone (Volume 6, section 58: "Ledger Extension
 * Discipline"). `'auditor'` was added in the TNA Auditor v0.1 milestone (Volume 7) on the same
 * discipline. Both are purely additive changes — no existing value was removed or renamed, so every
 * event accepted under the tagged `tna-ledger-v0.1` commit remains valid under this schema. The tag
 * itself is untouched; this file is part of how the branch evolves beyond it.
 */
export type SourceComponent = 'tna-gate' | 'execution-broker' | 'isolation-runner' | 'vad-engine' | 'human-decision-service' | 'ledger' | 'sentinel' | 'auditor';
export const SOURCE_COMPONENTS: readonly SourceComponent[] = ['tna-gate', 'execution-broker', 'isolation-runner', 'vad-engine', 'human-decision-service', 'ledger', 'sentinel', 'auditor'];

export const EVENT_TYPES = [
  'AGENT_REGISTERED',
  'AUTHORIZATION_REQUESTED', 'AUTHORIZATION_ALLOWED', 'AUTHORIZATION_BLOCKED', 'AUTHORIZATION_HELD',
  'APPROVAL_GRANTED', 'APPROVAL_REJECTED', 'APPROVAL_EXPIRED',
  'CAPABILITY_ISSUED', 'CAPABILITY_REDEEMED', 'CAPABILITY_REJECTED',
  'EXECUTION_STARTED', 'EXECUTION_SUCCEEDED', 'EXECUTION_FAILED', 'EXECUTION_TERMINATED', 'EXECUTION_INDETERMINATE',
  'ATOM_CREATED', 'ATOM_STARTED', 'ATOM_ATTEMPT_STARTED', 'ATOM_ATTEMPT_FAILED', 'ATOM_VALIDATION_PASSED', 'ATOM_VALIDATION_FAILED',
  'ATOM_VERIFICATION_ACCEPTED', 'ATOM_VERIFICATION_REJECTED', 'ATOM_HUMAN_DECISION', 'ATOM_ACCEPTED', 'ATOM_REJECTED', 'ATOM_ESCALATED',
  'POLICY_ISSUED', 'POLICY_REPLACED', 'AGENT_REVOKED',
  'INTEGRITY_CHECK_PASSED', 'INTEGRITY_CHECK_FAILED',
  // Added in TNA Sentinel v0.1 (Volume 6, section 57-58) — additive only, see SourceComponent above.
  'SENTINEL_SESSION_STARTED', 'SENTINEL_VIOLATION_DETECTED', 'SENTINEL_WARNING', 'SENTINEL_HOLD',
  'SENTINEL_TERMINATION_REQUESTED', 'SENTINEL_TERMINATED', 'SENTINEL_CONTAINMENT_FAILED',
  'SENTINEL_EMERGENCY_STOP_ACTIVATED', 'SENTINEL_EMERGENCY_STOP_RELEASED', 'SENTINEL_SESSION_COMPLETED',
  // Added in TNA Auditor v0.1 (Volume 7, section 115-116) — additive only, see SourceComponent above.
  'AUDIT_ASSESSMENT_CREATED', 'AUDIT_ASSESSMENT_STARTED', 'AUDIT_FINDING_CREATED',
  'AUDIT_ASSESSMENT_COMPLETED', 'AUDIT_ASSESSMENT_FAILED',
] as const;
export type LedgerEventType = typeof EVENT_TYPES[number];
const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

export type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED' | 'SECRET_REFERENCE';
const CLASSIFICATIONS = new Set<string>(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET_REFERENCE']);

export interface ActorRef { type: ActorType; id: string }

export interface AuthorityContext {
  agent_id?: string; decision_id?: string; policy_hash?: string; policy_issuance_id?: string;
  approval_id?: string; capability_id?: string; action?: string; tool?: string; resource?: string;
  operation?: string; destination?: string | null; authority_expiry?: string;
}
export interface SpecContext {
  atom_id?: string; atom_version?: string; spec_hash?: string; risk_level?: string;
  success_criterion_ids?: string[]; attempt_number?: number; validation_run_id?: string;
  verifier_id?: string; verifier_verdict?: string; human_decision?: string;
}
export interface ExecutionContext {
  execution_id?: string; tool?: string; operation?: string; resource?: string; input_hash?: string;
  started_at?: string; completed_at?: string; runtime_ms?: number; exit_status?: string;
  termination_reason?: string; result_hash?: string;
}
export interface ArtifactContext {
  artifact_id?: string; artifact_type?: string; artifact_hash?: string; diff_hash?: string;
  manifest_hash?: string; storage_reference?: string;
}
export interface RetentionMetadata { retention_class: string; retain_until?: string; legal_hold: boolean }

/** What a caller submits. The Ledger — never the caller — computes sequence, hashes, and receipt time. */
export interface LedgerEventInput {
  version: '1.0';
  event_id: string;
  event_type: LedgerEventType;
  tenant_id: string;
  stream_id: string;
  actor: ActorRef;
  correlation_id: string;
  causation_id?: string | null;
  parent_event_id?: string | null;
  source_component: SourceComponent;
  occurred_at?: string;
  authority_context?: AuthorityContext;
  spec_context?: SpecContext;
  execution_context?: ExecutionContext;
  artifact_context?: ArtifactContext;
  payload?: Record<string, unknown>;
  classification?: Classification;
  retention?: RetentionMetadata;
}

/** Fully persisted event, as returned by the store and query layers. */
export interface LedgerEvent extends LedgerEventInput {
  sequence: number;
  received_at: string;
  persisted_at: string;
  payload_hash: string;
  previous_event_hash: string;
  event_hash: string;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeId(value: unknown, maxLen = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
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

/** Recursively scans structured event content for secret-shaped fields or values. Returns a reason string, or null if clean. */
export function findSecretShapedField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) return 'value matches a bearer-token pattern';
  if (Array.isArray(value)) {
    for (const entry of value) { const found = findSecretShapedField(entry); if (found) return found; }
    return null;
  }
  if (typeof value === 'object') {
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) return `field name "${key}" is a disallowed secret-shaped field`;
      const found = findSecretShapedField(entryValue);
      if (found) return found;
    }
  }
  return null;
}

function assertContext(name: string, value: unknown): void {
  if (value !== undefined && !isPlainObject(value)) throw new LedgerError('INVALID_EVENT', `${name} must be an object`);
}

/** Validates and normalizes caller input. Throws LedgerError for any structural, enum, or secret violation. */
export function validateEventInput(input: unknown): LedgerEventInput {
  if (!isPlainObject(input)) throw new LedgerError('INVALID_EVENT', 'Event must be an object');
  if (input.version !== LEDGER_EVENT_VERSION) throw new LedgerError('UNSUPPORTED_VERSION', `Unsupported event version: ${String(input.version)}`);
  if (!safeId(input.event_id, 200)) throw new LedgerError('INVALID_EVENT', 'event_id must be a safe, bounded identifier');
  if (typeof input.event_type !== 'string' || !EVENT_TYPE_SET.has(input.event_type)) throw new LedgerError('UNKNOWN_EVENT_TYPE', `Unknown event type: ${String(input.event_type)}`);
  if (!safeId(input.tenant_id, 100)) throw new LedgerError('INVALID_EVENT', 'tenant_id is required');
  if (!safeId(input.stream_id, 200)) throw new LedgerError('INVALID_EVENT', 'stream_id is required');
  if (!isPlainObject(input.actor) || !ACTOR_TYPES.includes(input.actor.type as ActorType) || !safeId(input.actor.id, 200)) {
    throw new LedgerError('INVALID_EVENT', 'actor requires a controlled type and a safe id');
  }
  if (!safeId(input.correlation_id, 200)) throw new LedgerError('INVALID_EVENT', 'correlation_id is required');
  if (input.causation_id !== undefined && input.causation_id !== null && !safeId(input.causation_id, 200)) throw new LedgerError('INVALID_EVENT', 'causation_id must be a safe identifier');
  if (input.parent_event_id !== undefined && input.parent_event_id !== null && !safeId(input.parent_event_id, 200)) throw new LedgerError('INVALID_EVENT', 'parent_event_id must be a safe identifier');
  if (typeof input.source_component !== 'string' || !SOURCE_COMPONENTS.includes(input.source_component as SourceComponent)) {
    throw new LedgerError('INVALID_EVENT', `Unknown or untrusted source_component: ${String(input.source_component)}`);
  }
  if (input.occurred_at !== undefined && !isIsoTimestamp(input.occurred_at)) throw new LedgerError('INVALID_EVENT', 'occurred_at must be a valid ISO-8601 UTC timestamp');
  assertContext('authority_context', input.authority_context);
  assertContext('spec_context', input.spec_context);
  assertContext('execution_context', input.execution_context);
  assertContext('artifact_context', input.artifact_context);
  if (input.classification !== undefined && (typeof input.classification !== 'string' || !CLASSIFICATIONS.has(input.classification))) {
    throw new LedgerError('INVALID_EVENT', 'Unknown classification');
  }
  if (input.retention !== undefined) {
    if (!isPlainObject(input.retention) || typeof input.retention.retention_class !== 'string' || typeof input.retention.legal_hold !== 'boolean') {
      throw new LedgerError('INVALID_EVENT', 'retention metadata is malformed');
    }
  }
  if (input.payload !== undefined) {
    if (!isPlainObject(input.payload)) throw new LedgerError('INVALID_EVENT', 'payload must be an object');
    const size = Buffer.byteLength(canonical(input.payload), 'utf8');
    if (size > MAX_PAYLOAD_BYTES) throw new LedgerError('PAYLOAD_TOO_LARGE', `Payload of ${size} bytes exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`);
  }
  const secretHit = findSecretShapedField(input.payload) ?? findSecretShapedField(input.authority_context)
    ?? findSecretShapedField(input.execution_context) ?? findSecretShapedField(input.spec_context) ?? findSecretShapedField(input.artifact_context);
  if (secretHit) throw new LedgerError('INVALID_EVENT', `Rejected: ${secretHit}`);

  assertComplete(input as unknown as LedgerEventInput);

  const normalized: Record<string, unknown> = {
    version: LEDGER_EVENT_VERSION,
    event_id: input.event_id,
    event_type: input.event_type,
    tenant_id: input.tenant_id,
    stream_id: input.stream_id,
    actor: input.actor,
    correlation_id: input.correlation_id,
    source_component: input.source_component,
  };
  if (input.causation_id !== undefined) normalized.causation_id = input.causation_id;
  if (input.parent_event_id !== undefined) normalized.parent_event_id = input.parent_event_id;
  if (input.occurred_at !== undefined) normalized.occurred_at = input.occurred_at;
  if (input.authority_context !== undefined) normalized.authority_context = input.authority_context;
  if (input.spec_context !== undefined) normalized.spec_context = input.spec_context;
  if (input.execution_context !== undefined) normalized.execution_context = input.execution_context;
  if (input.artifact_context !== undefined) normalized.artifact_context = input.artifact_context;
  if (input.payload !== undefined) normalized.payload = input.payload;
  if (input.classification !== undefined) normalized.classification = input.classification;
  if (input.retention !== undefined) normalized.retention = input.retention;
  return normalized as unknown as LedgerEventInput;
}

/** Event-specific completeness rules (section 61). A "successful" event without its provenance is rejected. */
function assertComplete(input: LedgerEventInput): void {
  const ac = input.authority_context;
  const sc = input.spec_context;
  const ec = input.execution_context;
  const art = input.artifact_context;
  switch (input.event_type) {
    case 'AUTHORIZATION_ALLOWED':
      if (!ac?.decision_id || !ac.agent_id || !ac.policy_hash || !ac.action) {
        throw new LedgerError('INVALID_EVENT', 'AUTHORIZATION_ALLOWED requires authority_context.{decision_id,agent_id,policy_hash,action}');
      }
      break;
    case 'CAPABILITY_ISSUED':
      if (!ac?.capability_id || !ac.decision_id || !ac.authority_expiry) {
        throw new LedgerError('INVALID_EVENT', 'CAPABILITY_ISSUED requires authority_context.{capability_id,decision_id,authority_expiry}');
      }
      break;
    case 'CAPABILITY_REDEEMED':
      if (!ac?.capability_id) throw new LedgerError('INVALID_EVENT', 'CAPABILITY_REDEEMED requires authority_context.capability_id');
      break;
    case 'EXECUTION_STARTED':
      if (!ec?.execution_id) throw new LedgerError('INVALID_EVENT', 'EXECUTION_STARTED requires execution_context.execution_id');
      break;
    case 'EXECUTION_SUCCEEDED':
      if (!ec?.execution_id || !ec.result_hash) throw new LedgerError('INVALID_EVENT', 'EXECUTION_SUCCEEDED requires execution_context.{execution_id,result_hash}');
      break;
    case 'EXECUTION_FAILED':
    case 'EXECUTION_TERMINATED':
    case 'EXECUTION_INDETERMINATE':
      if (!ec?.execution_id) throw new LedgerError('INVALID_EVENT', `${input.event_type} requires execution_context.execution_id`);
      break;
    case 'ATOM_CREATED':
      if (!sc?.atom_id || !sc.spec_hash) throw new LedgerError('INVALID_EVENT', 'ATOM_CREATED requires spec_context.{atom_id,spec_hash}');
      break;
    case 'ATOM_ACCEPTED':
      if (!sc?.atom_id || !sc.spec_hash || !art?.artifact_hash || !sc.verifier_verdict || !sc.human_decision) {
        throw new LedgerError('INVALID_EVENT', 'ATOM_ACCEPTED requires spec_context.{atom_id,spec_hash,verifier_verdict,human_decision} and artifact_context.artifact_hash');
      }
      break;
    case 'AGENT_REVOKED':
      if (!ac?.agent_id) throw new LedgerError('INVALID_EVENT', 'AGENT_REVOKED requires authority_context.agent_id');
      break;
    default:
      break;
  }
}

/**
 * Inputs bound into the event hash. causation_id/parent_event_id/occurred_at are always present
 * here (as null when absent) so canonicalization is identical whether built fresh at append time
 * or reconstructed from stored columns at verification time — an omitted vs. null key must never
 * change the hash, or honest verification would spuriously fail.
 */
export interface EventHashCore {
  version: string; tenant_id: string; stream_id: string; sequence: number; event_id: string; event_type: string;
  occurred_at: string | null; actor: ActorRef; correlation_id: string; causation_id: string | null; parent_event_id: string | null;
  source_component: string; authority_context?: unknown; spec_context?: unknown; execution_context?: unknown;
  artifact_context?: unknown; payload_hash: string; previous_event_hash: string;
}
export function computeEventHash(core: EventHashCore): string { return hash(core); }
export function computePayloadHash(payload: unknown): string { return hash(payload === undefined ? null : payload); }
