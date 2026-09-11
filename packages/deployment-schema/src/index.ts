import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * TNA Deployment Engineering v0.1 (Volume 9). Configuration is executable authority (TNA-55): what an
 * operator writes into deployment config decides what network surface is exposed, which credentials are
 * accepted, and what a production process will silently do if a required value is missing. This package
 * defines `DeploymentConfig v1`, a strict loader/validator that fails startup on anything invalid or
 * unsafe rather than inventing a default (section 15, 17), and a secret-reference model that keeps
 * literal secret values out of the config object itself (section 18-19).
 *
 * This package has no I/O dependency on any accepted TNA component — it only knows about deployment
 * shape, never about Gate/Sentinel/Ledger/VAD/Auditor internals, so it cannot itself weaken any accepted
 * boundary (TNA-43).
 */

export const DEPLOYMENT_CONFIG_VERSION = '1' as const;
export const ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type Environment = typeof ENVIRONMENTS[number];

export type DeploymentConfigErrorCode =
  | 'UNKNOWN_FIELD' | 'INVALID_VALUE' | 'MISSING_REQUIRED' | 'WEAK_SECRET' | 'INSECURE_PRODUCTION_DEFAULT';

export class DeploymentConfigError extends Error {
  public constructor(public readonly code: DeploymentConfigErrorCode, message: string) {
    super(message);
    this.name = 'DeploymentConfigError';
  }
}

// ---------------------------------------------------------------------------------------------
// Secret references (section 18-19). Configuration carries a *reference* to a secret, never the
// secret value itself — `{ source: 'env', ref: 'TNA_ADMIN_TOKEN' }`, not the token in plaintext.
// ---------------------------------------------------------------------------------------------

export type SecretRefSource = 'env' | 'file';
export interface SecretRef {
  readonly source: SecretRefSource;
  readonly ref: string;
}

function isSecretRef(value: unknown): value is SecretRef {
  return isPlainObject(value) && (value.source === 'env' || value.source === 'file')
    && typeof value.ref === 'string' && value.ref.length > 0 && value.ref.length <= 4096;
}

/** Reads the actual secret value. Never logged, never included in a config hash or diagnostics dump. */
export function resolveSecretRef(ref: SecretRef, env: NodeJS.ProcessEnv = process.env): string {
  if (ref.source === 'env') {
    const value = env[ref.ref];
    if (value === undefined || value.length === 0) throw new DeploymentConfigError('MISSING_REQUIRED', `Secret env var ${ref.ref} is not set`);
    return value;
  }
  let raw: string;
  try { raw = readFileSync(ref.ref, 'utf8'); }
  catch { throw new DeploymentConfigError('MISSING_REQUIRED', `Secret file ${ref.ref} could not be read`); }
  const value = raw.trim();
  if (value.length === 0) throw new DeploymentConfigError('MISSING_REQUIRED', `Secret file ${ref.ref} is empty`);
  return value;
}

/** A human-readable, non-secret identifier for a secret reference — safe to hash/log/diagnose. */
export function secretRefIdentifier(ref: SecretRef): string { return `${ref.source}:${ref.ref}`; }

const WEAK_SECRET_VALUES = new Set([
  'changeme', 'change-me', 'admin', 'secret', 'password', 'test-secret', 'default', 'default-secret',
  'insecure', 'placeholder', '12345678', 'letmein', 'trustnoagent', 'tna-dev-secret',
]);
/** Section 95: a value on this list — or too short, or every character the same — is never an
 * acceptable production credential, no matter how it was supplied. */
export function isWeakSecret(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  if (WEAK_SECRET_VALUES.has(lowered)) return true;
  if (value.length < 32) return true;
  if (new Set(value).size <= 2) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// DeploymentConfig v1
// ---------------------------------------------------------------------------------------------

export interface DeploymentNetworkConfig {
  readonly host: string;
  readonly port: number;
  /** Whether X-Forwarded-For/X-Forwarded-Proto from the immediate peer are trusted (section 28) —
   * true only behind a known reverse proxy on a private network, never on a directly internet-facing
   * listener. */
  readonly trust_proxy: boolean;
  /** null = no CORS header emitted (restrictive default, section 29). '*' is rejected in production
   * (section 96) unless credentials are structurally impossible for the route in question. */
  readonly cors_allow_origin: string | null;
}
export interface DeploymentStorageConfig {
  readonly data_dir: string;
}
export interface DeploymentSecretsConfig {
  readonly operator_token_ref: SecretRef;
  readonly admin_token_ref: SecretRef;
  readonly service_token_ref: SecretRef;
  /** Capability signing key. Optional in development/test (a random key is generated in-memory);
   * mandatory in production (section 17 — no magic production default). */
  readonly capability_key_ref: SecretRef | null;
}
export interface DeploymentResourceLimits {
  readonly request_timeout_ms: number;
  readonly headers_timeout_ms: number;
  readonly max_body_bytes: number;
}
export interface DeploymentConfig {
  readonly version: typeof DEPLOYMENT_CONFIG_VERSION;
  readonly environment: Environment;
  readonly tenant_id: string;
  readonly network: DeploymentNetworkConfig;
  readonly storage: DeploymentStorageConfig;
  readonly secrets: DeploymentSecretsConfig;
  readonly limits: DeploymentResourceLimits;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assertNoUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new DeploymentConfigError('UNKNOWN_FIELD', `Unknown configuration field: ${path}.${key}`);
  }
}
function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) throw new DeploymentConfigError('MISSING_REQUIRED', `${path}.${key} must be a non-empty string`);
  return value;
}
function requireInt(obj: Record<string, unknown>, key: string, path: string, min: number, max: number): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new DeploymentConfigError('INVALID_VALUE', `${path}.${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}
function requireSecretRef(obj: Record<string, unknown>, key: string, path: string): SecretRef {
  const value = obj[key];
  if (!isSecretRef(value)) throw new DeploymentConfigError('MISSING_REQUIRED', `${path}.${key} must be a secret reference ({ source: 'env'|'file', ref })`);
  return value;
}

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$|^::1$|^\[[0-9a-fA-F:]+\]$/;

/**
 * Strictly parses and validates a raw configuration object into a `DeploymentConfig`. Rejects any
 * unknown field, any out-of-range value, and (in production) any missing-required or insecure-default
 * value outright — section 15: "Startup must fail on invalid configuration," not fall back silently.
 */
export function parseDeploymentConfig(raw: unknown): DeploymentConfig {
  if (!isPlainObject(raw)) throw new DeploymentConfigError('INVALID_VALUE', 'Configuration must be a JSON object');
  assertNoUnknownKeys(raw, ['version', 'environment', 'tenant_id', 'network', 'storage', 'secrets', 'limits'], '$');

  if (raw.version !== DEPLOYMENT_CONFIG_VERSION) throw new DeploymentConfigError('INVALID_VALUE', `$.version must be "${DEPLOYMENT_CONFIG_VERSION}"`);
  const environmentRaw = raw.environment;
  if (typeof environmentRaw !== 'string' || !(ENVIRONMENTS as readonly string[]).includes(environmentRaw)) {
    throw new DeploymentConfigError('INVALID_VALUE', `$.environment must be one of: ${ENVIRONMENTS.join(', ')}`);
  }
  const environment = environmentRaw as Environment;
  const tenantId = requireString(raw, 'tenant_id', '$');
  if (!TENANT_ID_PATTERN.test(tenantId)) throw new DeploymentConfigError('INVALID_VALUE', '$.tenant_id has an invalid shape');

  if (!isPlainObject(raw.network)) throw new DeploymentConfigError('MISSING_REQUIRED', '$.network is required');
  assertNoUnknownKeys(raw.network, ['host', 'port', 'trust_proxy', 'cors_allow_origin'], '$.network');
  const host = requireString(raw.network, 'host', '$.network');
  if (!HOST_PATTERN.test(host)) throw new DeploymentConfigError('INVALID_VALUE', '$.network.host is not a valid hostname/IP');
  const port = requireInt(raw.network, 'port', '$.network', 1, 65535);
  const trustProxy = raw.network.trust_proxy;
  if (typeof trustProxy !== 'boolean') throw new DeploymentConfigError('INVALID_VALUE', '$.network.trust_proxy must be a boolean');
  const corsAllowOrigin = raw.network.cors_allow_origin;
  if (corsAllowOrigin !== null && typeof corsAllowOrigin !== 'string') throw new DeploymentConfigError('INVALID_VALUE', '$.network.cors_allow_origin must be a string or null');
  if (typeof corsAllowOrigin === 'string' && corsAllowOrigin !== '*') {
    try { new URL(corsAllowOrigin); } catch { throw new DeploymentConfigError('INVALID_VALUE', '$.network.cors_allow_origin must be "*", a valid origin URL, or null'); }
  }

  if (!isPlainObject(raw.storage)) throw new DeploymentConfigError('MISSING_REQUIRED', '$.storage is required');
  assertNoUnknownKeys(raw.storage, ['data_dir'], '$.storage');
  const dataDir = requireString(raw.storage, 'data_dir', '$.storage');

  if (!isPlainObject(raw.secrets)) throw new DeploymentConfigError('MISSING_REQUIRED', '$.secrets is required');
  assertNoUnknownKeys(raw.secrets, ['operator_token_ref', 'admin_token_ref', 'service_token_ref', 'capability_key_ref'], '$.secrets');
  const operatorTokenRef = requireSecretRef(raw.secrets, 'operator_token_ref', '$.secrets');
  const adminTokenRef = requireSecretRef(raw.secrets, 'admin_token_ref', '$.secrets');
  const serviceTokenRef = requireSecretRef(raw.secrets, 'service_token_ref', '$.secrets');
  const capabilityKeyRefRaw = raw.secrets.capability_key_ref;
  if (capabilityKeyRefRaw !== null && capabilityKeyRefRaw !== undefined && !isSecretRef(capabilityKeyRefRaw)) {
    throw new DeploymentConfigError('INVALID_VALUE', '$.secrets.capability_key_ref must be a secret reference or null');
  }
  const capabilityKeyRef = isSecretRef(capabilityKeyRefRaw) ? capabilityKeyRefRaw : null;

  if (!isPlainObject(raw.limits)) throw new DeploymentConfigError('MISSING_REQUIRED', '$.limits is required');
  assertNoUnknownKeys(raw.limits, ['request_timeout_ms', 'headers_timeout_ms', 'max_body_bytes'], '$.limits');
  const requestTimeoutMs = requireInt(raw.limits, 'request_timeout_ms', '$.limits', 1, 600_000);
  const headersTimeoutMs = requireInt(raw.limits, 'headers_timeout_ms', '$.limits', 1, 600_000);
  const maxBodyBytes = requireInt(raw.limits, 'max_body_bytes', '$.limits', 1, 100 * 1024 * 1024);

  const config: DeploymentConfig = {
    version: DEPLOYMENT_CONFIG_VERSION, environment, tenant_id: tenantId,
    network: { host, port, trust_proxy: trustProxy, cors_allow_origin: corsAllowOrigin },
    storage: { data_dir: dataDir },
    secrets: { operator_token_ref: operatorTokenRef, admin_token_ref: adminTokenRef, service_token_ref: serviceTokenRef, capability_key_ref: capabilityKeyRef },
    limits: { request_timeout_ms: requestTimeoutMs, headers_timeout_ms: headersTimeoutMs, max_body_bytes: maxBodyBytes },
  };
  assertProductionSafe(config);
  return config;
}

/**
 * Section 16-17: production must not silently inherit developer-friendly behavior. Every check here
 * fails startup (throws) rather than downgrading to a warning.
 */
function assertProductionSafe(config: DeploymentConfig): void {
  if (config.environment !== 'production') return;
  if (config.secrets.capability_key_ref === null) {
    throw new DeploymentConfigError('MISSING_REQUIRED', 'production requires secrets.capability_key_ref — a random in-memory key is not acceptable in production');
  }
  if (config.network.cors_allow_origin === '*') {
    throw new DeploymentConfigError('INSECURE_PRODUCTION_DEFAULT', 'production must not set network.cors_allow_origin to "*" for an authenticated control-plane API');
  }
  if (config.network.host === '0.0.0.0' && !config.network.trust_proxy) {
    throw new DeploymentConfigError('INSECURE_PRODUCTION_DEFAULT', 'production binding to 0.0.0.0 without trust_proxy implies a directly internet-facing listener with no TLS boundary — bind to a private interface behind a reverse proxy instead');
  }
}

/**
 * Resolves every secret reference in a config and additionally rejects a weak/default value in
 * production (section 95) — this is a separate pass from `parseDeploymentConfig` because it requires
 * I/O (reading env vars / secret files), which the pure structural validator above deliberately avoids.
 */
export interface ResolvedDeploymentSecrets {
  readonly operatorToken: string;
  readonly adminToken: string;
  readonly serviceToken: string;
  readonly capabilityKey: string | null;
}
export function resolveDeploymentSecrets(config: DeploymentConfig, env: NodeJS.ProcessEnv = process.env): ResolvedDeploymentSecrets {
  const operatorToken = resolveSecretRef(config.secrets.operator_token_ref, env);
  const adminToken = resolveSecretRef(config.secrets.admin_token_ref, env);
  const serviceToken = resolveSecretRef(config.secrets.service_token_ref, env);
  const capabilityKey = config.secrets.capability_key_ref ? resolveSecretRef(config.secrets.capability_key_ref, env) : null;
  if (config.environment === 'production') {
    for (const [name, value] of [['operator_token', operatorToken], ['admin_token', adminToken], ['service_token', serviceToken], ...(capabilityKey !== null ? [['capability_key', capabilityKey]] : [])] as const) {
      if (isWeakSecret(value)) throw new DeploymentConfigError('WEAK_SECRET', `production secret "${name}" is missing, too short, too uniform, or a known-weak default value`);
    }
    const tokens = [operatorToken, adminToken, serviceToken];
    if (new Set(tokens).size !== tokens.length) throw new DeploymentConfigError('WEAK_SECRET', 'production operator/admin/service tokens must be distinct');
  }
  return { operatorToken, adminToken, serviceToken, capabilityKey };
}

/**
 * Section 74: a deployment_config_hash excluding secret *values* but including secret reference
 * *identifiers* — enough to detect "the operator changed what secret is referenced" or "the port
 * changed" without ever hashing anything that would let the hash itself leak a credential.
 */
export function computeConfigHash(config: DeploymentConfig): string {
  const shape = {
    version: config.version, environment: config.environment, tenant_id: config.tenant_id,
    network: config.network, storage: config.storage,
    secrets: {
      operator_token_ref: secretRefIdentifier(config.secrets.operator_token_ref),
      admin_token_ref: secretRefIdentifier(config.secrets.admin_token_ref),
      service_token_ref: secretRefIdentifier(config.secrets.service_token_ref),
      capability_key_ref: config.secrets.capability_key_ref ? secretRefIdentifier(config.secrets.capability_key_ref) : null,
    },
    limits: config.limits,
  };
  return createHash('sha256').update(canonicalJson(shape)).digest('hex');
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

// ---------------------------------------------------------------------------------------------
// Env-var loader (section 76-77's primary, 12-factor-style path — the config a container actually
// receives). Structurally builds the same raw shape `parseDeploymentConfig` validates, so every
// strictness rule above applies uniformly regardless of how the config arrived.
// ---------------------------------------------------------------------------------------------

function envSecretRef(env: NodeJS.ProcessEnv, baseName: string): SecretRef | undefined {
  const fileRef = env[`${baseName}_FILE`];
  if (fileRef) return { source: 'file', ref: fileRef };
  const envName = env[`${baseName}_ENV`] ?? baseName;
  if (env[envName] !== undefined) return { source: 'env', ref: envName };
  return undefined;
}
function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

export function loadDeploymentConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DeploymentConfig {
  const operatorRef = envSecretRef(env, 'TNA_OPERATOR_TOKEN');
  const adminRef = envSecretRef(env, 'TNA_ADMIN_TOKEN');
  const serviceRef = envSecretRef(env, 'TNA_SERVICE_TOKEN');
  const capabilityRef = envSecretRef(env, 'TNA_CAPABILITY_KEY');
  const raw = {
    version: env.TNA_CONFIG_VERSION ?? DEPLOYMENT_CONFIG_VERSION,
    environment: env.TNA_ENV ?? 'development',
    tenant_id: env.TNA_TENANT_ID ?? 'tenant_default',
    network: {
      host: env.TNA_HOST ?? '127.0.0.1',
      port: envNumber(env, 'TNA_PORT', 4618),
      trust_proxy: env.TNA_TRUST_PROXY === 'true',
      cors_allow_origin: env.TNA_CORS_ALLOW_ORIGIN ?? null,
    },
    storage: { data_dir: env.TNA_DATA_DIR ?? './data' },
    secrets: {
      operator_token_ref: operatorRef ?? { source: 'env', ref: 'TNA_OPERATOR_TOKEN' },
      admin_token_ref: adminRef ?? { source: 'env', ref: 'TNA_ADMIN_TOKEN' },
      service_token_ref: serviceRef ?? { source: 'env', ref: 'TNA_SERVICE_TOKEN' },
      capability_key_ref: capabilityRef ?? null,
    },
    limits: {
      request_timeout_ms: envNumber(env, 'TNA_REQUEST_TIMEOUT_MS', 30_000),
      headers_timeout_ms: envNumber(env, 'TNA_HEADERS_TIMEOUT_MS', 10_000),
      max_body_bytes: envNumber(env, 'TNA_MAX_BODY_BYTES', 262_144),
    },
  };
  return parseDeploymentConfig(raw);
}

// ---------------------------------------------------------------------------------------------
// Redaction (section 20-21, 34, 58-60). Applied uniformly to anything about to be logged or served
// on a diagnostics surface — never to Ledger evidence, which has its own, separate secret-shape guard
// in `platform-schema`.
// ---------------------------------------------------------------------------------------------

const REDACT_KEY_PATTERN = /(secret|token|password|api[_-]?key|private[_-]?key|authorization|credential|signing[_-]?key)/i;
const REDACT_VALUE_PATTERN = /Bearer\s+\S+/i;
export const REDACTED = '[REDACTED]';

/** Deep-clones `value`, replacing any secret-shaped field or bearer-token-shaped string with
 * `REDACTED`. Safe to apply to arbitrary request/response/config-adjacent objects before logging. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 20) return REDACTED;
  if (typeof value === 'string') return REDACT_VALUE_PATTERN.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map(entry => redact(entry, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) out[key] = REDACT_KEY_PATTERN.test(key) ? REDACTED : redact(entryValue, depth + 1);
    return out;
  }
  return value;
}
