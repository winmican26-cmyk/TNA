import assert from 'node:assert/strict';
import test from 'node:test';
import { startRealPlatform, submitAction, startControlCenter, CookieJar } from './harness.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), section 64-65. Two REAL, fully separate
 * Platform instances (tenant A, tenant B — each its own real in-memory Gate/Sentinel/Ledger/store stack,
 * exactly mirroring how two real customers are actually deployed in this project), registered under two
 * distinct tenant ids in one real Control Center. A session belongs to exactly one tenant; this proves
 * that tenant is the ONLY tenant whose data that session can ever reach — not merely that the UI hides a
 * link, but that the HTTP layer itself has no code path to the other tenant's real backend.
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return jar;
}

test('tenant isolation: a session bound to tenant A can only ever see tenant A actions, never tenant B\'s, even by guessing a real tenant-B action id', async () => {
  const platformA = await startRealPlatform('ten_a', 'a');
  const platformB = await startRealPlatform('ten_b', 'b');
  try {
    const seededA = await submitAction(platformA, 'req_a_1', {}, 'ten_a');
    const seededB = await submitAction(platformB, 'req_b_1', {}, 'ten_b');
    assert.equal(seededA.status, 201); assert.equal(seededB.status, 201);
    const actionIdA = seededA.body.platform_action_id as string;
    const actionIdB = seededB.body.platform_action_id as string;

    const cc = await startControlCenter([
      { tenant_id: 'ten_a', platform_base_url: platformA.baseUrl, platform_token: platformA.agentToken, platform_operator_token: platformA.operatorToken },
      { tenant_id: 'ten_b', platform_base_url: platformB.baseUrl, platform_token: platformB.agentToken, platform_operator_token: platformB.operatorToken },
    ]);
    try {
      cc.sessions.createUser('ten_a', 'user-a', 'password-for-tenant-a-user', 'client-viewer');
      const jarA = await login(cc.baseUrl, 'user-a', 'password-for-tenant-a-user');

      // Tenant A's own action: reachable.
      const own = await fetch(`${cc.baseUrl}/api/actions/${actionIdA}`, { headers: { Cookie: jarA.header() } });
      assert.equal(own.status, 200);

      // Tenant B's real, existing action id, requested by a tenant-A session: must NOT be reachable —
      // proven by the fact that tenant A's own registered backend (the only one this session can ever
      // reach) genuinely has no row with tenant B's action id.
      const crossTenant = await fetch(`${cc.baseUrl}/api/actions/${actionIdB}`, { headers: { Cookie: jarA.header() } });
      assert.equal(crossTenant.status, 404, 'a tenant-A session must never resolve a real tenant-B action id — there is no code path to tenant B\'s backend at all for this session');

      // The action list itself never contains tenant B's action either.
      const list = await fetch(`${cc.baseUrl}/api/actions?limit=50`, { headers: { Cookie: jarA.header() } });
      const listBody = await list.json() as { items: readonly { platform_action_id: string }[] };
      assert.ok(!listBody.items.some(a => a.platform_action_id === actionIdB), 'tenant A\'s action list must never contain a tenant B action');
    } finally { await cc.close(); }
  } finally { await platformA.close(); await platformB.close(); }
});

test('tenant isolation: URL tampering on the dashboard cannot be used to select a different tenant (tenant is never a request parameter)', async () => {
  const platformA = await startRealPlatform('ten_a2', 'a2');
  const platformB = await startRealPlatform('ten_b2', 'b2');
  try {
    await submitAction(platformA, 'req_a2_1', {}, 'ten_a2');
    await submitAction(platformB, 'req_b2_1', {}, 'ten_b2');
    const cc = await startControlCenter([
      { tenant_id: 'ten_a2', platform_base_url: platformA.baseUrl, platform_token: platformA.agentToken, platform_operator_token: platformA.operatorToken },
      { tenant_id: 'ten_b2', platform_base_url: platformB.baseUrl, platform_token: platformB.agentToken, platform_operator_token: platformB.operatorToken },
    ]);
    try {
      cc.sessions.createUser('ten_a2', 'user-a2', 'password-for-tenant-a2-user', 'client-viewer');
      const jarA = await login(cc.baseUrl, 'user-a2', 'password-for-tenant-a2-user');
      // There is deliberately no `?tenantId=` (or any other) parameter this route reads at all — proven
      // by requesting one and confirming the response still reflects only tenant A2's own real data.
      const res = await fetch(`${cc.baseUrl}/api/dashboard?tenantId=ten_b2`, { headers: { Cookie: jarA.header() } });
      assert.equal(res.status, 200);
      const dashboard = await res.json() as { total_known_actions: number };
      assert.equal(dashboard.total_known_actions, 1, 'exactly tenant A2\'s own one seeded action — a tenantId query parameter must have no effect');
    } finally { await cc.close(); }
  } finally { await platformA.close(); await platformB.close(); }
});

test('tenant isolation: a session for a tenant with no registered backend fails closed, never falls back to another tenant\'s backend', async () => {
  const platformA = await startRealPlatform('ten_a3', 'a3');
  try {
    const cc = await startControlCenter([{ tenant_id: 'ten_a3', platform_base_url: platformA.baseUrl, platform_token: platformA.agentToken, platform_operator_token: platformA.operatorToken }]);
    try {
      cc.sessions.createUser('ten_unregistered', 'orphan-user', 'password-for-orphan-user-1', 'client-viewer');
      const jar = await login(cc.baseUrl, 'orphan-user', 'password-for-orphan-user-1');
      const res = await fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Cookie: jar.header() } });
      assert.equal(res.status, 503, 'an unregistered tenant must fail closed (503), never silently reach some other tenant\'s backend');
    } finally { await cc.close(); }
  } finally { await platformA.close(); }
});
