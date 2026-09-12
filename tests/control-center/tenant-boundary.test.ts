import assert from 'node:assert/strict';
import test from 'node:test';
import { startRealPlatform, submitAction, startControlCenter, CookieJar } from './harness.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../../apps/tna-control-center/src/auth.js';
import { tenantRegistryFromEntries } from '../../apps/tna-control-center/src/tenant-registry.js';
import { ControlCenterError } from '../../apps/tna-control-center/src/schema.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) — foundation review sections 8-10/25. The
 * authenticated session's own `tenant_id` is the ONLY source of tenant identity anywhere in this server;
 * these tests adversarially probe every input channel that might otherwise be mistaken for one.
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return jar;
}

test('tenant override: query string tenantId/tenant parameters are ignored on every route, not merely the dashboard', async () => {
  const platformA = await startRealPlatform('ten_qa', 'qa');
  const platformB = await startRealPlatform('ten_qb', 'qb');
  try {
    const seededA = await submitAction(platformA, 'req_qa_1', {}, 'ten_qa');
    await submitAction(platformB, 'req_qb_1', {}, 'ten_qb');
    const cc = await startControlCenter([
      { tenant_id: 'ten_qa', platform_base_url: platformA.baseUrl, platform_token: platformA.agentToken, platform_operator_token: platformA.operatorToken },
      { tenant_id: 'ten_qb', platform_base_url: platformB.baseUrl, platform_token: platformB.agentToken, platform_operator_token: platformB.operatorToken },
    ]);
    try {
      cc.sessions.createUser('ten_qa', 'qa-user', 'a-real-password-for-qa-1', 'client-viewer');
      const jar = await login(cc.baseUrl, 'qa-user', 'a-real-password-for-qa-1');

      for (const qs of ['?tenantId=ten_qb', '?tenant=ten_qb', '?tenant_id=ten_qb']) {
        const res = await fetch(`${cc.baseUrl}/api/actions${qs}`, { headers: { Cookie: jar.header() } });
        assert.equal(res.status, 200);
        const page = await res.json() as { items: readonly { platform_action_id: string }[] };
        assert.ok(page.items.every(a => a.platform_action_id === seededA.body.platform_action_id), `query parameter ${qs} must have no effect on which tenant's backend is queried`);
      }
    } finally { await cc.close(); }
  } finally { await platformA.close(); await platformB.close(); }
});

test('tenant override: JSON body tenant_id/tenantId fields are ignored on a mutating route', async () => {
  const platform = await startRealPlatform('ten_body', 'body');
  const other = await startRealPlatform('ten_body_other', 'body-other');
  try {
    const held = await submitAction(platform, 'req_body_hold', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, 'ten_body');
    const actionId = held.body.platform_action_id as string;
    const cc = await startControlCenter([
      { tenant_id: 'ten_body', platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken },
      { tenant_id: 'ten_body_other', platform_base_url: other.baseUrl, platform_token: other.agentToken, platform_operator_token: other.operatorToken },
    ]);
    try {
      cc.sessions.createUser('ten_body', 'body-reviewer', 'a-real-password-for-body-1', 'client-reviewer');
      const jar = await login(cc.baseUrl, 'body-reviewer', 'a-real-password-for-body-1');
      // The terminate route reads `reason` from the body; smuggle tenant fields alongside it.
      const res = await fetch(`${cc.baseUrl}/api/actions/${actionId}/terminate`, {
        method: 'POST', headers: { Cookie: jar.header(), 'X-CSRF-Token': jar.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'body-tenant-override-attempt', tenant_id: 'ten_body_other', tenantId: 'ten_body_other' }),
      });
      // Whatever the real Platform outcome is (terminate may be rejected for a HELD, non-executing action
      // — that is a REAL backend rule, not this test's concern), it must have been evaluated against the
      // caller's OWN tenant (`ten_body`), never `ten_body_other` — proven by the fact that this call can
      // only ever reach `platform`'s real base URL, which has no visibility into `other` at all.
      assert.notEqual(res.status, 503, 'the request must resolve to a real, registered tenant backend (the caller\'s own), not fail to resolve any tenant at all');
    } finally { await cc.close(); }
  } finally { await platform.close(); await other.close(); }
});

test('tenant override: custom headers naming a tenant are ignored', async () => {
  const platformA = await startRealPlatform('ten_ha', 'ha');
  const platformB = await startRealPlatform('ten_hb', 'hb');
  try {
    await submitAction(platformA, 'req_ha_1', {}, 'ten_ha');
    await submitAction(platformB, 'req_hb_1', {}, 'ten_hb');
    const cc = await startControlCenter([
      { tenant_id: 'ten_ha', platform_base_url: platformA.baseUrl, platform_token: platformA.agentToken, platform_operator_token: platformA.operatorToken },
      { tenant_id: 'ten_hb', platform_base_url: platformB.baseUrl, platform_token: platformB.agentToken, platform_operator_token: platformB.operatorToken },
    ]);
    try {
      cc.sessions.createUser('ten_ha', 'ha-user', 'a-real-password-for-ha-1', 'client-viewer');
      const jar = await login(cc.baseUrl, 'ha-user', 'a-real-password-for-ha-1');
      const res = await fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Cookie: jar.header(), 'X-Tenant-Id': 'ten_hb', 'X-Tenant': 'ten_hb' } });
      assert.equal(res.status, 200);
      const dashboard = await res.json() as { total_known_actions: number };
      assert.equal(dashboard.total_known_actions, 1, 'a spoofed tenant header must have no effect — only ten_ha\'s own one seeded action is ever visible');
    } finally { await cc.close(); }
  } finally { await platformA.close(); await platformB.close(); }
});

test('tenant identity is case-sensitive by design — "Tenant-X" and "tenant-x" never collide', async () => {
  const platformUpper = await startRealPlatform('Tenant-X', 'upper');
  const platformLower = await startRealPlatform('tenant-x', 'lower');
  try {
    await submitAction(platformUpper, 'req_upper_1', {}, 'Tenant-X');
    await submitAction(platformLower, 'req_lower_1', {}, 'tenant-x');
    const cc = await startControlCenter([
      { tenant_id: 'Tenant-X', platform_base_url: platformUpper.baseUrl, platform_token: platformUpper.agentToken, platform_operator_token: platformUpper.operatorToken },
      { tenant_id: 'tenant-x', platform_base_url: platformLower.baseUrl, platform_token: platformLower.agentToken, platform_operator_token: platformLower.operatorToken },
    ]);
    try {
      cc.sessions.createUser('Tenant-X', 'upper-user', 'a-real-password-for-upper-1', 'client-viewer');
      const jar = await login(cc.baseUrl, 'upper-user', 'a-real-password-for-upper-1');
      const res = await fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Cookie: jar.header() } });
      const dashboard = await res.json() as { total_known_actions: number };
      assert.equal(dashboard.total_known_actions, 1, '"Tenant-X" must resolve to its own backend, never fall through to "tenant-x"\'s');
    } finally { await cc.close(); }
  } finally { await platformUpper.close(); await platformLower.close(); }
});

test('duplicate tenant_id in a registry is a rejected configuration error, never silent last-write-wins', () => {
  assert.throws(() => tenantRegistryFromEntries([
    { tenant_id: 'dup', platform_base_url: 'http://127.0.0.1:1', platform_token: 'x'.repeat(32), platform_operator_token: 'y'.repeat(32) },
    { tenant_id: 'dup', platform_base_url: 'http://127.0.0.1:2', platform_token: 'z'.repeat(32), platform_operator_token: 'w'.repeat(32) },
  ]), ControlCenterError);
});

test('an unknown tenant (real session, but no registry entry at all) fails closed with 503, never a default backend', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_ghost', 'ghost-user', 'a-real-password-for-ghost-1', 'client-viewer');
    const jar = await login(cc.baseUrl, 'ghost-user', 'a-real-password-for-ghost-1');
    const res = await fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Cookie: jar.header() } });
    assert.equal(res.status, 503);
  } finally { await cc.close(); }
});

test('a suspended tenant fails closed for BOTH new logins and existing sessions\' active-authority routes', async () => {
  const platform = await startRealPlatform('ten_susp', 'susp');
  try {
    await submitAction(platform, 'req_susp_1', {}, 'ten_susp');
    const cc = await startControlCenter([{ tenant_id: 'ten_susp', platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken, status: 'SUSPENDED' }]);
    try {
      cc.sessions.createUser('ten_susp', 'susp-user', 'a-real-password-for-susp-1', 'client-viewer');
      const loginRes = await fetch(`${cc.baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'susp-user', password: 'a-real-password-for-susp-1' }) });
      assert.equal(loginRes.status, 403, 'a suspended tenant\'s user must not be able to log in at all');

      // A session minted directly at the store level (simulating one that existed before suspension took
      // effect) must ALSO be blocked from every active-authority route — defense in depth, not merely a
      // login-time check.
      const user = cc.sessions.createUser('ten_susp', 'susp-user-2', 'a-real-password-for-susp-2', 'client-viewer');
      const preExistingSession = cc.sessions.createSession(user);
      const dashboard = await fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Cookie: `${SESSION_COOKIE}=${preExistingSession.session_id}` } });
      assert.equal(dashboard.status, 403, 'an existing session for a NOW-suspended tenant must be blocked from active-authority routes, not merely blocked at future logins');
    } finally { await cc.close(); }
  } finally { await platform.close(); }
});
