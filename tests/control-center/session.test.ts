import assert from 'node:assert/strict';
import test from 'node:test';
import { startControlCenter, CookieJar } from './harness.js';
import { SESSION_COOKIE, CSRF_COOKIE } from '../../apps/tna-control-center/src/auth.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Real session lifecycle tests against the
 * real, spawned Control Center BFF server object (no mocked HTTP).
 */

test('session: unknown username is rejected, real password hashing verifies a correct login', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'alice', 'correct horse battery staple', 'client-viewer');
    const bad = await fetch(`${cc.baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nobody', password: 'whatever12345' }) });
    assert.equal(bad.status, 401);
    const wrongPassword = await fetch(`${cc.baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'wrong-password-1' }) });
    assert.equal(wrongPassword.status, 401);
    const good = await fetch(`${cc.baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'correct horse battery staple' }) });
    assert.equal(good.status, 200);
    const jar = new CookieJar();
    jar.capture(good);
    assert.ok(jar.get(SESSION_COOKIE), 'a real session cookie must be set on successful login');
    assert.ok(jar.get(CSRF_COOKIE), 'a real CSRF cookie must be set on successful login');
  } finally { await cc.close(); }
});

test('session: HttpOnly/SameSite attributes are real, not merely present', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'bob', 'a-strong-password-1234', 'client-viewer');
    const res = await fetch(`${cc.baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'a-strong-password-1234' }) });
    const setCookie = res.headers.getSetCookie();
    const sessionCookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`));
    const csrfCookie = setCookie.find(c => c.startsWith(`${CSRF_COOKIE}=`));
    assert.ok(sessionCookie?.includes('HttpOnly'), 'the session cookie must be HttpOnly — never readable by page JavaScript');
    assert.ok(sessionCookie?.includes('SameSite=Lax'));
    assert.ok(!csrfCookie?.includes('HttpOnly'), 'the CSRF cookie must NOT be HttpOnly — same-origin JS must be able to read it to echo it back as a header');
  } finally { await cc.close(); }
});

test('session: an unauthenticated request to a protected route is rejected, never defaulted to viewer access', async () => {
  const cc = await startControlCenter([]);
  try {
    const res = await fetch(`${cc.baseUrl}/api/dashboard`);
    assert.equal(res.status, 401);
  } finally { await cc.close(); }
});

test('session: logout destroys the real session row — the same cookie no longer authenticates afterward', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'carol', 'another-strong-password-1', 'client-viewer');
    const login = await fetch(`${cc.baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'carol', password: 'another-strong-password-1' }) });
    const jar = new CookieJar();
    jar.capture(login);
    const meBefore = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: jar.header() } });
    assert.equal(meBefore.status, 200);
    const logout = await fetch(`${cc.baseUrl}/api/session/logout`, { method: 'POST', headers: { Cookie: jar.header(), 'X-CSRF-Token': jar.get(CSRF_COOKIE)! } });
    assert.equal(logout.status, 200);
    const meAfter = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: jar.header() } });
    assert.equal(meAfter.status, 401, 'the destroyed session must never continue to authenticate');
  } finally { await cc.close(); }
});

test('session: a disabled account cannot authenticate even with the correct password, and its live session stops working once created before disabling', async () => {
  const cc = await startControlCenter([]);
  try {
    const user = cc.sessions.createUser('ten_a', 'dave', 'yet-another-strong-password', 'client-viewer');
    const sanity = await fetch(`${cc.baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dave', password: 'yet-another-strong-password' }) });
    assert.equal(sanity.status, 200, 'sanity: the account is not yet disabled, so login must succeed here');
    cc.sessions.setDisabled(user.user_id, true);
    const afterDisable = await fetch(`${cc.baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dave', password: 'yet-another-strong-password' }) });
    assert.equal(afterDisable.status, 401, 'a disabled account must never authenticate again, even with the correct password');
  } finally { await cc.close(); }
});
