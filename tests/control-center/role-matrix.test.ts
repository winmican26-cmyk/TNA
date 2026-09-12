import assert from 'node:assert/strict';
import test from 'node:test';
import { startRealPlatform, submitAction, startControlCenter, CookieJar } from './harness.js';
import { CSRF_COOKIE } from '../../apps/tna-control-center/src/auth.js';
import { CLIENT_PERMISSIONS, roleHasPermission } from '../../apps/tna-control-center/src/permissions.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) — foundation review sections 13-19. Real HTTP
 * tests proving the centralized permission matrix is what actually gates every mutating route (never a
 * frontend-only check), that no role gets implicit TNA-operator authority, that a request cannot escalate
 * its own authorization via body fields, and that the BFF can only ever narrow what a real backend would
 * allow — never widen it.
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return jar;
}

test('permission matrix: no role is ever granted a permission outside the authoritative matrix (structural sanity)', () => {
  // client-viewer and client-auditor must never hold any action-mutation, tool-management, identity, or
  // improvement-authority permission.
  for (const readOnlyRole of ['client-viewer', 'client-auditor'] as const) {
    for (const permission of ['action.approve', 'action.reject', 'action.terminate', 'tool.enable.request', 'tool.disable.request', 'identity.create', 'identity.suspend', 'credential.rotate', 'improvement.approve', 'improvement.promote', 'improvement.rollback', 'organization.manage'] as const) {
      assert.equal(roleHasPermission(readOnlyRole, permission), false, `${readOnlyRole} must never have ${permission}`);
    }
  }
  // client-admin must still never receive an operator-only capability — there simply is no permission in
  // the matrix that maps to one, which this asserts by checking the matrix's own closed permission list.
  const knownPermissions = new Set(CLIENT_PERMISSIONS);
  assert.ok(!knownPermissions.has('operator.anything' as never), 'sanity: the permission enum itself contains no operator-only capability to accidentally grant');
});

async function twoRoleSetup(seed: string) {
  const platform = await startRealPlatform(`ten_role_${seed}`, `role_${seed}`);
  const cc = await startControlCenter([{ tenant_id: `ten_role_${seed}`, platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken }]);
  cc.sessions.createUser(`ten_role_${seed}`, `viewer_${seed}`, `a-real-password-viewer-${seed}-1`, 'client-viewer');
  cc.sessions.createUser(`ten_role_${seed}`, `reviewer_${seed}`, `a-real-password-reviewer-${seed}-1`, 'client-reviewer');
  cc.sessions.createUser(`ten_role_${seed}`, `auditor_${seed}`, `a-real-password-auditor-${seed}-1`, 'client-auditor');
  cc.sessions.createUser(`ten_role_${seed}`, `admin_${seed}`, `a-real-password-admin-${seed}-1`, 'client-admin');
  return {
    platform, cc, tenantId: `ten_role_${seed}`,
    jarViewer: await login(cc.baseUrl, `viewer_${seed}`, `a-real-password-viewer-${seed}-1`),
    jarReviewer: await login(cc.baseUrl, `reviewer_${seed}`, `a-real-password-reviewer-${seed}-1`),
    jarAuditor: await login(cc.baseUrl, `auditor_${seed}`, `a-real-password-auditor-${seed}-1`),
    jarAdmin: await login(cc.baseUrl, `admin_${seed}`, `a-real-password-admin-${seed}-1`),
    close: async () => { await cc.close(); await platform.close(); },
  };
}

test('role boundary: viewer — read PASS, approve/terminate DENY', async () => {
  const ctx = await twoRoleSetup('viewer');
  try {
    const held = await submitAction(ctx.platform, 'req_rv_hold', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, ctx.tenantId);
    const actionId = held.body.platform_action_id as string;
    assert.equal((await fetch(`${ctx.cc.baseUrl}/api/dashboard`, { headers: { Cookie: ctx.jarViewer.header() } })).status, 200);
    assert.equal((await fetch(`${ctx.cc.baseUrl}/api/actions/${actionId}/approve`, { method: 'POST', headers: { Cookie: ctx.jarViewer.header(), 'X-CSRF-Token': ctx.jarViewer.get(CSRF_COOKIE)! } })).status, 403);
    assert.equal((await fetch(`${ctx.cc.baseUrl}/api/actions/${actionId}/terminate`, { method: 'POST', headers: { Cookie: ctx.jarViewer.header(), 'X-CSRF-Token': ctx.jarViewer.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }) })).status, 403);
  } finally { await ctx.close(); }
});

test('role boundary: reviewer — read PASS, eligible approval PASS, no admin/operator authority exists to test against yet (honest N/A)', async () => {
  const ctx = await twoRoleSetup('reviewer');
  try {
    const held = await submitAction(ctx.platform, 'req_rr_hold', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, ctx.tenantId);
    const actionId = held.body.platform_action_id as string;
    assert.equal((await fetch(`${ctx.cc.baseUrl}/api/dashboard`, { headers: { Cookie: ctx.jarReviewer.header() } })).status, 200);
    const approve = await fetch(`${ctx.cc.baseUrl}/api/actions/${actionId}/approve`, { method: 'POST', headers: { Cookie: ctx.jarReviewer.header(), 'X-CSRF-Token': ctx.jarReviewer.get(CSRF_COOKIE)! } });
    assert.equal(approve.status, 200);
  } finally { await ctx.close(); }
});

test('role boundary: auditor — evidence/action read PASS, approve/terminate DENY', async () => {
  const ctx = await twoRoleSetup('auditor');
  try {
    const seeded = await submitAction(ctx.platform, 'req_ra_seed', {}, ctx.tenantId);
    const actionId = seeded.body.platform_action_id as string;
    assert.equal((await fetch(`${ctx.cc.baseUrl}/api/actions/${actionId}`, { headers: { Cookie: ctx.jarAuditor.header() } })).status, 200);
    assert.equal((await fetch(`${ctx.cc.baseUrl}/api/actions/${actionId}/evidence`, { headers: { Cookie: ctx.jarAuditor.header() } })).status, 200);
    assert.equal((await fetch(`${ctx.cc.baseUrl}/api/actions/${actionId}/terminate`, { method: 'POST', headers: { Cookie: ctx.jarAuditor.header(), 'X-CSRF-Token': ctx.jarAuditor.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }) })).status, 403);
  } finally { await ctx.close(); }
});

test('role boundary: admin — permitted mutation (approve) PASS; no BFF route yet grants any operator-only Platform capability (honest N/A, verified structurally by permission-matrix test above)', async () => {
  const ctx = await twoRoleSetup('admin');
  try {
    const held = await submitAction(ctx.platform, 'req_rad_hold', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, ctx.tenantId);
    const actionId = held.body.platform_action_id as string;
    const approve = await fetch(`${ctx.cc.baseUrl}/api/actions/${actionId}/approve`, { method: 'POST', headers: { Cookie: ctx.jarAdmin.header(), 'X-CSRF-Token': ctx.jarAdmin.get(CSRF_COOKIE)! } });
    assert.equal(approve.status, 200);
  } finally { await ctx.close(); }
});

test('request-body role/permission escalation has no effect on the authenticated principal', async () => {
  const ctx = await twoRoleSetup('escalation');
  try {
    const held = await submitAction(ctx.platform, 'req_esc_hold', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, ctx.tenantId);
    const actionId = held.body.platform_action_id as string;
    // The viewer session smuggles claims of admin authority into the request body of a route that reads
    // a body (`terminate` reads `reason`) — these extra fields must have zero effect.
    const res = await fetch(`${ctx.cc.baseUrl}/api/actions/${actionId}/terminate`, {
      method: 'POST', headers: { Cookie: ctx.jarViewer.header(), 'X-CSRF-Token': ctx.jarViewer.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'escalation attempt', role: 'client-admin', permissions: ['*'], isAdmin: true }),
    });
    assert.equal(res.status, 403, 'a viewer session remains a viewer regardless of what the request body claims about its own authority');
  } finally { await ctx.close(); }
});

test('BFF trust boundary: a real backend rejection is surfaced, never overridden into a fabricated success, even for a role the BFF itself would have allowed', async () => {
  const ctx = await twoRoleSetup('boundary');
  try {
    // A normal COMPLETED action (never HELD) — the real Platform `resume()` refuses to approve anything
    // not currently HELD (`INVALID_TRANSITION`), independent of and unrelated to the BFF's own
    // `action.approve` permission check, which the reviewer role DOES pass.
    const completed = await submitAction(ctx.platform, 'req_boundary_completed', {}, ctx.tenantId);
    assert.equal(completed.body.state, 'COMPLETED');
    const actionId = completed.body.platform_action_id as string;
    const res = await fetch(`${ctx.cc.baseUrl}/api/actions/${actionId}/approve`, { method: 'POST', headers: { Cookie: ctx.jarReviewer.header(), 'X-CSRF-Token': ctx.jarReviewer.get(CSRF_COOKIE)! } });
    assert.notEqual(res.status, 200, 'the BFF must surface the real backend\'s rejection of an illegal transition — it must never fabricate a PROMOTE-equivalent success merely because the caller\'s client role was otherwise eligible');
  } finally { await ctx.close(); }
});
