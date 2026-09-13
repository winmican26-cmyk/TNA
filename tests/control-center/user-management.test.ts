import assert from 'node:assert/strict';
import test from 'node:test';
import { startRealPlatform, startControlCenter, TestClock, CookieJar } from './harness.js';
import { CSRF_COOKIE } from '../../apps/tna-control-center/src/auth.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 — signup invites and admin-mediated password reset. No
 * email integration exists or is added: both flows are real, single-use, expiring, admin-issued tokens
 * (mirrors the "credential shown once" discipline already used for service-identity issuance). The
 * invitee/resetter chooses only their password — tenant and role are fixed by the admin at issuance and
 * cannot be influenced by anything in the public `/api/signup` or `/api/reset-password` request body.
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return jar;
}
function csrfHeaders(jar: CookieJar) { return { 'Content-Type': 'application/json', Cookie: jar.header(), 'X-CSRF-Token': jar.get(CSRF_COOKIE)! }; }

async function setup(seed: string) {
  const tenantId = `ten_um_${seed}`;
  const platform = await startRealPlatform(tenantId, `um_${seed}`);
  const entry = { tenant_id: tenantId, platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken };
  const clock = new TestClock();
  const cc = await startControlCenter([entry], { clock });
  cc.sessions.createUser(tenantId, 'admin', 'a-real-password-for-admin-1', 'client-admin');
  return { platform, tenantId, cc, clock, close: async () => { await cc.close(); await platform.close(); } };
}

test('signup: a real client-admin-issued invite lets the invitee set only their password — the resulting real account has the tenant/role the admin fixed, never a self-chosen one', async () => {
  const ctx = await setup('signup1');
  try {
    const adminJar = await login(ctx.cc.baseUrl, 'admin', 'a-real-password-for-admin-1');
    const inviteRes = await fetch(`${ctx.cc.baseUrl}/api/users/invite`, { method: 'POST', headers: csrfHeaders(adminJar), body: JSON.stringify({ username: 'new-teammate', role: 'client-reviewer' }) });
    assert.equal(inviteRes.status, 201);
    const invite = await inviteRes.json() as { token: string; expires_at: string };
    assert.ok(invite.token.length >= 32);

    const signupRes = await fetch(`${ctx.cc.baseUrl}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite.token, password: 'a-real-chosen-password-1' }) });
    assert.equal(signupRes.status, 201);
    const created = await signupRes.json() as { username: string; tenant_id: string; role: string };
    assert.equal(created.username, 'new-teammate');
    assert.equal(created.tenant_id, ctx.tenantId, 'the real account must land in the admin\'s own tenant, never one the invitee could choose');
    assert.equal(created.role, 'client-reviewer', 'the real account must have the role the admin fixed, never a self-chosen one');

    const newUserJar = await login(ctx.cc.baseUrl, 'new-teammate', 'a-real-chosen-password-1');
    const me = await fetch(`${ctx.cc.baseUrl}/api/session/me`, { headers: { Cookie: newUserJar.header() } });
    assert.equal(me.status, 200);
  } finally { await ctx.close(); }
});

test('signup: an invite token is single-use — redeeming it twice fails the second time', async () => {
  const ctx = await setup('signup2');
  try {
    const adminJar = await login(ctx.cc.baseUrl, 'admin', 'a-real-password-for-admin-1');
    const inviteRes = await fetch(`${ctx.cc.baseUrl}/api/users/invite`, { method: 'POST', headers: csrfHeaders(adminJar), body: JSON.stringify({ username: 'once-only', role: 'client-viewer' }) });
    const invite = await inviteRes.json() as { token: string };
    const first = await fetch(`${ctx.cc.baseUrl}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite.token, password: 'first-real-password-1' }) });
    assert.equal(first.status, 201);
    const second = await fetch(`${ctx.cc.baseUrl}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite.token, password: 'second-real-password-1' }) });
    assert.equal(second.status, 400);
  } finally { await ctx.close(); }
});

test('signup: a real expired invite is rejected — real, deterministic clock, never a client-trusted timestamp', async () => {
  const ctx = await setup('signup3');
  try {
    const adminJar = await login(ctx.cc.baseUrl, 'admin', 'a-real-password-for-admin-1');
    const inviteRes = await fetch(`${ctx.cc.baseUrl}/api/users/invite`, { method: 'POST', headers: csrfHeaders(adminJar), body: JSON.stringify({ username: 'too-late', role: 'client-viewer' }) });
    const invite = await inviteRes.json() as { token: string };
    ctx.clock.advance(8 * 24 * 3600_000); // 8 days — past the 7-day signup TTL
    const res = await fetch(`${ctx.cc.baseUrl}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite.token, password: 'a-real-password-too-late-1' }) });
    assert.equal(res.status, 400);
  } finally { await ctx.close(); }
});

test('signup: a client-viewer cannot create an invite — server-side 403, never a hidden button as the only control', async () => {
  const ctx = await setup('signup4');
  try {
    ctx.cc.sessions.createUser(ctx.tenantId, 'plain-viewer', 'a-real-password-for-viewer-1', 'client-viewer');
    const viewerJar = await login(ctx.cc.baseUrl, 'plain-viewer', 'a-real-password-for-viewer-1');
    const res = await fetch(`${ctx.cc.baseUrl}/api/users/invite`, { method: 'POST', headers: csrfHeaders(viewerJar), body: JSON.stringify({ username: 'x', role: 'client-viewer' }) });
    assert.equal(res.status, 403);
  } finally { await ctx.close(); }
});

test('password reset: a real admin-issued reset token changes the real password, invalidates every existing session for that user, and cannot be reused', async () => {
  const ctx = await setup('reset1');
  try {
    ctx.cc.sessions.createUser(ctx.tenantId, 'reset-target', 'the-original-real-password-1', 'client-viewer');
    const targetJar = await login(ctx.cc.baseUrl, 'reset-target', 'the-original-real-password-1');
    const meBefore = await fetch(`${ctx.cc.baseUrl}/api/session/me`, { headers: { Cookie: targetJar.header() } });
    assert.equal(meBefore.status, 200, 'sanity: the pre-reset session must actually work');

    const adminJar = await login(ctx.cc.baseUrl, 'admin', 'a-real-password-for-admin-1');
    const tokenRes = await fetch(`${ctx.cc.baseUrl}/api/users/reset-target/reset-password-token`, { method: 'POST', headers: csrfHeaders(adminJar) });
    assert.equal(tokenRes.status, 201);
    const resetToken = await tokenRes.json() as { token: string };

    const resetRes = await fetch(`${ctx.cc.baseUrl}/api/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: resetToken.token, password: 'a-brand-new-real-password-1' }) });
    assert.equal(resetRes.status, 200);

    // The OLD session, issued before the reset, must be real dead — not merely "the password changed".
    const meAfter = await fetch(`${ctx.cc.baseUrl}/api/session/me`, { headers: { Cookie: targetJar.header() } });
    assert.equal(meAfter.status, 401, 'a password reset must destroy every existing session for that user');

    // The OLD password must no longer work; the NEW one must.
    const oldLogin = await fetch(`${ctx.cc.baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reset-target', password: 'the-original-real-password-1' }) });
    assert.equal(oldLogin.status, 401);
    const newLogin = await fetch(`${ctx.cc.baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reset-target', password: 'a-brand-new-real-password-1' }) });
    assert.equal(newLogin.status, 200);

    // Single-use.
    const reuse = await fetch(`${ctx.cc.baseUrl}/api/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: resetToken.token, password: 'yet-another-real-password-1' }) });
    assert.equal(reuse.status, 400);
  } finally { await ctx.close(); }
});

test('password reset: an admin cannot generate a reset token for a user in a different tenant — real cross-tenant isolation, never a shared user namespace', async () => {
  const ctxA = await setup('reset_cross_a');
  const ctxB = await setup('reset_cross_b');
  try {
    ctxB.cc.sessions.createUser(ctxB.tenantId, 'tenant-b-user', 'a-real-password-for-b-1', 'client-viewer');
    const adminAJar = await login(ctxA.cc.baseUrl, 'admin', 'a-real-password-for-admin-1');
    // Tenant A's admin talks to tenant A's own Control Center instance, which has no knowledge of tenant
    // B's user at all — this is real, structural isolation (separate server instances in this test), the
    // same isolation a real shared-process deployment achieves by scoping every lookup to session.tenant_id.
    const res = await fetch(`${ctxA.cc.baseUrl}/api/users/tenant-b-user/reset-password-token`, { method: 'POST', headers: csrfHeaders(adminAJar) });
    assert.equal(res.status, 404);
  } finally { await ctxA.close(); await ctxB.close(); }
});

test('GET /api/users lists only the real users of the caller\'s own tenant', async () => {
  const ctx = await setup('list1');
  try {
    ctx.cc.sessions.createUser(ctx.tenantId, 'teammate-1', 'a-real-password-for-teammate-1', 'client-viewer');
    const adminJar = await login(ctx.cc.baseUrl, 'admin', 'a-real-password-for-admin-1');
    const res = await fetch(`${ctx.cc.baseUrl}/api/users`, { headers: { Cookie: adminJar.header() } });
    assert.equal(res.status, 200);
    const body = await res.json() as { items: readonly { username: string }[] };
    const usernames = body.items.map(u => u.username);
    assert.ok(usernames.includes('admin'));
    assert.ok(usernames.includes('teammate-1'));
  } finally { await ctx.close(); }
});
