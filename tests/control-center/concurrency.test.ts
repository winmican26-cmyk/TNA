import assert from 'node:assert/strict';
import test from 'node:test';
import { startRealPlatform, submitAction, startControlCenter, CookieJar, TestClock } from './harness.js';
import { CSRF_COOKIE } from '../../apps/tna-control-center/src/auth.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) — foundation review section 26. Real
 * concurrent HTTP requests against the real, spawned Control Center server.
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return jar;
}

test('concurrency: two simultaneous reads on the same session both succeed and see consistent data', async () => {
  const platform = await startRealPlatform('ten_conc_1', 'conc1');
  try {
    await submitAction(platform, 'req_conc1_1', {}, 'ten_conc_1');
    const cc = await startControlCenter([{ tenant_id: 'ten_conc_1', platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken }]);
    try {
      cc.sessions.createUser('ten_conc_1', 'conc-user', 'a-real-password-for-conc-1', 'client-viewer');
      const jar = await login(cc.baseUrl, 'conc-user', 'a-real-password-for-conc-1');
      const [a, b] = await Promise.all([
        fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Cookie: jar.header() } }),
        fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Cookie: jar.header() } }),
      ]);
      assert.equal(a.status, 200); assert.equal(b.status, 200);
      const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]) as [{ total_known_actions: number }, { total_known_actions: number }];
      assert.equal(bodyA.total_known_actions, bodyB.total_known_actions);
    } finally { await cc.close(); }
  } finally { await platform.close(); }
});

test('concurrency: two independent sessions for the same tenant operate independently — one logging out never affects the other', async () => {
  const platform = await startRealPlatform('ten_conc_2', 'conc2');
  try {
    await submitAction(platform, 'req_conc2_1', {}, 'ten_conc_2');
    const cc = await startControlCenter([{ tenant_id: 'ten_conc_2', platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken }]);
    try {
      cc.sessions.createUser('ten_conc_2', 'conc-user-a', 'a-real-password-for-conc2-a', 'client-viewer');
      cc.sessions.createUser('ten_conc_2', 'conc-user-b', 'a-real-password-for-conc2-b', 'client-viewer');
      const jarA = await login(cc.baseUrl, 'conc-user-a', 'a-real-password-for-conc2-a');
      const jarB = await login(cc.baseUrl, 'conc-user-b', 'a-real-password-for-conc2-b');
      await fetch(`${cc.baseUrl}/api/session/logout`, { method: 'POST', headers: { Cookie: jarA.header(), 'X-CSRF-Token': jarA.get(CSRF_COOKIE)! } });
      const meA = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: jarA.header() } });
      const meB = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: jarB.header() } });
      assert.equal(meA.status, 401, 'A logged out');
      assert.equal(meB.status, 200, 'B must remain completely unaffected by A\'s logout');
    } finally { await cc.close(); }
  } finally { await platform.close(); }
});

test('concurrency: two different tenants\' sessions served by the same Control Center process never cross-contaminate under concurrent load', async () => {
  const platformA = await startRealPlatform('ten_conc_3a', 'conc3a');
  const platformB = await startRealPlatform('ten_conc_3b', 'conc3b');
  try {
    await submitAction(platformA, 'req_conc3a_1', {}, 'ten_conc_3a');
    await submitAction(platformB, 'req_conc3b_1', {}, 'ten_conc_3b');
    await submitAction(platformB, 'req_conc3b_2', {}, 'ten_conc_3b');
    const cc = await startControlCenter([
      { tenant_id: 'ten_conc_3a', platform_base_url: platformA.baseUrl, platform_token: platformA.agentToken, platform_operator_token: platformA.operatorToken },
      { tenant_id: 'ten_conc_3b', platform_base_url: platformB.baseUrl, platform_token: platformB.agentToken, platform_operator_token: platformB.operatorToken },
    ]);
    try {
      cc.sessions.createUser('ten_conc_3a', 'conc3-user-a', 'a-real-password-for-conc3-a', 'client-viewer');
      cc.sessions.createUser('ten_conc_3b', 'conc3-user-b', 'a-real-password-for-conc3-b', 'client-viewer');
      const jarA = await login(cc.baseUrl, 'conc3-user-a', 'a-real-password-for-conc3-a');
      const jarB = await login(cc.baseUrl, 'conc3-user-b', 'a-real-password-for-conc3-b');
      const requests: Promise<Response>[] = [];
      for (let i = 0; i < 10; i++) {
        requests.push(fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Cookie: jarA.header() } }));
        requests.push(fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Cookie: jarB.header() } }));
      }
      const results = await Promise.all(requests);
      for (const r of results) assert.equal(r.status, 200);
      const bodies = await Promise.all(results.map(r => r.json())) as { total_known_actions: number }[];
      for (let i = 0; i < bodies.length; i += 2) {
        assert.equal(bodies[i]!.total_known_actions, 1, 'every A request must see exactly A\'s 1 action, never B\'s');
        assert.equal(bodies[i + 1]!.total_known_actions, 2, 'every B request must see exactly B\'s 2 actions, never A\'s');
      }
    } finally { await cc.close(); }
  } finally { await platformA.close(); await platformB.close(); }
});

test('concurrency: logout racing a mutation — the mutation either completes against the still-valid session or is rejected once truly gone, never a corrupted in-between result', async () => {
  const platform = await startRealPlatform('ten_conc_4', 'conc4');
  try {
    const held = await submitAction(platform, 'req_conc4_hold', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, 'ten_conc_4');
    const actionId = held.body.platform_action_id as string;
    const cc = await startControlCenter([{ tenant_id: 'ten_conc_4', platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken }]);
    try {
      cc.sessions.createUser('ten_conc_4', 'conc4-user', 'a-real-password-for-conc4-1', 'client-reviewer');
      const jar = await login(cc.baseUrl, 'conc4-user', 'a-real-password-for-conc4-1');
      const csrf = jar.get(CSRF_COOKIE)!;
      const [approveRes, logoutRes] = await Promise.all([
        fetch(`${cc.baseUrl}/api/actions/${actionId}/approve`, { method: 'POST', headers: { Cookie: jar.header(), 'X-CSRF-Token': csrf } }),
        fetch(`${cc.baseUrl}/api/session/logout`, { method: 'POST', headers: { Cookie: jar.header(), 'X-CSRF-Token': csrf } }),
      ]);
      assert.ok([200, 401, 403].includes(approveRes.status), `unexpected status ${approveRes.status}`);
      assert.equal(logoutRes.status, 200);
      // Regardless of the race outcome above, the session must be unambiguously gone afterward.
      const after = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: jar.header() } });
      assert.equal(after.status, 401);
    } finally { await cc.close(); }
  } finally { await platform.close(); }
});

test('concurrency: expiry racing a mutation — once the deterministic clock has passed the TTL, the mutation is rejected, never allowed through on a stale session', async () => {
  const clock = new TestClock(Date.parse('2026-01-01T00:00:00Z'));
  const platform = await startRealPlatform('ten_conc_5', 'conc5');
  try {
    const held = await submitAction(platform, 'req_conc5_hold', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, 'ten_conc_5');
    const actionId = held.body.platform_action_id as string;
    const cc = await startControlCenter([{ tenant_id: 'ten_conc_5', platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken }], { clock });
    try {
      cc.sessions.createUser('ten_conc_5', 'conc5-user', 'a-real-password-for-conc5-1', 'client-reviewer');
      const jar = await login(cc.baseUrl, 'conc5-user', 'a-real-password-for-conc5-1');
      const csrf = jar.get(CSRF_COOKIE)!;
      clock.advance(9 * 3600_000); // well past the 8h TTL
      const res = await fetch(`${cc.baseUrl}/api/actions/${actionId}/approve`, { method: 'POST', headers: { Cookie: jar.header(), 'X-CSRF-Token': csrf } });
      assert.equal(res.status, 401, 'a mutation attempted after the deterministic clock has passed expiry must be rejected, never allowed through');
    } finally { await cc.close(); }
  } finally { await platform.close(); }
});
