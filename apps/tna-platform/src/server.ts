import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  MAX_BODY_BYTES, MAX_ACTION_PAGE_SIZE, PlatformError, isPlainObject, type PlatformPrincipal,
} from '../../../packages/platform-schema/src/index.js';
import {
  PlatformFacade, PlatformControlOrchestrator, PlatformStore, reconstructPlatformAction, type PlatformAction,
} from '../../../packages/platform-core/src/index.js';
import { AuditorRuntime, type AuditorPrincipal } from '../../../packages/auditor-engine/src/index.js';
import { buildAuditPackage } from '../../../packages/auditor-report/src/index.js';
import { redact } from '../../../packages/deployment-schema/src/index.js';
import type { MetricsRegistry } from '../../../packages/deployment-health/src/index.js';
import { getLiveness, getReadiness, type HealthDeps } from './health.js';
import { buildDiagnostics, listDeadLetters } from './diagnostics.js';
import { validateCredentials, principalFor, type PlatformCredentials } from './writers.js';

export class HttpError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}

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
function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

function readPageParams(url: URL): { limit?: number; cursor?: string } {
  for (const key of url.searchParams.keys()) if (key !== 'limit' && key !== 'cursor') throw new HttpError(400, `Unsupported query parameter: ${key}`);
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_ACTION_PAGE_SIZE)) throw new HttpError(400, `limit must be a positive integer <= ${MAX_ACTION_PAGE_SIZE}`);
  const cursor = url.searchParams.get('cursor');
  return { ...(limit !== undefined ? { limit } : {}), ...(cursor !== null ? { cursor } : {}) };
}

function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (!(error instanceof PlatformError)) return 503;
  switch (error.code) {
    case 'NOT_FOUND': return 404;
    case 'FORBIDDEN': return 403;
    case 'CONFLICT': return 409;
    case 'PAYLOAD_TOO_LARGE': return 413;
    case 'INVALID_INPUT': case 'UNSUPPORTED_VERSION': case 'INVALID_TRANSITION': case 'CONNECTOR_UNKNOWN': return 400;
    default: return 400;
  }
}

export interface PlatformServerDeps {
  readonly store: PlatformStore;
  readonly facade: PlatformFacade;
  readonly control: PlatformControlOrchestrator;
  readonly auditor?: { readonly runtime: AuditorRuntime; readonly principal: AuditorPrincipal };
  /** Section 31-33: full mandatory-dependency readiness wiring. Optional — a caller (such as an
   * isolated unit test) that omits it still gets a reduced /ready check against `store` alone. */
  readonly health?: HealthDeps;
  /** Section 61-63, 74, 75, 64: present in a real deployment; absent in isolated tests that don't
   * exercise observability/diagnostics routes. */
  readonly metrics?: MetricsRegistry;
  readonly startedAt?: number;
  readonly configHash?: string;
  readonly deploymentId?: string;
}

/**
 * Minimal HTTP surface over the platform domain facade (section 44, 54). Every route requires
 * identity — no anonymous action creation/run/export. There is no generic PATCH/PUT/DELETE mutation
 * route for a platform action anywhere (section 119's discipline, carried forward from Auditor):
 * mutation only ever happens through the named action endpoints below, each backed by the runtime's
 * own CAS-protected transitions.
 */
export function createPlatformServer(deps: PlatformServerDeps, credentials: PlatformCredentials, tenantId: string) {
  validateCredentials(credentials);
  const startedAt = deps.startedAt ?? Date.now();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30000, headersTimeout: 10000 }, (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        // Section 31: liveness/readiness are conventionally unauthenticated (a container orchestrator
        // or load balancer probes them with no credential) — but they are read-only status surfaces,
        // never a control-plane route, and never return a secret (section 34).
        if (req.method === 'GET' && path === '/live') return send(res, 200, getLiveness(startedAt));
        if (req.method === 'GET' && path === '/ready') {
          const readiness = deps.health ? await getReadiness(deps.health) : await reducedReadiness(deps.store, tenantId);
          return send(res, readiness.ready ? 200 : 503, readiness);
        }

        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Bearer credential required');
        const principal: PlatformPrincipal | null = principalFor(authorization.slice(7), credentials, tenantId);
        if (!principal) throw new HttpError(401, 'Invalid credential');

        // Section 64, 21, 61-63: operator-diagnostics and metrics surfaces. Never a raw config dump —
        // admin/service credential only, and every field returned is pre-vetted as non-secret.
        if (req.method === 'GET' && path === '/diagnostics') {
          assertAdminOrService(principal);
          const readiness = deps.health ? await getReadiness(deps.health) : { status: 'AVAILABLE' as const };
          return send(res, 200, redact(buildDiagnostics(deps.store, principal.tenantId, deps.configHash ?? 'unknown', deps.deploymentId ?? 'unknown', readiness.status)));
        }
        if (req.method === 'GET' && path === '/metrics') {
          assertAdminOrService(principal);
          if (!deps.metrics) throw new HttpError(503, 'Metrics are not configured');
          return sendText(res, 200, deps.metrics.renderPrometheus());
        }
        if (req.method === 'GET' && path === '/v1/platform/outbox/dead-letters') {
          assertAdminOrService(principal);
          return send(res, 200, listDeadLetters(deps.store, principal.tenantId));
        }

        if (req.method === 'POST' && path === '/v1/platform/actions') {
          const input = await body(req);
          if (!isPlainObject(input)) throw new HttpError(400, 'Request body must be an object');
          const action = await deps.facade.submitAndRun(principal, input, principal.id);
          return send(res, 201, action);
        }
        if (req.method === 'GET' && path === '/v1/platform/actions') {
          const params = readPageParams(url);
          return send(res, 200, deps.store.list(principal.tenantId, params));
        }

        const match = /^\/v1\/platform\/actions\/([A-Za-z0-9._:-]+)(\/.*)?$/.exec(path);
        if (match?.[1]) {
          const actionId = match[1];
          const subPath = match[2] ?? '';
          if (req.method === 'GET' && subPath === '') return send(res, 200, assertOwnedOrPrivileged(deps.store.get(principal.tenantId, actionId), principal));
          if (req.method === 'GET' && subPath === '/status') { const action = deps.store.get(principal.tenantId, actionId); return send(res, 200, { platform_action_id: action.platform_action_id, state: action.state, error_code: action.error_code, evidence_status: deps.store.evidenceStatus(principal.tenantId, actionId) }); }
          if (req.method === 'GET' && subPath === '/evidence') return send(res, 200, reconstructPlatformAction(deps.store, principal.tenantId, actionId));
          if (req.method === 'POST' && (subPath === '/approve' || subPath === '/resume')) return send(res, 200, deps.control.resume(principal, actionId));
          if (req.method === 'POST' && subPath === '/terminate') {
            const input = await body(req);
            const reason = isPlainObject(input) && typeof input.reason === 'string' ? input.reason : 'Operator-initiated termination';
            return send(res, 200, deps.control.terminate(principal, actionId, reason));
          }
          if (req.method === 'POST' && subPath === '/audit') {
            if (!deps.auditor) throw new HttpError(503, 'Auditor integration is not configured');
            return send(res, 200, await runPostHocAudit(deps.auditor.runtime, deps.auditor.principal, deps.store.get(principal.tenantId, actionId)));
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

/** Used only when `deps.health` was not supplied (isolated tests) — checks the one dependency always
 * present, `store`, so /ready never simply lies "ready" without checking anything. */
async function reducedReadiness(store: PlatformStore, tenantId: string): Promise<{ ready: boolean; status: 'AVAILABLE' | 'UNAVAILABLE'; components: readonly { component: string; status: string }[] }> {
  try { store.list(tenantId, { limit: 1 }); return { ready: true, status: 'AVAILABLE', components: [{ component: 'platform_store', status: 'AVAILABLE' }] }; }
  catch { return { ready: false, status: 'UNAVAILABLE', components: [{ component: 'platform_store', status: 'UNAVAILABLE' }] }; }
}

function assertAdminOrService(principal: PlatformPrincipal): void {
  if (principal.role !== 'platform-admin' && principal.role !== 'platform-service') throw new HttpError(403, 'Operator diagnostics require an admin or service credential');
}

/** A platform-agent principal may only read its own action; operator/admin/service may read any
 * action within their own tenant (mirrors the tenant/role model established in Auditor/Sentinel). */
function assertOwnedOrPrivileged(action: PlatformAction, principal: PlatformPrincipal): PlatformAction {
  if (principal.role === 'platform-agent' && principal.agentId !== action.request.agent_id) throw new HttpError(403, 'Access denied');
  return action;
}

/** Section 79-80: post-hoc governance assessment, never in the critical execution path. Section 81:
 * Auditor's result never rewrites the platform's own recorded execution outcome — the two are
 * returned side by side. */
async function runPostHocAudit(runtime: AuditorRuntime, principal: AuditorPrincipal, action: PlatformAction): Promise<{ execution_result: string; audit_outcome: unknown }> {
  const cutoff = new Date(Date.now() + 3_600_000).toISOString();
  const assessment = runtime.createAssessment(principal, {
    version: '1.0', tenant_id: action.tenant_id, name: `Platform action ${action.platform_action_id}`,
    scope: { tenant_wide: false, agent_ids: [action.request.agent_id], correlation_ids: [action.correlation_id], time_range: { from: action.created_at, to: cutoff } },
    control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: cutoff,
  });
  const run = await runtime.runAssessment(principal, assessment.assessment_id);
  const pkg = buildAuditPackage(runtime, principal, assessment.assessment_id);
  return { execution_result: action.state, audit_outcome: { outcome: run.outcome, risk_summary: run.risk_summary, assessment_id: assessment.assessment_id, package_hash: pkg.assessment_hash } };
}
