import assert from 'node:assert/strict';
import test from 'node:test';
import { startRealPlatform, startRealLedger, seedLedgerEvent, startControlCenter, CookieJar } from './harness.js';
import { CSRF_COOKIE } from '../../apps/tna-control-center/src/auth.js';
import type { TenantRegistryEntry } from '../../apps/tna-control-center/src/schema.js';
import { computeIncidents } from '../../apps/tna-control-center/src/incidents.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) — Incidents. No accepted backend has a real
 * Incident store, so this is a live, evidence-backed aggregation over real signals already fetched
 * elsewhere in the Control Center (see `incidents.ts`'s own honest scope note). These tests prove: (1) the
 * pure aggregation/severity function is deterministic and backend-owned (never delegated to the frontend),
 * and (2) the real `/api/incidents` route surfaces a real signal (an INDETERMINATE action) end-to-end, and
 * that acknowledgment is real, persisted, per-tenant Control-Center-local state — never a claim about the
 * underlying condition itself.
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return jar;
}

test('computeIncidents: severity is a deterministic, table-driven mapping — never an ad hoc per-caller choice', () => {
  const incidents = computeIncidents({
    components: [{ component: 'gate', status: 'UNAVAILABLE', mandatory: true }, { component: 'metrics', status: 'DEGRADED', mandatory: false }],
    tools: [{ tool_id: 't1', external_tool_name: 'search', review_status: 'POLICY_REVIEW_REQUIRED' }],
    connections: [{ mcp_server_id: 'mcp1', name: 'files', status: 'UNREACHABLE' }],
    actions: [{ platform_action_id: 'a1', state: 'INDETERMINATE' }],
    ledgerVerification: { valid: false, invalidStreams: 2 },
  });
  const bySignature = new Map(incidents.map(i => [i.signature, i]));
  assert.equal(bySignature.get('component:gate:UNAVAILABLE')?.severity, 'CRITICAL', 'a mandatory component being UNAVAILABLE is the most severe real condition');
  assert.equal(bySignature.get('component:metrics:DEGRADED')?.severity, 'LOW', 'an optional, merely-degraded component is real but low severity');
  assert.equal(bySignature.get('schema-drift:t1')?.severity, 'MEDIUM');
  assert.equal(bySignature.get('connection:mcp1:unreachable')?.severity, 'HIGH');
  assert.equal(bySignature.get('action:a1:indeterminate')?.severity, 'HIGH');
  assert.equal(bySignature.get('ledger:integrity')?.severity, 'CRITICAL');
  // Sorted most-severe first — never an arbitrary or frontend-decided order.
  assert.equal(incidents[0]!.severity, 'CRITICAL');
});

test('computeIncidents: a fully healthy real system produces zero incidents — never a fabricated one', () => {
  const incidents = computeIncidents({
    components: [{ component: 'gate', status: 'AVAILABLE', mandatory: true }],
    tools: [{ tool_id: 't1', external_tool_name: 'search', review_status: 'ENABLED' }],
    connections: [{ mcp_server_id: 'mcp1', name: 'files', status: 'REACHABLE' }],
    actions: [{ platform_action_id: 'a1', state: 'COMPLETED' }],
    ledgerVerification: { valid: true, invalidStreams: 0 },
  });
  assert.deepEqual(incidents, []);
});

test('incidents: real Ledger corruption is surfaced end-to-end through the real BFF route, and acknowledgment is real, persisted, per-tenant state', async () => {
  const tenantId = 'ten_incidents_1';
  const platform = await startRealPlatform(tenantId, 'incidents_1');
  const ledger = await startRealLedger(tenantId, 'incidents_1');
  const entry: TenantRegistryEntry = {
    tenant_id: tenantId, platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken,
    ledger_base_url: ledger.baseUrl, ledger_reader_token: ledger.readerToken, ledger_admin_token: ledger.adminToken,
  };
  const cc = await startControlCenter([entry]);
  try {
    seedLedgerEvent(ledger, tenantId, { event_id: 'evt-inc-1', stream_id: 'agent:incidents' });
    const raw = ledger.ledgerStore as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } };
    raw.db.prepare("UPDATE ledger_events SET event_type = 'TAMPERED_EVENT_TYPE' WHERE stream_id = 'agent:incidents'").run();

    cc.sessions.createUser(tenantId, 'incident-viewer', 'a-real-password-for-incidents-1', 'client-viewer');
    const jar = await login(cc.baseUrl, 'incident-viewer', 'a-real-password-for-incidents-1');
    const res = await fetch(`${cc.baseUrl}/api/incidents`, { headers: { Cookie: jar.header() } });
    assert.equal(res.status, 200);
    const body = await res.json() as { items: readonly { signature: string; type: string; acknowledgment: unknown }[] };
    const ledgerIncident = body.items.find(i => i.type === 'LEDGER_INTEGRITY');
    assert.ok(ledgerIncident, 'the real tampered stream must surface as a real LEDGER_INTEGRITY incident');
    assert.equal(ledgerIncident!.acknowledgment, null, 'an unacknowledged incident must show a null acknowledgment, never a fabricated one');

    // client-viewer holds `incident.acknowledge`? No — only client-auditor/client-admin do per the matrix;
    // client-viewer must be refused server-side.
    const csrfHeaders = { 'Content-Type': 'application/json', Cookie: jar.header(), 'X-CSRF-Token': jar.get(CSRF_COOKIE)! };
    const deniedAck = await fetch(`${cc.baseUrl}/api/incidents/${encodeURIComponent(ledgerIncident!.signature)}/acknowledge`, { method: 'POST', headers: csrfHeaders });
    assert.equal(deniedAck.status, 403);

    cc.sessions.createUser(tenantId, 'incident-auditor', 'a-real-password-for-incidents-2', 'client-auditor');
    const auditorJar = await login(cc.baseUrl, 'incident-auditor', 'a-real-password-for-incidents-2');
    const auditorCsrf = { 'Content-Type': 'application/json', Cookie: auditorJar.header(), 'X-CSRF-Token': auditorJar.get(CSRF_COOKIE)! };
    const ackRes = await fetch(`${cc.baseUrl}/api/incidents/${encodeURIComponent(ledgerIncident!.signature)}/acknowledge`, { method: 'POST', headers: auditorCsrf });
    assert.equal(ackRes.status, 200);

    const res2 = await fetch(`${cc.baseUrl}/api/incidents`, { headers: { Cookie: jar.header() } });
    const body2 = await res2.json() as { items: readonly { signature: string; acknowledgment: { acknowledged_by: string } | null }[] };
    const ledgerIncident2 = body2.items.find(i => i.signature === ledgerIncident!.signature);
    assert.ok(ledgerIncident2, 'the real, still-corrupt Ledger condition must still be surfaced after acknowledgment — acknowledging is not the same as the condition being resolved');
    assert.ok(ledgerIncident2!.acknowledgment, 'the acknowledgment must now be real, persisted state');
  } finally { await cc.close(); await ledger.close(); await platform.close(); }
});
