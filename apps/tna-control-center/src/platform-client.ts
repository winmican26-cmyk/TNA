import { ControlCenterError, type TenantRegistryEntry } from './schema.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). A real, thin HTTP client to the tenant's own
 * `apps/tna-platform` instance — the accepted, unmodified backend service. Every method here is a real
 * `fetch` call; nothing in this file computes, caches, or asserts a security-relevant fact itself. Mirrors
 * `apps/tna-operator/src/http-client.ts`'s `PlatformClient` pattern exactly (same project, same
 * discipline: the operator console and the Control Center both stay thin over the same real backend).
 */

async function request(entry: TenantRegistryEntry, method: string, path: string, token: string = entry.platform_token, jsonBody?: unknown): Promise<unknown> {
  const res = await fetch(`${entry.platform_base_url}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
  });
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed ? String((parsed as { error: unknown }).error) : `Platform HTTP ${res.status}`;
    throw new ControlCenterError(res.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_ERROR', message);
  }
  return parsed;
}

export interface ActionListParams { readonly limit?: number; readonly cursor?: string }

export class PlatformProxyClient {
  public listActions(entry: TenantRegistryEntry, params: ActionListParams = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    const qs = query.toString();
    return request(entry, 'GET', `/v1/platform/actions${qs ? `?${qs}` : ''}`);
  }
  public getAction(entry: TenantRegistryEntry, actionId: string): Promise<unknown> {
    return request(entry, 'GET', `/v1/platform/actions/${encodeURIComponent(actionId)}`);
  }
  public getActionEvidence(entry: TenantRegistryEntry, actionId: string): Promise<unknown> {
    return request(entry, 'GET', `/v1/platform/actions/${encodeURIComponent(actionId)}/evidence`);
  }
  public diagnostics(entry: TenantRegistryEntry): Promise<unknown> {
    return request(entry, 'GET', '/diagnostics');
  }
  /** Section 14/16/17: approval — always issued with the tenant's OPERATOR token, never the plain agent
   * token, and Platform's own accepted `PlatformControlOrchestrator.resume()` independently re-enforces
   * that only an operator/admin principal may call this regardless of what this proxy sends. */
  public approveAction(entry: TenantRegistryEntry, actionId: string): Promise<unknown> {
    return request(entry, 'POST', `/v1/platform/actions/${encodeURIComponent(actionId)}/approve`, entry.platform_operator_token, {});
  }
  public terminateAction(entry: TenantRegistryEntry, actionId: string, reason: string): Promise<unknown> {
    return request(entry, 'POST', `/v1/platform/actions/${encodeURIComponent(actionId)}/terminate`, entry.platform_operator_token, { reason });
  }
  public ready(entry: TenantRegistryEntry): Promise<{ status: string } & Record<string, unknown>> {
    return fetch(`${entry.platform_base_url}/ready`).then(r => r.json()) as Promise<{ status: string } & Record<string, unknown>>;
  }
}
