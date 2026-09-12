/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11) — operator CLI smoke test. Boots a real
 * `tna-client-gateway` process and drives the real, compiled `tna` operator CLI binary through one
 * onboarding + diagnostics + incident flow. Exit 0 on success, non-zero on failure.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { resolve } from 'node:path';

function line(text: string): void { process.stdout.write(`${text}\n`); }
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}

const GATEWAY_MAIN = resolve('dist', 'apps', 'tna-client-gateway', 'src', 'main.js');
const OPERATOR_MAIN = resolve('dist', 'apps', 'tna-operator', 'src', 'main.js');
const ADMIN_TOKEN_ENV = 'SMOKE_OPERATOR_ADMIN_TOKEN';

async function main(): Promise<void> {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-smoke-gateway-'));
  const profileDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-smoke-profiles-'));
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-smoke-audit-'));
  const adminToken = `smoke-admin-${'x'.repeat(24)}`;
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
    line('CLIENT GATEWAY LIVE');

    writeFileSync(resolve(profileDir, 'smoke.json'), JSON.stringify({ role: 'admin', devMode: true, clientGatewayUrl: baseUrl, clientGatewayAdminTokenEnv: ADMIN_TOKEN_ENV }));
    const env = { ...process.env, TNA_OPERATOR_PROFILE_DIR: profileDir, [ADMIN_TOKEN_ENV]: adminToken, TNA_OPERATOR_AUDIT_DIR: auditDir };
    function runCli(args: readonly string[]) { return spawnSync(execPath, [OPERATOR_MAIN, ...args], { env, encoding: 'utf8' }); }

    const status = runCli(['status', '--profile', 'smoke', '--json']);
    assert.equal(status.status, 0, status.stderr);
    line('OPERATOR CLI AUTHENTICATED');

    const tenantRun = runCli(['tenant', 'create', '--profile', 'smoke', '--json', '--input', JSON.stringify({ display_name: 'Smoke Co', environment: 'development', deployment_binding: 'operator-smoke', policy_profile: 'default', allowed_connector_types: ['mcp-stdio'] })]);
    assert.equal(tenantRun.status, 0, tenantRun.stderr);
    const tenant = (JSON.parse(tenantRun.stdout) as { data: { tenant_id: string } }).data;
    line('TENANT CREATED');

    const doctorRun = runCli(['doctor', '--profile', 'smoke', '--json']);
    assert.ok(doctorRun.status !== null);
    line('DOCTOR RAN (READ-ONLY)');

    const incidentRun = runCli(['incident', 'collect', '--profile', 'smoke', '--json', '--tenant', tenant.tenant_id]);
    assert.equal(incidentRun.status, 0, incidentRun.stderr);
    assert.ok(!incidentRun.stdout.includes(adminToken), 'incident package must never contain the raw admin token');
    const incident = (JSON.parse(incidentRun.stdout) as { data: { manifest: { manifest_hash: string } } }).data;
    assert.equal(incident.manifest.manifest_hash.length, 64);
    line('INCIDENT PACKAGE COLLECTED AND HASHED');

    const viewerProfilePath = resolve(profileDir, 'smoke-viewer.json');
    writeFileSync(viewerProfilePath, JSON.stringify({ role: 'viewer', devMode: true, clientGatewayUrl: baseUrl, clientGatewayAdminTokenEnv: ADMIN_TOKEN_ENV }));
    const viewerAttempt = runCli(['tenant', 'suspend', '--profile', 'smoke-viewer', '--json', '--tenant', tenant.tenant_id, '--reason', 'x']);
    assert.notEqual(viewerAttempt.status, 0);
    const viewerResult = JSON.parse(viewerAttempt.stdout) as { code: string };
    assert.equal(viewerResult.code, 'FORBIDDEN');
    line('ROLE BOUNDARY ENFORCED');

    line('SMOKE PASSED');
    process.stdout.write('TNA Operator CLI v0.1 packaged smoke test passed.\n');
  } finally {
    if (gateway) gateway.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 200));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`smoke test failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
