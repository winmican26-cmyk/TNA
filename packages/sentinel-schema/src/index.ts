import { createHash } from 'node:crypto';

export const SENTINEL_SESSION_VERSION = '1.0' as const;
export const SENTINEL_OBSERVATION_VERSION = '1.0' as const;
export const SENTINEL_POLICY_VERSION = '1.0' as const;

export const MAX_OBSERVATION_PAYLOAD_BYTES = 8192;
export const MAX_VIOLATIONS_PER_RESPONSE = 200;
export const MAX_DECISIONS_PER_RESPONSE = 200;
export const MAX_SESSION_QUERY_PAGE_SIZE = 200;
export const DEFAULT_SESSION_QUERY_PAGE_SIZE = 50;
export const MAX_ALLOWED_LIST_ENTRIES = 200;
export const MAX_RULES_PER_POLICY = 100;

export class SentinelError extends Error {
  public constructor(public readonly code:
    'INVALID_INPUT' | 'UNKNOWN_OBSERVATION_TYPE' | 'UNSUPPORTED_VERSION' | 'OBSERVATION_CONFLICT'
    | 'NOT_FOUND' | 'FORBIDDEN' | 'PAYLOAD_TOO_LARGE' | 'INVALID_TRANSITION' | 'POLICY_INVALID'
    | 'SESSION_TERMINAL',
  message: string) {
    super(message);
    this.name = 'SentinelError';
  }
}

/** Runtime session lifecycle (section 8). FAILED is deliberately not implemented in v0.1 — see
 * docs/sentinel/sentinel-session-spec-v1.md for why it adds no state distinguishable from
 * TERMINATED/INDETERMINATE with the mechanisms this milestone builds. */
export const SESSION_STATUSES = ['CREATED', 'MONITORING', 'WARNED', 'HELD', 'TERMINATING', 'TERMINATED', 'COMPLETED', 'INDETERMINATE'] as const;
export type SessionStatus = typeof SESSION_STATUSES[number];
const SESSION_STATUS_SET = new Set<string>(SESSION_STATUSES);
export function isSessionStatus(value: unknown): value is SessionStatus { return typeof value === 'string' && SESSION_STATUS_SET.has(value); }

/** Controlled observation source registry (section 12). An untrusted source name is never accepted. */
export const OBSERVATION_SOURCES = ['TNA_GATE', 'EXECUTION_BROKER', 'ISOLATION_RUNNER', 'EGRESS_GUARD', 'SECRET_BROKER', 'TOOL_ADAPTER', 'VAD_RUNTIME', 'SENTINEL', 'SYSTEM'] as const;
export type ObservationSource = typeof OBSERVATION_SOURCES[number];
const OBSERVATION_SOURCE_SET = new Set<string>(OBSERVATION_SOURCES);

export const OBSERVATION_TYPES = [
  'EXECUTION_STARTED',
  'TOOL_CALL_REQUESTED', 'TOOL_CALL_STARTED', 'TOOL_CALL_COMPLETED', 'TOOL_CALL_FAILED',
  'RESOURCE_READ', 'RESOURCE_WRITE', 'RESOURCE_CREATE', 'RESOURCE_DELETE',
  'NETWORK_REQUEST', 'NETWORK_REDIRECT',
  'PROCESS_STARTED', 'PROCESS_EXITED',
  'SECRET_LEASE_REQUESTED', 'SECRET_LEASE_GRANTED', 'SECRET_LEASE_RELEASED',
  'COST_REPORTED',
  'AUTHORITY_RECHECK', 'POLICY_RECHECK', 'REVOCATION_RECHECK',
  'EXECUTION_HEARTBEAT', 'EXECUTION_COMPLETED', 'EXECUTION_FAILED',
] as const;
export type ObservationType = typeof OBSERVATION_TYPES[number];
const OBSERVATION_TYPE_SET = new Set<string>(OBSERVATION_TYPES);

/** Bind authenticated source identity to the observation types it may submit (section 11-12). */
export const SOURCE_ALLOWED_OBSERVATION_TYPES: Readonly<Record<ObservationSource, readonly ObservationType[]>> = {
  TNA_GATE: ['AUTHORITY_RECHECK', 'POLICY_RECHECK', 'REVOCATION_RECHECK'],
  EXECUTION_BROKER: ['EXECUTION_STARTED', 'TOOL_CALL_REQUESTED', 'TOOL_CALL_STARTED', 'TOOL_CALL_COMPLETED', 'TOOL_CALL_FAILED', 'EXECUTION_COMPLETED', 'EXECUTION_FAILED', 'EXECUTION_HEARTBEAT', 'COST_REPORTED'],
  ISOLATION_RUNNER: ['PROCESS_STARTED', 'PROCESS_EXITED', 'RESOURCE_READ', 'RESOURCE_WRITE', 'RESOURCE_CREATE', 'RESOURCE_DELETE'],
  EGRESS_GUARD: ['NETWORK_REQUEST', 'NETWORK_REDIRECT'],
  SECRET_BROKER: ['SECRET_LEASE_REQUESTED', 'SECRET_LEASE_GRANTED', 'SECRET_LEASE_RELEASED'],
  TOOL_ADAPTER: ['TOOL_CALL_REQUESTED', 'TOOL_CALL_STARTED', 'TOOL_CALL_COMPLETED', 'TOOL_CALL_FAILED', 'RESOURCE_READ', 'RESOURCE_WRITE', 'RESOURCE_CREATE', 'RESOURCE_DELETE'],
  VAD_RUNTIME: ['EXECUTION_STARTED', 'EXECUTION_COMPLETED', 'EXECUTION_FAILED', 'EXECUTION_HEARTBEAT'],
  SENTINEL: ['AUTHORITY_RECHECK', 'POLICY_RECHECK', 'REVOCATION_RECHECK'],
  SYSTEM: ['COST_REPORTED', 'EXECUTION_HEARTBEAT'],
};

/** Which observation types describe a not-yet-effected action vs. one already completed (section 67-68). */
const PRE_ACTION_TYPES = new Set<ObservationType>(['TOOL_CALL_REQUESTED', 'NETWORK_REQUEST', 'PROCESS_STARTED', 'RESOURCE_WRITE', 'RESOURCE_CREATE', 'RESOURCE_DELETE', 'SECRET_LEASE_REQUESTED']);
export type ObservationPhase = 'PRE_ACTION' | 'POST_ACTION';
export function observationPhase(type: ObservationType): ObservationPhase { return PRE_ACTION_TYPES.has(type) ? 'PRE_ACTION' : 'POST_ACTION'; }

export const RULE_ACTIONS = ['OBSERVE', 'WARN', 'HOLD', 'TERMINATE'] as const;
export type RuleAction = typeof RULE_ACTIONS[number];
const RULE_ACTION_SET = new Set<string>(RULE_ACTIONS);

export const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = typeof SEVERITIES[number];
const SEVERITY_SET = new Set<string>(SEVERITIES);
export const SEVERITY_SCORE: Readonly<Record<Severity, number>> = { INFO: 0, LOW: 10, MEDIUM: 30, HIGH: 60, CRITICAL: 100 };

export const DECISION_TYPES = ['CONTINUE', 'WARN', 'HOLD', 'TERMINATE'] as const;
export type SentinelDecisionType = typeof DECISION_TYPES[number];
/** Deterministic precedence (section 41): TERMINATE > HOLD > WARN > CONTINUE. */
export const DECISION_PRECEDENCE: Readonly<Record<SentinelDecisionType, number>> = { CONTINUE: 0, WARN: 1, HOLD: 2, TERMINATE: 3 };

export const RULE_TYPES = [
  'AUTHORITY_EXPIRED', 'APPROVAL_REVOKED', 'AGENT_REVOKED', 'POLICY_CHANGED',
  'TOOL_NOT_ALLOWED', 'OPERATION_NOT_ALLOWED', 'RESOURCE_NOT_ALLOWED',
  'DESTINATION_NOT_ALLOWED', 'PRIVATE_NETWORK_DESTINATION', 'REDIRECT_NOT_ALLOWED',
  'RUNTIME_EXCEEDED', 'COST_EXCEEDED',
  'TOO_MANY_TOOL_CALLS', 'TOO_MANY_NETWORK_REQUESTS', 'TOO_MANY_PROCESS_SPAWNS', 'UNEXPECTED_PROCESS',
  'SECRET_LEASE_NOT_ALLOWED', 'TOOL_INPUT_HASH_MISMATCH', 'CAPABILITY_CONTEXT_MISMATCH', 'MISSING_HEARTBEAT',
] as const;
export type RuleType = typeof RULE_TYPES[number];
const RULE_TYPE_SET = new Set<string>(RULE_TYPES);

export const PREVENTION_STATUSES = ['PREVENTED', 'DETECTED_AFTER_EFFECT', 'CONTAINMENT_REQUESTED', 'CONTAINMENT_CONFIRMED', 'CONTAINMENT_UNCONFIRMED'] as const;
export type PreventionStatus = typeof PREVENTION_STATUSES[number];

export const AUTHORITY_STATUSES = ['VALID', 'EXPIRED', 'REVOKED', 'POLICY_CHANGED', 'UNKNOWN'] as const;
export type AuthorityStatusKind = typeof AUTHORITY_STATUSES[number];
/** Extra context on a REVOKED status (section 19 vs 20): which authority object was revoked. Not part
 * of the fixed status enum itself — an additive detail the revalidator may supply. */
export type RevokedScope = 'agent' | 'approval';
export interface AuthorityStatus { status: AuthorityStatusKind; revokedScope?: RevokedScope; currentPolicyHash?: string | null; detail?: string }

export const OPERATIONS = ['read', 'write', 'create', 'delete'] as const;
export type Operation = typeof OPERATIONS[number];
const OPERATION_SET = new Set<string>(OPERATIONS);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safeId(value: unknown, maxLen = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
/** Resource/tool-path identifiers may contain '/' and a trailing '/**' glob (sections 7, 25, 88). */
export function safeResourcePattern(value: unknown, maxLen = 400): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen
    && !/[\\%\s]/.test(value) && !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*(\*\*)?$/.test(value);
}
export function isHex64(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
function finitePositiveInt(value: unknown, max: number): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max; }
function finiteNonNegativeNumber(value: unknown, max: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max; }

/** Deterministic canonical serialization: key order never affects the result (mirrors ledger-schema). */
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
/** Recursively scans structured observation content for secret-shaped fields/values (section 86).
 * Not comprehensive DLP — a fixed rule set, same principle as the accepted Ledger detector. */
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

export interface RuntimeLimits { max_runtime_seconds: number; heartbeat_interval_seconds?: number; heartbeat_grace_seconds?: number }
export interface CostLimits { max_cost_usd: number }
export interface CapabilityContext { capability_id: string; decision_id: string; agent_id: string; tool: string; operation: Operation; resource: string; expiry: string; input_hash: string }

/** Caller-supplied fields at session creation (section 7). Only a trusted controller/system principal
 * may create a session — see sentinel-runtime's role model; this package validates shape only. */
export interface SentinelSessionInput {
  version: '1.0';
  tenant_id: string; agent_id: string; execution_id: string;
  decision_id?: string; capability_id?: string; correlation_id: string;
  authority_snapshot_hash: string; policy_snapshot_hash: string;
  expected_action: string; expected_tool: string; expected_resource: string;
  allowed_destinations: readonly string[]; allowed_operations: readonly Operation[];
  allowed_processes?: readonly string[]; allowed_secrets?: readonly string[];
  authority_expiry: string;
  runtime_limits: RuntimeLimits; cost_limits: CostLimits;
  capability_context?: CapabilityContext;
}

/** Fully persisted session, as returned by sentinel-runtime. Runtime-owned fields are never caller-set. */
export interface SentinelSession extends SentinelSessionInput {
  sentinel_session_id: string;
  started_at: string;
  updated_at: string;
  status: SessionStatus;
  observation_sequence: number;
  tool_call_count: number;
  network_request_count: number;
  process_spawn_count: number;
  session_cost: number;
  last_heartbeat_at: string | null;
}

function assertProcessName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}
function assertStringArray(value: unknown, max: number, check: (v: unknown) => boolean): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(check);
}

/** Validates and normalizes a caller-supplied session input (section 7). Throws SentinelError. */
export function validateSessionInput(input: unknown): SentinelSessionInput {
  if (!isPlainObject(input)) throw new SentinelError('INVALID_INPUT', 'Session input must be an object');
  if (input.version !== SENTINEL_SESSION_VERSION) throw new SentinelError('UNSUPPORTED_VERSION', `Unsupported session version: ${String(input.version)}`);
  if (!safeId(input.tenant_id, 100)) throw new SentinelError('INVALID_INPUT', 'tenant_id is required');
  if (!safeId(input.agent_id, 200)) throw new SentinelError('INVALID_INPUT', 'agent_id is required');
  if (!safeId(input.execution_id, 200)) throw new SentinelError('INVALID_INPUT', 'execution_id is required');
  if (input.decision_id !== undefined && !safeId(input.decision_id, 200)) throw new SentinelError('INVALID_INPUT', 'decision_id must be a safe identifier');
  if (input.capability_id !== undefined && !safeId(input.capability_id, 200)) throw new SentinelError('INVALID_INPUT', 'capability_id must be a safe identifier');
  if (!safeId(input.correlation_id, 200)) throw new SentinelError('INVALID_INPUT', 'correlation_id is required');
  if (!isHex64(input.authority_snapshot_hash)) throw new SentinelError('INVALID_INPUT', 'authority_snapshot_hash must be a sha256 hex digest');
  if (!isHex64(input.policy_snapshot_hash)) throw new SentinelError('INVALID_INPUT', 'policy_snapshot_hash must be a sha256 hex digest');
  if (!safeId(input.expected_action, 200)) throw new SentinelError('INVALID_INPUT', 'expected_action is required');
  if (!safeId(input.expected_tool, 200)) throw new SentinelError('INVALID_INPUT', 'expected_tool is required');
  if (!safeResourcePattern(input.expected_resource)) throw new SentinelError('INVALID_INPUT', 'expected_resource is required');
  if (!assertStringArray(input.allowed_destinations, MAX_ALLOWED_LIST_ENTRIES, v => typeof v === 'string' && v.length > 0 && v.length <= 253)) throw new SentinelError('INVALID_INPUT', 'allowed_destinations must be a bounded array of hostnames');
  if (!assertStringArray(input.allowed_operations, OPERATIONS.length, v => typeof v === 'string' && OPERATION_SET.has(v))) throw new SentinelError('INVALID_INPUT', 'allowed_operations must be drawn from the controlled operation vocabulary');
  if (input.allowed_processes !== undefined && !assertStringArray(input.allowed_processes, MAX_ALLOWED_LIST_ENTRIES, assertProcessName)) throw new SentinelError('INVALID_INPUT', 'allowed_processes must be a bounded array of safe executable names');
  if (input.allowed_secrets !== undefined && !assertStringArray(input.allowed_secrets, MAX_ALLOWED_LIST_ENTRIES, v => safeId(v, 200))) throw new SentinelError('INVALID_INPUT', 'allowed_secrets must be a bounded array of safe identifiers');
  if (!isIsoTimestamp(input.authority_expiry)) throw new SentinelError('INVALID_INPUT', 'authority_expiry must be a valid ISO-8601 UTC timestamp');
  if (!isPlainObject(input.runtime_limits) || !finitePositiveInt(input.runtime_limits.max_runtime_seconds, 30 * 24 * 3600)) throw new SentinelError('INVALID_INPUT', 'runtime_limits.max_runtime_seconds is required');
  if (input.runtime_limits.heartbeat_interval_seconds !== undefined && !finitePositiveInt(input.runtime_limits.heartbeat_interval_seconds, 24 * 3600)) throw new SentinelError('INVALID_INPUT', 'runtime_limits.heartbeat_interval_seconds must be a positive integer');
  if (input.runtime_limits.heartbeat_grace_seconds !== undefined && !finitePositiveInt(input.runtime_limits.heartbeat_grace_seconds, 24 * 3600)) throw new SentinelError('INVALID_INPUT', 'runtime_limits.heartbeat_grace_seconds must be a positive integer');
  if (!isPlainObject(input.cost_limits) || !finiteNonNegativeNumber(input.cost_limits.max_cost_usd, 1_000_000)) throw new SentinelError('INVALID_INPUT', 'cost_limits.max_cost_usd is required');
  if (input.capability_context !== undefined) {
    const cc = input.capability_context;
    if (!isPlainObject(cc) || !safeId(cc.capability_id, 200) || !safeId(cc.decision_id, 200) || !safeId(cc.agent_id, 200)
      || !safeId(cc.tool, 200) || typeof cc.operation !== 'string' || !OPERATION_SET.has(cc.operation)
      || !safeResourcePattern(cc.resource) || !isIsoTimestamp(cc.expiry) || !isHex64(cc.input_hash)) {
      throw new SentinelError('INVALID_INPUT', 'capability_context is malformed');
    }
  }
  const secretHit = findSecretShapedField(input.capability_context);
  if (secretHit) throw new SentinelError('INVALID_INPUT', `Rejected: ${secretHit}`);

  const normalized: Record<string, unknown> = {
    version: SENTINEL_SESSION_VERSION, tenant_id: input.tenant_id, agent_id: input.agent_id, execution_id: input.execution_id,
    correlation_id: input.correlation_id, authority_snapshot_hash: input.authority_snapshot_hash, policy_snapshot_hash: input.policy_snapshot_hash,
    expected_action: input.expected_action, expected_tool: input.expected_tool, expected_resource: input.expected_resource,
    allowed_destinations: input.allowed_destinations, allowed_operations: input.allowed_operations,
    authority_expiry: input.authority_expiry, runtime_limits: input.runtime_limits, cost_limits: input.cost_limits,
  };
  if (input.decision_id !== undefined) normalized.decision_id = input.decision_id;
  if (input.capability_id !== undefined) normalized.capability_id = input.capability_id;
  if (input.allowed_processes !== undefined) normalized.allowed_processes = input.allowed_processes;
  if (input.allowed_secrets !== undefined) normalized.allowed_secrets = input.allowed_secrets;
  if (input.capability_context !== undefined) normalized.capability_context = input.capability_context;
  return normalized as unknown as SentinelSessionInput;
}

/** What a caller submits for one observation (section 9). Sentinel runtime owns `sequence`/`received_at`. */
export interface SentinelObservationInput {
  version: '1.0';
  observation_id: string;
  tenant_id: string;
  sentinel_session_id: string;
  timestamp: string;
  source: ObservationSource;
  observation_type: ObservationType;
  payload?: Record<string, unknown>;
}
export interface SentinelObservation extends SentinelObservationInput {
  sequence: number;
  received_at: string;
}

/** Validates and normalizes a caller-supplied observation input (section 9-10). Throws SentinelError. */
export function validateObservationInput(input: unknown): SentinelObservationInput {
  if (!isPlainObject(input)) throw new SentinelError('INVALID_INPUT', 'Observation must be an object');
  if (input.version !== SENTINEL_OBSERVATION_VERSION) throw new SentinelError('UNSUPPORTED_VERSION', `Unsupported observation version: ${String(input.version)}`);
  if (!safeId(input.observation_id, 200)) throw new SentinelError('INVALID_INPUT', 'observation_id must be a safe, bounded identifier');
  if (!safeId(input.tenant_id, 100)) throw new SentinelError('INVALID_INPUT', 'tenant_id is required');
  if (!safeId(input.sentinel_session_id, 200)) throw new SentinelError('INVALID_INPUT', 'sentinel_session_id is required');
  if (!isIsoTimestamp(input.timestamp)) throw new SentinelError('INVALID_INPUT', 'timestamp must be a valid ISO-8601 UTC timestamp');
  if (typeof input.source !== 'string' || !OBSERVATION_SOURCE_SET.has(input.source)) throw new SentinelError('INVALID_INPUT', `Unknown or untrusted source: ${String(input.source)}`);
  if (typeof input.observation_type !== 'string' || !OBSERVATION_TYPE_SET.has(input.observation_type)) throw new SentinelError('UNKNOWN_OBSERVATION_TYPE', `Unknown observation type: ${String(input.observation_type)}`);
  if (input.payload !== undefined) {
    if (!isPlainObject(input.payload)) throw new SentinelError('INVALID_INPUT', 'payload must be an object');
    const size = Buffer.byteLength(canonical(input.payload), 'utf8');
    if (size > MAX_OBSERVATION_PAYLOAD_BYTES) throw new SentinelError('PAYLOAD_TOO_LARGE', `Payload of ${size} bytes exceeds the ${MAX_OBSERVATION_PAYLOAD_BYTES}-byte limit`);
    const secretHit = findSecretShapedField(input.payload);
    if (secretHit) throw new SentinelError('INVALID_INPUT', `Rejected: ${secretHit}`);
  }
  const normalized: Record<string, unknown> = {
    version: SENTINEL_OBSERVATION_VERSION, observation_id: input.observation_id, tenant_id: input.tenant_id,
    sentinel_session_id: input.sentinel_session_id, timestamp: input.timestamp, source: input.source, observation_type: input.observation_type,
  };
  if (input.payload !== undefined) normalized.payload = input.payload;
  return normalized as unknown as SentinelObservationInput;
}

export { RULE_TYPE_SET, RULE_ACTION_SET, SEVERITY_SET };
