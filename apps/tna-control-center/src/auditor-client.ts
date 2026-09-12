import { ControlCenterError, type TenantRegistryEntry } from './schema.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). A real, thin HTTP client to the tenant's own
 * real `apps/tna-auditor` instance (single-tenant-per-process, mirrors Platform/Ledger).
 */

async function request<T>(entry: TenantRegistryEntry, path: string): Promise<T> {
  if (!entry.auditor_base_url || !entry.auditor_token) throw new ControlCenterError('NOT_CONFIGURED', 'Auditor integration is not configured for this tenant');
  const res = await fetch(`${entry.auditor_base_url}${path}`, { headers: { Authorization: `Bearer ${entry.auditor_token}` } });
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed ? String((parsed as { error: unknown }).error) : `Auditor HTTP ${res.status}`;
    throw new ControlCenterError(res.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_ERROR', message);
  }
  return parsed as T;
}

export class AuditorProxyClient {
  public listAssessments(entry: TenantRegistryEntry): Promise<unknown> {
    return request(entry, '/v1/auditor/assessments');
  }
  public getAssessment(entry: TenantRegistryEntry, assessmentId: string): Promise<unknown> {
    return request(entry, `/v1/auditor/assessments/${encodeURIComponent(assessmentId)}`);
  }
  public listResults(entry: TenantRegistryEntry, assessmentId: string): Promise<unknown> {
    return request(entry, `/v1/auditor/assessments/${encodeURIComponent(assessmentId)}/results`);
  }
  public listFindings(entry: TenantRegistryEntry, assessmentId: string): Promise<unknown> {
    return request(entry, `/v1/auditor/assessments/${encodeURIComponent(assessmentId)}/findings`);
  }
}
