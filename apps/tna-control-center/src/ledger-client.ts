import { ControlCenterError, type TenantRegistryEntry } from './schema.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). A real, thin, READ-ONLY HTTP client to the
 * tenant's own real `apps/tna-ledger` instance (single-tenant-per-process, mirrors Platform). Only ever
 * uses the reader-scoped token — this Control Center never writes to the Ledger directly (it has no
 * authority to append events; that remains exclusively the trusted writers — Gate/VAD/Platform/etc.).
 */

async function request<T>(entry: TenantRegistryEntry, path: string, token: string | undefined = entry.ledger_reader_token): Promise<T> {
  if (!entry.ledger_base_url || !token) throw new ControlCenterError('NOT_CONFIGURED', 'Ledger integration is not configured for this tenant');
  const res = await fetch(`${entry.ledger_base_url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed ? String((parsed as { error: unknown }).error) : `Ledger HTTP ${res.status}`;
    throw new ControlCenterError(res.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_ERROR', message);
  }
  return parsed as T;
}

export interface LedgerSearchParams { readonly correlationId?: string; readonly streamId?: string; readonly eventType?: string; readonly limit?: number; readonly cursor?: string }

export class LedgerProxyClient {
  public search(entry: TenantRegistryEntry, params: LedgerSearchParams): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params.correlationId) qs.set('correlationId', params.correlationId);
    if (params.streamId) qs.set('streamId', params.streamId);
    if (params.eventType) qs.set('eventType', params.eventType);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    return request(entry, `/v1/ledger/search?${qs.toString()}`);
  }
  // Ledger's own real route matcher (`apps/tna-ledger/src/server.ts`) restricts stream/event ids to the
  // literal character class `[A-Za-z0-9._:-]` and matches path segments RAW — it does not itself decode
  // percent-encoding. Since that class already excludes every character that would need URL-escaping,
  // `encodeURIComponent` must NOT be applied here: doing so would turn a legal, unencoded `:` into a
  // literal `%3A` in the outgoing request, which Ledger's own regex then fails to match (a real bug found
  // and fixed while building this integration — colons are routine in real stream ids, e.g. `agent:a1`,
  // `improvement:gen_...`). The BFF's OWN inbound route already decodes its path segment exactly once
  // (`server.ts`); this client passes that already-decoded, already-safe id straight through.
  public getStream(entry: TenantRegistryEntry, streamId: string, limit?: number, cursor?: string): Promise<unknown> {
    const qs = new URLSearchParams();
    if (limit) qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    const q = qs.toString();
    return request(entry, `/v1/ledger/streams/${streamId}${q ? `?${q}` : ''}`);
  }
  /** Real cryptographic hash-chain verification of one stream — never a fabricated "VERIFIED". */
  public verifyStream(entry: TenantRegistryEntry, streamId: string): Promise<unknown> {
    return request(entry, `/v1/ledger/streams/${streamId}/verify`);
  }
  /** Real, whole-ledger integrity verification — the authoritative source for the assurance panel's
   * Ledger row (VERIFIED/DEGRADED/CORRUPT), never a hardcoded value. Requires the ADMIN-scoped Ledger
   * token (`Ledger.verifyAll()` itself calls `assertIsAdmin` — the reader token is insufficient). */
  public verifyAll(entry: TenantRegistryEntry): Promise<unknown> {
    return request(entry, '/v1/ledger/verify', entry.ledger_admin_token);
  }
  public getEvent(entry: TenantRegistryEntry, eventId: string): Promise<unknown> {
    return request(entry, `/v1/ledger/events/${eventId}`);
  }
}
