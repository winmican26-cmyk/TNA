import { ControlCenterError, type TenantRegistryEntry } from './schema.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). A real, thin HTTP client to the tenant's own
 * real `apps/tna-improvement-governor` instance (single-tenant-per-process, mirrors Platform/Ledger/
 * Auditor). The flagship demonstration of TNA's central claim — "a successor can become better without
 * automatically becoming more powerful" — must be rendered from THIS client's real responses, never from a
 * value invented in the frontend: every generation's status, benchmark delta, authority delta, and
 * holdout/canary result comes straight from the governor's own `ImprovementStore`/Ledger-backed state.
 */

async function request<T>(entry: TenantRegistryEntry, method: string, path: string, bodyObj?: unknown): Promise<T> {
  if (!entry.improvement_base_url || !entry.improvement_admin_token) throw new ControlCenterError('NOT_CONFIGURED', 'Recursive-improvement integration is not configured for this tenant');
  const res = await fetch(`${entry.improvement_base_url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${entry.improvement_admin_token}`, 'Content-Type': 'application/json' },
    ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
  });
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed ? String((parsed as { error: unknown }).error) : `Improvement Governor HTTP ${res.status}`;
    throw new ControlCenterError(res.status === 404 ? 'NOT_FOUND' : res.status === 409 ? 'CONFLICT' : 'UPSTREAM_ERROR', message);
  }
  return parsed as T;
}

export class ImprovementGovernorProxyClient {
  public listGenerations(entry: TenantRegistryEntry, systemId: string, limit?: number): Promise<unknown> {
    const qs = new URLSearchParams({ systemId });
    if (limit) qs.set('limit', String(limit));
    return request(entry, 'GET', `/v1/improvements?${qs.toString()}`);
  }
  public getGeneration(entry: TenantRegistryEntry, generationId: string): Promise<unknown> {
    return request(entry, 'GET', `/v1/improvements/${generationId}`);
  }
  /** Real reconstructed evidence (Gate/Sentinel/Ledger, section-J assessment) for one generation — never a
   * value asserted independently of what actually happened. */
  public getEvidence(entry: TenantRegistryEntry, generationId: string): Promise<unknown> {
    return request(entry, 'GET', `/v1/improvements/${generationId}/evidence`);
  }
  /** Real, Ledger-reconstructed lineage across an entire system's generations — this is what renders the
   * flagship Gen N-1 -> Gen N -> Gen N+1 lineage view. */
  public getLineage(entry: TenantRegistryEntry, generationId: string): Promise<unknown> {
    return request(entry, 'GET', `/v1/improvements/${generationId}/lineage`);
  }
  /** Mutations — gated server-side by `improvement.approve`/`.promote`/`.rollback` (client-admin only). The
   * governor's own Gate authorization is still the actual authority; this BFF never bypasses it. */
  public approve(entry: TenantRegistryEntry, generationId: string, operation: string, approverRole?: string): Promise<unknown> {
    return request(entry, 'POST', `/v1/improvements/${generationId}/approve`, { operation, ...(approverRole ? { approverRole } : {}) });
  }
  public promote(entry: TenantRegistryEntry, generationId: string, approvalId?: string): Promise<unknown> {
    return request(entry, 'POST', `/v1/improvements/${generationId}/promote`, approvalId ? { approvalId } : {});
  }
  public rollback(entry: TenantRegistryEntry, generationId: string, targetGenerationId: string, approvalId?: string, trigger?: string): Promise<unknown> {
    return request(entry, 'POST', `/v1/improvements/${generationId}/rollback`, { targetGenerationId, ...(approvalId ? { approvalId } : {}), ...(trigger ? { trigger } : {}) });
  }
}
