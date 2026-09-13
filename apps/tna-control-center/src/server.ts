/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). The real Control Center BFF HTTP server.
 *
 * Architecture (kickoff section 3, restated): BROWSER -> this authenticated API -> the tenant's own real
 * `apps/tna-platform` instance -> Gate/Sentinel/VAD/Ledger -> Ledger evidence. This server holds no
 * authority of its own: it never writes to a trusted store directly (no direct SQLite mutation of
 * anything Gate/Sentinel/Ledger own), it never fabricates a Gate/Sentinel/Ledger outcome, and every
 * dashboard/action value returned to the browser is either read straight from a real Platform API
 * response or a real, computed-here aggregate OVER that real response (e.g. "how many of these real
 * actions have state BLOCKED") — never a hardcoded number.
 *
 * Fail-closed startup (TNA-64 precedent): every dependency (`ControlCenterSessionStore`, `TenantRegistry`,
 * `PlatformProxyClient`) is a required constructor parameter.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { ControlCenterError, CLIENT_ROLES, type ClientRole, type ControlCenterSession, type TenantRegistryEntry } from './schema.js';
import { ControlCenterSessionStore } from './session-store.js';
import type { TenantRegistry } from './tenant-registry.js';
import { PlatformProxyClient } from './platform-client.js';
import { ClientGatewayProxyClient, type ClientGatewayConfig } from './client-gateway-client.js';
import { LedgerProxyClient } from './ledger-client.js';
import { AuditorProxyClient } from './auditor-client.js';
import { ImprovementGovernorProxyClient } from './improvement-client.js';
import { computeIncidents } from './incidents.js';
import { parseCookies, setSessionCookies, clearSessionCookies, verifyCsrf, SESSION_COOKIE } from './auth.js';
import { authorizeClientPermission, permissionsForRole, PermissionDeniedError, type ClientPermission } from './permissions.js';

export class HttpError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}

export interface ControlCenterDeps {
  readonly sessions: ControlCenterSessionStore;
  readonly tenants: TenantRegistry;
  readonly platform: PlatformProxyClient;
  readonly cookieSecure: boolean;
  readonly startedAt?: number;
  /** Section 122: an already-built (`vite build`) static frontend directory, or `null` to serve API
   * routes only (the shape every backend-focused test in this suite uses). */
  readonly staticRoot?: string | null;
  /** Foundation-review item A: the real, accepted Client Gateway admin API — the authoritative source of
   * tenant lifecycle status, connections, governed tools, and service identities. `null` only for
   * Platform-only configurations (older tests) that predate this integration; every route that needs it
   * fails closed with 503 when absent, it never silently falls back to a weaker local truth. */
  readonly clientGateway?: ClientGatewayConfig | null;
  readonly clientGatewayClient?: ClientGatewayProxyClient | null;
  readonly ledger?: LedgerProxyClient | null;
  readonly auditor?: AuditorProxyClient | null;
  readonly improvement?: ImprovementGovernorProxyClient | null;
  readonly environment?: 'development' | 'staging' | 'production' | undefined;
  readonly trustedOrigins?: readonly string[] | undefined;
}

/** Build-order items 11-12: one real, strict CSP with no `unsafe-inline`/`unsafe-eval` — the actual
 * compiled frontend bundle (`apps/tna-control-center-web`'s `vite build` output) has no inline
 * script/style at all (a plain hashed `<script type="module">` + `<link rel="stylesheet">`, verified by
 * inspection of the built `index.html`), so this is not a theoretical policy that would break the real
 * app — it is exactly what the real app needs and nothing more. `frame-ancestors 'none'` plus
 * `X-Frame-Options: DENY` together cover clickjacking for both CSP-aware and legacy user agents. Applied
 * to EVERY response this server sends, including static file responses (`serveStatic`) — the earlier
 * version of this function only set these on JSON `send()` responses, silently leaving the actual HTML
 * page (where CSP/frame-ancestors matter most) unprotected. */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
};

/** Build-order item 10: explicit, exact-match CORS — never a wildcard, and `Access-Control-Allow
 * -Credentials` is set ONLY alongside a specific, allow-listed origin (a wildcard `*` combined with
 * credentials is both meaningless to browsers and never emitted by this code path at all). An `Origin`
 * header that does not exactly match an entry in `trustedOrigins` gets no CORS headers whatsoever — the
 * browser's own same-origin policy then blocks the cross-origin script from reading the response, which is
 * the correct default for a cookie-authenticated console with no legitimate cross-origin caller in v0.1.
 * Returns `true` if this call fully handled the request (a preflight `OPTIONS`), meaning the caller must
 * not process it further. */
function applyCors(req: IncomingMessage, res: ServerResponse, trustedOrigins: readonly string[]): boolean {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && trustedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, SECURITY_HEADERS); res.end(); return true; }
  return false;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json' };
/** Section 122: serves the packaged, ALREADY-BUILT frontend — never a dev server, never `vite` invoked
 * from this process. Real path-containment (mirrors `assertInsideWorkspace`'s discipline from Volume 12):
 * a request path is resolved and verified to stay inside `staticRoot` before any file read, defeating a
 * `../../etc/passwd`-style traversal attempt. Unknown paths fall back to `index.html` (client-side
 * routing) UNLESS the path looks like a static asset request, which 404s instead of silently serving HTML. */
function serveStatic(staticRoot: string, urlPath: string, res: ServerResponse): boolean {
  const root = resolve(staticRoot);
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(root + sep)) { res.writeHead(403); res.end(); return true; }
  const looksLikeAsset = extname(relative).length > 0;
  const target = existsSync(candidate) && statSync(candidate).isFile() ? candidate : (looksLikeAsset ? null : resolve(root, 'index.html'));
  if (!target || !existsSync(target)) return false;
  const type = CONTENT_TYPES[extname(target)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS });
  createReadStream(target).pipe(res);
  return true;
}

const MAX_BODY_BYTES = 65_536;
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
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
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

/** Section 60: security headers on every response, and errors never leak a stack trace, a filesystem
 * path, a SQLite path, or another tenant's identifier. */
function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(data));
}
function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof PermissionDeniedError) return 403;
  if (error instanceof ControlCenterError) {
    switch (error.code) {
      case 'NOT_FOUND': return 404;
      case 'CONFLICT': return 409;
      case 'FORBIDDEN': return 403;
      case 'NOT_CONFIGURED': return 503;
      default: return 400;
    }
  }
  return 500;
}
/** Never includes a raw error message from an upstream/internal failure verbatim to the browser beyond
 * what the specific, deliberately-bounded error types above already sanitize — an unexpected exception
 * (e.g. a thrown filesystem error) is reported as a generic message only (section 60). */
function errorBody(error: unknown): { readonly error: string; readonly code?: string } {
  if (error instanceof HttpError) return { error: error.message };
  if (error instanceof PermissionDeniedError) return { error: error.message, code: 'FORBIDDEN' };
  if (error instanceof ControlCenterError) return { error: error.message, code: error.code };
  return { error: 'Internal server error' };
}

function requireSession(deps: ControlCenterDeps, req: IncomingMessage): ControlCenterSession {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) throw new HttpError(401, 'No session');
  const session = deps.sessions.getSession(sessionId);
  if (!session) throw new HttpError(401, 'Session invalid or expired');
  return session;
}
function requireCsrf(req: IncomingMessage, session: ControlCenterSession): void {
  if (!verifyCsrf(req, session.csrf_token)) throw new HttpError(403, 'CSRF token missing or invalid');
}
/** Section 5/18: "hidden button != security control" — permission enforcement happens here, server-side,
 * on every mutating (and, for future routes, every sensitive read) request, via the single centralized
 * `authorizeClientPermission` matrix in `permissions.ts` — never an inline `if (role === ...)` scattered
 * per route. */
function requirePermission(session: ControlCenterSession, permission: ClientPermission): void {
  authorizeClientPermission(session.role, permission);
}
/** Foundation-review item A: reconciles tenant lifecycle against the REAL, authoritative Volume 10
 * `ClientStore` record (via Client Gateway) rather than trusting only the Control-Center-local
 * `TenantRegistryEntry.status` flag — this is what prevents the Control Center from ever believing a
 * tenant is ACTIVE while the real system of record believes it is SUSPENDED (or vice versa). When
 * `deps.clientGateway` is configured, ITS real, freshly-queried status is authoritative and the local flag
 * is ignored entirely for this decision; the local flag remains the fallback ONLY for a Platform-only
 * configuration that has no Client Gateway integration at all. */
async function checkTenantLifecycle(deps: ControlCenterDeps, tenantId: string, entry: TenantRegistryEntry): Promise<void> {
  if (deps.clientGateway && deps.clientGatewayClient) {
    let tenant: Record<string, unknown>;
    try { tenant = await deps.clientGatewayClient.getTenant(deps.clientGateway, tenantId); }
    catch { throw new HttpError(503, 'Could not verify tenant status with the authoritative Client Gateway record'); }
    const status = tenant.status;
    if (status !== 'ACTIVE') throw new HttpError(403, `This tenant is ${String(status)} — contact your TNA operator`);
    return;
  }
  if (entry.status === 'SUSPENDED') throw new HttpError(403, 'This tenant is suspended — contact your TNA operator');
}
async function tenantEntry(deps: ControlCenterDeps, session: ControlCenterSession): Promise<TenantRegistryEntry> {
  // Section 3/64: the tenant is ALWAYS the authenticated session's own tenant_id — never accepted from a
  // path/query/body/header parameter, so there is no code path by which a request can name a different
  // tenant. A suspended/non-active tenant fails closed for every active-authority route (dashboard,
  // actions, approve, terminate, evidence, tools, connections, identities) even for an existing,
  // otherwise-valid session — checked fresh on every request, never cached.
  const entry = deps.tenants.entryFor(session.tenant_id);
  if (!entry) throw new HttpError(503, 'This tenant has no registered backend — contact your TNA operator');
  await checkTenantLifecycle(deps, session.tenant_id, entry);
  return entry;
}
function requireClientGateway(deps: ControlCenterDeps): { readonly config: ClientGatewayConfig; readonly client: ClientGatewayProxyClient } {
  if (!deps.clientGateway || !deps.clientGatewayClient) throw new HttpError(503, 'Client Gateway integration is not configured for this deployment');
  return { config: deps.clientGateway, client: deps.clientGatewayClient };
}

export function createControlCenterServer(deps: ControlCenterDeps) {
  return createServer(async (req, res) => {
    try {
      if (applyCors(req, res, deps.trustedOrigins ?? [])) return;

      const url = new URL(req.url ?? '/', 'http://internal');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/live') return send(res, 200, { live: true, uptime_seconds: Math.round((Date.now() - (deps.startedAt ?? Date.now())) / 1000) });
      if (req.method === 'GET' && path === '/ready') {
        // Fail-closed readiness: actually touches the session store, never a cached flag.
        deps.sessions.getSession('__readiness_probe__');
        return send(res, 200, { ready: true });
      }

      // Section 122: the packaged static frontend (index.html, JS, CSS) is public — a browser must be
      // able to load the login page before it has any session at all. Only paths NOT under `/api/` are
      // ever offered to the static handler, so this can never shadow an authenticated API route.
      if (deps.staticRoot && req.method === 'GET' && !path.startsWith('/api/') && serveStatic(deps.staticRoot, path, res)) return;

      if (req.method === 'POST' && path === '/api/session/login') {
        const input = await body(req);
        if (typeof input.username !== 'string' || typeof input.password !== 'string') throw new HttpError(400, 'username and password are required');
        const user = deps.sessions.authenticate(input.username, input.password);
        if (!user) throw new HttpError(401, 'Invalid username or password');
        // A suspended/non-active tenant's users cannot authenticate at all — fail closed before a session
        // is ever minted, not merely blocked later on individual routes. Reconciled against the real
        // Client Gateway lifecycle record when configured (foundation-review item A), never only the
        // Control-Center-local flag.
        const loginEntry = deps.tenants.entryFor(user.tenant_id);
        if (loginEntry) await checkTenantLifecycle(deps, user.tenant_id, loginEntry);
        const session = deps.sessions.createSession(user);
        setSessionCookies(res, session.session_id, session.csrf_token, deps.cookieSecure, 8 * 3600);
        return send(res, 200, { user: { username: user.username, tenant_id: user.tenant_id, role: user.role } });
      }
      // Public, pre-session routes (mirrors login's own lack of a CSRF check — there is no session cookie
      // yet for CSRF's threat model to apply to). Both redeem a real, admin-issued, single-use, expiring
      // token; neither ever lets the caller choose their own tenant or role.
      if (req.method === 'POST' && path === '/api/signup') {
        const input = await body(req);
        if (typeof input.token !== 'string' || typeof input.password !== 'string') throw new HttpError(400, 'token and password are required');
        const user = deps.sessions.redeemSignupInvite(input.token, input.password);
        return send(res, 201, { username: user.username, tenant_id: user.tenant_id, role: user.role });
      }
      if (req.method === 'POST' && path === '/api/reset-password') {
        const input = await body(req);
        if (typeof input.token !== 'string' || typeof input.password !== 'string') throw new HttpError(400, 'token and password are required');
        deps.sessions.redeemPasswordReset(input.token, input.password);
        return send(res, 200, { reset: true });
      }

      if (req.method === 'POST' && path === '/api/session/logout') {
        const cookies = parseCookies(req);
        const sessionId = cookies[SESSION_COOKIE];
        if (sessionId) {
          const session = deps.sessions.getSession(sessionId);
          if (session) requireCsrf(req, session);
          deps.sessions.destroySession(sessionId);
        }
        clearSessionCookies(res, deps.cookieSecure);
        return send(res, 200, { loggedOut: true });
      }
      if (req.method === 'GET' && path === '/api/session/me') {
        const session = requireSession(deps, req);
        const user = deps.sessions.getUserById(session.user_id);
        return send(res, 200, { username: user.username, tenant_id: user.tenant_id, role: user.role, permissions: permissionsForRole(user.role), environment: deps.environment ?? 'development' });
      }

      // Every route below requires a real, current, non-expired session.
      const session = requireSession(deps, req);

      if (req.method === 'GET' && path === '/api/dashboard') {
        requirePermission(session, 'action.read');
        const entry = await tenantEntry(deps, session);
        const [readiness, actionsPage] = await Promise.all([
          deps.platform.ready(entry).catch(() => ({ status: 'UNAVAILABLE' as const, ready: false, components: [] })),
          deps.platform.listActions(entry, { limit: 200 }).catch(() => ({ items: [] })),
        ]);
        const items = Array.isArray((actionsPage as { items?: unknown }).items) ? (actionsPage as { items: readonly Record<string, unknown>[] }).items : [];
        const dayAgo = Date.now() - 24 * 3600_000;
        const inLast24h = items.filter(a => typeof a.created_at === 'string' && Date.parse(a.created_at) >= dayAgo);
        const countByState = (state: string) => items.filter(a => a.state === state).length;
        return send(res, 200, {
          assurance: readiness,
          actions_last_24h: inLast24h.length,
          blocked: countByState('BLOCKED'), held: countByState('HELD'), terminated: countByState('TERMINATED'), indeterminate: countByState('INDETERMINATE'),
          total_known_actions: items.length,
        });
      }

      if (req.method === 'GET' && path === '/api/actions') {
        requirePermission(session, 'action.read');
        const entry = await tenantEntry(deps, session);
        const limitRaw = url.searchParams.get('limit');
        const cursor = url.searchParams.get('cursor') ?? undefined;
        const result = await deps.platform.listActions(entry, { ...(limitRaw ? { limit: Number(limitRaw) } : {}), ...(cursor ? { cursor } : {}) });
        return send(res, 200, result);
      }
      const actionMatch = path.match(/^\/api\/actions\/([^/]+)(\/evidence)?$/);
      if (req.method === 'GET' && actionMatch) {
        requirePermission(session, actionMatch[2] ? 'evidence.read' : 'action.read');
        const entry = await tenantEntry(deps, session);
        const actionId = decodeURIComponent(actionMatch[1]!);
        const result = actionMatch[2] ? await deps.platform.getActionEvidence(entry, actionId) : await deps.platform.getAction(entry, actionId);
        return send(res, 200, result);
      }

      // Section 14-17: approval inbox actions. `client-reviewer` or higher only — checked here, on the
      // real HTTP request, never only by a frontend hiding the button (section 5, 16). CSRF-protected
      // like every other mutating route (section 54).
      const approveMatch = path.match(/^\/api\/actions\/([^/]+)\/approve$/);
      if (req.method === 'POST' && approveMatch) {
        requirePermission(session, 'action.approve');
        requireCsrf(req, session);
        const entry = await tenantEntry(deps, session);
        const result = await deps.platform.approveAction(entry, decodeURIComponent(approveMatch[1]!));
        return send(res, 200, result);
      }
      const terminateMatch = path.match(/^\/api\/actions\/([^/]+)\/terminate$/);
      if (req.method === 'POST' && terminateMatch) {
        requirePermission(session, 'action.terminate');
        requireCsrf(req, session);
        const input = await body(req);
        const reason = typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason : undefined;
        if (!reason) throw new HttpError(400, 'reason is required to terminate an action');
        const entry = await tenantEntry(deps, session);
        const result = await deps.platform.terminateAction(entry, decodeURIComponent(terminateMatch[1]!), reason);
        return send(res, 200, result);
      }

      // -----------------------------------------------------------------------------------
      // Evidence Explorer (real Ledger) and Audit/Assurance (real Auditor) routes.
      // -----------------------------------------------------------------------------------
      if (req.method === 'GET' && path === '/api/evidence/search') {
        requirePermission(session, 'evidence.read');
        const entry = await tenantEntry(deps, session);
        if (!deps.ledger) throw new HttpError(503, 'Ledger integration is not configured for this deployment');
        const correlationId = url.searchParams.get('correlationId');
        const streamId = url.searchParams.get('streamId');
        const eventType = url.searchParams.get('eventType');
        const limitRaw = url.searchParams.get('limit');
        const cursor = url.searchParams.get('cursor');
        return send(res, 200, await deps.ledger.search(entry, {
          ...(correlationId ? { correlationId } : {}), ...(streamId ? { streamId } : {}), ...(eventType ? { eventType } : {}),
          ...(limitRaw ? { limit: Number(limitRaw) } : {}), ...(cursor ? { cursor } : {}),
        }));
      }
      const streamMatch = path.match(/^\/api\/evidence\/streams\/([^/]+)(\/verify)?$/);
      if (req.method === 'GET' && streamMatch) {
        requirePermission(session, 'evidence.read');
        const entry = await tenantEntry(deps, session);
        if (!deps.ledger) throw new HttpError(503, 'Ledger integration is not configured for this deployment');
        // `path` comes from `url.pathname`, which preserves percent-encoding (it does not auto-decode) —
        // a stream id containing `:` or other URL-reserved characters (real stream ids in this project
        // routinely look like `agent:a1`/`improvement:gen_...`) must be decoded exactly once here, then
        // re-encoded exactly once by the Ledger client when building the outgoing request — never
        // double-encoded, which would send a literal `%3A`-shaped id the real Ledger has no row for.
        const streamId = decodeURIComponent(streamMatch[1]!);
        const result = streamMatch[2] ? await deps.ledger.verifyStream(entry, streamId) : await deps.ledger.getStream(entry, streamId);
        return send(res, 200, result);
      }
      if (req.method === 'GET' && path === '/api/evidence/verify') {
        requirePermission(session, 'evidence.read');
        const entry = await tenantEntry(deps, session);
        if (!deps.ledger) throw new HttpError(503, 'Ledger integration is not configured for this deployment');
        // `Ledger.verifyAll()`'s real `FullVerificationResult` reports counts (`validStreams`/
        // `invalidStreams`), not a single boolean — unlike the per-stream result. `valid` here is a
        // direct, non-fabricated projection of those authoritative counts (never an independent claim),
        // added so the assurance panel's whole-ledger row can render the same VERIFIED/not shape as a
        // single stream's result.
        const result = await deps.ledger.verifyAll(entry) as { invalidStreams: number };
        return send(res, 200, { ...result, valid: result.invalidStreams === 0 });
      }

      if (req.method === 'GET' && path === '/api/audit/assessments') {
        requirePermission(session, 'audit.read');
        const entry = await tenantEntry(deps, session);
        if (!deps.auditor) throw new HttpError(503, 'Auditor integration is not configured for this deployment');
        return send(res, 200, await deps.auditor.listAssessments(entry));
      }
      const assessmentMatch = path.match(/^\/api\/audit\/assessments\/([^/]+)(\/results|\/findings)?$/);
      if (req.method === 'GET' && assessmentMatch) {
        requirePermission(session, 'audit.read');
        const entry = await tenantEntry(deps, session);
        if (!deps.auditor) throw new HttpError(503, 'Auditor integration is not configured for this deployment');
        const assessmentId = decodeURIComponent(assessmentMatch[1]!);
        const result = assessmentMatch[2] === '/results' ? await deps.auditor.listResults(entry, assessmentId)
          : assessmentMatch[2] === '/findings' ? await deps.auditor.listFindings(entry, assessmentId)
          : await deps.auditor.getAssessment(entry, assessmentId);
        return send(res, 200, result);
      }

      // -----------------------------------------------------------------------------------
      // Recursive-improvement lineage (real `apps/tna-improvement-governor`, Volume 12). The flagship
      // demonstration of "a successor can become better without automatically becoming more powerful" —
      // every generation's status/benchmark/authority-delta/holdout/canary field rendered here comes
      // straight from the governor's own real, Ledger-backed state, never a UI-side inference.
      // -----------------------------------------------------------------------------------
      if (req.method === 'GET' && path === '/api/improvements') {
        requirePermission(session, 'improvement.read');
        const entry = await tenantEntry(deps, session);
        if (!deps.improvement) throw new HttpError(503, 'Recursive-improvement integration is not configured for this deployment');
        const systemId = url.searchParams.get('systemId');
        if (!systemId) throw new HttpError(400, 'systemId query parameter is required');
        const limitRaw = url.searchParams.get('limit');
        return send(res, 200, await deps.improvement.listGenerations(entry, systemId, limitRaw ? Number(limitRaw) : undefined));
      }
      const improvementMatch = path.match(/^\/api\/improvements\/([^/]+)(\/evidence|\/lineage|\/approve|\/promote|\/rollback)?$/);
      if (improvementMatch) {
        const generationId = decodeURIComponent(improvementMatch[1]!);
        const sub = improvementMatch[2];
        const entry = await tenantEntry(deps, session);
        if (!deps.improvement) throw new HttpError(503, 'Recursive-improvement integration is not configured for this deployment');
        if (req.method === 'GET' && sub === undefined) { requirePermission(session, 'improvement.read'); return send(res, 200, await deps.improvement.getGeneration(entry, generationId)); }
        if (req.method === 'GET' && sub === '/evidence') { requirePermission(session, 'improvement.read'); return send(res, 200, await deps.improvement.getEvidence(entry, generationId)); }
        if (req.method === 'GET' && sub === '/lineage') { requirePermission(session, 'improvement.read'); return send(res, 200, await deps.improvement.getLineage(entry, generationId)); }
        if (req.method === 'POST' && sub === '/approve') {
          requirePermission(session, 'improvement.approve');
          requireCsrf(req, session);
          const input = await body(req);
          if (typeof input.operation !== 'string') throw new HttpError(400, 'operation is required');
          // Never pass the CLIENT's own role through as the Gate approver role — the governor's real
          // envelope (`registerImprovementGovernor`) requires a specific, tenant-configured approver role
          // (e.g. `improvement-approver`) for `promote`/`rollback`/`start_canary`; a client's role string
          // (`client-admin`, etc.) would not match it and the real Gate approval would simply fail. The
          // Control Center's `improvement.approve` permission check above is what gates WHO on this side
          // may trigger the approval; the governor's own configured approver role remains its default.
          return send(res, 200, await deps.improvement.approve(entry, generationId, input.operation));
        }
        if (req.method === 'POST' && sub === '/promote') {
          requirePermission(session, 'improvement.promote');
          requireCsrf(req, session);
          const input = await body(req);
          return send(res, 200, await deps.improvement.promote(entry, generationId, typeof input.approvalId === 'string' ? input.approvalId : undefined));
        }
        if (req.method === 'POST' && sub === '/rollback') {
          requirePermission(session, 'improvement.rollback');
          requireCsrf(req, session);
          const input = await body(req);
          if (typeof input.targetGenerationId !== 'string') throw new HttpError(400, 'targetGenerationId is required');
          return send(res, 200, await deps.improvement.rollback(entry, generationId, input.targetGenerationId, typeof input.approvalId === 'string' ? input.approvalId : undefined, typeof input.trigger === 'string' ? input.trigger : undefined));
        }
      }

      // -----------------------------------------------------------------------------------
      // Incidents — see `incidents.ts` for the honest scope note: no accepted backend has a real Incident
      // store, so this is a live, evidence-backed aggregation over already-real sources, computed fresh on
      // every request (never cached as if it were a persisted incident record).
      // -----------------------------------------------------------------------------------
      if (req.method === 'GET' && path === '/api/incidents') {
        requirePermission(session, 'incident.read');
        const entry = await tenantEntry(deps, session);
        const [componentsResult, actionsResult, ledgerResult, connectionsResult, toolsResult] = await Promise.allSettled([
          deps.platform.ready(entry),
          deps.platform.listActions(entry, { limit: 200 }),
          deps.ledger ? deps.ledger.verifyAll(entry) as Promise<{ valid: boolean; invalidStreams: number }> : Promise.resolve(null),
          deps.clientGateway && deps.clientGatewayClient ? deps.clientGatewayClient.listMcpServers(deps.clientGateway, session.tenant_id) : Promise.resolve(null),
          deps.clientGateway && deps.clientGatewayClient ? deps.clientGatewayClient.listTools(deps.clientGateway, session.tenant_id) : Promise.resolve(null),
        ]);
        const components = componentsResult.status === 'fulfilled' ? (componentsResult.value as { components?: unknown }).components as readonly { component: string; status: string; mandatory?: boolean; message?: string }[] | undefined : undefined;
        const actionsRaw = actionsResult.status === 'fulfilled' ? (actionsResult.value as { items?: unknown }).items as readonly { platform_action_id: string; state: string }[] | undefined : undefined;
        const ledgerVerification = ledgerResult.status === 'fulfilled' ? ledgerResult.value : null;
        const connections = connectionsResult.status === 'fulfilled' ? connectionsResult.value as readonly { mcp_server_id: string; name: string; status: string }[] | null : null;
        const tools = toolsResult.status === 'fulfilled' ? toolsResult.value as readonly { tool_id: string; external_tool_name: string; review_status: string }[] | null : null;
        const incidents = computeIncidents({ components, actions: actionsRaw, ledgerVerification, connections: connections ?? undefined, tools: tools ?? undefined });
        const acknowledgments = deps.sessions.getIncidentAcknowledgments(session.tenant_id);
        return send(res, 200, {
          items: incidents.map(i => ({ ...i, acknowledgment: acknowledgments.get(i.signature) ?? null })),
        });
      }
      const incidentAckMatch = path.match(/^\/api\/incidents\/([^/]+)\/acknowledge$/);
      if (req.method === 'POST' && incidentAckMatch) {
        requirePermission(session, 'incident.acknowledge');
        requireCsrf(req, session);
        deps.sessions.acknowledgeIncident(session.tenant_id, decodeURIComponent(incidentAckMatch[1]!), session.user_id);
        return send(res, 200, { acknowledged: true });
      }

      // -----------------------------------------------------------------------------------
      // Client Gateway-backed routes (organization, connections/MCP, governed tools, identities).
      // Every one of these calls `tenantEntry()` first — not because the returned Platform registry
      // entry is itself used here, but because that call is where the real, freshly-queried tenant
      // -lifecycle check lives (foundation-review item A) and where an unregistered tenant fails closed.
      // -----------------------------------------------------------------------------------

      if (req.method === 'GET' && path === '/api/organization') {
        requirePermission(session, 'organization.read');
        await tenantEntry(deps, session);
        const { config, client } = requireClientGateway(deps);
        return send(res, 200, await client.getTenant(config, session.tenant_id));
      }
      if (req.method === 'GET' && path === '/api/readiness') {
        requirePermission(session, 'organization.read');
        await tenantEntry(deps, session);
        const { config, client } = requireClientGateway(deps);
        return send(res, 200, await client.getReadiness(config, session.tenant_id));
      }
      if (req.method === 'GET' && path === '/api/health') {
        requirePermission(session, 'organization.read');
        await tenantEntry(deps, session);
        const { config, client } = requireClientGateway(deps);
        return send(res, 200, await client.getHealth(config, session.tenant_id));
      }

      if (req.method === 'GET' && path === '/api/connections') {
        requirePermission(session, 'connection.read');
        await tenantEntry(deps, session);
        const { config, client } = requireClientGateway(deps);
        return send(res, 200, await client.listMcpServers(config, session.tenant_id));
      }

      if (req.method === 'GET' && path === '/api/tools') {
        requirePermission(session, 'tool.read');
        await tenantEntry(deps, session);
        const { config, client } = requireClientGateway(deps);
        return send(res, 200, await client.listTools(config, session.tenant_id));
      }
      const toolEnableMatch = path.match(/^\/api\/tools\/([^/]+)\/enable$/);
      if (req.method === 'POST' && toolEnableMatch) {
        requirePermission(session, 'tool.enable.request');
        requireCsrf(req, session);
        await tenantEntry(deps, session);
        const input = await body(req);
        const stateVersion = typeof input.state_version === 'number' ? input.state_version : undefined;
        if (stateVersion === undefined) throw new HttpError(400, 'state_version is required');
        const riskClass = input.risk_class;
        if (riskClass !== 'LOW' && riskClass !== 'MEDIUM' && riskClass !== 'HIGH' && riskClass !== 'CRITICAL') throw new HttpError(400, 'risk_class must be LOW|MEDIUM|HIGH|CRITICAL');
        const policyId = typeof input.policy_id === 'string' && input.policy_id.length > 0 ? input.policy_id : undefined;
        if (!policyId) throw new HttpError(400, 'policy_id is required');
        const { config, client } = requireClientGateway(deps);
        const result = await client.enableTool(config, session.tenant_id, decodeURIComponent(toolEnableMatch[1]!), {
          state_version: stateVersion, risk_class: riskClass, policy_id: policyId,
          allowed_operations: Array.isArray(input.allowed_operations) ? input.allowed_operations : ['read'],
          resource_patterns: Array.isArray(input.resource_patterns) ? input.resource_patterns : ['*'],
          requires_human_approval: input.requires_human_approval === true,
          requires_vad: input.requires_vad === true,
          runtime_limits: {}, cost_limits: {},
        });
        return send(res, 200, result);
      }
      const toolDisableMatch = path.match(/^\/api\/tools\/([^/]+)\/disable$/);
      if (req.method === 'POST' && toolDisableMatch) {
        requirePermission(session, 'tool.disable.request');
        requireCsrf(req, session);
        await tenantEntry(deps, session);
        const input = await body(req);
        const stateVersion = typeof input.state_version === 'number' ? input.state_version : undefined;
        if (stateVersion === undefined) throw new HttpError(400, 'state_version is required');
        const { config, client } = requireClientGateway(deps);
        return send(res, 200, await client.disableTool(config, session.tenant_id, decodeURIComponent(toolDisableMatch[1]!), stateVersion));
      }

      if (req.method === 'GET' && path === '/api/identities') {
        requirePermission(session, 'identity.read');
        await tenantEntry(deps, session);
        const { config, client } = requireClientGateway(deps);
        return send(res, 200, await client.listServiceIdentities(config, session.tenant_id));
      }
      if (req.method === 'POST' && path === '/api/identities') {
        requirePermission(session, 'identity.create');
        requireCsrf(req, session);
        await tenantEntry(deps, session);
        const input = await body(req);
        const name = typeof input.name === 'string' && input.name.length > 0 ? input.name : undefined;
        const role = typeof input.role === 'string' ? input.role : undefined;
        if (!name || !role) throw new HttpError(400, 'name and role are required');
        const { config, client } = requireClientGateway(deps);
        // The real, plaintext credential token is returned exactly once, at issuance — this response is
        // the ONLY time it will ever exist outside the Client Gateway's own hashed storage.
        return send(res, 201, await client.createServiceIdentity(config, session.tenant_id, name, role));
      }
      const identityRotateMatch = path.match(/^\/api\/identities\/([^/]+)\/rotate$/);
      if (req.method === 'POST' && identityRotateMatch) {
        requirePermission(session, 'credential.rotate');
        requireCsrf(req, session);
        await tenantEntry(deps, session);
        const input = await body(req);
        const stateVersion = typeof input.state_version === 'number' ? input.state_version : undefined;
        if (stateVersion === undefined) throw new HttpError(400, 'state_version is required');
        const { config, client } = requireClientGateway(deps);
        return send(res, 200, await client.rotateCredential(config, session.tenant_id, decodeURIComponent(identityRotateMatch[1]!), stateVersion));
      }
      const identityRevokeMatch = path.match(/^\/api\/identities\/([^/]+)\/revoke$/);
      if (req.method === 'POST' && identityRevokeMatch) {
        // Mapped to `identity.suspend` — a service identity's only non-ACTIVE status is REVOKED; there is
        // no separate "suspend" state for identities in the accepted Volume 10 model, so "suspend" the
        // permission name and "revoke" the real operation are the same real capability.
        requirePermission(session, 'identity.suspend');
        requireCsrf(req, session);
        await tenantEntry(deps, session);
        const input = await body(req);
        const stateVersion = typeof input.state_version === 'number' ? input.state_version : undefined;
        if (stateVersion === undefined) throw new HttpError(400, 'state_version is required');
        const { config, client } = requireClientGateway(deps);
        return send(res, 200, await client.revokeServiceIdentity(config, session.tenant_id, decodeURIComponent(identityRevokeMatch[1]!), stateVersion));
      }

      // -----------------------------------------------------------------------------------
      // Control-Center human user management (signup invites, admin-mediated password reset). A distinct
      // resource from the identity.* routes above, which govern Client Gateway SERVICE identities, not
      // human logins to this console. Every route resolves its tenant from `session.tenant_id` — an admin
      // can never invite/reset a user into a tenant other than their own.
      // -----------------------------------------------------------------------------------
      if (req.method === 'GET' && path === '/api/users') {
        requirePermission(session, 'user.invite');
        const users = deps.sessions.listUsers(session.tenant_id);
        return send(res, 200, { items: users.map(u => ({ username: u.username, role: u.role, created_at: u.created_at, disabled: u.disabled })) });
      }
      if (req.method === 'POST' && path === '/api/users/invite') {
        requirePermission(session, 'user.invite');
        requireCsrf(req, session);
        const input = await body(req);
        if (typeof input.username !== 'string' || input.username.length === 0) throw new HttpError(400, 'username is required');
        if (typeof input.role !== 'string' || !(CLIENT_ROLES as readonly string[]).includes(input.role)) throw new HttpError(400, `role must be one of: ${CLIENT_ROLES.join(', ')}`);
        const invite = deps.sessions.createSignupInvite(session.tenant_id, input.username, input.role as ClientRole);
        return send(res, 201, invite);
      }
      const resetTokenMatch = path.match(/^\/api\/users\/([^/]+)\/reset-password-token$/);
      if (req.method === 'POST' && resetTokenMatch) {
        requirePermission(session, 'user.reset_password');
        requireCsrf(req, session);
        const username = decodeURIComponent(resetTokenMatch[1]!);
        const resetToken = deps.sessions.createPasswordResetToken(session.tenant_id, username);
        return send(res, 201, resetToken);
      }

      throw new HttpError(404, 'Not found');
    } catch (error) {
      send(res, errorStatus(error), errorBody(error));
    }
  });
}

export { CLIENT_ROLES };
