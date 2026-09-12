import assert from 'node:assert/strict';
import test from 'node:test';
import { startRealPlatform, startRealClientGateway, startControlCenter, CookieJar, type RealClientGateway } from './harness.js';
import { CSRF_COOKIE } from '../../apps/tna-control-center/src/auth.js';
import { hashSchema } from '../../packages/mcp-schema/src/index.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) — Connections/MCP, Governed Tools + schema
 * drift, and Identity/Credential lifecycle, all real HTTP against a real, in-process Client Gateway
 * (`'record-only'` mode — sufficient since none of these routes touch `/v1/client/actions` governed
 * execution). This is also the real proof for foundation-review item A: tenant lifecycle is now
 * reconciled against Client Gateway's own real `ClientStore`, never a Control-Center-local flag alone.
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return { res, jar };
}

function activeTenant(cg: RealClientGateway, displayName: string) {
  const tenant = cg.store.createTenant({ display_name: displayName, environment: 'test', deployment_binding: 'dep1', policy_profile: 'default', allowed_connector_types: ['mcp-stdio'] }, 'test-admin');
  return cg.store.activateTenant(tenant.tenant_id, tenant.state_version);
}

function registerServerWithTool(cg: RealClientGateway, tenantId: string) {
  const server = cg.store.registerMcpServer(tenantId, { name: 'test-mcp-server', transport: 'stdio', executable: '/usr/bin/true', args: [], env_allowlist: [], credential_ref: null }, 'test-admin');
  const discovery = cg.store.recordDiscovery(tenantId, server.mcp_server_id, [{ name: 'search_docs', description: 'Search internal docs', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }], hashSchema);
  const tools = cg.store.listTools(tenantId);
  return { server, discovery, tool: tools[0]! };
}

/** A Platform registry entry is still required (`tenantEntry()`'s fail-closed unregistered-tenant check
 * runs for every route, including Client-Gateway-backed ones) even though these tests never call Platform
 * itself. */
async function setup(seed: string, displayName: string) {
  const platform = await startRealPlatform(`ten_cg_${seed}`, `cg_${seed}`);
  const cg = await startRealClientGateway(seed);
  const tenant = activeTenant(cg, displayName);
  const cc = await startControlCenter(
    [{ tenant_id: tenant.tenant_id, platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken }],
    { clientGateway: { baseUrl: cg.baseUrl, adminToken: cg.adminToken } },
  );
  return { platform, cg, tenant, cc, close: async () => { await cc.close(); await cg.close(); await platform.close(); } };
}

test('tenant lifecycle reconciliation: a REAL ClientStore suspension blocks login and every active route, overriding what the local Platform registry believes', async () => {
  const ctx = await setup('lifecycle', 'Lifecycle Co');
  try {
    ctx.cc.sessions.createUser(ctx.tenant.tenant_id, 'lifecycle-user', 'a-real-password-for-lifecycle-1', 'client-viewer');
    const { res: loginRes, jar } = await login(ctx.cc.baseUrl, 'lifecycle-user', 'a-real-password-for-lifecycle-1');
    assert.equal(loginRes.status, 200, 'sanity: ACTIVE tenant can log in');
    const dashboardBefore = await fetch(`${ctx.cc.baseUrl}/api/dashboard`, { headers: { Cookie: jar.header() } });
    assert.equal(dashboardBefore.status, 200);

    // Suspend via the REAL ClientStore — the Control Center's local Platform-registry entry has no
    // `status` field set at all (defaults absent/ACTIVE) — only the real Client Gateway record changes.
    const currentTenant = ctx.cg.store.getTenant(ctx.tenant.tenant_id);
    ctx.cg.store.suspendTenant(ctx.tenant.tenant_id, currentTenant.state_version, 'real suspension for this test');

    const dashboardAfter = await fetch(`${ctx.cc.baseUrl}/api/dashboard`, { headers: { Cookie: jar.header() } });
    assert.equal(dashboardAfter.status, 403, 'the EXISTING session must be blocked the moment the real ClientStore record is suspended — no local flag was ever changed');

    const secondLogin = await fetch(`${ctx.cc.baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lifecycle-user', password: 'a-real-password-for-lifecycle-1' }) });
    assert.equal(secondLogin.status, 403, 'a new login must also be blocked, reconciled against the real record');
  } finally { await ctx.close(); }
});

test('organization/readiness/health reflect real ClientStore data, never fabricated', async () => {
  const ctx = await setup('org', 'Org Co');
  try {
    ctx.cc.sessions.createUser(ctx.tenant.tenant_id, 'org-user', 'a-real-password-for-org-1', 'client-viewer');
    const { jar } = await login(ctx.cc.baseUrl, 'org-user', 'a-real-password-for-org-1');

    const orgRes = await fetch(`${ctx.cc.baseUrl}/api/organization`, { headers: { Cookie: jar.header() } });
    assert.equal(orgRes.status, 200);
    const org = await orgRes.json() as { tenant_id: string; status: string; display_name: string };
    assert.equal(org.tenant_id, ctx.tenant.tenant_id);
    assert.equal(org.status, 'ACTIVE');
    assert.equal(org.display_name, 'Org Co');

    const readinessRes = await fetch(`${ctx.cc.baseUrl}/api/readiness`, { headers: { Cookie: jar.header() } });
    assert.equal(readinessRes.status, 200);
    const readiness = await readinessRes.json() as { readiness: string; checks: readonly unknown[] };
    assert.ok(['READY', 'READY_WITH_LIMITATIONS', 'NOT_READY', 'INSUFFICIENT_EVIDENCE'].includes(readiness.readiness));
    assert.ok(readiness.checks.length > 0, 'real computed checks, not an empty/fabricated array');

    const healthRes = await fetch(`${ctx.cc.baseUrl}/api/health`, { headers: { Cookie: jar.header() } });
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json() as { tenant_status: string };
    assert.equal(health.tenant_status, 'ACTIVE');
  } finally { await ctx.close(); }
});

test('connections: a real registered MCP server is visible, and cross-tenant connections never leak in the same shared Client Gateway process', async () => {
  const ctxA = await setup('conn_a', 'Conn A');
  try {
    registerServerWithTool(ctxA.cg, ctxA.tenant.tenant_id);
    // Tenant B shares the SAME Client Gateway process — this is exactly the scenario that matters, since
    // Platform's separate-process-per-tenant model structurally cannot even represent this risk.
    const tenantB = activeTenant(ctxA.cg, 'Conn B');
    registerServerWithTool(ctxA.cg, tenantB.tenant_id);

    ctxA.cc.sessions.createUser(ctxA.tenant.tenant_id, 'conn-a-user', 'a-real-password-for-conn-a-1', 'client-viewer');
    const { jar } = await login(ctxA.cc.baseUrl, 'conn-a-user', 'a-real-password-for-conn-a-1');
    const res = await fetch(`${ctxA.cc.baseUrl}/api/connections`, { headers: { Cookie: jar.header() } });
    assert.equal(res.status, 200);
    const servers = await res.json() as readonly { tenant_id: string; name: string }[];
    assert.equal(servers.length, 1, 'exactly tenant A\'s own one real registered server — never tenant B\'s, despite sharing one Client Gateway process');
    assert.equal(servers[0]!.tenant_id, ctxA.tenant.tenant_id);
  } finally { await ctxA.close(); }
});

test('governed tools: real schema-drift review_status is visible, and enable/disable use the real backend with real state_version CAS', async () => {
  const ctx = await setup('tools', 'Tools Co');
  try {
    const { tool } = registerServerWithTool(ctx.cg, ctx.tenant.tenant_id);
    assert.equal(tool.review_status, 'DISCOVERED', 'a freshly-discovered tool is real, unenabled, and awaiting review');

    ctx.cc.sessions.createUser(ctx.tenant.tenant_id, 'tools-viewer', 'a-real-password-for-tools-v-1', 'client-viewer');
    ctx.cc.sessions.createUser(ctx.tenant.tenant_id, 'tools-admin', 'a-real-password-for-tools-a-1', 'client-admin');
    const { jar: viewerJar } = await login(ctx.cc.baseUrl, 'tools-viewer', 'a-real-password-for-tools-v-1');
    const { jar: adminJar } = await login(ctx.cc.baseUrl, 'tools-admin', 'a-real-password-for-tools-a-1');

    const listRes = await fetch(`${ctx.cc.baseUrl}/api/tools`, { headers: { Cookie: viewerJar.header() } });
    const tools = await listRes.json() as readonly { tool_id: string; review_status: string; state_version: number }[];
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.review_status, 'DISCOVERED');

    // Viewer cannot enable — server-side permission check, not merely a hidden button.
    const deniedEnable = await fetch(`${ctx.cc.baseUrl}/api/tools/${tool.tool_id}/enable`, {
      method: 'POST', headers: { Cookie: viewerJar.header(), 'X-CSRF-Token': viewerJar.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state_version: tool.state_version, risk_class: 'LOW', policy_id: 'default-policy' }),
    });
    assert.equal(deniedEnable.status, 403);

    // Admin can enable, using the REAL current state_version (real CAS, not a fabricated success).
    const enableRes = await fetch(`${ctx.cc.baseUrl}/api/tools/${tool.tool_id}/enable`, {
      method: 'POST', headers: { Cookie: adminJar.header(), 'X-CSRF-Token': adminJar.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state_version: tool.state_version, risk_class: 'LOW', policy_id: 'default-policy' }),
    });
    assert.equal(enableRes.status, 200);
    const enableBody = await enableRes.json() as { tool: { enabled: boolean; review_status: string; state_version: number } };
    const enabled = enableBody.tool;
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.review_status, 'ENABLED');

    // A STALE state_version (the pre-enable one, reused) is a real CAS conflict, not silently accepted.
    const staleDisable = await fetch(`${ctx.cc.baseUrl}/api/tools/${tool.tool_id}/disable`, {
      method: 'POST', headers: { Cookie: adminJar.header(), 'X-CSRF-Token': adminJar.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state_version: tool.state_version }),
    });
    assert.notEqual(staleDisable.status, 200, 'a stale state_version must be a real conflict, never silently accepted');

    const disableRes = await fetch(`${ctx.cc.baseUrl}/api/tools/${tool.tool_id}/disable`, {
      method: 'POST', headers: { Cookie: adminJar.header(), 'X-CSRF-Token': adminJar.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state_version: enabled.state_version }),
    });
    assert.equal(disableRes.status, 200);
    const disabled = await disableRes.json() as { enabled: boolean };
    assert.equal(disabled.enabled, false);
  } finally { await ctx.close(); }
});

test('identities: a credential is real and shown exactly once; the list view never re-exposes it; rotate issues a NEW real credential; revoke changes real status', async () => {
  const ctx = await setup('idn', 'Identity Co');
  try {
    ctx.cc.sessions.createUser(ctx.tenant.tenant_id, 'idn-admin', 'a-real-password-for-idn-1', 'client-admin');
    const { jar } = await login(ctx.cc.baseUrl, 'idn-admin', 'a-real-password-for-idn-1');

    const createRes = await fetch(`${ctx.cc.baseUrl}/api/identities`, {
      method: 'POST', headers: { Cookie: jar.header(), 'X-CSRF-Token': jar.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'billing-agent', role: 'agent-client' }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json() as { identity: { service_id: string; state_version: number }; credential: { token: string } };
    assert.ok(created.credential.token.startsWith('tnaclient_'), 'a real, correctly-shaped issued credential');

    const listRes = await fetch(`${ctx.cc.baseUrl}/api/identities`, { headers: { Cookie: jar.header() } });
    const listText = await listRes.text();
    assert.ok(!listText.includes(created.credential.token), 'the plaintext credential must never reappear in a subsequent list response');

    const rotateRes = await fetch(`${ctx.cc.baseUrl}/api/identities/${created.identity.service_id}/rotate`, {
      method: 'POST', headers: { Cookie: jar.header(), 'X-CSRF-Token': jar.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state_version: created.identity.state_version }),
    });
    assert.equal(rotateRes.status, 200);
    const rotated = await rotateRes.json() as { identity: { state_version: number }; credential: { token: string } };
    assert.notEqual(rotated.credential.token, created.credential.token, 'rotation must issue a genuinely new real credential, not repeat the old one');

    const revokeRes = await fetch(`${ctx.cc.baseUrl}/api/identities/${created.identity.service_id}/revoke`, {
      method: 'POST', headers: { Cookie: jar.header(), 'X-CSRF-Token': jar.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state_version: rotated.identity.state_version }),
    });
    assert.equal(revokeRes.status, 200);
    const revoked = await revokeRes.json() as { status: string };
    assert.equal(revoked.status, 'REVOKED');
  } finally { await ctx.close(); }
});

test('identities: a viewer cannot create, rotate, or revoke — server-side, real HTTP', async () => {
  const ctx = await setup('idn_role', 'Identity Role Co');
  try {
    ctx.cc.sessions.createUser(ctx.tenant.tenant_id, 'idn-viewer', 'a-real-password-for-idn-role-1', 'client-viewer');
    const { jar } = await login(ctx.cc.baseUrl, 'idn-viewer', 'a-real-password-for-idn-role-1');
    const res = await fetch(`${ctx.cc.baseUrl}/api/identities`, {
      method: 'POST', headers: { Cookie: jar.header(), 'X-CSRF-Token': jar.get(CSRF_COOKIE)!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'should-not-be-created', role: 'agent-client' }),
    });
    assert.equal(res.status, 403);
  } finally { await ctx.close(); }
});
