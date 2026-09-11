import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { equalToken } from '../../../packages/agent-identity/src/index.js';
import { SentinelError, type SentinelPrincipal, type SentinelRuntime, type SentinelRole } from '../../../packages/sentinel-runtime/src/index.js';
import {
  gateSource, executionBrokerSource, isolationRunnerSource, egressGuardSource, secretBrokerSource,
  toolAdapterSource, vadRuntimeSource, systemSource, reader, controller, admin,
} from './writers.js';

export class HttpError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}

/** One bearer credential per fixed source identity, plus reader/controller/admin (section 79-80). */
export interface SentinelCredentials {
  observerGateToken: string; observerBrokerToken: string; observerIsolationToken: string; observerEgressToken: string;
  observerSecretBrokerToken: string; observerToolAdapterToken: string; observerVadToken: string; observerSystemToken: string;
  readerToken: string; controllerToken: string; adminToken: string;
}

function validateCredentials(c: SentinelCredentials): void {
  const tokens = Object.values(c);
  if (tokens.some(t => t.length < 32) || new Set(tokens).size !== tokens.length) {
    throw new Error('Sentinel credentials must be distinct and at least 32 characters');
  }
}

function principalFor(token: string, c: SentinelCredentials, tenantId: string): SentinelPrincipal | null {
  if (equalToken(token, c.observerGateToken)) return gateSource(tenantId);
  if (equalToken(token, c.observerBrokerToken)) return executionBrokerSource(tenantId);
  if (equalToken(token, c.observerIsolationToken)) return isolationRunnerSource(tenantId);
  if (equalToken(token, c.observerEgressToken)) return egressGuardSource(tenantId);
  if (equalToken(token, c.observerSecretBrokerToken)) return secretBrokerSource(tenantId);
  if (equalToken(token, c.observerToolAdapterToken)) return toolAdapterSource(tenantId);
  if (equalToken(token, c.observerVadToken)) return vadRuntimeSource(tenantId);
  if (equalToken(token, c.observerSystemToken)) return systemSource(tenantId);
  if (equalToken(token, c.readerToken)) return reader(tenantId);
  if (equalToken(token, c.controllerToken)) return controller(tenantId);
  if (equalToken(token, c.adminToken)) return admin(tenantId);
  return null;
}

const MAX_BODY_BYTES = 65536;
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return {};
  try { return JSON.parse(text) as unknown; }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

const PAGE_PARAM_KEYS = ['limit', 'cursor'] as const;
function readPageParams(url: URL): { limit?: number; cursor?: string } {
  for (const key of url.searchParams.keys()) if (!(PAGE_PARAM_KEYS as readonly string[]).includes(key)) throw new HttpError(400, `Unsupported query parameter: ${key}`);
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new HttpError(400, 'limit must be a positive integer');
  const cursor = url.searchParams.get('cursor');
  return { ...(limit !== undefined ? { limit } : {}), ...(cursor !== null ? { cursor } : {}) };
}

function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (!(error instanceof SentinelError)) return 503;
  switch (error.code) {
    case 'NOT_FOUND': return 404;
    case 'FORBIDDEN': return 403;
    case 'OBSERVATION_CONFLICT': return 409;
    case 'SESSION_TERMINAL': return 409;
    case 'PAYLOAD_TOO_LARGE': return 413;
    case 'INVALID_INPUT': case 'UNKNOWN_OBSERVATION_TYPE': case 'UNSUPPORTED_VERSION': case 'INVALID_TRANSITION': case 'POLICY_INVALID': return 400;
    default: return 400;
  }
}

const STOP_SCOPES = ['tenant', 'agent', 'session'] as const;
function isStopScope(value: unknown): value is typeof STOP_SCOPES[number] { return typeof value === 'string' && (STOP_SCOPES as readonly string[]).includes(value); }
function asRecord(value: unknown): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Request body must be an object'); return value as Record<string, unknown>; }
function requireString(record: Record<string, unknown>, key: string): string { const v = record[key]; if (typeof v !== 'string' || v.length === 0) throw new HttpError(400, `${key} is required`); return v; }

/**
 * Minimal HTTP surface over the Sentinel domain facade (section 81). Every route requires identity
 * (section 82) — there is no anonymous or self-declared identity. No route mutates session state
 * outside the explicit action endpoints below; there is no generic PATCH/PUT/DELETE session or
 * observation route (mirrors the Ledger lesson: mutation only ever happens through named, audited
 * operations, never a resource-shaped write).
 */
export function createSentinelServer(runtime: SentinelRuntime, credentials: SentinelCredentials, tenantId: string) {
  validateCredentials(credentials);
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    void (async () => {
      try {
        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Bearer credential required');
        const principal = principalFor(authorization.slice(7), credentials, tenantId);
        if (!principal) throw new HttpError(401, 'Invalid credential');

        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (req.method === 'POST' && path === '/v1/sentinel/sessions') {
          const input = await body(req);
          return send(res, 201, runtime.createSession(principal, input));
        }
        if (req.method === 'POST' && path === '/v1/sentinel/stops') {
          const input = asRecord(await body(req));
          const scopeType = input.scopeType;
          if (!isStopScope(scopeType)) throw new HttpError(400, 'scopeType must be tenant, agent, or session');
          return send(res, 201, runtime.activateStop(principal, scopeType, requireString(input, 'scopeValue'), requireString(input, 'reason')));
        }
        if (req.method === 'POST' && path === '/v1/sentinel/stops/release') {
          const input = asRecord(await body(req));
          const scopeType = input.scopeType;
          if (!isStopScope(scopeType)) throw new HttpError(400, 'scopeType must be tenant, agent, or session');
          return send(res, 200, runtime.releaseStop(principal, scopeType, requireString(input, 'scopeValue')));
        }
        if (req.method === 'GET' && path === '/v1/sentinel/stops') return send(res, 200, runtime.listStops(principal));

        const sessionMatch = /^\/v1\/sentinel\/sessions\/([A-Za-z0-9._:-]+)(\/.*)?$/.exec(path);
        if (sessionMatch?.[1]) {
          const sessionId = sessionMatch[1];
          const subPath = sessionMatch[2] ?? '';
          if (req.method === 'GET' && subPath === '') return send(res, 200, runtime.getSession(principal, sessionId));
          if (req.method === 'POST' && subPath === '/observations') {
            const input = await body(req);
            const result = await runtime.submitObservation(principal, sessionId, input);
            return send(res, 201, result);
          }
          if (req.method === 'POST' && subPath === '/evaluate') return send(res, 200, await runtime.evaluateSession(principal, sessionId));
          if (req.method === 'POST' && subPath === '/hold') { const input = asRecord(await body(req)); return send(res, 200, await runtime.hold(principal, sessionId, requireString(input, 'message'))); }
          if (req.method === 'POST' && subPath === '/terminate') { const input = asRecord(await body(req)); return send(res, 200, await runtime.terminate(principal, sessionId, requireString(input, 'message'))); }
          if (req.method === 'POST' && subPath === '/resume') {
            const input = asRecord(await body(req));
            const rationale = requireString(input, 'rationale');
            const policySnapshotHash = typeof input.policySnapshotHash === 'string' ? input.policySnapshotHash : undefined;
            const authorityExpiry = typeof input.authorityExpiry === 'string' ? input.authorityExpiry : undefined;
            return send(res, 200, runtime.resume(principal, sessionId, { rationale, ...(policySnapshotHash !== undefined ? { policySnapshotHash } : {}), ...(authorityExpiry !== undefined ? { authorityExpiry } : {}) }));
          }
          if (req.method === 'POST' && subPath === '/complete') return send(res, 200, runtime.completeSession(principal, sessionId));
          if (req.method === 'GET' && subPath === '/violations') { const params = readPageParams(url); return send(res, 200, runtime.listViolations(principal, sessionId, params.limit, params.cursor)); }
          if (req.method === 'GET' && subPath === '/decisions') { const params = readPageParams(url); return send(res, 200, runtime.listDecisions(principal, sessionId, params.limit, params.cursor)); }
        }
        throw new HttpError(404, 'Route not found');
      } catch (error) {
        send(res, errorStatus(error), { error: error instanceof Error ? error.message : 'Service unavailable' });
      }
    })();
  });
  server.maxRequestsPerSocket = 100;
  return server;
}
export type { SentinelRole };
