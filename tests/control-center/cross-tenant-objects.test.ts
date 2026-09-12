import assert from 'node:assert/strict';
import test from 'node:test';
import { startRealPlatform, submitAction, startControlCenter, CookieJar } from './harness.js';
import { CSRF_COOKIE } from '../../apps/tna-control-center/src/auth.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) — foundation review sections 11-12. Extends
 * the original single cross-tenant-read proof to approve/terminate/pagination and to the
 * object-existence-leakage question explicitly. Real, separate Platform instances throughout — never a
 * mocked repository.
 *
 * Honest scope note (section 11): Platform's real `GET /v1/platform/actions` route supports only
 * `limit`/`cursor` (`readPageParams` in `apps/tna-platform/src/server.ts` rejects any other query
 * parameter with 400) — there is no filter/search query capability to probe for cross-tenant leakage
 * through, so "filtering/search" is N/A rather than untested.
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return jar;
}

async function twoTenantSetup(seed: string) {
  const platformA = await startRealPlatform(`ten_x_${seed}`, `xa_${seed}`);
  const platformB = await startRealPlatform(`ten_y_${seed}`, `xb_${seed}`);
  const cc = await startControlCenter([
    { tenant_id: `ten_x_${seed}`, platform_base_url: platformA.baseUrl, platform_token: platformA.agentToken, platform_operator_token: platformA.operatorToken },
    { tenant_id: `ten_y_${seed}`, platform_base_url: platformB.baseUrl, platform_token: platformB.agentToken, platform_operator_token: platformB.operatorToken },
  ]);
  cc.sessions.createUser(`ten_x_${seed}`, `reviewer_${seed}`, `a-real-password-for-${seed}-1`, 'client-reviewer');
  const jarA = await login(cc.baseUrl, `reviewer_${seed}`, `a-real-password-for-${seed}-1`);
  return {
    platformA, platformB, cc, jarA,
    close: async () => { await cc.close(); await platformA.close(); await platformB.close(); },
  };
}

test('cross-tenant: Tenant A cannot approve a real, existing Tenant B HELD action', async () => {
  const ctx = await twoTenantSetup('approve');
  try {
    const held = await submitAction(ctx.platformB, 'req_xb_hold', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, 'ten_y_approve');
    assert.equal(held.body.state, 'HELD');
    const actionId = held.body.platform_action_id as string;
    const res = await fetch(`${ctx.cc.baseUrl}/api/actions/${actionId}/approve`, { method: 'POST', headers: { Cookie: ctx.jarA.header(), 'X-CSRF-Token': ctx.jarA.get(CSRF_COOKIE)! } });
    assert.equal(res.status, 404, 'Tenant A must never be able to approve a real Tenant B action — its own registered backend genuinely has no such row');
  } finally { await ctx.close(); }
});

test('cross-tenant: Tenant A cannot terminate a real, existing Tenant B action', async () => {
  const ctx = await twoTenantSetup('terminate');
  try {
    const seeded = await submitAction(ctx.platformB, 'req_xb_term', {}, 'ten_y_terminate');
    const actionId = seeded.body.platform_action_id as string;
    const res = await fetch(`${ctx.cc.baseUrl}/api/actions/${actionId}/terminate`, { method: 'POST', headers: { Cookie: ctx.jarA.header(), 'X-CSRF-Token': ctx.jarA.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'cross-tenant probe' }) });
    assert.equal(res.status, 404);
  } finally { await ctx.close(); }
});

test('cross-tenant: pagination never surfaces Tenant B\'s actions to Tenant A, and an invalid/foreign-shaped cursor is rejected rather than leaking data', async () => {
  const ctx = await twoTenantSetup('page');
  try {
    for (let i = 0; i < 3; i++) await submitAction(ctx.platformA, `req_xa_page_${i}`, {}, 'ten_x_page');
    const bAction = await submitAction(ctx.platformB, 'req_xb_page', {}, 'ten_y_page');

    // Ordinary pagination (no cursor) — only ever Tenant A's own items.
    const plain = await fetch(`${ctx.cc.baseUrl}/api/actions?limit=50`, { headers: { Cookie: ctx.jarA.header() } });
    assert.equal(plain.status, 200);
    const plainPage = await plain.json() as { items: readonly { platform_action_id: string }[] };
    assert.ok(!plainPage.items.some(a => a.platform_action_id === bAction.body.platform_action_id));

    // Supplying a real Tenant-B action id AS a cursor value is foreign, malformed input for Tenant A's
    // own real backend's pagination scheme — the real Platform store correctly REJECTS it (400, invalid
    // cursor) rather than either crashing or, worse, somehow resolving it against Tenant B's data. Either
    // outcome that is not "leaks Tenant B data" is compliant; confirm it is specifically the real reject.
    const foreignCursor = await fetch(`${ctx.cc.baseUrl}/api/actions?limit=50&cursor=${encodeURIComponent(bAction.body.platform_action_id as string)}`, { headers: { Cookie: ctx.jarA.header() } });
    assert.equal(foreignCursor.status, 400, 'a cursor value shaped like it came from a different tenant\'s data is foreign input to Tenant A\'s own real backend and is correctly rejected, never resolved as if it were valid');
  } finally { await ctx.close(); }
});

test('object-existence leakage: a cross-tenant object and a truly nonexistent object are indistinguishable (both 404, same shape)', async () => {
  const ctx = await twoTenantSetup('exist');
  try {
    const bAction = await submitAction(ctx.platformB, 'req_xb_exist', {}, 'ten_y_exist');
    const realCrossTenantId = bAction.body.platform_action_id as string;
    const trulyFakeId = 'platform_action_this_id_was_never_created_anywhere';

    const crossTenantRes = await fetch(`${ctx.cc.baseUrl}/api/actions/${realCrossTenantId}`, { headers: { Cookie: ctx.jarA.header() } });
    const fakeRes = await fetch(`${ctx.cc.baseUrl}/api/actions/${trulyFakeId}`, { headers: { Cookie: ctx.jarA.header() } });

    assert.equal(crossTenantRes.status, fakeRes.status, 'a real cross-tenant object and a genuinely nonexistent object must produce the identical status code');
    assert.equal(crossTenantRes.status, 404, 'never 403 (which would confirm the object exists somewhere) — 404 either way');
    const crossTenantBody = await crossTenantRes.json() as { error?: string };
    const fakeBody = await fakeRes.json() as { error?: string };
    assert.equal(typeof crossTenantBody.error, 'string');
    assert.equal(typeof fakeBody.error, 'string');
  } finally { await ctx.close(); }
});

test('object-existence leakage: the same indistinguishability holds for /evidence', async () => {
  const ctx = await twoTenantSetup('exist-evidence');
  try {
    const bAction = await submitAction(ctx.platformB, 'req_xb_exist_ev', {}, 'ten_y_exist-evidence');
    const realCrossTenantId = bAction.body.platform_action_id as string;
    const crossTenantRes = await fetch(`${ctx.cc.baseUrl}/api/actions/${realCrossTenantId}/evidence`, { headers: { Cookie: ctx.jarA.header() } });
    const fakeRes = await fetch(`${ctx.cc.baseUrl}/api/actions/nonexistent-evidence-probe/evidence`, { headers: { Cookie: ctx.jarA.header() } });
    assert.equal(crossTenantRes.status, fakeRes.status);
    assert.equal(crossTenantRes.status, 404);
  } finally { await ctx.close(); }
});
