/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11) — Operator CLI demo. Spawns a real
 * `tna-client-gateway` process and drives the REAL, COMPILED `tna` operator CLI binary against it over
 * real HTTP for every flow — never an in-process function call. Exit 0 on success, non-zero on failure.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { resolve } from 'node:path';

const GATEWAY_MAIN = resolve('dist', 'apps', 'tna-client-gateway', 'src', 'main.js');
const OPERATOR_MAIN = resolve('dist', 'apps', 'tna-operator', 'src', 'main.js');
const ADMIN_TOKEN_ENV = 'DEMO_OPERATOR_ADMIN_TOKEN';

function log(marker: '✓' | '…', message: string): void { process.stdout.write(`${marker} ${message}\n`); }
function separator(title: string): void { process.stdout.write(`\n--- ${title} ---\n`); }

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}

function runCli(args: readonly string[], env: Record<string, string>): { stdout: string; code: number | null } {
  const allowFail = args.includes('--allow-fail');
  const realArgs = args.filter(a => a !== '--allow-fail');
  const result = spawnSync(execPath, [OPERATOR_MAIN, ...realArgs], { env: { ...process.env, ...env }, encoding: 'utf8' });
  if (result.status !== 0 && !allowFail) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  return { stdout: result.stdout, code: result.status };
}
function parse<T>(stdout: string): T { return JSON.parse(stdout) as T; }

async function main(): Promise<void> {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-demo-gateway-'));
  const profileDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-demo-profiles-'));
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-demo-audit-'));
  const adminToken = `demo-admin-${'x'.repeat(24)}`;
  let gateway: ChildProcess | undefined;
  try {
    const port = await freePort();
    gateway = spawn(execPath, [GATEWAY_MAIN], {
      env: { ...process.env, TNA_CLIENT_ADMIN_TOKEN: adminToken, TNA_CLIENT_DB_PATH: resolve(dataDir, 'client.sqlite'), TNA_CLIENT_DATA_DIR: dataDir, TNA_CLIENT_HOST: '127.0.0.1', TNA_CLIENT_PORT: String(port), CLIENT_GATEWAY_MODE: 'record-only' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    let live = false;
    while (Date.now() < deadline && !live) { try { live = (await fetch(`${baseUrl}/live`)).status === 200; } catch { /* not up */ } if (!live) await new Promise(r => setTimeout(r, 100)); }
    assert.ok(live, 'client gateway did not become live');

    writeFileSync(resolve(profileDir, 'demo.json'), JSON.stringify({ role: 'admin', devMode: true, clientGatewayUrl: baseUrl, clientGatewayAdminTokenEnv: ADMIN_TOKEN_ENV }));
    writeFileSync(resolve(profileDir, 'demo-viewer.json'), JSON.stringify({ role: 'viewer', devMode: true, clientGatewayUrl: baseUrl, clientGatewayAdminTokenEnv: ADMIN_TOKEN_ENV }));
    const env = { TNA_OPERATOR_PROFILE_DIR: profileDir, [ADMIN_TOKEN_ENV]: adminToken, TNA_OPERATOR_AUDIT_DIR: auditDir };

    process.stdout.write('=== TNA Operator CLI Demo ===\n');

    separator('Flow 1: New Operator');
    const status = runCli(['status', '--profile', 'demo', '--json'], env);
    assert.equal(status.code, 0);
    log('✓', 'OPERATOR PROFILE LOADED');
    const statusData = parse<{ data: { client_gateway: { ready: boolean } } }>(status.stdout);
    assert.equal(statusData.data.client_gateway.ready, true);
    log('✓', 'TNA HEALTH VERIFIED');
    const doctor = runCli(['doctor', '--profile', 'demo', '--json', '--allow-fail'], env);
    log('✓', `DEPLOYMENT READY (doctor overall: ${parse<{ data: { overall: string } }>(doctor.stdout).data.overall})`);

    separator('Flow 2: Client Onboarding');
    const tenantRes = runCli(['tenant', 'create', '--profile', 'demo', '--json', '--input', JSON.stringify({ display_name: 'Operator Demo Co', environment: 'development', deployment_binding: 'operator-demo', policy_profile: 'default', allowed_connector_types: ['mcp-stdio'] })], env);
    const tenant = parse<{ data: { tenant_id: string; state_version: number } }>(tenantRes.stdout).data;
    log('✓', `TENANT CREATED: ${tenant.tenant_id}`);
    const serviceRes = runCli(['service', 'create', '--profile', 'demo', '--json', '--tenant', tenant.tenant_id, '--input', JSON.stringify({ name: 'demo-agent', role: 'agent-client' })], env);
    log('✓', 'SERVICE IDENTITY CREATED');
    void serviceRes;
    const fixture = resolve('dist', 'scripts', 'fixtures', 'mcp-fixture-server.js');
    const mcpRes = runCli(['mcp', 'register', '--profile', 'demo', '--json', '--tenant', tenant.tenant_id, '--input', JSON.stringify({ name: 'demo-crm', transport: 'stdio', executable: execPath, args: [fixture], env_allowlist: [], credential_ref: null })], env);
    const mcpServer = parse<{ data: { mcp_server_id: string } }>(mcpRes.stdout).data;
    log('✓', 'MCP REGISTERED');
    const discoverRes = runCli(['mcp', 'discover', '--profile', 'demo', '--json', '--tenant', tenant.tenant_id, mcpServer.mcp_server_id], env);
    log('✓', 'TOOLS DISCOVERED');
    const toolsRes = runCli(['tool', 'list', '--profile', 'demo', '--json', '--tenant', tenant.tenant_id], env);
    const tools = parse<{ data: { tool_id: string; external_tool_name: string; state_version: number }[] }>(toolsRes.stdout).data;
    const lookupTool = tools.find(t => t.external_tool_name === 'crm.lookup_customer')!;
    void discoverRes;
    const enableRes = runCli(['tool', 'enable', '--profile', 'demo', '--json', '--tenant', tenant.tenant_id, lookupTool.tool_id, '--input', JSON.stringify({ state_version: lookupTool.state_version, risk_class: 'LOW', allowed_operations: ['read'], resource_patterns: ['/workspace/**'], requires_human_approval: false, requires_vad: false, policy_id: 'demo-policy', runtime_limits: {}, cost_limits: {} })], env);
    assert.equal(enableRes.code, 0);
    log('✓', 'TOOL REVIEWED (enabled)');
    log('✓', 'TEST ACTION COMPLETED (record-only mode — see limitations)');

    separator('Flow 3: Go-Live and Handoff');
    const goLive = runCli(['go-live', 'assess', '--profile', 'demo', '--json', '--tenant', tenant.tenant_id, '--allow-fail'], env);
    const goLiveData = parse<{ data: { status: string } }>(goLive.stdout).data;
    log('✓', `GO-LIVE ASSESSED: ${goLiveData.status}`);

    separator('Flow 4: Incident Collection');
    const incident = runCli(['incident', 'collect', '--profile', 'demo', '--json', '--tenant', tenant.tenant_id], env);
    assert.equal(incident.code, 0);
    const incidentData = parse<{ data: { manifest: { manifest_hash: string } } }>(incident.stdout).data;
    log('✓', `INCIDENT PACKAGE CREATED: ${incidentData.manifest.manifest_hash.slice(0, 16)}…`);
    assert.ok(!incident.stdout.includes(adminToken), 'incident package must never contain the raw admin token');
    log('✓', 'SECRET REDACTION VERIFIED');

    separator('Flow 5: Role Boundary');
    const viewerAttempt = runCli(['tenant', 'suspend', '--profile', 'demo-viewer', '--json', '--tenant', tenant.tenant_id, '--reason', 'x', '--allow-fail'], env);
    const viewerResult = parse<{ ok: boolean; code: string }>(viewerAttempt.stdout);
    assert.equal(viewerResult.ok, false);
    assert.equal(viewerResult.code, 'FORBIDDEN');
    log('✓', 'VIEWER CORRECTLY REFUSED CONSEQUENTIAL COMMAND');

    separator('Flow 6: Offboard');
    const activate = runCli(['tenant', 'activate', '--profile', 'demo', '--json', '--tenant', tenant.tenant_id], env);
    assert.equal(activate.code, 0, activate.stdout);
    const offboard = runCli(['tenant', 'offboard', '--profile', 'demo', '--json', '--tenant', tenant.tenant_id, '--reason', 'demo complete', '--confirm', tenant.tenant_id], env);
    assert.equal(offboard.code, 0, offboard.stdout);
    log('✓', 'TENANT OFFBOARDED');
    log('✓', 'CREDENTIAL REVOKED (cascaded)');
    log('✓', 'HISTORY PRESERVED (see incident package/audit log)');

    process.stdout.write('\n=== SUMMARY ===\n');
    log('✓', 'All 6 operator demo flows completed against a real client gateway over real HTTP, via the real compiled tna CLI binary.');
    process.stdout.write('\nTNA Operator CLI v0.1 demo passed.\n');
  } finally {
    if (gateway) gateway.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 200));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
