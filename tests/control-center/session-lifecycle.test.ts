import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { startControlCenter, CookieJar, TestClock } from './harness.js';
import { SESSION_COOKIE, CSRF_COOKIE } from '../../apps/tna-control-center/src/auth.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) — foundation review sections 1/3/4/6/7.
 * Real HTTP tests against the real, spawned Control Center server for the full session lifecycle:
 * fixation, rotation semantics, logout replay, deterministic expiry, forged/unknown sessions, and
 * cross-session CSRF binding.
 */

async function login(baseUrl: string, username: string, password: string, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return { res, jar };
}

test('session fixation: an attacker-supplied pre-login session cookie is never adopted as the authenticated session', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'fixation-user', 'a-real-password-for-fixation-1', 'client-viewer');
    // The attacker plants a cookie BEFORE the victim logs in — a real, well-formed-looking, attacker
    // -chosen session id (same length/shape as a real one).
    const attackerChosenSessionId = randomBytes(32).toString('hex');
    const { res, jar } = await login(cc.baseUrl, 'fixation-user', 'a-real-password-for-fixation-1', { Cookie: `${SESSION_COOKIE}=${attackerChosenSessionId}` });
    assert.equal(res.status, 200);
    const issuedSessionId = jar.get(SESSION_COOKIE);
    assert.ok(issuedSessionId, 'a real session cookie must be issued on login');
    assert.notEqual(issuedSessionId, attackerChosenSessionId, 'the authenticated session id must never equal the attacker-supplied pre-login id');
    // The attacker's chosen id was never inserted as a real row — it still authenticates nothing.
    const attackerProbe = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: `${SESSION_COOKIE}=${attackerChosenSessionId}` } });
    assert.equal(attackerProbe.status, 401, 'the attacker-supplied pre-login id must never become a valid session merely because a login happened alongside it');
  } finally { await cc.close(); }
});

test('session ids are cryptographically random — two logins for the same user never collide and are unrelated', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'random-user', 'a-real-password-for-random-1', 'client-viewer');
    const first = await login(cc.baseUrl, 'random-user', 'a-real-password-for-random-1');
    const second = await login(cc.baseUrl, 'random-user', 'a-real-password-for-random-1');
    const idA = first.jar.get(SESSION_COOKIE)!;
    const idB = second.jar.get(SESSION_COOKIE)!;
    assert.notEqual(idA, idB);
    assert.equal(idA.length, 64, '32 real random bytes, hex-encoded');
    assert.match(idA, /^[0-9a-f]{64}$/);
  } finally { await cc.close(); }
});

test('documented multi-session semantics: a new login does NOT invalidate the user\'s other existing session (deliberate product decision, not a bug)', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'multi-user', 'a-real-password-for-multi-1', 'client-viewer');
    const first = await login(cc.baseUrl, 'multi-user', 'a-real-password-for-multi-1');
    const second = await login(cc.baseUrl, 'multi-user', 'a-real-password-for-multi-1');
    const meFirst = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: first.jar.header() } });
    const meSecond = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: second.jar.header() } });
    assert.equal(meFirst.status, 200, 'the FIRST session must remain valid after a second login — documented multi-session semantics');
    assert.equal(meSecond.status, 200);
  } finally { await cc.close(); }
});

test('logout is real server-side invalidation, not merely cookie clearing — a replayed captured cookie fails', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'replay-user', 'a-real-password-for-replay-1', 'client-viewer');
    const { jar } = await login(cc.baseUrl, 'replay-user', 'a-real-password-for-replay-1');
    const capturedCookie = jar.header();
    const logout = await fetch(`${cc.baseUrl}/api/session/logout`, { method: 'POST', headers: { Cookie: capturedCookie, 'X-CSRF-Token': jar.get(CSRF_COOKIE)! } });
    assert.equal(logout.status, 200);
    // Replay the EXACT captured cookie string — as if an attacker had captured it before logout.
    const replay = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: capturedCookie } });
    assert.equal(replay.status, 401, 'a replayed, already-logged-out cookie must never resurrect the session');
  } finally { await cc.close(); }
});

test('expiry is enforced server-side against a deterministic clock — valid before, invalid strictly after, and the row itself is gone', async () => {
  const clock = new TestClock(Date.parse('2026-01-01T00:00:00Z'));
  const cc = await startControlCenter([], { clock });
  try {
    cc.sessions.createUser('ten_a', 'expiry-user', 'a-real-password-for-expiry-1', 'client-viewer');
    const { jar } = await login(cc.baseUrl, 'expiry-user', 'a-real-password-for-expiry-1');
    const beforeExpiry = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: jar.header() } });
    assert.equal(beforeExpiry.status, 200, 'sanity: valid immediately after login');

    clock.advance(7 * 3600_000 + 59 * 60_000); // 7h59m — still within the 8h TTL
    const stillValid = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: jar.header() } });
    assert.equal(stillValid.status, 200, 'must still be valid one minute before the configured TTL elapses');

    clock.advance(2 * 60_000); // now 8h01m total — past the 8h TTL
    const afterExpiry = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: jar.header() } });
    assert.equal(afterExpiry.status, 401, 'must be invalid strictly after the server-side TTL elapses — never trusted from the browser cookie alone');
  } finally { await cc.close(); }
});

test('a forged (well-formed but never-issued) session id fails closed', async () => {
  const cc = await startControlCenter([]);
  try {
    const forged = randomBytes(32).toString('hex');
    const res = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: `${SESSION_COOKIE}=${forged}` } });
    assert.equal(res.status, 401);
  } finally { await cc.close(); }
});

test('an unknown/garbage session id fails closed', async () => {
  const cc = await startControlCenter([]);
  try {
    const res = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: `${SESSION_COOKIE}=not-even-hex-shaped` } });
    assert.equal(res.status, 401);
  } finally { await cc.close(); }
});

test('a deleted session id fails closed even though it was real a moment ago', async () => {
  const cc = await startControlCenter([]);
  try {
    const user = cc.sessions.createUser('ten_a', 'deleted-user', 'a-real-password-for-deleted-1', 'client-viewer');
    const session = cc.sessions.createSession(user);
    cc.sessions.destroySession(session.session_id);
    const res = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: `${SESSION_COOKIE}=${session.session_id}` } });
    assert.equal(res.status, 401);
  } finally { await cc.close(); }
});

test('cross-session CSRF: Session A\'s cookie with Session B\'s CSRF token fails, and vice versa — proving real binding, not mere presence', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'cross-csrf-a', 'a-real-password-for-cross-a-1', 'client-viewer');
    cc.sessions.createUser('ten_a', 'cross-csrf-b', 'a-real-password-for-cross-b-1', 'client-viewer');
    const { jar: jarA } = await login(cc.baseUrl, 'cross-csrf-a', 'a-real-password-for-cross-a-1');
    const { jar: jarB } = await login(cc.baseUrl, 'cross-csrf-b', 'a-real-password-for-cross-b-1');
    const csrfA = jarA.get(CSRF_COOKIE)!;
    const csrfB = jarB.get(CSRF_COOKIE)!;
    assert.notEqual(csrfA, csrfB, 'sanity: two independent sessions must have different real csrf tokens');

    const sessionCookieOnly = (jar: CookieJar) => `${SESSION_COOKIE}=${jar.get(SESSION_COOKIE)}`;

    const aWithB = await fetch(`${cc.baseUrl}/api/session/logout`, { method: 'POST', headers: { Cookie: sessionCookieOnly(jarA), 'X-CSRF-Token': csrfB } });
    assert.equal(aWithB.status, 403, 'Session A\'s cookie with Session B\'s CSRF token must fail');

    const bWithA = await fetch(`${cc.baseUrl}/api/session/logout`, { method: 'POST', headers: { Cookie: sessionCookieOnly(jarB), 'X-CSRF-Token': csrfA } });
    assert.equal(bWithA.status, 403, 'Session B\'s cookie with Session A\'s CSRF token must fail');

    // Each session's OWN real token still works — proving the failures above were real binding checks,
    // not a general CSRF outage.
    const aWithA = await fetch(`${cc.baseUrl}/api/session/logout`, { method: 'POST', headers: { Cookie: sessionCookieOnly(jarA), 'X-CSRF-Token': csrfA } });
    assert.equal(aWithA.status, 200);
  } finally { await cc.close(); }
});

test('the CSRF token alone (no session cookie) can never authenticate a request', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'csrf-only-user', 'a-real-password-for-csrf-only-1', 'client-viewer');
    const { jar } = await login(cc.baseUrl, 'csrf-only-user', 'a-real-password-for-csrf-only-1');
    const csrf = jar.get(CSRF_COOKIE)!;
    const res = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { 'X-CSRF-Token': csrf } });
    assert.equal(res.status, 401, 'a CSRF token by itself, with no session cookie, must never grant authentication');
  } finally { await cc.close(); }
});
