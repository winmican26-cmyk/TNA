import { ControlCenterError } from './schema.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). A real, thin HTTP client to the accepted,
 * unmodified `apps/tna-client-gateway` ADMIN API. Unlike `apps/tna-platform` (one real process per
 * tenant), Client Gateway is genuinely multi-tenant — one real process serves every tenant, addressed by
 * a `:tenantId` PATH segment under `/v1/admin/tenants/...`. There is therefore exactly ONE Client Gateway
 * base URL / admin token for the whole Control Center deployment (`ControlCenterConfig.clientGateway`),
 * never a per-tenant registry entry — the tenant scoping happens entirely in the PATH segment, which this
 * client always sets from the caller-supplied `tenantId` parameter, which every route handler in
 * `server.ts` sources exclusively from `session.tenant_id` — never from a request.
 *
 * This client is ALSO the authoritative source of real tenant lifecycle status
 * (PENDING/ACTIVE/SUSPENDED/OFFBOARDING/OFFBOARDED) — see `server.ts`'s `tenantEntry()`, which queries
 * `getTenant()` on every request to reconcile against Volume 10's real `ClientStore` record rather than
 * trusting a Control-Center-local flag (foundation-review item A).
 */

export interface ClientGatewayConfig {
  readonly baseUrl: string;
  readonly adminToken: string;
}

async function request<T>(config: ClientGatewayConfig, method: string, path: string, jsonBody?: unknown): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method, headers: { Authorization: `Bearer ${config.adminToken}`, ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
  });
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed ? String((parsed as { error: unknown }).error) : `Client Gateway HTTP ${res.status}`;
    const code = parsed && typeof parsed === 'object' && parsed !== null && 'code' in parsed ? String((parsed as { code: unknown }).code) : undefined;
    throw new ControlCenterError(res.status === 404 ? 'NOT_FOUND' : (code ?? 'UPSTREAM_ERROR'), message);
  }
  return parsed as T;
}

const t = (tenantId: string) => `/v1/admin/tenants/${encodeURIComponent(tenantId)}`;

export class ClientGatewayProxyClient {
  public getTenant(config: ClientGatewayConfig, tenantId: string): Promise<Record<string, unknown>> {
    return request(config, 'GET', t(tenantId));
  }
  public getHealth(config: ClientGatewayConfig, tenantId: string): Promise<Record<string, unknown>> {
    return request(config, 'GET', `${t(tenantId)}/health`);
  }
  public getReadiness(config: ClientGatewayConfig, tenantId: string): Promise<Record<string, unknown>> {
    return request(config, 'GET', `${t(tenantId)}/readiness`);
  }
  public listMcpServers(config: ClientGatewayConfig, tenantId: string): Promise<readonly Record<string, unknown>[]> {
    return request(config, 'GET', `${t(tenantId)}/mcp-servers`);
  }
  public listTools(config: ClientGatewayConfig, tenantId: string): Promise<readonly Record<string, unknown>[]> {
    return request(config, 'GET', `${t(tenantId)}/tools`);
  }
  public enableTool(config: ClientGatewayConfig, tenantId: string, toolId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return request(config, 'POST', `${t(tenantId)}/tools/${encodeURIComponent(toolId)}/enable`, input);
  }
  public disableTool(config: ClientGatewayConfig, tenantId: string, toolId: string, stateVersion: number): Promise<Record<string, unknown>> {
    return request(config, 'POST', `${t(tenantId)}/tools/${encodeURIComponent(toolId)}/disable`, { state_version: stateVersion });
  }
  public listServiceIdentities(config: ClientGatewayConfig, tenantId: string): Promise<{ items: readonly Record<string, unknown>[] }> {
    return request(config, 'GET', `${t(tenantId)}/services`);
  }
  public createServiceIdentity(config: ClientGatewayConfig, tenantId: string, name: string, role: string): Promise<Record<string, unknown>> {
    return request(config, 'POST', `${t(tenantId)}/services`, { name, role });
  }
  public rotateCredential(config: ClientGatewayConfig, tenantId: string, serviceId: string, stateVersion: number): Promise<Record<string, unknown>> {
    return request(config, 'POST', `${t(tenantId)}/services/${encodeURIComponent(serviceId)}/rotate`, { state_version: stateVersion });
  }
  public revokeServiceIdentity(config: ClientGatewayConfig, tenantId: string, serviceId: string, stateVersion: number): Promise<Record<string, unknown>> {
    return request(config, 'POST', `${t(tenantId)}/services/${encodeURIComponent(serviceId)}/revoke`, { state_version: stateVersion });
  }
}
