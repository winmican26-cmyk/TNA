import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { equalToken } from '../../../packages/agent-identity/src/index.js';
import { Ledger, LedgerError, type LedgerPrincipal } from '../../../packages/ledger-core/src/index.js';
import { gateWriter, vadWriter, reader, admin } from './writers.js';

export class HttpError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}

export interface LedgerCredentials { writerGateToken: string; writerVadToken: string; readerToken: string; adminToken: string }

function validateCredentials(c: LedgerCredentials): void {
  const tokens = [c.writerGateToken, c.writerVadToken, c.readerToken, c.adminToken];
  if (tokens.some(t => t.length < 32) || new Set(tokens).size !== tokens.length) {
    throw new Error('Ledger credentials must be distinct and at least 32 characters');
  }
}

function principalFor(token: string, credentials: LedgerCredentials, tenantId: string): LedgerPrincipal | null {
  if (equalToken(token, credentials.writerGateToken)) return gateWriter(tenantId);
  if (equalToken(token, credentials.writerVadToken)) return vadWriter(tenantId);
  if (equalToken(token, credentials.readerToken)) return reader(tenantId);
  if (equalToken(token, credentials.adminToken)) return admin(tenantId);
  return null;
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    length += buffer.length;
    if (length > 65536) throw new HttpError(413, 'Request too large');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

const SEARCH_PARAM_KEYS = ['actorId', 'correlationId', 'eventType', 'streamId', 'fromTime', 'toTime', 'limit', 'cursor'] as const;
function readSearchParams(url: URL): { actorId?: string; correlationId?: string; eventType?: string; streamId?: string; fromTime?: string; toTime?: string; limit?: number; cursor?: string } {
  for (const key of url.searchParams.keys()) if (!(SEARCH_PARAM_KEYS as readonly string[]).includes(key)) throw new HttpError(400, `Unsupported search parameter: ${key}`);
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new HttpError(400, 'limit must be a positive integer');
  const result: ReturnType<typeof readSearchParams> = {};
  for (const key of ['actorId', 'correlationId', 'eventType', 'streamId', 'fromTime', 'toTime', 'cursor'] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) result[key] = value;
  }
  if (limit !== undefined) result.limit = limit;
  return result;
}

const PAGE_PARAM_KEYS = ['limit', 'cursor'] as const;
function readPageParams(url: URL): { limit?: number; cursor?: string } {
  for (const key of url.searchParams.keys()) if (!(PAGE_PARAM_KEYS as readonly string[]).includes(key)) throw new HttpError(400, `Unsupported query parameter: ${key}`);
  const result: { limit?: number; cursor?: string } = {};
  const limitRaw = url.searchParams.get('limit');
  if (limitRaw !== null) {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0) throw new HttpError(400, 'limit must be a positive integer');
    result.limit = limit;
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null) result.cursor = cursor;
  return result;
}

function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (!(error instanceof LedgerError)) return 503;
  switch (error.code) {
    case 'NOT_FOUND': return 404;
    case 'FORBIDDEN': return 403;
    case 'EVENT_CONFLICT': case 'STREAM_CONFLICT': return 409;
    case 'PAYLOAD_TOO_LARGE': return 413;
    case 'INVALID_EVENT': case 'UNKNOWN_EVENT_TYPE': case 'UNSUPPORTED_VERSION': case 'ORPHAN_EVENT': return 400;
    case 'INTEGRITY_FAILURE': return 409;
    default: return 400;
  }
}

/**
 * Minimal HTTP surface over the Ledger domain facade (section 49). No route mutates or deletes
 * historical events (section 115) — every write is an append. Bearer credentials map to one of four
 * fixed service identities (section 50); there is no anonymous or self-declared identity.
 */
export function createLedgerServer(ledger: Ledger, credentials: LedgerCredentials, tenantId: string) {
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

        if (req.method === 'POST' && path === '/v1/ledger/events') {
          const input = await body(req);
          return send(res, 201, ledger.append(principal, input));
        }
        if (req.method === 'POST' && path === '/v1/ledger/export/verify') {
          const input = await body(req);
          return send(res, 200, ledger.verifyExportedBundle(principal, input as never));
        }
        if (req.method === 'GET') {
          const eventMatch = /^\/v1\/ledger\/events\/([A-Za-z0-9._:-]+)$/.exec(path);
          if (eventMatch?.[1]) return send(res, 200, ledger.getEvent(principal, eventMatch[1]));

          const verifyMatch = /^\/v1\/ledger\/streams\/([A-Za-z0-9._:-]+)\/verify$/.exec(path);
          if (verifyMatch?.[1]) return send(res, 200, ledger.verifyStream(principal, verifyMatch[1]));

          const streamMatch = /^\/v1\/ledger\/streams\/([A-Za-z0-9._:-]+)$/.exec(path);
          if (streamMatch?.[1]) {
            const { limit, cursor } = readPageParams(url);
            return send(res, 200, ledger.getStream(principal, streamMatch[1], limit, cursor));
          }

          if (path === '/v1/ledger/search') {
            const params = readSearchParams(url);
            return send(res, 200, ledger.search(principal, params, params.limit, params.cursor));
          }
          if (path === '/v1/ledger/reconstruct') {
            const kind = url.searchParams.get('type');
            const correlationId = url.searchParams.get('correlationId');
            if (!correlationId) throw new HttpError(400, 'correlationId is required');
            if (kind === 'gate') return send(res, 200, ledger.reconstructGateAction(principal, correlationId));
            if (kind === 'vad') return send(res, 200, ledger.reconstructVadAtom(principal, correlationId));
            throw new HttpError(400, 'type must be "gate" or "vad"');
          }
          if (path === '/v1/ledger/export') {
            const correlationId = url.searchParams.get('correlationId');
            if (!correlationId) throw new HttpError(400, 'correlationId is required');
            return send(res, 200, ledger.exportEvidence(principal, correlationId));
          }
          if (path === '/v1/ledger/verify') {
            return send(res, 200, ledger.verifyAll(principal));
          }
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
