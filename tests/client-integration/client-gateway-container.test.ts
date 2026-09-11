import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { before, after, test } from 'node:test';
import { PlatformStore } from '../../packages/platform-core/src/index.js';
import { Ledger, LedgerStore } from '../../packages/ledger-core/src/index.js';
import { platformLedgerReader } from '../../apps/tna-ledger/src/writers.js';

/**
 * TNA Client Integration & MCP Gateway v0.1 — real container verification. Builds and runs the actual
 * production image (the same `deploy/docker/Dockerfile` Volume 9 built), overriding its entrypoint to
 * start `apps/tna-client-gateway` instead of `apps/tna-platform` — both apps ship in the one image
 * already (`dist/apps/*`), so no new Dockerfile is needed. Never a static inspection: every assertion
 * here is against a real running container, driven over real HTTP, with a real MCP child process
 * spawned *inside* the container's own PID namespace by the containerized gateway process itself.
 *
 * Packaged-execution closure: `apps/tna-client-gateway/src/main.ts` now wires a real `PlatformFacade`
 * (governed mode is the default and the only mode production permits — see `config.ts` and
 * `governed-execution.ts`), so this suite now additionally proves a full governed client action
 * completing entirely *inside* the container: real Gate ALLOW, real Capability/Sentinel, a real MCP
 * child process spawned in the container's own PID namespace, and real Ledger evidence — copied out of
 * the container's data volume and verified with the real accepted `Ledger`/`PlatformStore` reader
 * classes, never a static inspection of container output.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const IMAGE = 'tna-client-gateway:test';
const FIXTURE_IN_IMAGE = '/tmp/mcp-fixture-server.js';
const ADMIN_TOKEN = `admin-${'x'.repeat(30)}`;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
}
function dockerQuiet(args: string[]): { code: number } {
  try { execFileSync('docker', args, { encoding: 'utf8', cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }); return { code: 0 }; }
  catch (error) { return { code: (error as { status?: number }).status ?? 1 }; }
}
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}
async function waitUntilLive(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/live`); if (res.status === 200) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`container never became live on port ${port}`);
}
function adminHeaders(): Record<string, string> { return { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' }; }

let dockerAvailable = true;
before(() => {
  const check = dockerQuiet(['version', '--format', '{{.Server.Version}}']);
  if (check.code !== 0) { dockerAvailable = false; return; }
  docker(['build', '-f', 'deploy/docker/Dockerfile', '-t', IMAGE, '.']);
});
after(() => { try { execFileSync('docker', ['rmi', '-f', IMAGE], { cwd: repoRoot }); } catch { /* best-effort */ } });

test('real container: client gateway boots non-root, becomes ready, and the real admin/MCP-discovery surface works over HTTP inside the container', async t => {
  if (!dockerAvailable) { t.skip('Docker daemon not available'); return; }
  const name = `tna-client-gateway-test-${randomUUID().slice(0, 8)}`;
  const volume = `tna-client-gateway-test-vol-${randomUUID().slice(0, 8)}`;
  const port = await freePort();
  try {
    docker(['volume', 'create', volume]);
    docker([
      'run', '-d', '--name', name, '-p', `${port}:4318`, '-v', `${volume}:/data`,
      '--entrypoint', 'node',
      '-e', `TNA_CLIENT_ADMIN_TOKEN=${ADMIN_TOKEN}`, '-e', 'TNA_CLIENT_DB_PATH=/data/client.sqlite',
      '-e', 'TNA_CLIENT_HOST=0.0.0.0', '-e', 'TNA_CLIENT_PORT=4318',
      IMAGE, 'dist/apps/tna-client-gateway/src/main.js',
    ]);
    await waitUntilLive(port);
    const baseUrl = `http://127.0.0.1:${port}`;

    // Section 9 (Volume 9): non-root, tested, not merely documented.
    const uid = docker(['exec', name, 'id', '-u']).trim();
    assert.notEqual(uid, '0', 'the container process must not run as root');

    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);

    // Real admin API over real HTTP, against the real container.
    const tenantRes = await fetch(`${baseUrl}/v1/admin/tenants`, {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ display_name: 'Container Test Co', environment: 'development', deployment_binding: 'container-test', policy_profile: 'default', allowed_connector_types: ['mcp-stdio'] }),
    });
    assert.equal(tenantRes.status, 201);
    const tenant = await tenantRes.json() as { tenant_id: string; state_version: number };

    // Copy the real MCP fixture server into the running container — it is deliberately not shipped in
    // the production image (section 8: no test fixtures in the runtime image), so this test supplies
    // it the same way an operator would supply a real third-party MCP server binary.
    docker(['cp', 'dist/scripts/fixtures/mcp-fixture-server.js', `${name}:${FIXTURE_IN_IMAGE}`]);

    const mcpRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/mcp-servers`, {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ name: 'Containerized CRM', transport: 'stdio', executable: 'node', args: [FIXTURE_IN_IMAGE], env_allowlist: ['PATH'], credential_ref: null }),
    });
    assert.equal(mcpRes.status, 201);
    const mcpServer = await mcpRes.json() as { mcp_server_id: string };

    // A real MCP child process, spawned by the containerized gateway process, inside the container's
    // own PID namespace — not simulated.
    const discoverRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/mcp-servers/${mcpServer.mcp_server_id}/discover`, { method: 'POST', headers: adminHeaders(), body: '{}' });
    assert.equal(discoverRes.status, 200);
    const discovery = await discoverRes.json() as { created: string[] };
    assert.equal(discovery.created.length, 2, 'the real fixture server inside the container must advertise both demo tools');

    // --- Packaged-execution closure: a full governed action, entirely inside the container ---------
    const toolsRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/tools`, { headers: adminHeaders() });
    const tools = await toolsRes.json() as { tool_id: string; external_tool_name: string; state_version: number }[];
    const lookupTool = tools.find(t => t.external_tool_name === 'crm.lookup_customer')!;
    assert.ok(lookupTool, 'the containerized fixture must have advertised crm.lookup_customer');

    const serviceRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/services`, {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ name: 'container-agent', role: 'agent-client' }),
    });
    assert.equal(serviceRes.status, 201);
    const service = await serviceRes.json() as { identity: { service_id: string }; credential: { token: string } };

    const enableRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/tools/${lookupTool.tool_id}/enable`, {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({
        state_version: lookupTool.state_version, risk_class: 'LOW', allowed_operations: ['read'],
        resource_patterns: ['/workspace/crm/**'], requires_human_approval: false, requires_vad: false,
        policy_id: 'container-test-policy', runtime_limits: {}, cost_limits: {},
      }),
    });
    assert.equal(enableRes.status, 200, await enableRes.text());

    const activateRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/activate`, {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ state_version: tenant.state_version }),
    });
    assert.equal(activateRes.status, 200, await activateRes.text());

    const actionRes = await fetch(`${baseUrl}/v1/client/actions`, {
      method: 'POST', headers: { Authorization: `Bearer ${service.credential.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_id: lookupTool.tool_id, resource: '/workspace/crm/customer/42', input: { customer_id: 'cust-42' } }),
    });
    const actionText = await actionRes.text();
    assert.equal(actionRes.status, 201, actionText);
    const action = JSON.parse(actionText) as { state: string; platform_action_id: string; correlation_id: string };
    assert.equal(action.state, 'COMPLETED', 'a real Gate ALLOW -> Capability -> Sentinel CONTINUE -> real containerized MCP call must complete the action');

    // Real evidence, copied out of the container's own data volume — not a static inspection of HTTP
    // responses. Every store here runs WAL mode, so a full-directory `docker cp` (base file + its
    // `-wal`/`-shm` sidecars together) is taken each snapshot, never just the base `.sqlite` file alone
    // (which could miss recent, not-yet-checkpointed commits). Opening the snapshot with the real
    // accepted store/reader classes proves the evidence exists exactly as the packaged binary itself
    // would read it.
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'tna-client-gateway-container-evidence-'));
    function snapshotData(): string {
      const snapshotDir = resolve(evidenceRoot, `snap-${randomUUID().slice(0, 8)}`);
      docker(['cp', `${name}:/data`, snapshotDir]);
      return snapshotDir;
    }
    try {
      const firstSnapshot = snapshotData();
      const platform = new PlatformStore(resolve(firstSnapshot, 'tna-client-gateway-platform.sqlite'));
      try {
        const stored = platform.get(tenant.tenant_id, action.platform_action_id);
        assert.equal(stored.gate_decision?.decision, 'ALLOW');
        assert.ok(stored.capability_id, 'a real capability must have been issued inside the container');
        assert.ok(stored.sentinel_session_id, 'a real Sentinel session must have been created inside the container');
        assert.ok(stored.result_hash, 'a real result hash proves the containerized MCP fixture actually responded');
      } finally { platform.close(); }

      // The outbox dispatch loop runs inside the container on its own 2-second timer — poll by taking
      // a fresh directory snapshot each attempt rather than assuming the first one already caught the
      // delivered event.
      const reader = platformLedgerReader(tenant.tenant_id);
      let completedFound = false;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !completedFound) {
        const snapshotDir = snapshotData();
        const ledgerStore = new LedgerStore(resolve(snapshotDir, 'tna-client-gateway-ledger.sqlite'));
        try {
          const ledger = new Ledger(ledgerStore);
          const events = ledger.getStream(reader, `platform:${action.platform_action_id}`).items;
          completedFound = events.some(e => e.event_type === 'PLATFORM_ACTION_COMPLETED');
        } finally { ledgerStore.close(); }
        if (!completedFound) await new Promise(r => setTimeout(r, 500));
      }
      assert.ok(completedFound, 'real Ledger evidence (PLATFORM_ACTION_COMPLETED) must exist for the containerized governed action');
    } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }

    // Repeat discovery a few times (each spawns and shuts down its own MCP child — `/discover` always
    // uses a fresh, non-cached McpStdioClient) and confirm no *orphaned* child process accumulates
    // inside the container's PID namespace. Exactly one extra node process is expected to remain: the
    // governed-execution connector's own McpStdioClient (`connectors.ts`'s `clientCache`) is
    // deliberately kept alive and reused across calls for the same MCP server — that is the one
    // process `shutdownMcpClients()` (proven below) is responsible for reaping, not an orphan.
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/mcp-servers/${mcpServer.mcp_server_id}/discover`, { method: 'POST', headers: adminHeaders(), body: '{}' });
      assert.equal(res.status, 200);
    }
    const processList = docker(['top', name]);
    const nodeProcessCount = processList.split('\n').filter(line => /\bnode\b/.test(line)).length;
    assert.equal(nodeProcessCount, 2, `exactly two node processes (the gateway, plus the one cached, reused governed-execution MCP client) should remain inside the container after repeated MCP discovery cycles — got:\n${processList}`);

    // Real, genuine SIGTERM shutdown (Volume 9 discipline carried forward).
    docker(['stop', '--time', '10', name]);
    const exitCode = docker(['inspect', name, '--format', '{{.State.ExitCode}}']).trim();
    assert.equal(exitCode, '0', 'a graceful SIGTERM shutdown inside the real container must exit 0');
    const logs = docker(['logs', name]);
    assert.ok(logs.includes('Graceful shutdown complete'), 'the shutdown handler (which calls shutdownMcpClients()) must actually run to completion');

    // Once the container is gone, `docker top` against it must fail — there is no host-visible process
    // left over for this container to leak.
    const topAfterStop = dockerQuiet(['top', name]);
    assert.notEqual(topAfterStop.code, 0, 'a stopped container must have no running process list at all');
  } finally {
    try { docker(['rm', '-f', name]); } catch { /* best-effort cleanup */ }
    try { docker(['volume', 'rm', volume]); } catch { /* best-effort cleanup */ }
  }
});
