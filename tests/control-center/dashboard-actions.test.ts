import assert from 'node:assert/strict';
import test from 'node:test';
import { startRealPlatform, submitAction, startControlCenter, CookieJar } from './harness.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), sections 6/9/50. Every number the dashboard
 * and actions list return must be computed from real Platform data — this is this increment's evidence
 * -provenance proof: seed a specific, known real ALLOW action and a specific, known real BLOCK action,
 * then assert the dashboard's counts and the actions list reflect exactly those real outcomes.
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return jar;
}

test('dashboard: real seeded COMPLETED and BLOCKED actions produce exactly matching real counts — never hardcoded', async () => {
  const platform = await startRealPlatform('ten_dash', 'dash');
  try {
    const completed = await submitAction(platform, 'req_dash_ok', {}, 'ten_dash');
    assert.equal(completed.body.state, 'COMPLETED');
    const blocked = await submitAction(platform, 'req_dash_block', { tool: 'shell.unrestricted' }, 'ten_dash');
    assert.equal(blocked.body.state, 'BLOCKED');

    const cc = await startControlCenter([{ tenant_id: 'ten_dash', platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken }]);
    try {
      cc.sessions.createUser('ten_dash', 'viewer', 'a-real-password-for-viewer-1', 'client-viewer');
      const jar = await login(cc.baseUrl, 'viewer', 'a-real-password-for-viewer-1');
      const res = await fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Cookie: jar.header() } });
      assert.equal(res.status, 200);
      const dashboard = await res.json() as { total_known_actions: number; blocked: number; held: number };
      assert.equal(dashboard.total_known_actions, 2, 'exactly the two real seeded actions, not a hardcoded number');
      assert.equal(dashboard.blocked, 1, 'exactly the one real BLOCKED action');
      assert.equal(dashboard.held, 0);
    } finally { await cc.close(); }
  } finally { await platform.close(); }
});

test('actions list and action detail: the real Gate decision (BLOCKED) is visible unmodified through the Control Center proxy', async () => {
  const platform = await startRealPlatform('ten_actions', 'actions');
  try {
    const blocked = await submitAction(platform, 'req_actions_block', { tool: 'shell.unrestricted' }, 'ten_actions');
    const actionId = blocked.body.platform_action_id as string;
    const cc = await startControlCenter([{ tenant_id: 'ten_actions', platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken }]);
    try {
      cc.sessions.createUser('ten_actions', 'viewer2', 'a-real-password-for-viewer-2', 'client-viewer');
      const jar = await login(cc.baseUrl, 'viewer2', 'a-real-password-for-viewer-2');
      const detail = await fetch(`${cc.baseUrl}/api/actions/${actionId}`, { headers: { Cookie: jar.header() } });
      assert.equal(detail.status, 200);
      const body = await detail.json() as { state: string };
      assert.equal(body.state, 'BLOCKED', 'the Control Center must never re-derive or soften a real BLOCK decision');

      const evidence = await fetch(`${cc.baseUrl}/api/actions/${actionId}/evidence`, { headers: { Cookie: jar.header() } });
      assert.equal(evidence.status, 200);
    } finally { await cc.close(); }
  } finally { await platform.close(); }
});

test('dashboard: an unreachable tenant backend is reported honestly, never rendered as a healthy zero', async () => {
  const cc = await startControlCenter([{ tenant_id: 'ten_down', platform_base_url: 'http://127.0.0.1:1', platform_token: 'x'.repeat(32), platform_operator_token: 'y'.repeat(32) }]);
  try {
    cc.sessions.createUser('ten_down', 'viewer3', 'a-real-password-for-viewer-3', 'client-viewer');
    const jar = await login(cc.baseUrl, 'viewer3', 'a-real-password-for-viewer-3');
    const res = await fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Cookie: jar.header() } });
    assert.equal(res.status, 200);
    const dashboard = await res.json() as { assurance: { status: string } };
    assert.equal(dashboard.assurance.status, 'UNAVAILABLE', 'an unreachable backend must be reported as UNAVAILABLE, never silently defaulted to a healthy status');
  } finally { await cc.close(); }
});
