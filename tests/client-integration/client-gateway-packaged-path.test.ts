import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execPath } from 'node:process';

import { PlatformStore, reconstructPlatformAction } from '../../packages/platform-core/src/index.js';
import { Ledger, LedgerStore } from '../../packages/ledger-core/src/index.js';
import { platformLedgerReader } from '../../apps/tna-ledger/src/writers.js';
import { SentinelRuntime, adminPrincipal as sentinelAdminPrincipal } from '../../packages/sentinel-runtime/src/index.js';

/**
 * TNA Client Integration & MCP Gateway v0.1 — Packaged-Execution Closure.
 *
 * Every test here spawns and drives the ACTUAL compiled production entrypoint
 * (`dist/apps/tna-client-gateway/src/main.js`) as a real, separate OS process, over real TCP HTTP — no
 * in-process handler construction anywhere in this file. This is the direct answer to the one mandatory
 * blocker the final review found: the packaged binary had never actually been exercised end-to-end, so
 * `POST /v1/client/actions` silently ran only the honest-but-non-governed `state: 'RECORDED'` mode
 * (main.ts never wired a PlatformFacade). It now does (see `governed-execution.ts`), and this file is
 * the proof — including a genuine, previously-undetected defect this closure pass found and fixed: the
 * original packaged path used a `platform-service`-role principal to drive execution, which
 * `PlatformExecutionOrchestrator.run` unconditionally rejects (it requires a tenant-bound
 * `platform-agent`) — meaning even with a facade wired, every real submission through the packaged
 * binary would have failed at the Gate-authorization step. That was only found by actually calling the
 * packaged HTTP endpoint, exactly the failure mode "prove it through the packaged binary" exists to
 * catch.
 *
 * Real evidence, not inferred from final status alone: every ALLOW/BLOCK/Sentinel-prevention assertion
 * below additionally opens the gateway's own real `PlatformStore`/`Ledger`/`SentinelRuntime` SQLite
 * files directly (the same files the running process has open, via WAL-mode concurrent access — the
 * same technique `client-gateway-container.test.ts` and the config-snapshot-immutability test already
 * use) and inspects `gate_decision`, `capability_id`, `sentinel_session_id`, and `result_hash` — never
 * just the HTTP response's `state` field.
 *
 * SIGTERM caveat (matches `tests/deployment/deployment-shutdown.test.ts`): Node's `child.kill('SIGTERM')`
 * only delivers a real, JS-handleable signal on POSIX. On native Windows it force-terminates the process
 * without ever running `main.ts`'s shutdown handler (a documented Node/Windows platform limitation, not
 * a product defect) — so the exit-code-0/"Graceful shutdown complete" assertions below are POSIX-only.
 * The authoritative graceful-shutdown proof on every platform is `client-gateway-container.test.ts`'s
 * real `docker stop`, which this closure extends to cover the real governed path (see that file).
 */

const FIXTURE_JS = resolve('dist', 'scripts', 'fixtures', 'mcp-fixture-server.js').replace(/\\/g, '/');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}

/** A real MCP child-process wrapper: sets `MCP_FIXTURE_MODE` from a *file* it reads at import time
 * (rather than inheriting it from the gateway's own environment), so a test can change a registered MCP
 * server's effective behavior between two real `/discover` calls without ever changing its registered
 * `executable`/`args` — exactly what proving genuine schema *drift* (same server, same tool, changed
 * schema) through the real admin HTTP API requires. */
function writeModeWrapper(dir: string, modeFilePath: string): string {
  const wrapperPath = resolve(dir, `mode-wrapper-${randomUUID().slice(0, 8)}.mjs`);
  const content = [
    "import { readFileSync } from 'node:fs';",
    `process.env.MCP_FIXTURE_MODE = readFileSync(${JSON.stringify(modeFilePath)}, 'utf8').trim();`,
    `await import(${JSON.stringify(`file://${FIXTURE_JS}`)});`,
    '',
  ].join('\n');
  writeFileSync(wrapperPath, content);
  return wrapperPath;
}
function writeFixedModeWrapper(dir: string, mode: string): string {
  const modeFile = resolve(dir, `mode-${randomUUID().slice(0, 8)}.txt`);
  writeFileSync(modeFile, mode);
  return writeModeWrapper(dir, modeFile);
}

type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>;

interface GatewayHandle {
  readonly proc: SpawnedProcess;
  readonly baseUrl: string;
  readonly dataDir: string;
  readonly adminToken: string;
  readonly stdout: string[];
  readonly stderr: string[];
}

async function spawnGateway(env: NodeJS.ProcessEnv): Promise<GatewayHandle> {
  const port = await freePort();
  const dataDir = mkdtempSync(resolve(tmpdir(), 'tna-client-gateway-packaged-'));
  const adminToken = `admin-${'x'.repeat(30)}`;
  const proc = spawn(execPath, [resolve('dist', 'apps', 'tna-client-gateway', 'src', 'main.js')], {
    env: {
      ...process.env, ...env,
      TNA_CLIENT_ADMIN_TOKEN: adminToken, TNA_CLIENT_DB_PATH: resolve(dataDir, 'client.sqlite'),
      TNA_CLIENT_DATA_DIR: dataDir, TNA_CLIENT_HOST: '127.0.0.1', TNA_CLIENT_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: string[] = []; const stderr: string[] = [];
  proc.stdout.on('data', chunk => stdout.push(String(chunk)));
  proc.stderr.on('data', chunk => stderr.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let live = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`gateway exited early (code ${proc.exitCode}): ${stderr.join('')}`);
    try { const res = await fetch(`${baseUrl}/live`); if (res.status === 200) { live = true; break; } } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  if (!live) throw new Error(`gateway never became live: stdout=${stdout.join('')} stderr=${stderr.join('')}`);
  return { proc, baseUrl, dataDir, adminToken, stdout, stderr };
}

async function stopGateway(gw: GatewayHandle): Promise<number | null> {
  gw.proc.kill('SIGTERM');
  return new Promise<number | null>(resolvePromise => gw.proc.on('exit', code => resolvePromise(code)));
}

function adminHeaders(gw: GatewayHandle): Record<string, string> { return { Authorization: `Bearer ${gw.adminToken}`, 'Content-Type': 'application/json' }; }
function clientHeaders(token: string): Record<string, string> { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }

/** Reads the response body exactly once as text, asserts the expected status (the raw text becomes the
 * assertion failure message, so a non-matching status is still diagnosable), then parses it as JSON. */
async function expectJson<T>(res: Response, expectedStatus: number): Promise<T> {
  const text = await res.text();
  assert.equal(res.status, expectedStatus, `expected HTTP ${expectedStatus}, got ${res.status}: ${text}`);
  return text.length === 0 ? ({} as T) : JSON.parse(text) as T;
}

interface OnboardedTenant {
  readonly tenantId: string; readonly serviceToken: string; readonly serviceId: string;
  readonly mcpServerId: string; readonly toolId: string; readonly toolPlatformId: string;
}

/** Full real onboarding through the packaged binary's own admin HTTP API: tenant, service identity,
 * MCP server registration, real discovery (a real child process spawn), risk-agnostic tool enablement
 * bound to `resourcePattern`, and tenant activation. Mirrors Flow 1 of the accepted demo script, but
 * entirely over real HTTP against the real packaged binary rather than direct library calls. */
async function onboardTenant(gw: GatewayHandle, label: string, wrapperPath: string, resourcePattern: string): Promise<OnboardedTenant> {
  const tenantRes = await fetch(`${gw.baseUrl}/v1/admin/tenants`, {
    method: 'POST', headers: adminHeaders(gw),
    body: JSON.stringify({ display_name: label, environment: 'development', deployment_binding: `packaged-test-${label}`, policy_profile: 'default', allowed_connector_types: ['mcp-stdio'] }),
  });
  const tenant = await expectJson<{ tenant_id: string; state_version: number }>(tenantRes, 201);

  const serviceRes = await fetch(`${gw.baseUrl}/v1/admin/tenants/${tenant.tenant_id}/services`, {
    method: 'POST', headers: adminHeaders(gw), body: JSON.stringify({ name: `${label}-agent`, role: 'agent-client' }),
  });
  const service = await expectJson<{ identity: { service_id: string }; credential: { token: string } }>(serviceRes, 201);

  const mcpRes = await fetch(`${gw.baseUrl}/v1/admin/tenants/${tenant.tenant_id}/mcp-servers`, {
    method: 'POST', headers: adminHeaders(gw),
    body: JSON.stringify({ name: `${label}-crm`, transport: 'stdio', executable: execPath, args: [wrapperPath], env_allowlist: [], credential_ref: null }),
  });
  const mcpServer = await expectJson<{ mcp_server_id: string }>(mcpRes, 201);

  const discoverRes = await fetch(`${gw.baseUrl}/v1/admin/tenants/${tenant.tenant_id}/mcp-servers/${mcpServer.mcp_server_id}/discover`, { method: 'POST', headers: adminHeaders(gw), body: '{}' });
  await expectJson(discoverRes, 200);

  const toolsRes = await fetch(`${gw.baseUrl}/v1/admin/tenants/${tenant.tenant_id}/tools`, { headers: adminHeaders(gw) });
  const tools = await expectJson<{ tool_id: string; external_tool_name: string; state_version: number }[]>(toolsRes, 200);
  const lookupTool = tools.find(t => t.external_tool_name === 'crm.lookup_customer')!;
  assert.ok(lookupTool, 'the real fixture must have advertised crm.lookup_customer');

  const enableRes = await fetch(`${gw.baseUrl}/v1/admin/tenants/${tenant.tenant_id}/tools/${lookupTool.tool_id}/enable`, {
    method: 'POST', headers: adminHeaders(gw),
    body: JSON.stringify({
      state_version: lookupTool.state_version, risk_class: 'LOW', allowed_operations: ['read'],
      resource_patterns: [resourcePattern], requires_human_approval: false, requires_vad: false,
      policy_id: `policy-${label}`, runtime_limits: {}, cost_limits: {},
    }),
  });
  await expectJson(enableRes, 200);

  const activateRes = await fetch(`${gw.baseUrl}/v1/admin/tenants/${tenant.tenant_id}/activate`, {
    method: 'POST', headers: adminHeaders(gw), body: JSON.stringify({ state_version: tenant.state_version }),
  });
  await expectJson(activateRes, 200);

  return {
    tenantId: tenant.tenant_id, serviceToken: service.credential.token, serviceId: service.identity.service_id,
    mcpServerId: mcpServer.mcp_server_id, toolId: lookupTool.tool_id, toolPlatformId: `mcp.${lookupTool.tool_id}`,
  };
}

interface ClientActionResponse {
  readonly client_action_id: string; readonly platform_action_id?: string; readonly correlation_id?: string;
  readonly state: string; readonly config_snapshot_hash: string;
}

let workDir: string;
let normalWrapper: string;
let gateway: GatewayHandle;

before(async () => {
  workDir = mkdtempSync(resolve(tmpdir(), 'tna-packaged-path-wrappers-'));
  normalWrapper = writeFixedModeWrapper(workDir, 'normal');
  gateway = await spawnGateway({});
});

after(async () => {
  const exitCode = await stopGateway(gateway);
  if (process.platform !== 'win32') {
    assert.equal(exitCode, 0, `gateway must exit 0 on SIGTERM; stderr=${gateway.stderr.join('')}`);
    assert.ok(gateway.stdout.join('').includes('Graceful shutdown complete'), 'the shutdown handler must actually run to completion');
  }
  rmSync(workDir, { recursive: true, force: true });
});

test('packaged governed ALLOW path: real Gate ALLOW, real Capability/Sentinel/MCP, real Ledger evidence, correlation preserved, and a body-supplied tenant_id cannot redirect the authenticated tenant', async () => {
  const tenant = await onboardTenant(gateway, `allow-${randomUUID().slice(0, 6)}`, normalWrapper, '/workspace/crm/**');

  const actionRes = await fetch(`${gateway.baseUrl}/v1/client/actions`, {
    method: 'POST', headers: clientHeaders(tenant.serviceToken),
    body: JSON.stringify({
      tool_id: tenant.toolId, resource: '/workspace/crm/customer/42', input: { customer_id: 'cust-42' },
      // §11: a caller-supplied tenant_id must never redirect execution — the authenticated service
      // identity's own tenant remains authoritative. This field is not read anywhere in the client
      // route handler; its presence here proves that, not merely assumes it.
      tenant_id: 'ten_should-be-ignored-completely',
    }),
  });
  const action = await expectJson<ClientActionResponse>(actionRes, 201);
  assert.equal(action.state, 'COMPLETED', 'a real Gate ALLOW -> Capability -> Sentinel CONTINUE -> real MCP call must complete the action: ' + JSON.stringify(action));
  assert.ok(action.platform_action_id);
  assert.ok(action.correlation_id);

  // Real evidence, not inferred from `state` alone: open the gateway's own real PlatformStore file.
  const platform = new PlatformStore(resolve(gateway.dataDir, 'tna-client-gateway-platform.sqlite'));
  try {
    const stored = platform.get(tenant.tenantId, action.platform_action_id!);
    assert.equal(stored.tenant_id, tenant.tenantId, 'the action must be bound to the AUTHENTICATED tenant, never the spoofed body tenant_id');
    assert.equal(stored.gate_decision?.decision, 'ALLOW');
    assert.ok(stored.capability_id, 'a real capability must have been issued');
    assert.ok(stored.sentinel_session_id, 'a real Sentinel session must have been created');
    assert.ok(stored.result_hash, 'a real result hash proves the real MCP fixture actually responded — impossible without initialize, tools/call, and a returned result all having genuinely occurred');
    assert.equal(stored.correlation_id, action.correlation_id);
    assert.equal(stored.request.tool, tenant.toolPlatformId);
    assert.equal((stored.request.metadata as Record<string, unknown> | undefined)?.client_action_id, action.client_action_id, 'end-to-end correlation: the client_action_id minted before the platform ever saw this request must survive into the platform request that becomes Ledger evidence');
  } finally { platform.close(); }

  // Real Ledger evidence — the outbox dispatch loop (main.ts) delivers into the SAME Ledger file the
  // running gateway process writes to; poll with bounded retries rather than a fixed sleep.
  const ledgerStore = new LedgerStore(resolve(gateway.dataDir, 'tna-client-gateway-ledger.sqlite'));
  try {
    const ledger = new Ledger(ledgerStore);
    const reader = platformLedgerReader(tenant.tenantId);
    let events: ReturnType<typeof ledger.getStream>['items'] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      events = ledger.getStream(reader, `platform:${action.platform_action_id}`).items;
      if (events.some(e => e.event_type === 'PLATFORM_ACTION_COMPLETED')) break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.ok(events.length > 0, 'real Ledger evidence must exist for the real platform action');
    const completed = events.find(e => e.event_type === 'PLATFORM_ACTION_COMPLETED');
    assert.ok(completed, 'a PLATFORM_ACTION_COMPLETED Ledger event must exist');
    assert.equal(completed!.tenant_id, tenant.tenantId);
    assert.equal(completed!.correlation_id, action.correlation_id);
    assert.equal(completed!.authority_context?.tool, tenant.toolPlatformId, 'the governed_tool_id is encoded in the Ledger authority_context.tool (mcp.<tool_id>)');
  } finally { ledgerStore.close(); }
});

test('packaged Gate BLOCK path: an enabled tool requested outside its bound resource pattern is blocked by real Gate policy — Capability/Sentinel/MCP never engage', async () => {
  const tenant = await onboardTenant(gateway, `block-${randomUUID().slice(0, 6)}`, normalWrapper, '/workspace/crm/**');

  const actionRes = await fetch(`${gateway.baseUrl}/v1/client/actions`, {
    method: 'POST', headers: clientHeaders(tenant.serviceToken),
    body: JSON.stringify({ tool_id: tenant.toolId, resource: '/workspace/other/forbidden', input: { customer_id: 'cust-42' } }),
  });
  const action = await expectJson<ClientActionResponse>(actionRes, 201);
  assert.notEqual(action.state, 'COMPLETED');
  assert.ok(action.platform_action_id);

  const platform = new PlatformStore(resolve(gateway.dataDir, 'tna-client-gateway-platform.sqlite'));
  try {
    const stored = platform.get(tenant.tenantId, action.platform_action_id!);
    assert.equal(stored.gate_decision?.decision, 'BLOCK', 'Gate itself — not a client-layer shortcut — must be the one refusing this request');
    assert.equal(stored.gate_decision?.reason, 'Undeclared resource or operation');
    assert.equal(stored.capability_id, null, 'no capability may be issued for a Gate BLOCK');
    assert.equal(stored.sentinel_session_id, null, 'no Sentinel session may be created for a Gate BLOCK');
    assert.equal(stored.result_hash, null, 'the real MCP fixture must never have been invoked');
  } finally { platform.close(); }
});

test('packaged Sentinel prevention: a real emergency stop (accepted Sentinel admin API) TERMINATEs the session before the real MCP fixture is ever invoked', async () => {
  const tenant = await onboardTenant(gateway, `sentinel-${randomUUID().slice(0, 6)}`, normalWrapper, '/workspace/crm/**');

  // A real, accepted, admin-only Sentinel operation — not a fake/mocked SentinelPort. Applied directly
  // against the gateway's own live Sentinel store file (the same one the running process has open,
  // WAL-mode concurrent access), exactly the way a real operator's Sentinel control-plane tool would.
  const sentinel = new SentinelRuntime(resolve(gateway.dataDir, 'tna-client-gateway-sentinel.sqlite'));
  try { sentinel.activateStop(sentinelAdminPrincipal('closure-test-sentinel-admin', tenant.tenantId), 'tenant', tenant.tenantId, 'packaged-path closure test emergency stop'); }
  finally { sentinel.close(); }

  const actionRes = await fetch(`${gateway.baseUrl}/v1/client/actions`, {
    method: 'POST', headers: clientHeaders(tenant.serviceToken),
    body: JSON.stringify({ tool_id: tenant.toolId, resource: '/workspace/crm/customer/1', input: { customer_id: 'cust-1' } }),
  });
  const action = await expectJson<ClientActionResponse>(actionRes, 201);
  assert.notEqual(action.state, 'COMPLETED');
  assert.ok(action.platform_action_id);

  const platform = new PlatformStore(resolve(gateway.dataDir, 'tna-client-gateway-platform.sqlite'));
  try {
    const stored = platform.get(tenant.tenantId, action.platform_action_id!);
    assert.equal(stored.gate_decision?.decision, 'ALLOW', 'Gate must have allowed this — proving Sentinel, not Gate, is what stopped it');
    assert.ok(stored.capability_id, 'a capability is issued before the Sentinel pre-action check runs');
    assert.ok(stored.sentinel_session_id, 'a real Sentinel session was created');
    assert.equal(stored.result_hash, null, 'the real MCP fixture must never have been invoked once Sentinel terminated the session pre-action');
    assert.equal(stored.error_code, 'SENTINEL_TERMINATED');
  } finally { platform.close(); }
});

test('packaged cross-tenant rejection: one tenant\'s credential cannot reach another tenant\'s governed tool through the real HTTP API', async () => {
  const tenantA = await onboardTenant(gateway, `crossA-${randomUUID().slice(0, 6)}`, normalWrapper, '/workspace/crm/**');
  const tenantB = await onboardTenant(gateway, `crossB-${randomUUID().slice(0, 6)}`, normalWrapper, '/workspace/crm/**');

  const actionRes = await fetch(`${gateway.baseUrl}/v1/client/actions`, {
    method: 'POST', headers: clientHeaders(tenantA.serviceToken),
    body: JSON.stringify({ tool_id: tenantB.toolId, resource: '/workspace/crm/customer/1', input: { customer_id: 'cust-1' } }),
  });
  const body = await expectJson<{ code?: string }>(actionRes, 404);
  assert.equal(body.code, 'NOT_FOUND', "Tenant A's authenticated identity must never resolve Tenant B's tool_id — tenant scoping happens before the platform is ever reached");

  const platform = new PlatformStore(resolve(gateway.dataDir, 'tna-client-gateway-platform.sqlite'));
  try {
    const tenantBActions = platform.list(tenantB.tenantId);
    assert.ok(tenantBActions.items.every(item => item.request.agent_id !== `client:${tenantA.serviceId}`), "no platform action for Tenant B's tenant may have been created on Tenant A's behalf");
  } finally { platform.close(); }
});

test('packaged schema drift rejection: real rediscovery of the same MCP server with a changed schema disables the tool before any HTTP submission reaches Gate', async () => {
  const modeFile = resolve(workDir, `drift-mode-${randomUUID().slice(0, 8)}.txt`);
  writeFileSync(modeFile, 'normal');
  const driftWrapper = writeModeWrapper(workDir, modeFile);
  const tenant = await onboardTenant(gateway, `drift-${randomUUID().slice(0, 6)}`, driftWrapper, '/workspace/crm/**');

  // Confirm the tool genuinely works before drift (schema H1).
  const beforeRes = await fetch(`${gateway.baseUrl}/v1/client/actions`, {
    method: 'POST', headers: clientHeaders(tenant.serviceToken),
    body: JSON.stringify({ tool_id: tenant.toolId, resource: '/workspace/crm/customer/1', input: { customer_id: 'cust-1' } }),
  });
  const before = await expectJson<ClientActionResponse>(beforeRes, 201);
  assert.equal(before.state, 'COMPLETED');

  // Change the *same registered server's* effective schema (H1 -> H2) without touching its registered
  // executable/args, then rediscover through the real admin HTTP API — genuine drift, not a new server.
  writeFileSync(modeFile, 'schema-v2');
  const rediscoverRes = await fetch(`${gateway.baseUrl}/v1/admin/tenants/${tenant.tenantId}/mcp-servers/${tenant.mcpServerId}/discover`, { method: 'POST', headers: adminHeaders(gateway), body: '{}' });
  const discovery = await expectJson<{ driftDetected: string[] }>(rediscoverRes, 200);
  assert.ok(discovery.driftDetected.includes(tenant.toolId), 'the real rediscovery must have detected the schema change on the same tool_id');

  const toolRes = await fetch(`${gateway.baseUrl}/v1/admin/tenants/${tenant.tenantId}/tools`, { headers: adminHeaders(gateway) });
  const tools = await expectJson<{ tool_id: string; enabled: boolean; review_status: string }[]>(toolRes, 200);
  const drifted = tools.find(t => t.tool_id === tenant.toolId)!;
  assert.equal(drifted.enabled, false);
  assert.equal(drifted.review_status, 'POLICY_REVIEW_REQUIRED');

  const afterRes = await fetch(`${gateway.baseUrl}/v1/client/actions`, {
    method: 'POST', headers: clientHeaders(tenant.serviceToken),
    body: JSON.stringify({ tool_id: tenant.toolId, resource: '/workspace/crm/customer/2', input: { customer_id: 'cust-2' } }),
  });
  const after = await expectJson<{ code?: string }>(afterRes, 409);
  assert.equal(after.code, 'TOOL_NOT_ENABLED', 'a drifted tool must be refused before Gate is ever reached, and the real MCP fixture must never be invoked for this request');
});

test('packaged suspension and offboarding boundaries: ACTIVE works, SUSPENDED and OFFBOARDED are rejected, and historical evidence remains intact for a trusted operator path', async () => {
  const suspended = await onboardTenant(gateway, `suspend-${randomUUID().slice(0, 6)}`, normalWrapper, '/workspace/crm/**');

  const activeRes = await fetch(`${gateway.baseUrl}/v1/client/actions`, {
    method: 'POST', headers: clientHeaders(suspended.serviceToken),
    body: JSON.stringify({ tool_id: suspended.toolId, resource: '/workspace/crm/customer/1', input: { customer_id: 'cust-1' } }),
  });
  const activeAction = await expectJson<ClientActionResponse>(activeRes, 201);
  assert.equal(activeAction.state, 'COMPLETED', 'an ACTIVE tenant must be able to submit a real governed action');

  const tenantRes = await fetch(`${gateway.baseUrl}/v1/admin/tenants/${suspended.tenantId}`, { headers: adminHeaders(gateway) });
  const tenantState = await expectJson<{ state_version: number }>(tenantRes, 200);
  const suspendRes = await fetch(`${gateway.baseUrl}/v1/admin/tenants/${suspended.tenantId}/suspend`, {
    method: 'POST', headers: adminHeaders(gateway), body: JSON.stringify({ state_version: tenantState.state_version, reason: 'closure test suspension' }),
  });
  await expectJson(suspendRes, 200);

  const suspendedActionRes = await fetch(`${gateway.baseUrl}/v1/client/actions`, {
    method: 'POST', headers: clientHeaders(suspended.serviceToken),
    body: JSON.stringify({ tool_id: suspended.toolId, resource: '/workspace/crm/customer/2', input: { customer_id: 'cust-2' } }),
  });
  const suspendedBody = await expectJson<{ code?: string }>(suspendedActionRes, 409);
  assert.equal(suspendedBody.code, 'TENANT_NOT_ACTIVE');

  // Historical evidence — the pre-suspension COMPLETED action — remains intact and reconstructible via
  // a trusted operator's own direct access to the real PlatformStore (mirrors the accepted demo's
  // Flow 5/6 reconstruction proof, now checked against the packaged binary's own real data files).
  const platform = new PlatformStore(resolve(gateway.dataDir, 'tna-client-gateway-platform.sqlite'));
  try {
    const reconstruction = reconstructPlatformAction(platform, suspended.tenantId, activeAction.platform_action_id!);
    assert.equal(reconstruction.final_status, 'COMPLETED');
  } finally { platform.close(); }

  const offboarded = await onboardTenant(gateway, `offboard-${randomUUID().slice(0, 6)}`, normalWrapper, '/workspace/crm/**');
  const offboardTenantRes = await fetch(`${gateway.baseUrl}/v1/admin/tenants/${offboarded.tenantId}`, { headers: adminHeaders(gateway) });
  const offboardTenantState = await expectJson<{ state_version: number }>(offboardTenantRes, 200);
  const offboardRes = await fetch(`${gateway.baseUrl}/v1/admin/tenants/${offboarded.tenantId}/offboard`, {
    method: 'POST', headers: adminHeaders(gateway), body: JSON.stringify({ state_version: offboardTenantState.state_version, reason: 'closure test offboarding' }),
  });
  await expectJson(offboardRes, 200);

  const offboardedActionRes = await fetch(`${gateway.baseUrl}/v1/client/actions`, {
    method: 'POST', headers: clientHeaders(offboarded.serviceToken),
    body: JSON.stringify({ tool_id: offboarded.toolId, resource: '/workspace/crm/customer/1', input: { customer_id: 'cust-1' } }),
  });
  await expectJson(offboardedActionRes, 401);
});

test('production configuration fails closed: NODE_ENV=production with CLIENT_GATEWAY_MODE=record-only refuses to start; governed mode starts normally in production', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'tna-client-gateway-prod-fail-'));
  const port = await freePort();
  const proc = spawn(execPath, [resolve('dist', 'apps', 'tna-client-gateway', 'src', 'main.js')], {
    env: {
      ...process.env, NODE_ENV: 'production', CLIENT_GATEWAY_MODE: 'record-only',
      TNA_CLIENT_ADMIN_TOKEN: `admin-${'x'.repeat(30)}`, TNA_CLIENT_DB_PATH: resolve(dataDir, 'client.sqlite'),
      TNA_CLIENT_DATA_DIR: dataDir, TNA_CLIENT_HOST: '127.0.0.1', TNA_CLIENT_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  proc.stderr.on('data', chunk => stderr.push(String(chunk)));
  const exitCode = await new Promise<number | null>(resolvePromise => proc.on('exit', code => resolvePromise(code)));
  assert.notEqual(exitCode, 0, 'production + record-only must refuse to start rather than serving an ungoverned endpoint');
  assert.ok(stderr.join('').includes('record-only'), 'the failure reason must be diagnosable, not a bare crash');
  rmSync(dataDir, { recursive: true, force: true });

  // Positive control: production does NOT categorically refuse to start — only the record-only
  // combination does. Governed mode (the default) must start normally under NODE_ENV=production.
  const prodGoverned = await spawnGateway({ NODE_ENV: 'production' });
  try {
    const ready = await fetch(`${prodGoverned.baseUrl}/ready`);
    assert.equal(ready.status, 200);
    const readyBody = await ready.json() as { governed_execution: boolean };
    assert.equal(readyBody.governed_execution, true);
  } finally {
    await stopGateway(prodGoverned);
  }
});
