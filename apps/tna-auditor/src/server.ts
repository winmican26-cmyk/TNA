import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { equalToken } from '../../../packages/agent-identity/src/index.js';
import { AuditorError, type AuditorPrincipal, type AuditorRuntime } from '../../../packages/auditor-engine/src/index.js';
import { buildAuditPackage, verifyAuditPackage } from '../../../packages/auditor-report/src/index.js';
import { listCatalog, getControl, TNA_BASELINE_V01, TNA_HIGH_RISK_V01 } from '../../../packages/auditor-controls/src/index.js';
import { isControlProfileId } from '../../../packages/auditor-schema/src/index.js';
import { reader, runner, admin } from './writers.js';

export class HttpError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}

export interface AuditorCredentials { readerToken: string; runnerToken: string; adminToken: string }

function validateCredentials(c: AuditorCredentials): void {
  const tokens = Object.values(c);
  if (tokens.some(t => t.length < 32) || new Set(tokens).size !== tokens.length) {
    throw new Error('Auditor credentials must be distinct and at least 32 characters');
  }
}

function principalFor(token: string, c: AuditorCredentials, tenantId: string): AuditorPrincipal | null {
  if (equalToken(token, c.adminToken)) return admin(tenantId);
  if (equalToken(token, c.runnerToken)) return runner(tenantId);
  if (equalToken(token, c.readerToken)) return reader(tenantId);
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

const PAGE_PARAM_KEYS = ['limit', 'cursor', 'run'] as const;
function readPageParams(url: URL): { limit?: number; cursor?: string; run?: number } {
  for (const key of url.searchParams.keys()) if (!(PAGE_PARAM_KEYS as readonly string[]).includes(key)) throw new HttpError(400, `Unsupported query parameter: ${key}`);
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new HttpError(400, 'limit must be a positive integer');
  const cursor = url.searchParams.get('cursor');
  const runRaw = url.searchParams.get('run');
  const run = runRaw === null ? undefined : Number(runRaw);
  if (run !== undefined && (!Number.isInteger(run) || run <= 0)) throw new HttpError(400, 'run must be a positive integer');
  return { ...(limit !== undefined ? { limit } : {}), ...(cursor !== null ? { cursor } : {}), ...(run !== undefined ? { run } : {}) };
}

function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (!(error instanceof AuditorError)) return 503;
  switch (error.code) {
    case 'NOT_FOUND': return 404;
    case 'FORBIDDEN': return 403;
    case 'CONFLICT': return 409;
    case 'PAYLOAD_TOO_LARGE': return 413;
    // UNKNOWN_PROFILE/UNKNOWN_CONTROL arise from validating body content (an invalid enum value),
    // not from a URL resource lookup — the GET /controls/:id and /profiles/:id routes above check
    // existence directly and throw their own 404 before ever reaching an AuditorError.
    case 'INVALID_INPUT': case 'UNSUPPORTED_VERSION': case 'INVALID_TRANSITION': case 'SCOPE_INVALID':
    case 'CATALOG_VERSION_MISMATCH': case 'MANIFEST_INVALID': case 'EVIDENCE_UNAVAILABLE':
    case 'UNKNOWN_PROFILE': case 'UNKNOWN_CONTROL': return 400;
    default: return 400;
  }
}

/**
 * Minimal HTTP surface over the Auditor domain facade (section 53). Every route requires identity
 * (section 54) — no anonymous assessment creation/run/export. No route mutates a control result or
 * finding directly (section 119) — mutation only ever happens through `run`/`replay`, which the
 * runtime itself computes end to end; there is no PATCH/PUT/DELETE for a control result anywhere.
 */
export function createAuditorServer(runtime: AuditorRuntime, credentials: AuditorCredentials, tenantId: string) {
  validateCredentials(credentials);
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30000, headersTimeout: 10000 }, (req, res) => {
    void (async () => {
      try {
        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Bearer credential required');
        const principal = principalFor(authorization.slice(7), credentials, tenantId);
        if (!principal) throw new HttpError(401, 'Invalid credential');

        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (req.method === 'GET' && path === '/v1/auditor/controls') return send(res, 200, listCatalog());
        if (req.method === 'GET' && path.startsWith('/v1/auditor/controls/')) {
          const controlId = path.slice('/v1/auditor/controls/'.length);
          return send(res, 200, getControl(controlId));
        }
        if (req.method === 'GET' && path === '/v1/auditor/profiles') return send(res, 200, [TNA_BASELINE_V01, TNA_HIGH_RISK_V01]);
        if (req.method === 'GET' && path.startsWith('/v1/auditor/profiles/')) {
          const profileId = path.slice('/v1/auditor/profiles/'.length);
          if (!isControlProfileId(profileId)) throw new HttpError(404, 'Unknown profile');
          return send(res, 200, profileId === 'TNA_BASELINE_V01' ? TNA_BASELINE_V01 : TNA_HIGH_RISK_V01);
        }
        if (req.method === 'POST' && path === '/v1/auditor/packages/verify') {
          const input = await body(req);
          return send(res, 200, verifyAuditPackage(input));
        }

        if (req.method === 'POST' && path === '/v1/auditor/assessments') {
          const input = await body(req);
          return send(res, 201, runtime.createAssessment(principal, input));
        }
        if (req.method === 'GET' && path === '/v1/auditor/assessments') {
          const params = readPageParams(url);
          return send(res, 200, runtime.listAssessments(principal, params.limit, params.cursor));
        }

        const assessmentMatch = /^\/v1\/auditor\/assessments\/([A-Za-z0-9._:-]+)(\/.*)?$/.exec(path);
        if (assessmentMatch?.[1]) {
          const assessmentId = assessmentMatch[1];
          const subPath = assessmentMatch[2] ?? '';
          if (req.method === 'GET' && subPath === '') return send(res, 200, runtime.getAssessment(principal, assessmentId));
          if (req.method === 'POST' && subPath === '/run') return send(res, 200, await runtime.runAssessment(principal, assessmentId));
          if (req.method === 'POST' && subPath === '/replay') {
            const input = await body(req);
            const runNumber = typeof (input as Record<string, unknown>).runNumber === 'number' ? (input as Record<string, unknown>).runNumber as number : undefined;
            return send(res, 200, runtime.replayAssessment(principal, assessmentId, { ...(runNumber !== undefined ? { runNumber } : {}) }));
          }
          if (req.method === 'GET' && subPath === '/results') { const params = readPageParams(url); return send(res, 200, runtime.listControlResults(principal, assessmentId, params.run, params.limit, params.cursor)); }
          if (req.method === 'GET' && subPath === '/findings') { const params = readPageParams(url); return send(res, 200, runtime.listFindings(principal, assessmentId, params.run, params.limit, params.cursor)); }
          if (req.method === 'GET' && subPath === '/runs') return send(res, 200, runtime.listRuns(principal, assessmentId));
          if (req.method === 'GET' && subPath === '/export') { const params = readPageParams(url); return send(res, 200, buildAuditPackage(runtime, principal, assessmentId, params.run)); }
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
