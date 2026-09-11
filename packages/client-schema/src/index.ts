import { createHash, randomUUID } from 'node:crypto';

/**
 * TNA Client Integration & MCP Gateway v0.1 (Volume 10). Domain types, validation, and canonicalization
 * for the client-onboarding control plane: tenants, service identities, credentials, and the risk/
 * readiness vocabulary shared with `packages/mcp-schema`. Deliberately narrow — tenant identity, role
 * set, and status vocabulary are closed unions, never arbitrary strings (section 4), matching this
 * project's established discipline of never introducing a "type: string" escape hatch for anything
 * security-relevant.
 */

export const MAX_NAME_LENGTH = 200;
export const MAX_METADATA_BYTES = 4096;
export const MAX_CLIENT_PAGE_SIZE = 200;
export const DEFAULT_CLIENT_PAGE_SIZE = 50;

export type ClientErrorCode =
  | 'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'PAYLOAD_TOO_LARGE'
  | 'TENANT_NOT_ACTIVE' | 'SERVICE_IDENTITY_REVOKED' | 'CREDENTIAL_INVALID'
  | 'TOOL_NOT_ENABLED' | 'TOOL_POLICY_REVIEW_REQUIRED' | 'SCHEMA_DRIFT_DETECTED'
  | 'CROSS_TENANT_DENIED';

export class ClientError extends Error {
  public constructor(public readonly code: ClientErrorCode, message: string) {
    super(message);
    this.name = 'ClientError';
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

const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|secret|password|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|authorization|credential|signing[_-]?key)/i;
const SECRET_VALUE_PATTERN = /Bearer\s+\S+/i;
/** Section 145: reused, unchanged detection algorithm from `platform-schema`/`deployment-schema` — a
 * fixed rule set, not general DLP. Applied to every piece of client/MCP metadata this package accepts
 * before it is ever persisted or echoed back. */
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
// Client tenant (section 4-5)
// ---------------------------------------------------------------------------------------------

export const CLIENT_TENANT_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'OFFBOARDED'] as const;
export type ClientTenantStatus = typeof CLIENT_TENANT_STATUSES[number];

export interface ClientTenant {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly environment: 'development' | 'test' | 'production';
  readonly status: ClientTenantStatus;
  readonly created_at: string;
  readonly created_by: string;
  readonly deployment_binding: string;
  readonly policy_profile: string;
  readonly allowed_connector_types: readonly ('mcp-stdio')[];
  readonly configuration_hash: string;
  readonly state_version: number;
  readonly suspended_reason: string | null;
  readonly offboarding_reason: string | null;
}

/** Section 5: tenant identity is runtime-owned. A caller never supplies `tenant_id` for creation — the
 * platform mints one (`ten_<uuid>`); a trusted operator/admin principal is the only caller of this
 * validator's result. */
export interface ClientTenantCreateInput {
  readonly display_name: string;
  readonly environment: 'development' | 'test' | 'production';
  readonly deployment_binding: string;
  readonly policy_profile: string;
  readonly allowed_connector_types: readonly ('mcp-stdio')[];
}
export function validateClientTenantCreateInput(raw: unknown): ClientTenantCreateInput {
  if (!isPlainObject(raw)) throw new ClientError('INVALID_INPUT', 'Tenant create input must be an object');
  const allowed = ['display_name', 'environment', 'deployment_binding', 'policy_profile', 'allowed_connector_types'];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new ClientError('INVALID_INPUT', `Unknown field: ${key}`);
  if (typeof raw.display_name !== 'string' || raw.display_name.length === 0 || raw.display_name.length > MAX_NAME_LENGTH) throw new ClientError('INVALID_INPUT', 'display_name must be a non-empty bounded string');
  if (raw.environment !== 'development' && raw.environment !== 'test' && raw.environment !== 'production') throw new ClientError('INVALID_INPUT', 'environment must be development|test|production');
  if (!safeId(raw.deployment_binding)) throw new ClientError('INVALID_INPUT', 'deployment_binding must be a safe identifier');
  if (!safeId(raw.policy_profile)) throw new ClientError('INVALID_INPUT', 'policy_profile must be a safe identifier');
  if (!Array.isArray(raw.allowed_connector_types) || raw.allowed_connector_types.length === 0 || raw.allowed_connector_types.some(t => t !== 'mcp-stdio')) {
    throw new ClientError('INVALID_INPUT', 'allowed_connector_types must be a non-empty array of supported connector types');
  }
  const found = findSecretShapedField(raw);
  if (found) throw new ClientError('INVALID_INPUT', `Tenant create input rejected: ${found}`);
  return raw as unknown as ClientTenantCreateInput;
}
export function newTenantId(): string { return `ten_${randomUUID()}`; }

// ---------------------------------------------------------------------------------------------
// Client service identity (section 6)
// ---------------------------------------------------------------------------------------------

export const CLIENT_SERVICE_ROLES = ['agent-client', 'tool-provider', 'operator', 'read-only-auditor'] as const;
export type ClientServiceRole = typeof CLIENT_SERVICE_ROLES[number];
export const CLIENT_SERVICE_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type ClientServiceStatus = typeof CLIENT_SERVICE_STATUSES[number];

export interface ClientServiceIdentity {
  readonly service_id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly role: ClientServiceRole;
  readonly status: ClientServiceStatus;
  readonly credential_ref: string;
  readonly created_at: string;
  readonly last_rotated_at: string;
  readonly state_version: number;
}
export interface ClientServiceIdentityCreateInput { readonly name: string; readonly role: ClientServiceRole }
export function validateServiceIdentityCreateInput(raw: unknown): ClientServiceIdentityCreateInput {
  if (!isPlainObject(raw)) throw new ClientError('INVALID_INPUT', 'Service identity create input must be an object');
  for (const key of Object.keys(raw)) if (!['name', 'role'].includes(key)) throw new ClientError('INVALID_INPUT', `Unknown field: ${key}`);
  if (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > MAX_NAME_LENGTH) throw new ClientError('INVALID_INPUT', 'name must be a non-empty bounded string');
  if (!(CLIENT_SERVICE_ROLES as readonly string[]).includes(raw.role as string)) throw new ClientError('INVALID_INPUT', `role must be one of: ${CLIENT_SERVICE_ROLES.join(', ')}`);
  return { name: raw.name, role: raw.role as ClientServiceRole };
}
export function newServiceId(): string { return `svc_${randomUUID()}`; }

// ---------------------------------------------------------------------------------------------
// Credentials (section 7-8). Only a reference + verification hash are ever persisted — the raw bearer
// value is returned to the caller exactly once, at issuance/rotation, and never again.
// ---------------------------------------------------------------------------------------------

export interface IssuedCredential { readonly credential_ref: string; readonly token: string }
function randomToken(): string { return randomUUID() + randomUUID().replace(/-/g, ''); }
export function issueCredential(): IssuedCredential { return { credential_ref: `cred_${randomUUID()}`, token: `tnaclient_${randomToken()}` }; }
export function hashCredentialToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
/** Constant-time-ish comparison via hash equality — both sides are already fixed-length hex digests, so
 * a straightforward comparison does not leak timing information proportional to a secret's content. */
export function verifyCredentialToken(token: string, storedHash: string): boolean { return hashCredentialToken(token) === storedHash; }

// ---------------------------------------------------------------------------------------------
// Risk / readiness / bypass vocabulary (sections 21, 51, 118-119) — shared with `mcp-schema`.
// ---------------------------------------------------------------------------------------------

export const RISK_CLASSIFICATIONS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskClassification = typeof RISK_CLASSIFICATIONS[number];

export const ONBOARDING_READINESS = ['READY', 'READY_WITH_LIMITATIONS', 'NOT_READY', 'INSUFFICIENT_EVIDENCE'] as const;
export type OnboardingReadiness = typeof ONBOARDING_READINESS[number];

export const BYPASS_ASSESSMENTS = ['NO_KNOWN_BYPASS', 'KNOWN_BYPASS', 'UNKNOWN'] as const;
export type BypassAssessment = typeof BYPASS_ASSESSMENTS[number];

/**
 * Section 118-119: "Can the client bypass TNA?" is fundamentally an operator attestation, not
 * something derivable from `ClientStore` state alone — nothing in this store can observe whether a
 * client's agents also hold a separate, direct credential to the same external system outside TNA's
 * own credential chain. This function is the one deterministic place that attestation becomes a
 * `BypassAssessment` value, so the answer is reproducible and auditable rather than an ad hoc operator
 * judgment call recorded in prose. `externalDirectCredential: true` always wins — a known bypass is
 * never allowed to be reported as clean high-assurance mediation merely because other things look fine
 * (section 119: "This must not become a clean high-assurance readiness result"). */
export function computeBypassAssessment(attestation: { readonly tnaCredentialChain: boolean; readonly externalDirectCredential: boolean }): BypassAssessment {
  if (attestation.externalDirectCredential) return 'KNOWN_BYPASS';
  if (attestation.tnaCredentialChain) return 'NO_KNOWN_BYPASS';
  return 'UNKNOWN';
}

export interface Page<T> { readonly items: readonly T[]; readonly nextCursor?: string }
export function readPageOptions(limit: number | undefined, maxSize: number = MAX_CLIENT_PAGE_SIZE): number {
  const effective = limit ?? DEFAULT_CLIENT_PAGE_SIZE;
  if (!Number.isInteger(effective) || effective <= 0 || effective > maxSize) throw new ClientError('INVALID_INPUT', `limit must be a positive integer <= ${maxSize}`);
  return effective;
}
