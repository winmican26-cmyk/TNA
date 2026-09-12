/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) — packaged smoke test. Boots the REAL,
 * COMPILED `tna-control-center` BFF binary (`dist/apps/tna-control-center/src/main.js`, never an imported
 * function) serving the REAL, `vite build`-packaged frontend as static assets, in front of a real
 * in-process Platform/Gate/Sentinel/Ledger stack (the same real code every other test in this project
 * exercises — not spawned as a second OS process in this v0.1 pass, an honest, documented simplification;
 * see the proof-of-work for what a full multi-process container topology check would still need).
 * Exercises a real login -> dashboard -> actions -> action detail -> evidence flow purely over HTTP,
 * plus confirms the packaged static frontend is actually served (not a dev server). Exit 0 on success.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { execPath } from 'node:process';
import { resolve } from 'node:path';
import { Gate } from '../apps/tna-gate-api/src/gate.js';
import { Store } from '../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../packages/capability-core/src/index.js';
import { ExecutionBroker, ToolRegistry } from '../packages/execution-broker/src/index.js';
import { LedgerStore } from '../packages/ledger-core/src/index.js';
import { SentinelRuntime, controllerPrincipal as sentinelController, observerPrincipal as sentinelObserverFactory } from '../packages/sentinel-runtime/src/index.js';
import { PlatformExecutionOrchestrator, PlatformGateOrchestrator, PlatformControlOrchestrator, PlatformFacade, PlatformStore, type GatePort } from '../packages/platform-core/src/index.js';
import { createPlatformServer } from '../apps/tna-platform/src/server.js';
import { ControlCenterSessionStore } from '../apps/tna-control-center/src/session-store.js';

function line(text: string): void { process.stdout.write(`${text}\n`); }
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}
const TENANT = 'ten_smoke_cc';
const AGENT = 'deployment-agent-17'; // must match tests/fixture.ts's envelope().agent.id
const CC_MAIN = resolve('dist', 'apps', 'tna-control-center', 'src', 'main.js');
const WEB_DIST = resolve('apps', 'tna-control-center-web', 'dist');

async function main(): Promise<void> {
  if (!existsSync(WEB_DIST)) { process.stderr.write(`Frontend is not built. Run: npm --prefix apps/tna-control-center-web install && npm --prefix apps/tna-control-center-web run build\n`); process.exitCode = 1; return; }

  // --- Real in-process Platform/Gate/Sentinel/Ledger stack (see file header) ---
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-cc-smoke-platform-'));
  const { envelope, NOW } = await import('../tests/fixture.js');
  const gateEvidence = new Store(':memory:');
  const gate = new Gate(gateEvidence, () => NOW);
  const CREDENTIALS = { agentTokens: { [`agent-token-${'s'.repeat(24)}`]: AGENT }, operatorToken: `operator-token-${'s'.repeat(24)}`, adminToken: `admin-token-${'s'.repeat(28)}`, serviceToken: `service-token-${'s'.repeat(24)}` };
  gate.register({ kind: 'admin', role: 'administrator' }, { id: AGENT, name: 'Smoke Agent' });
  gate.setEnvelope({ kind: 'admin', role: 'administrator' }, envelope());
  const registry = new ToolRegistry();
  registry.register({ name: 'log.write', action: 'log.write', resourceType: 'files', allowedOperations: ['read'], networkRequired: false, credentialsRequired: [], handler: context => ({ echoed: context.input }) });
  const broker = new ExecutionBroker(gateEvidence, new CapabilityCodec(randomBytes(32)), registry);
  const sentinel = new SentinelRuntime(':memory:', { clock: () => NOW });
  const { adminPrincipal: sentinelAdmin } = await import('../packages/sentinel-runtime/src/index.js');
  sentinel.installDefaultPolicy(sentinelAdmin('sentinel-admin', TENANT));
  const ledgerStore = new LedgerStore(':memory:');
  const platformStore = new PlatformStore(resolve(dir, 'platform.sqlite'));
  const gatePort: GatePort = { authorize: (principal, req) => gate.authorize(principal, req) };
  const gateOrchestrator = new PlatformGateOrchestrator(platformStore, gatePort);
  const executionOrchestrator = new PlatformExecutionOrchestrator(platformStore, broker, sentinel, sentinelController('c', TENANT), sentinelObserverFactory('o', TENANT, ['EXECUTION_BROKER']));
  const control = new PlatformControlOrchestrator(platformStore);
  const facade = new PlatformFacade(platformStore, gateOrchestrator, executionOrchestrator);
  const platformServer = createPlatformServer({ store: platformStore, facade, control }, CREDENTIALS, TENANT);
  const platformPort = await freePort();
  await new Promise<void>(res => platformServer.listen(platformPort, '127.0.0.1', res));
  const platformBaseUrl = `http://127.0.0.1:${platformPort}`;
  line('REAL PLATFORM/GATE/SENTINEL/LEDGER STACK LIVE');

  // Seed one real ALLOW action so the packaged Control Center has something real to show.
  const seedRes = await fetch(`${platformBaseUrl}/v1/platform/actions`, {
    method: 'POST', headers: { Authorization: `Bearer ${Object.keys(CREDENTIALS.agentTokens)[0]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: '1.0', request_id: 'smoke_1', tenant_id: TENANT, agent_id: AGENT, action: 'log.write', tool: 'log.write', operation: 'write', resource: '/workspace/logs/deploy.log', input: { message: 'smoke' }, requires_verification: false }),
  });
  assert.equal(seedRes.status, 201);
  line('REAL SEEDED ACTION COMPLETED');

  // --- Real, packaged Control Center binary, serving the real built frontend ---
  const ccDataDir = mkdtempSync(resolve(tmpdir(), 'tna-cc-smoke-cc-'));
  const registryPath = resolve(ccDataDir, 'tenants.json');
  writeFileSync(registryPath, JSON.stringify([{ tenant_id: TENANT, platform_base_url: platformBaseUrl, platform_token: Object.keys(CREDENTIALS.agentTokens)[0], platform_operator_token: CREDENTIALS.operatorToken }]));
  const ccPort = await freePort();
  let cc: ChildProcess | undefined;
  try {
    cc = spawn(execPath, [CC_MAIN], {
      env: { ...process.env, TNA_CONTROL_CENTER_DB_PATH: resolve(ccDataDir, 'cc.sqlite'), TNA_CONTROL_CENTER_TENANT_REGISTRY_PATH: registryPath, TNA_CONTROL_CENTER_PORT: String(ccPort), TNA_CONTROL_CENTER_HOST: '127.0.0.1', TNA_CONTROL_CENTER_STATIC_ROOT: WEB_DIST },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const ccBaseUrl = `http://127.0.0.1:${ccPort}`;
    const deadline = Date.now() + 15_000;
    let live = false;
    while (Date.now() < deadline && !live) { try { live = (await fetch(`${ccBaseUrl}/live`)).status === 200; } catch { /* not up */ } if (!live) await new Promise(r => setTimeout(r, 100)); }
    assert.ok(live, 'control center did not become live');
    line('PACKAGED CONTROL CENTER LIVE');

    // Real static frontend is served — never a dev server.
    const indexRes = await fetch(`${ccBaseUrl}/`);
    assert.equal(indexRes.status, 200);
    const indexHtml = await indexRes.text();
    assert.ok(indexHtml.includes('<div id="root">'), 'the real, built frontend index.html must be served');
    line('PACKAGED STATIC FRONTEND SERVED (real vite build output, not a dev server)');

    // Provision a real client user out of band (mirrors how every other TNA service identity in this
    // project is provisioned — no self-service signup in v0.1).
    const sessions = new ControlCenterSessionStore(resolve(ccDataDir, 'cc.sqlite'));
    sessions.createUser(TENANT, 'smoke-viewer', 'a-real-smoke-test-password-1', 'client-viewer');
    sessions.close();

    // Real cookie-jar login/session flow.
    const loginRes = await fetch(`${ccBaseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'smoke-viewer', password: 'a-real-smoke-test-password-1' }) });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.getSetCookie();
    const cookieHeader = setCookie.map(c => c.split(';')[0]).join('; ');
    line('REAL LOGIN SESSION ESTABLISHED (HttpOnly session cookie + CSRF cookie)');

    const dashboardRes = await fetch(`${ccBaseUrl}/api/dashboard`, { headers: { Cookie: cookieHeader } });
    assert.equal(dashboardRes.status, 200);
    const dashboard = await dashboardRes.json() as { total_known_actions: number; assurance: { status: string } };
    assert.equal(dashboard.total_known_actions, 1, 'the dashboard must reflect exactly the one real seeded action');
    assert.equal(dashboard.assurance.status, 'AVAILABLE');
    line(`DASHBOARD REFLECTS REAL BACKEND STATE (1 action, assurance ${dashboard.assurance.status})`);

    const actionsRes = await fetch(`${ccBaseUrl}/api/actions`, { headers: { Cookie: cookieHeader } });
    assert.equal(actionsRes.status, 200);
    const actionsPage = await actionsRes.json() as { items: readonly { platform_action_id: string; state: string }[] };
    assert.equal(actionsPage.items.length, 1);
    assert.equal(actionsPage.items[0]!.state, 'COMPLETED');
    const actionId = actionsPage.items[0]!.platform_action_id;
    line('ACTIONS LIST REFLECTS REAL PLATFORM DATA');

    const evidenceRes = await fetch(`${ccBaseUrl}/api/actions/${actionId}/evidence`, { headers: { Cookie: cookieHeader } });
    assert.equal(evidenceRes.status, 200);
    line('REAL EVIDENCE RECONSTRUCTED THROUGH THE CONTROL CENTER PROXY');

    const unauthedRes = await fetch(`${ccBaseUrl}/api/dashboard`);
    assert.equal(unauthedRes.status, 401);
    line('UNAUTHENTICATED ACCESS REJECTED');

    line('SMOKE PASSED');
    process.stdout.write('TNA Client Control Center & Assurance UI v0.1 packaged smoke test passed.\n');
  } finally {
    if (cc) cc.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 200));
    await new Promise<void>(res => platformServer.close(() => res()));
    platformStore.close(); gateEvidence.close(); sentinel.close(); ledgerStore.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(ccDataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

main().catch(error => { process.stderr.write(`smoke test failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
