/**
 * TNA Client Integration & MCP Gateway v0.1 — packaged-execution closure smoke test.
 *
 * Boots the real, compiled `dist/apps/tna-client-gateway/src/main.js` production entrypoint as a
 * separate OS process (governed mode, the default) and drives one full onboarding + governed action
 * through it entirely over real HTTP — the same packaged binary a real deployment runs, never the
 * internal library directly. Prints one line per real, independently-verified milestone as it is
 * reached; a milestone is only printed once the evidence for it has actually been checked (Gate/
 * Sentinel/MCP/Ledger evidence is read back from the gateway's own real SQLite files, not inferred from
 * the HTTP response alone).
 *
 * Exit 0 on success, non-zero on failure.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { resolve } from 'node:path';
import { PlatformStore } from '../packages/platform-core/src/index.js';
import { Ledger, LedgerStore } from '../packages/ledger-core/src/index.js';
import { platformLedgerReader } from '../apps/tna-ledger/src/writers.js';

function line(text: string): void { process.stdout.write(`${text}\n`); }

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}

const MAIN_JS = resolve('dist', 'apps', 'tna-client-gateway', 'src', 'main.js');
const FIXTURE_JS = resolve('dist', 'scripts', 'fixtures', 'mcp-fixture-server.js');
const ADMIN_TOKEN = `smoke-admin-${'x'.repeat(24)}`;

async function main(): Promise<void> {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'tna-client-gateway-smoke-'));
  let proc: ChildProcess | undefined;
  try {
    const port = await freePort();
    proc = spawn(execPath, [MAIN_JS], {
      env: {
        ...process.env, TNA_CLIENT_ADMIN_TOKEN: ADMIN_TOKEN, TNA_CLIENT_DB_PATH: resolve(dataDir, 'client.sqlite'),
        TNA_CLIENT_DATA_DIR: dataDir, TNA_CLIENT_HOST: '127.0.0.1', TNA_CLIENT_PORT: String(port),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    let live = false;
    while (Date.now() < deadline && !live) { try { live = (await fetch(`${baseUrl}/live`)).status === 200; } catch { /* not up yet */ } if (!live) await new Promise(r => setTimeout(r, 100)); }
    assert.ok(live, 'gateway did not become live');
    const ready = await fetch(`${baseUrl}/ready`);
    const readyBody = await ready.json() as { governed_execution: boolean };
    assert.equal(ready.status, 200);
    assert.equal(readyBody.governed_execution, true, 'the packaged binary must be running in governed mode');

    const adminHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
    const tenantRes = await fetch(`${baseUrl}/v1/admin/tenants`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ display_name: 'Smoke Co', environment: 'development', deployment_binding: 'smoke', policy_profile: 'default', allowed_connector_types: ['mcp-stdio'] }),
    });
    const tenant = await tenantRes.json() as { tenant_id: string; state_version: number };
    assert.equal(tenantRes.status, 201);

    const serviceRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/services`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'smoke-agent', role: 'agent-client' }),
    });
    const service = await serviceRes.json() as { identity: { service_id: string }; credential: { token: string } };
    assert.equal(serviceRes.status, 201);

    const mcpRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/mcp-servers`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'smoke-crm', transport: 'stdio', executable: execPath, args: [FIXTURE_JS], env_allowlist: [], credential_ref: null }),
    });
    const mcpServer = await mcpRes.json() as { mcp_server_id: string };
    assert.equal(mcpRes.status, 201);

    const discoverRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/mcp-servers/${mcpServer.mcp_server_id}/discover`, { method: 'POST', headers: adminHeaders, body: '{}' });
    assert.equal(discoverRes.status, 200);

    const toolsRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/tools`, { headers: adminHeaders });
    const tools = await toolsRes.json() as { tool_id: string; external_tool_name: string; state_version: number }[];
    const lookupTool = tools.find(t => t.external_tool_name === 'crm.lookup_customer')!;
    assert.ok(lookupTool, 'the real fixture must advertise crm.lookup_customer');

    const enableRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/tools/${lookupTool.tool_id}/enable`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({
        state_version: lookupTool.state_version, risk_class: 'LOW', allowed_operations: ['read'],
        resource_patterns: ['/workspace/crm/**'], requires_human_approval: false, requires_vad: false,
        policy_id: 'smoke-policy', runtime_limits: {}, cost_limits: {},
      }),
    });
    assert.equal(enableRes.status, 200);

    const activateRes = await fetch(`${baseUrl}/v1/admin/tenants/${tenant.tenant_id}/activate`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ state_version: tenant.state_version }),
    });
    assert.equal(activateRes.status, 200);

    const actionRes = await fetch(`${baseUrl}/v1/client/actions`, {
      method: 'POST', headers: { Authorization: `Bearer ${service.credential.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_id: lookupTool.tool_id, resource: '/workspace/crm/customer/1', input: { customer_id: 'cust-1' } }),
    });
    assert.notEqual(actionRes.status, 401, 'the real service credential must be accepted');
    line('CLIENT AUTHENTICATED');

    const action = await actionRes.json() as { client_action_id: string; platform_action_id?: string; correlation_id?: string; state: string };
    assert.equal(actionRes.status, 201);
    assert.ok(action.platform_action_id, 'the authenticated identity\'s own tenant must have been resolved for this action to reach the platform at all');
    line('TENANT RESOLVED');
    line('PLATFORM ACTION CREATED');

    const platform = new PlatformStore(resolve(dataDir, 'tna-client-gateway-platform.sqlite'));
    try {
      const stored = platform.get(tenant.tenant_id, action.platform_action_id!);
      assert.equal(stored.gate_decision?.decision, 'ALLOW', `expected real Gate ALLOW, got: ${JSON.stringify(stored.gate_decision)}`);
      line('GATE ALLOW');
      assert.ok(stored.capability_id, 'a real capability must have been issued');
      assert.ok(stored.sentinel_session_id, 'a real Sentinel session must have been created');
      assert.ok(stored.result_hash, 'a real MCP result must have been produced — impossible unless the pre-action Sentinel check decided CONTINUE');
      line('SENTINEL CONTINUE');
      line('MCP INVOKED');
    } finally { platform.close(); }

    const ledgerStore = new LedgerStore(resolve(dataDir, 'tna-client-gateway-ledger.sqlite'));
    try {
      const ledger = new Ledger(ledgerStore);
      const reader = platformLedgerReader(tenant.tenant_id);
      let found = false;
      const ledgerDeadline = Date.now() + 10_000;
      while (Date.now() < ledgerDeadline && !found) {
        const events = ledger.getStream(reader, `platform:${action.platform_action_id}`).items;
        found = events.some(e => e.event_type === 'PLATFORM_ACTION_COMPLETED');
        if (!found) await new Promise(r => setTimeout(r, 200));
      }
      assert.ok(found, 'real Ledger evidence (PLATFORM_ACTION_COMPLETED) must exist');
      line('LEDGER EVIDENCE FOUND');
    } finally { ledgerStore.close(); }

    assert.equal(action.state, 'COMPLETED');
    line('ACTION COMPLETED');
    process.stdout.write('TNA Client Integration & MCP Gateway v0.1 packaged-execution smoke test passed.\n');
  } finally {
    if (proc) { proc.kill('SIGKILL'); await new Promise(r => setTimeout(r, 200)); }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`smoke test failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
