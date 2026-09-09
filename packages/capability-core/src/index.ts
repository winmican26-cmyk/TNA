import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 1 as const;
const DEFAULT_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 60;
const MAC_LENGTH = 32;

export class CapabilityError extends Error {
  constructor(message = 'Invalid capability token') {
    super(message);
    this.name = 'CapabilityError';
  }
}

export interface CapabilityPayload {
  version: 1;
  capability_id: string;
  execution_id: string;
  agent_id: string;
  decision_id: string;
  action: string;
  tool: string;
  resource: string;
  operation: string;
  input_hash: string;
  destination: string | null;
  policy_hash: string;
  policy_issuance_id: string;
  issued_at: string;
  expires_at: string;
  single_use: true;
  nonce: string;
}

export type CapabilityInput = Omit<CapabilityPayload, 'version' | 'issued_at' | 'expires_at' | 'single_use' | 'nonce' | 'input_hash'> & {
  input_hash?: string;
  expires_at?: string;
};

export interface CapabilityOptions {
  clock?: () => number;
  ttlSeconds?: number;
}

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonical(value: CanonicalValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new CapabilityError();
  const decoded = Buffer.from(value, 'base64url');
  if (encode(decoded) !== value) throw new CapabilityError();
  return decoded;
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function parseIso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

export class CapabilityCodec {
  private readonly secret: Buffer;
  private readonly clock: () => number;
  private readonly ttlSeconds: number;

  constructor(secret: Uint8Array, options?: CapabilityOptions | (() => number), ttlSeconds = DEFAULT_TTL_SECONDS) {
    if (secret.byteLength < 32) throw new CapabilityError('Capability secret must be at least 32 bytes');
    const resolvedOptions = typeof options === 'function' ? { clock: options, ttlSeconds } : options;
    const resolvedTtl = resolvedOptions?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isInteger(resolvedTtl) || resolvedTtl <= 0 || resolvedTtl > MAX_TTL_SECONDS) {
      throw new CapabilityError('Capability TTL must be an integer from 1 to 60 seconds');
    }
    this.secret = Buffer.from(secret);
    this.clock = resolvedOptions?.clock ?? Date.now;
    this.ttlSeconds = resolvedTtl;
  }

  issue(input: CapabilityInput): { token: string; payload: CapabilityPayload } {
    if (!this.validInput(input)) throw new CapabilityError('Invalid capability input');
    const inputHash = input.input_hash ?? createHash('sha256').update('null').digest('hex');
    const issuedAt = this.clock();
    if (!Number.isFinite(issuedAt)) throw new CapabilityError('Invalid clock value');
    const issuedAtIso = new Date(issuedAt).toISOString();
    const maximumExpiry = issuedAt + this.ttlSeconds * 1000;
    const requestedExpiry = input.expires_at === undefined ? maximumExpiry : Date.parse(input.expires_at);
    if (!Number.isFinite(requestedExpiry) || requestedExpiry < issuedAt) throw new CapabilityError('Invalid capability expiry');
    const payload = {
      version: VERSION, capability_id: input.capability_id, execution_id: input.execution_id,
      agent_id: input.agent_id, decision_id: input.decision_id, action: input.action,
      tool: input.tool, resource: input.resource, operation: input.operation,
      input_hash: inputHash,
      destination: input.destination, policy_hash: input.policy_hash,
      policy_issuance_id: input.policy_issuance_id, issued_at: issuedAtIso,
      expires_at: new Date(Math.min(requestedExpiry, maximumExpiry)).toISOString(),
      single_use: true, nonce: encode(randomBytes(16)),
    };
    return { token: this.sign(payload as CapabilityPayload), payload: payload as CapabilityPayload };
  }

  verify(token: string): CapabilityPayload {
    try {
      if (typeof token !== 'string') throw new CapabilityError();
      const parts = token.split('.');
      if (parts.length !== 2) throw new CapabilityError();
      const payloadBytes = decode(parts[0]!);
      const suppliedMac = decode(parts[1]!);
      if (suppliedMac.length !== MAC_LENGTH) throw new CapabilityError();
      const expectedMac = createHmac('sha256', this.secret).update(payloadBytes).digest();
      if (!timingSafeEqual(expectedMac, suppliedMac)) throw new CapabilityError();
      const parsed: unknown = JSON.parse(payloadBytes.toString('utf8'));
      if (!this.validPayload(parsed) || parsed.version !== VERSION) throw new CapabilityError();
      if (canonical(parsed as unknown as CanonicalValue) !== payloadBytes.toString('utf8')) throw new CapabilityError();
      const now = this.clock();
      if (!Number.isFinite(now)) throw new CapabilityError();
      const issuedAt = Date.parse(parsed.issued_at);
      const expiresAt = Date.parse(parsed.expires_at);
      if (issuedAt > now) throw new CapabilityError('Capability issued in the future');
      if (expiresAt - issuedAt > MAX_TTL_SECONDS * 1000) throw new CapabilityError('Capability TTL exceeds maximum');
      if (expiresAt <= now) throw new CapabilityError('Capability expired');
      return parsed;
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      throw new CapabilityError();
    }
  }

  private sign(payload: CapabilityPayload): string {
    const payloadBytes = Buffer.from(canonical(payload as unknown as CanonicalValue));
    const mac = createHmac('sha256', this.secret).update(payloadBytes).digest();
    return `${encode(payloadBytes)}.${encode(mac)}`;
  }

  private validInput(input: CapabilityInput): boolean {
    const keys = ['action', 'agent_id', 'capability_id', 'decision_id', 'destination', 'execution_id', 'operation', 'policy_hash', 'policy_issuance_id', 'resource', 'tool', 'input_hash'];
    if (input !== null && typeof input === 'object' && (Object.keys(input).some(key => !keys.includes(key) && key !== 'expires_at') || ![keys.length - 1, keys.length, keys.length + 1].includes(Object.keys(input).length))) return false;
    return input !== null && typeof input === 'object'
      && validText(input.capability_id) && validText(input.execution_id) && validText(input.agent_id)
      && validText(input.decision_id) && validText(input.action) && validText(input.tool)
      && validText(input.resource) && validText(input.operation)
      && (input.input_hash === undefined || /^[a-f0-9]{64}$/.test(input.input_hash))
      && (input.destination === null || validText(input.destination))
      && validText(input.policy_hash) && validText(input.policy_issuance_id)
      && (input.expires_at === undefined || parseIso(input.expires_at));
  }

  private validPayload(value: unknown): value is CapabilityPayload {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const payload = value as Record<string, unknown>;
    const keys = ['version', 'capability_id', 'execution_id', 'agent_id', 'decision_id', 'action', 'tool', 'resource', 'operation', 'input_hash', 'destination', 'policy_hash', 'policy_issuance_id', 'issued_at', 'expires_at', 'single_use', 'nonce'];
    return Object.keys(payload).length === keys.length && keys.every(key => key in payload)
      && payload.version === VERSION && payload.single_use === true
      && validText(payload.capability_id) && validText(payload.execution_id) && validText(payload.agent_id)
      && validText(payload.decision_id) && validText(payload.action) && validText(payload.tool)
      && validText(payload.resource) && validText(payload.operation)
      && typeof payload.input_hash === 'string' && /^[a-f0-9]{64}$/.test(payload.input_hash)
      && (payload.destination === null || validText(payload.destination))
      && validText(payload.policy_hash) && validText(payload.policy_issuance_id)
      && parseIso(payload.issued_at) && parseIso(payload.expires_at) && validText(payload.nonce)
      && /^[A-Za-z0-9_-]{22}$/.test(payload.nonce)
      && Date.parse(payload.expires_at) >= Date.parse(payload.issued_at);
  }
}