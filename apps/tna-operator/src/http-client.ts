/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Thin, real HTTP clients over the
 * ALREADY-ACCEPTED admin/operator surfaces of `apps/tna-platform` and `apps/tna-client-gateway`. Section
 * 7: the operator CLI performs no direct database access anywhere — every read and every mutation goes
 * through one of these two clients, which in turn call only routes those apps' own accepted `server.ts`
 * files already expose.
 */

export class OperatorHttpError extends Error {
  public constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
    this.name = 'OperatorHttpError';
  }
}

async function request(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
      ? String((parsed as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new OperatorHttpError(res.status, message, parsed);
  }
  return parsed;
}

export class PlatformClient {
  public constructor(private readonly baseUrl: string, private readonly token: string) {}
  public ready(): Promise<unknown> { return fetch(`${this.baseUrl}/ready`).then(r => r.json()); }
  public live(): Promise<unknown> { return fetch(`${this.baseUrl}/live`).then(r => r.json()); }
  public diagnostics(): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', '/diagnostics'); }
  public deadLetters(): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', '/v1/platform/outbox/dead-letters'); }
  public listActions(params: { limit?: number; cursor?: string } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    const qs = query.toString();
    return request(this.baseUrl, this.token, 'GET', `/v1/platform/actions${qs ? `?${qs}` : ''}`);
  }
  public getAction(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/platform/actions/${id}`); }
  public getEvidence(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/platform/actions/${id}/evidence`); }
  public approve(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/platform/actions/${id}/approve`); }
  public terminate(id: string, reason: string): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/platform/actions/${id}/terminate`, { reason }); }
  public audit(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/platform/actions/${id}/audit`); }
}

export class ClientGatewayClient {
  public constructor(private readonly baseUrl: string, private readonly token: string) {}
  public ready(): Promise<unknown> { return fetch(`${this.baseUrl}/ready`).then(r => r.json()); }
  public listTenants(): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', '/v1/admin/tenants'); }
  public getTenant(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/admin/tenants/${id}`); }
  public createTenant(input: unknown): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', '/v1/admin/tenants', input); }
  public activateTenant(id: string, stateVersion: number): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/admin/tenants/${id}/activate`, { state_version: stateVersion }); }
  public suspendTenant(id: string, stateVersion: number, reason: string): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/admin/tenants/${id}/suspend`, { state_version: stateVersion, reason }); }
  public offboardTenant(id: string, stateVersion: number, reason: string): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/admin/tenants/${id}/offboard`, { state_version: stateVersion, reason }); }
  public listServices(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/admin/tenants/${id}/services`); }
  public createService(id: string, input: unknown): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/admin/tenants/${id}/services`, input); }
  public rotateService(tenantId: string, serviceId: string, stateVersion: number): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/admin/tenants/${tenantId}/services/${serviceId}/rotate`, { state_version: stateVersion }); }
  public revokeService(tenantId: string, serviceId: string, stateVersion: number): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/admin/tenants/${tenantId}/services/${serviceId}/revoke`, { state_version: stateVersion }); }
  public listMcpServers(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/admin/tenants/${id}/mcp-servers`); }
  public registerMcpServer(id: string, input: unknown): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/admin/tenants/${id}/mcp-servers`, input); }
  public discoverMcp(tenantId: string, serverId: string): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/admin/tenants/${tenantId}/mcp-servers/${serverId}/discover`, {}); }
  public listTools(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/admin/tenants/${id}/tools`); }
  public enableTool(tenantId: string, toolId: string, input: unknown): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/admin/tenants/${tenantId}/tools/${toolId}/enable`, input); }
  public disableTool(tenantId: string, toolId: string, stateVersion: number): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/admin/tenants/${tenantId}/tools/${toolId}/disable`, { state_version: stateVersion }); }
  public health(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/admin/tenants/${id}/health`); }
  public readiness(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/admin/tenants/${id}/readiness`); }
}

/** TNA Recursive Improvement Governance v0.1 (Volume 12), section L: a thin HTTP client over the real
 * packaged governor's API — the CLI never manipulates `ImprovementStore` directly. */
export class ImprovementGovernorClient {
  public constructor(private readonly baseUrl: string, private readonly token: string) {}
  public ready(): Promise<unknown> { return fetch(`${this.baseUrl}/ready`).then(r => r.json()); }
  public propose(input: unknown): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', '/v1/improvements', input); }
  public list(systemId: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/improvements?systemId=${encodeURIComponent(systemId)}`); }
  public show(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/improvements/${id}`); }
  public authorize(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/improvements/${id}/authorize`); }
  public build(id: string, input: unknown): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/improvements/${id}/build`, input); }
  public evaluate(id: string, input: unknown): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/improvements/${id}/evaluate`, input); }
  public approve(id: string, input: unknown): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/improvements/${id}/approve`, input); }
  public canary(id: string, input: unknown): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/improvements/${id}/canary`, input); }
  public promote(id: string, input: unknown): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/improvements/${id}/promote`, input); }
  public rollback(id: string, input: unknown): Promise<unknown> { return request(this.baseUrl, this.token, 'POST', `/v1/improvements/${id}/rollback`, input); }
  public evidence(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/improvements/${id}/evidence`); }
  public lineage(id: string): Promise<unknown> { return request(this.baseUrl, this.token, 'GET', `/v1/improvements/${id}/lineage`); }
}
