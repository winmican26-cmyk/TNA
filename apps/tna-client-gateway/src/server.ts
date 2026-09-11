/**
 * TNA Client Integration & MCP Gateway v0.1 (Volume 10). HTTP server surface for the client gateway
 * (§35-37, 131). Uses Node.js built-in `node:http` (same as tna-platform). Two authentication domains:
 *
 * - **Admin API** (`/v1/admin/...`): requires `Authorization: Bearer <TNA_CLIENT_ADMIN_TOKEN>`.
 *   Tenant lifecycle, service identity management, MCP server registration, tool governance.
 *
 * - **Client API** (`/v1/client/...`): requires a service identity bearer token authenticated via
 *   `ClientStore.authenticateService`. The tenant_id is derived from the authenticated identity
 *   (§37 — never from the request body).
 *
 * Error handling (§113-114): client errors never expose internal DB paths, stack traces, or other
 * tenant IDs. ClientError/McpError codes map to HTTP status codes.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  ClientError, isPlainObject, type ClientErrorCode,
} from '../../../packages/client-schema/src/index.js';
import {
  validateClientTenantCreateInput,
  validateServiceIdentityCreateInput,
} from '../../../packages/client-schema/src/index.js';
import {
  ClientStore, toolPlatformId,
} from '../../../packages/client-core/src/index.js';
import {
  McpError, hashSchema, validateMcpServerRegisterInput, type McpErrorCode,
} from '../../../packages/mcp-schema/src/index.js';
import { McpStdioClient } from '../../../packages/mcp-gateway/src/index.js';
import {
  type PlatformPrincipal, agentPrincipal,
} from '../../../packages/platform-schema/src/index.js';
import type {
  PlatformFacade,
} from '../../../packages/platform-core/src/index.js';

const MAX_BODY_BYTES = 262_144;

export class HttpError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

// -------------------------------------------------------------------------------------
// HTTP helpers
// -------------------------------------------------------------------------------------

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
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
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

// -------------------------------------------------------------------------------------
// Error → HTTP status mapping (§113-114)
// -------------------------------------------------------------------------------------

function clientErrorStatus(code: ClientErrorCode): number {
  switch (code) {
    case 'NOT_FOUND': return 404;
    case 'FORBIDDEN': case 'CROSS_TENANT_DENIED': return 403;
    case 'CONFLICT': return 409;
    case 'PAYLOAD_TOO_LARGE': return 413;
    case 'TENANT_NOT_ACTIVE': return 409;
    case 'SERVICE_IDENTITY_REVOKED': return 403;
    case 'CREDENTIAL_INVALID': return 401;
    case 'TOOL_NOT_ENABLED': return 409;
    case 'TOOL_POLICY_REVIEW_REQUIRED': return 409;
    case 'SCHEMA_DRIFT_DETECTED': return 409;
    case 'INVALID_INPUT': return 400;
    default: return 400;
  }
}

function mcpErrorStatus(code: McpErrorCode): number {
  switch (code) {
    case 'MCP_SERVER_UNAVAILABLE': return 502;
    case 'MCP_INITIALIZATION_FAILED': return 502;
    case 'MCP_TOOL_NOT_FOUND': return 404;
    case 'MCP_SCHEMA_DRIFT': return 409;
    case 'MCP_TOOL_DISABLED': return 409;
    case 'MCP_TIMEOUT': return 504;
    case 'MCP_PROTOCOL_ERROR': return 502;
    case 'MCP_RESULT_TOO_LARGE': return 502;
    case 'MCP_INDETERMINATE': return 502;
    default: return 500;
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof ClientError) return clientErrorStatus(error.code);
  if (error instanceof McpError) return mcpErrorStatus(error.code);
  return 500;
}

function errorBody(error: unknown): { error: string; code?: string } {
  if (error instanceof HttpError) return { error: error.message };
  if (error instanceof ClientError) return { error: error.message, code: error.code };
  if (error instanceof McpError) return { error: error.message, code: error.code };
  return { error: 'Internal server error' };
}

// -------------------------------------------------------------------------------------
// Route helpers
// -------------------------------------------------------------------------------------

function extractBearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Authorization: Bearer <token> required');
  }
  return authorization.slice(7);
}

function requireStateVersion(raw: unknown, label: string): number {
  if (!isPlainObject(raw)) throw new HttpError(400, `${label} body must be an object`);
  const sv = (raw as Record<string, unknown>).state_version;
  if (typeof sv !== 'number' || !Number.isInteger(sv) || sv < 0) {
    throw new HttpError(400, 'state_version must be a non-negative integer');
  }
  return sv;
}

function requireString(raw: unknown, field: string, label: string): string {
  if (!isPlainObject(raw)) throw new HttpError(400, `${label} body must be an object`);
  const value = (raw as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, `${field} must be a non-empty string`);
  }
  return value;
}

// -------------------------------------------------------------------------------------
// §69: Client integration health
// -------------------------------------------------------------------------------------

interface IntegrationHealth {
  readonly tenant_status: string;
  readonly active_services: number;
  readonly registered_servers: number;
  readonly reachable_servers: number;
  readonly enabled_tools: number;
  readonly tools_requiring_review: number;
  readonly healthy: boolean;
}

function computeIntegrationHealth(store: ClientStore, tenantId: string): IntegrationHealth {
  const tenant = store.getTenant(tenantId);
  const services = store.listServiceIdentities(tenantId, { limit: 200 });
  const servers = store.listMcpServers(tenantId);
  const tools = store.listTools(tenantId);
  const activeServices = services.items.filter(s => s.status === 'ACTIVE').length;
  const reachableServers = servers.filter(s => s.status === 'REACHABLE').length;
  const enabledTools = tools.filter(t => t.enabled).length;
  const reviewRequired = tools.filter(t => t.review_status === 'POLICY_REVIEW_REQUIRED' || t.review_status === 'DISCOVERED').length;
  const healthy = tenant.status === 'ACTIVE' && activeServices > 0;
  return {
    tenant_status: tenant.status,
    active_services: activeServices,
    registered_servers: servers.length,
    reachable_servers: reachableServers,
    enabled_tools: enabledTools,
    tools_requiring_review: reviewRequired,
    healthy,
  };
}

// -------------------------------------------------------------------------------------
// §51: Onboarding readiness assessment
// -------------------------------------------------------------------------------------

interface OnboardingReadiness {
  readonly tenant_id: string;
  readonly readiness: 'READY' | 'READY_WITH_LIMITATIONS' | 'NOT_READY' | 'INSUFFICIENT_EVIDENCE';
  readonly checks: readonly { readonly check: string; readonly passed: boolean; readonly detail: string }[];
}

function assessOnboardingReadiness(store: ClientStore, tenantId: string): OnboardingReadiness {
  const tenant = store.getTenant(tenantId);
  const services = store.listServiceIdentities(tenantId, { limit: 200 });
  const servers = store.listMcpServers(tenantId);
  const tools = store.listTools(tenantId);
  const checks: { check: string; passed: boolean; detail: string }[] = [];

  // Check 1: tenant must be ACTIVE
  checks.push({
    check: 'tenant_active',
    passed: tenant.status === 'ACTIVE',
    detail: tenant.status === 'ACTIVE' ? 'Tenant is active' : `Tenant is ${tenant.status}`,
  });

  // Check 2: at least one active service identity
  const activeServices = services.items.filter(s => s.status === 'ACTIVE');
  checks.push({
    check: 'service_identity_exists',
    passed: activeServices.length > 0,
    detail: activeServices.length > 0 ? `${activeServices.length} active service identit${activeServices.length === 1 ? 'y' : 'ies'}` : 'No active service identities',
  });

  // Check 3: at least one MCP server registered and reachable
  const reachableServers = servers.filter(s => s.status === 'REACHABLE');
  checks.push({
    check: 'mcp_server_reachable',
    passed: reachableServers.length > 0,
    detail: reachableServers.length > 0 ? `${reachableServers.length} reachable MCP server(s)` : 'No reachable MCP servers',
  });

  // Check 4: at least one enabled tool
  const enabledTools = tools.filter(t => t.enabled);
  checks.push({
    check: 'tool_enabled',
    passed: enabledTools.length > 0,
    detail: enabledTools.length > 0 ? `${enabledTools.length} enabled tool(s)` : 'No enabled tools',
  });

  // Check 5: no tools stuck in POLICY_REVIEW_REQUIRED
  const reviewRequired = tools.filter(t => t.review_status === 'POLICY_REVIEW_REQUIRED');
  checks.push({
    check: 'no_pending_reviews',
    passed: reviewRequired.length === 0,
    detail: reviewRequired.length === 0 ? 'All tools are reviewed' : `${reviewRequired.length} tool(s) awaiting policy review`,
  });

  const critical = checks.filter(c => !c.passed);
  let readiness: OnboardingReadiness['readiness'];
  if (critical.length === 0) {
    readiness = 'READY';
  } else if (checks[0]!.passed && checks[1]!.passed && critical.length <= 2) {
    readiness = 'READY_WITH_LIMITATIONS';
  } else if (checks.some(c => c.passed)) {
    readiness = 'NOT_READY';
  } else {
    readiness = 'INSUFFICIENT_EVIDENCE';
  }

  return { tenant_id: tenantId, readiness, checks };
}

// -------------------------------------------------------------------------------------
// Server dependencies
// -------------------------------------------------------------------------------------

/** §packaged-execution closure, TNA-64. 'governed': `POST /v1/client/actions` MUST flow through the
 * real platform facade (Gate → Capability → Sentinel → ExecutionBroker → Connector) — no fallback to
 * recording-only exists in this mode; `createClientGatewayServer` refuses to construct a server that
 * claims 'governed' without a `platformFacadeFor` resolver (fail closed at startup, never per-request).
 * 'record-only': `POST /v1/client/actions` only ever records the action in the client store — it
 * provides **no governed execution assurance** (no Gate/Capability/Sentinel/MCP path runs at all) and
 * must never be the production posture (`apps/tna-client-gateway/src/config.ts` refuses it outright
 * when `NODE_ENV=production`). */
export type ClientGatewayMode = 'governed' | 'record-only';

export interface ClientGatewayServerDeps {
  readonly store: ClientStore;
  /** Defaults to 'governed' when `platformFacadeFor` is supplied, 'record-only' otherwise — this
   * default exists only for test/library ergonomics; the real production entrypoint
   * (`apps/tna-client-gateway/src/main.ts`) always sets this explicitly from validated config and never
   * relies on the default. */
  readonly mode?: ClientGatewayMode;
  /** Resolves the one real `PlatformFacade` for a given tenant (tenant-scoped because a Sentinel
   * principal is fixed at that facade's construction — see `governed-execution.ts`). Required when
   * `mode: 'governed'`. */
  readonly platformFacadeFor?: (tenantId: string) => PlatformFacade;
  /** Re-derives Gate's agent registration/envelope and connector/tool registrations for one tenant from
   * live `ClientStore` state immediately before a governed submission — see `governed-execution.ts`.
   * Optional only so unit tests that construct a `platformFacadeFor` directly (bypassing Gate/Sentinel
   * entirely) do not also need to supply Gate wiring; the real production entrypoint always supplies it
   * alongside `platformFacadeFor`. */
  readonly syncGovernedTenant?: (tenantId: string, agentId: string) => void;
  readonly startedAt?: number;
}

/**
 * Creates the HTTP server for the TNA Client Gateway. Two authentication domains:
 * - Admin routes: TNA_CLIENT_ADMIN_TOKEN bearer
 * - Client routes: service identity bearer (resolved via ClientStore.authenticateService)
 *
 * Fails closed at construction (TNA-64): a server built with `mode: 'governed'` but no
 * `platformFacadeFor` throws immediately rather than silently falling back to recording-only once
 * running — there is no code path by which 'governed' can end up behaving like 'record-only'.
 */
export function createClientGatewayServer(deps: ClientGatewayServerDeps, adminToken: string) {
  const startedAt = deps.startedAt ?? Date.now();
  const { store } = deps;
  const mode: ClientGatewayMode = deps.mode ?? (deps.platformFacadeFor ? 'governed' : 'record-only');
  if (mode === 'governed' && !deps.platformFacadeFor) {
    throw new Error(
      'createClientGatewayServer: mode "governed" requires platformFacadeFor — refusing to start a ' +
      'server that would silently behave as record-only (TNA-64: the packaged path must be the real path)',
    );
  }

  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 },
    (req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const path = url.pathname;

          // Health probes — unauthenticated (same convention as tna-platform)
          if (req.method === 'GET' && path === '/live') {
            return send(res, 200, { status: 'ALIVE', uptime_ms: Date.now() - startedAt });
          }
          if (req.method === 'GET' && path === '/ready') {
            try {
              store.listTenants({ limit: 1 });
              return send(res, 200, { ready: true, status: 'AVAILABLE', mode, governed_execution: mode === 'governed' });
            } catch {
              return send(res, 503, { ready: false, status: 'UNAVAILABLE', mode, governed_execution: false });
            }
          }

          // -----------------------------------------------------------------
          // Admin API routes (§ Admin token authentication)
          // -----------------------------------------------------------------
          if (path.startsWith('/v1/admin/')) {
            const token = extractBearerToken(req);
            if (token !== adminToken) throw new HttpError(401, 'Invalid admin token');
            return await handleAdminRoute(req, res, path, store);
          }

          // -----------------------------------------------------------------
          // Client API routes (§ service identity authentication)
          // -----------------------------------------------------------------
          if (path.startsWith('/v1/client/')) {
            const token = extractBearerToken(req);
            const identity = store.authenticateService(token);
            if (!identity) throw new HttpError(401, 'Invalid or revoked service credential');
            // §37: tenant_id is derived from the authenticated identity, never request body
            const tenantId = identity.tenant_id;
            return await handleClientRoute(req, res, path, store, tenantId, identity.service_id, deps.platformFacadeFor, deps.syncGovernedTenant);
          }

          throw new HttpError(404, 'Route not found');
        } catch (error) {
          send(res, errorStatus(error), errorBody(error));
        }
      })();
    },
  );
  server.maxRequestsPerSocket = 100;
  return server;
}

// -------------------------------------------------------------------------------------
// Admin API route handler
// -------------------------------------------------------------------------------------

async function handleAdminRoute(
  req: IncomingMessage, res: ServerResponse, path: string, store: ClientStore,
): Promise<void> {
  // POST /v1/admin/tenants — create tenant
  if (req.method === 'POST' && path === '/v1/admin/tenants') {
    const raw = await body(req);
    const input = validateClientTenantCreateInput(raw);
    const tenant = store.createTenant(input, 'admin');
    return send(res, 201, tenant);
  }

  // GET /v1/admin/tenants — list tenants
  if (req.method === 'GET' && path === '/v1/admin/tenants') {
    return send(res, 200, store.listTenants());
  }

  // Routes scoped to /v1/admin/tenants/:id/...
  const tenantMatch = /^\/v1\/admin\/tenants\/([A-Za-z0-9._:-]+)(\/.*)?$/.exec(path);
  if (tenantMatch?.[1]) {
    const tenantId = tenantMatch[1];
    const subPath = tenantMatch[2] ?? '';

    // GET /v1/admin/tenants/:id — get tenant
    if (req.method === 'GET' && subPath === '') {
      return send(res, 200, store.getTenant(tenantId));
    }

    // POST /v1/admin/tenants/:id/activate
    if (req.method === 'POST' && subPath === '/activate') {
      const raw = await body(req);
      const sv = requireStateVersion(raw, 'activate');
      return send(res, 200, store.activateTenant(tenantId, sv));
    }

    // POST /v1/admin/tenants/:id/suspend — requires reason
    if (req.method === 'POST' && subPath === '/suspend') {
      const raw = await body(req);
      const sv = requireStateVersion(raw, 'suspend');
      const reason = requireString(raw, 'reason', 'suspend');
      return send(res, 200, store.suspendTenant(tenantId, sv, reason));
    }

    // POST /v1/admin/tenants/:id/offboard — requires reason
    if (req.method === 'POST' && subPath === '/offboard') {
      const raw = await body(req);
      const sv = requireStateVersion(raw, 'offboard');
      const reason = requireString(raw, 'reason', 'offboard');
      return send(res, 200, store.beginOffboarding(tenantId, sv, reason, 'admin'));
    }

    // POST /v1/admin/tenants/:id/services — create service identity
    if (req.method === 'POST' && subPath === '/services') {
      const raw = await body(req);
      const input = validateServiceIdentityCreateInput(raw);
      const result = store.createServiceIdentity(tenantId, input, 'admin');
      return send(res, 201, result);
    }

    // GET /v1/admin/tenants/:id/services — list service identities
    if (req.method === 'GET' && subPath === '/services') {
      return send(res, 200, store.listServiceIdentities(tenantId));
    }

    // Service identity sub-routes: /services/:sid/...
    const serviceMatch = /^\/services\/([A-Za-z0-9._:-]+)(\/.*)?$/.exec(subPath);
    if (serviceMatch?.[1]) {
      const serviceId = serviceMatch[1];
      const svcSubPath = serviceMatch[2] ?? '';

      // POST /v1/admin/tenants/:id/services/:sid/rotate
      if (req.method === 'POST' && svcSubPath === '/rotate') {
        const raw = await body(req);
        const sv = requireStateVersion(raw, 'rotate');
        return send(res, 200, store.rotateCredential(tenantId, serviceId, sv));
      }

      // POST /v1/admin/tenants/:id/services/:sid/revoke
      if (req.method === 'POST' && svcSubPath === '/revoke') {
        const raw = await body(req);
        const sv = requireStateVersion(raw, 'revoke');
        return send(res, 200, store.revokeServiceIdentity(tenantId, serviceId, sv));
      }
    }

    // POST /v1/admin/tenants/:id/mcp-servers — register MCP server
    if (req.method === 'POST' && subPath === '/mcp-servers') {
      const raw = await body(req);
      const input = validateMcpServerRegisterInput(raw);
      return send(res, 201, store.registerMcpServer(tenantId, input, 'admin'));
    }

    // GET /v1/admin/tenants/:id/mcp-servers — list MCP servers
    if (req.method === 'GET' && subPath === '/mcp-servers') {
      return send(res, 200, store.listMcpServers(tenantId));
    }

    // MCP server sub-routes: /mcp-servers/:sid/...
    const mcpMatch = /^\/mcp-servers\/([A-Za-z0-9._:-]+)(\/.*)?$/.exec(subPath);
    if (mcpMatch?.[1]) {
      const mcpServerId = mcpMatch[1];
      const mcpSubPath = mcpMatch[2] ?? '';

      // POST /v1/admin/tenants/:id/mcp-servers/:sid/discover — discover tools
      if (req.method === 'POST' && mcpSubPath === '/discover') {
        const server = store.getMcpServer(tenantId, mcpServerId);
        const client = new McpStdioClient({
          executable: server.executable,
          args: server.args as string[],
          envAllowlist: server.env_allowlist as string[],
        });
        try {
          await client.connect();
          const tools = await client.listTools();
          const result = store.recordDiscovery(tenantId, mcpServerId, tools, hashSchema);
          return send(res, 200, result);
        } catch (error) {
          // Record server as unreachable on connection/protocol failure
          try { store.setMcpServerStatus(tenantId, mcpServerId, server.state_version, 'UNREACHABLE'); } catch { /* best-effort */ }
          throw error;
        } finally {
          await client.shutdown().catch(() => { /* best-effort */ });
        }
      }
    }

    // Tool sub-routes: /tools/:tid/...
    const toolMatch = /^\/tools\/([A-Za-z0-9._:-]+)(\/.*)?$/.exec(subPath);
    if (toolMatch?.[1]) {
      const toolId = toolMatch[1];
      const toolSubPath = toolMatch[2] ?? '';

      // POST /v1/admin/tenants/:id/tools/:tid/enable
      if (req.method === 'POST' && toolSubPath === '/enable') {
        const raw = await body(req);
        if (!isPlainObject(raw)) throw new HttpError(400, 'Enable tool body must be an object');
        const sv = requireStateVersion(raw, 'enable');
        const riskClassRaw = (raw as Record<string, unknown>).risk_class;
        if (riskClassRaw !== 'LOW' && riskClassRaw !== 'MEDIUM' && riskClassRaw !== 'HIGH' && riskClassRaw !== 'CRITICAL') {
          throw new HttpError(400, 'risk_class must be LOW|MEDIUM|HIGH|CRITICAL');
        }
        const riskClass = riskClassRaw as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
        const policyId = (raw as Record<string, unknown>).policy_id;
        if (typeof policyId !== 'string' || policyId.length === 0) {
          throw new HttpError(400, 'policy_id is required');
        }
        const obj = raw as Record<string, unknown>;
        const result = store.enableTool(tenantId, toolId, sv, {
          risk_class: riskClass,
          allowed_operations: Array.isArray(obj.allowed_operations) ? obj.allowed_operations as string[] : ['read'],
          resource_patterns: Array.isArray(obj.resource_patterns) ? obj.resource_patterns as string[] : ['*'],
          requires_human_approval: obj.requires_human_approval === true,
          requires_vad: obj.requires_vad === true,
          policy_id: policyId,
          runtime_limits: isPlainObject(obj.runtime_limits) ? obj.runtime_limits as Record<string, unknown> : {},
          cost_limits: isPlainObject(obj.cost_limits) ? obj.cost_limits as Record<string, unknown> : {},
          bound_by: 'admin',
        });
        return send(res, 200, result);
      }

      // POST /v1/admin/tenants/:id/tools/:tid/disable
      if (req.method === 'POST' && toolSubPath === '/disable') {
        const raw = await body(req);
        const sv = requireStateVersion(raw, 'disable');
        return send(res, 200, store.disableTool(tenantId, toolId, sv));
      }
    }

    // GET /v1/admin/tenants/:id/tools — list governed tools
    if (req.method === 'GET' && subPath === '/tools') {
      return send(res, 200, store.listTools(tenantId));
    }

    // GET /v1/admin/tenants/:id/health — integration health (§69)
    if (req.method === 'GET' && subPath === '/health') {
      return send(res, 200, computeIntegrationHealth(store, tenantId));
    }

    // GET /v1/admin/tenants/:id/readiness — onboarding readiness (§51)
    if (req.method === 'GET' && subPath === '/readiness') {
      return send(res, 200, assessOnboardingReadiness(store, tenantId));
    }
  }

  throw new HttpError(404, 'Route not found');
}

// -------------------------------------------------------------------------------------
// Client API route handler
// -------------------------------------------------------------------------------------

async function handleClientRoute(
  req: IncomingMessage, res: ServerResponse, path: string,
  store: ClientStore, tenantId: string, serviceId: string,
  platformFacadeFor?: (tenantId: string) => PlatformFacade,
  syncGovernedTenant?: (tenantId: string, agentId: string) => void,
): Promise<void> {
  // POST /v1/client/actions — submit action (§35)
  if (req.method === 'POST' && path === '/v1/client/actions') {
    const raw = await body(req);
    if (!isPlainObject(raw)) throw new HttpError(400, 'Action body must be an object');
    const obj = raw as Record<string, unknown>;

    // §37: tenant_id comes from the authenticated identity, NEVER from request body
    store.assertActionEligible(tenantId);

    // Build a client action record
    const clientActionId = `cact_${randomUUID()}`;
    const configSnapshotHash = store.computeIntegrationConfigHash(tenantId);
    const now = new Date().toISOString();

    // Determine the governed tool if specified
    const toolId = typeof obj.tool_id === 'string' ? obj.tool_id : null;
    let mcpServerId: string | null = null;
    let platformToolId: string | null = null;

    if (toolId) {
      const tool = store.getTool(tenantId, toolId);
      if (!tool.enabled) throw new ClientError('TOOL_NOT_ENABLED', `Tool ${toolId} is not enabled`);
      if (tool.review_status === 'POLICY_REVIEW_REQUIRED') throw new ClientError('TOOL_POLICY_REVIEW_REQUIRED', `Tool ${toolId} requires policy review`);
      mcpServerId = tool.provider_id;
      platformToolId = toolPlatformId(tool.tool_id);
    }

    store.recordClientAction({
      tenant_id: tenantId,
      client_action_id: clientActionId,
      service_id: serviceId,
      mcp_server_id: mcpServerId,
      governed_tool_id: toolId,
      config_snapshot_hash: configSnapshotHash,
      created_at: now,
    });

    // If a platformFacadeFor resolver is wired, flow through the full governed platform path
    // (TNA-64: this is the ONLY path that ever runs Gate/Capability/Sentinel/MCP — there is no
    // fallback from here to the record-only branch below within a single request).
    if (platformFacadeFor && platformToolId) {
      // §37: the agent identity Gate authorizes is the authenticated service identity itself — a
      // caller cannot request a different agent_id and have Gate evaluate a different authority (this
      // also matches the identity `syncGovernedTenant` registers/binds an envelope to, immediately
      // below). Deliberately the bare `service_id` (already `svc_<uuid>`, globally unique) rather than
      // a `client:`-prefixed variant: Gate's own envelope schema validates `agent.id` against
      // `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`, which rejects a colon — a real defect this closure pass
      // found by actually submitting through the packaged HTTP binary (every governed request failed
      // Gate authorization with a schema-validation error until this was fixed).
      const agentId = serviceId;
      const requestId = typeof obj.request_id === 'string' ? obj.request_id : clientActionId;
      const platformRequest: Record<string, unknown> = {
        version: '1.0',
        request_id: requestId,
        tenant_id: tenantId,
        agent_id: agentId,
        action: typeof obj.action === 'string' ? obj.action : `${platformToolId}.execute`,
        tool: platformToolId,
        operation: typeof obj.operation === 'string' ? obj.operation : 'read',
        resource: typeof obj.resource === 'string' ? obj.resource : '*',
        input: isPlainObject(obj.input) ? obj.input : {},
        requires_verification: obj.requires_verification === true,
        // §correlation preservation: the client_action_id is the one caller-visible anchor minted
        // before the platform ever sees this request — threading it through metadata means Ledger
        // evidence (via the platform's own request snapshot) can always be traced back to the exact
        // client_actions row that originated it, without inventing a second, competing correlation id.
        metadata: {
          ...(isPlainObject(obj.metadata) ? obj.metadata : {}),
          client_action_id: clientActionId, client_service_id: serviceId,
          ...(mcpServerId ? { mcp_server_id: mcpServerId } : {}),
          ...(toolId ? { governed_tool_id: toolId } : {}),
        },
      };
      try {
        syncGovernedTenant?.(tenantId, agentId);
        const facade = platformFacadeFor(tenantId);
        const principal: PlatformPrincipal = agentPrincipal(agentId, tenantId, agentId);
        const action = await facade.submitAndRun(principal, platformRequest, `client:${serviceId}`);
        return send(res, 201, {
          client_action_id: clientActionId,
          platform_action_id: action.platform_action_id,
          correlation_id: action.correlation_id,
          state: action.state,
          config_snapshot_hash: configSnapshotHash,
        });
      } catch (error) {
        // Still return the client action record on platform failure
        return send(res, 201, {
          client_action_id: clientActionId,
          platform_error: error instanceof Error ? error.message : 'Platform execution failed',
          state: 'FAILED',
          config_snapshot_hash: configSnapshotHash,
        });
      }
    }

    // Record-only mode (TNA-64): reachable ONLY when the server was explicitly constructed without a
    // platformFacadeFor — never a silent fallback from the governed branch above. This response is
    // deliberately never labeled COMPLETED/ALLOW/anything execution-shaped: `state: 'RECORDED'`
    // provides no governed execution assurance whatsoever (no Gate, no Capability, no Sentinel, no MCP
    // call ever occurs on this path) and must never be mistaken for the governed result.
    return send(res, 201, {
      client_action_id: clientActionId,
      state: 'RECORDED',
      config_snapshot_hash: configSnapshotHash,
    });
  }

  // GET /v1/client/actions/:id — get action status
  const actionMatch = /^\/v1\/client\/actions\/([A-Za-z0-9._:-]+)(\/.*)?$/.exec(path);
  if (actionMatch?.[1]) {
    const actionId = actionMatch[1];
    const actionSubPath = actionMatch[2] ?? '';

    if (req.method === 'GET' && actionSubPath === '') {
      const record = store.getClientAction(tenantId, actionId);
      if (!record) throw new ClientError('NOT_FOUND', `No action ${actionId}`);
      return send(res, 200, record);
    }

    // GET /v1/client/actions/:id/evidence
    if (req.method === 'GET' && actionSubPath === '/evidence') {
      const record = store.getClientAction(tenantId, actionId);
      if (!record) throw new ClientError('NOT_FOUND', `No action ${actionId}`);
      return send(res, 200, {
        client_action_id: record.client_action_id,
        config_snapshot_hash: record.config_snapshot_hash,
        tenant_id: tenantId,
      });
    }
  }

  throw new HttpError(404, 'Route not found');
}
