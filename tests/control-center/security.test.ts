import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealPlatform, submitAction, startControlCenter, CookieJar } from './harness.js';
import { CSRF_COOKIE } from '../../apps/tna-control-center/src/auth.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), sections 16/54/58/60/66. Real HTTP security
 * tests against the real, spawned Control Center server — never a unit test of the CSRF/role-check
 * functions in isolation.
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return jar;
}

test('CSRF: a mutating request with the session cookie but no CSRF header is rejected', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'csrf-user', 'a-real-password-for-csrf-1', 'client-viewer');
    const jar = await login(cc.baseUrl, 'csrf-user', 'a-real-password-for-csrf-1');
    const res = await fetch(`${cc.baseUrl}/api/session/logout`, { method: 'POST', headers: { Cookie: jar.header() } });
    assert.equal(res.status, 403, 'a mutating request without a matching CSRF header must be rejected even with a valid session cookie');
  } finally { await cc.close(); }
});

test('CSRF: a forged CSRF header that does not match the session\'s real csrf_token is rejected', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'csrf-user-2', 'a-real-password-for-csrf-2', 'client-viewer');
    const jar = await login(cc.baseUrl, 'csrf-user-2', 'a-real-password-for-csrf-2');
    const res = await fetch(`${cc.baseUrl}/api/session/logout`, { method: 'POST', headers: { Cookie: jar.header(), 'X-CSRF-Token': 'a-completely-forged-token-value' } });
    assert.equal(res.status, 403);
  } finally { await cc.close(); }
});

test('CSRF: the real csrf_token from the session\'s own cookie succeeds', async () => {
  const cc = await startControlCenter([]);
  try {
    cc.sessions.createUser('ten_a', 'csrf-user-3', 'a-real-password-for-csrf-3', 'client-viewer');
    const jar = await login(cc.baseUrl, 'csrf-user-3', 'a-real-password-for-csrf-3');
    const res = await fetch(`${cc.baseUrl}/api/session/logout`, { method: 'POST', headers: { Cookie: jar.header(), 'X-CSRF-Token': jar.get(CSRF_COOKIE)! } });
    assert.equal(res.status, 200);
  } finally { await cc.close(); }
});

test('role boundary: a client-viewer\'s real, direct HTTP approve request is rejected server-side even with a valid session and correct CSRF token — a hidden button is never the actual security control', async () => {
  const platform = await startRealPlatform('ten_role', 'role');
  try {
    const held = await submitAction(platform, 'req_role_hold', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, 'ten_role');
    assert.equal(held.body.state, 'HELD');
    const actionId = held.body.platform_action_id as string;

    const cc = await startControlCenter([{ tenant_id: 'ten_role', platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken }]);
    try {
      cc.sessions.createUser('ten_role', 'viewer-only', 'a-real-password-for-viewer-only', 'client-viewer');
      const viewerJar = await login(cc.baseUrl, 'viewer-only', 'a-real-password-for-viewer-only');
      const deniedApprove = await fetch(`${cc.baseUrl}/api/actions/${actionId}/approve`, { method: 'POST', headers: { Cookie: viewerJar.header(), 'X-CSRF-Token': viewerJar.get(CSRF_COOKIE)! } });
      assert.equal(deniedApprove.status, 403, 'client-viewer must never be able to approve a HELD action, even with a perfectly valid session and CSRF token');

      cc.sessions.createUser('ten_role', 'reviewer', 'a-real-password-for-reviewer-1', 'client-reviewer');
      const reviewerJar = await login(cc.baseUrl, 'reviewer', 'a-real-password-for-reviewer-1');
      const allowedApprove = await fetch(`${cc.baseUrl}/api/actions/${actionId}/approve`, { method: 'POST', headers: { Cookie: reviewerJar.header(), 'X-CSRF-Token': reviewerJar.get(CSRF_COOKIE)! } });
      assert.equal(allowedApprove.status, 200, 'client-reviewer must be able to approve, proving the 403 above was a real role check, not a general failure');
      const approved = await allowedApprove.json() as { state: string };
      assert.notEqual(approved.state, 'HELD', 'the real Platform state must have actually advanced past HELD');
    } finally { await cc.close(); }
  } finally { await platform.close(); }
});

test('security headers: every response carries the required headers, including on an error response', async () => {
  const cc = await startControlCenter([]);
  try {
    const res = await fetch(`${cc.baseUrl}/api/dashboard`); // unauthenticated -> 401, still must carry headers
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(res.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally { await cc.close(); }
});

test('error redaction: a 500-shaped internal failure never leaks a filesystem path, stack trace, or bearer token', async () => {
  const cc = await startControlCenter([{ tenant_id: 'ten_err', platform_base_url: 'http://127.0.0.1:1', platform_token: 'x'.repeat(32), platform_operator_token: 'y'.repeat(32) }]);
  try {
    cc.sessions.createUser('ten_err', 'err-user', 'a-real-password-for-err-1', 'client-viewer');
    const jar = await login(cc.baseUrl, 'err-user', 'a-real-password-for-err-1');
    const res = await fetch(`${cc.baseUrl}/api/actions/nonexistent-action-id`, { headers: { Cookie: jar.header() } });
    const text = await res.text();
    assert.ok(!text.includes('sqlite'), 'error body must never mention a SQLite path');
    assert.ok(!text.includes('/home/') && !text.includes('C:\\'), 'error body must never leak a filesystem path');
    assert.ok(!text.includes('x'.repeat(32)), 'error body must never leak a backend bearer token');
  } finally { await cc.close(); }
});

test('CORS: a configured trusted origin receives real, exact-match CORS headers with credentials allowed', async () => {
  const cc = await startControlCenter([], { trustedOrigins: ['https://trusted.example.com'] });
  try {
    const res = await fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Origin: 'https://trusted.example.com' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://trusted.example.com');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(res.headers.get('vary'), 'Origin');
  } finally { await cc.close(); }
});

test('CORS: an unconfigured, hostile origin receives no CORS headers at all — the browser\'s own same-origin policy is what actually blocks it', async () => {
  const cc = await startControlCenter([], { trustedOrigins: ['https://trusted.example.com'] });
  try {
    const res = await fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  } finally { await cc.close(); }
});

test('CORS: with no trustedOrigins configured (the default), no origin is ever granted CORS access, including one that merely looks legitimate', async () => {
  const cc = await startControlCenter([]);
  try {
    const res = await fetch(`${cc.baseUrl}/api/dashboard`, { headers: { Origin: 'https://anything.example.com' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally { await cc.close(); }
});

test('CORS: a wildcard is never emitted, and is therefore never combined with credentials — a real preflight from a trusted origin gets the exact origin back, never "*"', async () => {
  const cc = await startControlCenter([], { trustedOrigins: ['https://trusted.example.com'] });
  try {
    const res = await fetch(`${cc.baseUrl}/api/dashboard`, { method: 'OPTIONS', headers: { Origin: 'https://trusted.example.com', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://trusted.example.com');
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  } finally { await cc.close(); }
});

test('CSP: the full production policy is present with no unsafe-inline/unsafe-eval, on both API and static responses', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cc-static-'));
  writeFileSync(resolve(dir, 'index.html'), '<html><body>real built app</body></html>');
  const cc = await startControlCenter([], { staticRoot: dir });
  try {
    const apiRes = await fetch(`${cc.baseUrl}/api/dashboard`);
    const csp = apiRes.headers.get('content-security-policy') ?? '';
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) {
      assert.ok(csp.includes(directive), `API CSP must include ${directive}`);
    }
    assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), 'CSP must never include unsafe-inline/unsafe-eval');

    const staticRes = await fetch(`${cc.baseUrl}/`);
    assert.equal(staticRes.status, 200);
    const staticCsp = staticRes.headers.get('content-security-policy') ?? '';
    assert.ok(staticCsp.includes("frame-ancestors 'none'"), 'the actual HTML page response (not just JSON API responses) must also carry the CSP');
    assert.equal(staticRes.headers.get('x-frame-options'), 'DENY');
  } finally { await cc.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('environment: /api/session/me reflects the real, operator-configured deployment environment — never a frontend-hardcoded value', async () => {
  const cc = await startControlCenter([{ tenant_id: 'ten_env', platform_base_url: 'http://127.0.0.1:1', platform_token: 'x'.repeat(32), platform_operator_token: 'y'.repeat(32) }], { environment: 'production' });
  try {
    cc.sessions.createUser('ten_env', 'env-user', 'a-real-password-for-env-1', 'client-viewer');
    const jar = await login(cc.baseUrl, 'env-user', 'a-real-password-for-env-1');
    const res = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: jar.header() } });
    const body = await res.json() as { environment: string };
    assert.equal(body.environment, 'production');
  } finally { await cc.close(); }
});

test('environment: an unconfigured deployment fails toward the least-reassuring label ("development"), never toward "production"', async () => {
  const cc = await startControlCenter([{ tenant_id: 'ten_env2', platform_base_url: 'http://127.0.0.1:1', platform_token: 'x'.repeat(32), platform_operator_token: 'y'.repeat(32) }]);
  try {
    cc.sessions.createUser('ten_env2', 'env-user2', 'a-real-password-for-env-2', 'client-viewer');
    const jar = await login(cc.baseUrl, 'env-user2', 'a-real-password-for-env-2');
    const res = await fetch(`${cc.baseUrl}/api/session/me`, { headers: { Cookie: jar.header() } });
    const body = await res.json() as { environment: string };
    assert.equal(body.environment, 'development');
  } finally { await cc.close(); }
});
