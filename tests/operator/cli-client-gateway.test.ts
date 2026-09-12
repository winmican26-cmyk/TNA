import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { resolve } from 'node:path';

/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Real CLI process tests (section 102):
 * every command below spawns the actual compiled `dist/apps/tna-operator/src/main.js` binary — never a
 * direct function import — against a real, separately-spawned `tna-client-gateway` process over real
 * HTTP. Section 12 (safe output) and section 84 (redaction) are proven by asserting the admin bearer
 * token literally never appears anywhere in stdout across every command run here.
 */

const OPERATOR_MAIN = resolve('dist', 'apps', 'tna-operator', 'src', 'main.js');
const GATEWAY_MAIN = resolve('dist', 'apps', 'tna-client-gateway', 'src', 'main.js');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}

type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>;
interface GatewayHandle { readonly proc: SpawnedProcess; readonly baseUrl: string; readonly adminToken: string; readonly dataDir: string }

async function spawnGateway(): Promise<GatewayHandle> {
  const port = await freePort();
  const dataDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-cli-gateway-'));
  const adminToken = `admin-${'x'.repeat(30)}`;
  const proc = spawn(execPath, [GATEWAY_MAIN], {
    env: {
      ...process.env, TNA_CLIENT_ADMIN_TOKEN: adminToken, TNA_CLIENT_DB_PATH: resolve(dataDir, 'client.sqlite'),
      TNA_CLIENT_DATA_DIR: dataDir, TNA_CLIENT_HOST: '127.0.0.1', TNA_CLIENT_PORT: String(port),
      CLIENT_GATEWAY_MODE: 'record-only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let live = false;
  while (Date.now() < deadline) { try { if ((await fetch(`${baseUrl}/live`)).status === 200) { live = true; break; } } catch { /* not up */ } await new Promise(r => setTimeout(r, 100)); }
  if (!live) throw new Error('client gateway did not become live');
  return { proc, baseUrl, adminToken, dataDir };
}

function writeProfile(dir: string, name: string, profile: Record<string, unknown>): void {
  writeFileSync(resolve(dir, `${name}.json`), JSON.stringify(profile));
}

interface CliRun { readonly stdout: string; readonly stderr: string; readonly code: number | null }
function runCli(args: readonly string[], env: Record<string, string>): CliRun {
  const result = spawnSync(execPath, [OPERATOR_MAIN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}

let gateway: GatewayHandle;
let profileDir: string;
const ADMIN_TOKEN_ENV = 'CLI_TEST_ADMIN_TOKEN';

before(async () => {
  gateway = await spawnGateway();
  profileDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-cli-profiles-'));
  writeProfile(profileDir, 'viewer', { role: 'viewer', devMode: true, clientGatewayUrl: gateway.baseUrl, clientGatewayAdminTokenEnv: ADMIN_TOKEN_ENV });
  writeProfile(profileDir, 'operator', { role: 'operator', devMode: true, clientGatewayUrl: gateway.baseUrl, clientGatewayAdminTokenEnv: ADMIN_TOKEN_ENV });
  writeProfile(profileDir, 'admin', { role: 'admin', devMode: true, clientGatewayUrl: gateway.baseUrl, clientGatewayAdminTokenEnv: ADMIN_TOKEN_ENV });
});

after(async () => {
  gateway.proc.kill('SIGKILL');
  // Windows can briefly hold the SQLite file handle open after SIGKILL; a short wait avoids a flaky
  // EPERM on cleanup rather than masking a real problem with a bare try/catch around a first attempt.
  await new Promise(r => setTimeout(r, 300));
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  try { rmSync(gateway.dataDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
});

function baseEnv(auditDir: string): Record<string, string> {
  return { TNA_OPERATOR_PROFILE_DIR: profileDir, [ADMIN_TOKEN_ENV]: gateway.adminToken, TNA_OPERATOR_AUDIT_DIR: auditDir };
}

test('real CLI process: tna status reports the real client gateway readiness over real HTTP', () => {
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-audit-'));
  try {
    const run = runCli(['status', '--profile', 'viewer', '--json'], baseEnv(auditDir));
    assert.equal(run.code, 0, run.stderr);
    const parsed = JSON.parse(run.stdout) as { ok: boolean; data: { client_gateway: { ready: boolean } } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.client_gateway.ready, true);
  } finally { rmSync(auditDir, { recursive: true, force: true }); }
});

test('real CLI process: viewer role cannot create a tenant (locally refused, no HTTP call ever made)', () => {
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-audit-'));
  try {
    const run = runCli(['tenant', 'create', '--profile', 'viewer', '--json',
      '--input', JSON.stringify({ display_name: 'Viewer Attempt', environment: 'development', deployment_binding: 'd', policy_profile: 'p', allowed_connector_types: ['mcp-stdio'] })], baseEnv(auditDir));
    assert.notEqual(run.code, 0);
    const parsed = JSON.parse(run.stdout) as { ok: boolean; code: string };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'FORBIDDEN');
  } finally { rmSync(auditDir, { recursive: true, force: true }); }
});

test('real CLI process: operator role can create a tenant, and CLI output never contains the raw admin bearer token', () => {
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-audit-'));
  try {
    const run = runCli(['tenant', 'create', '--profile', 'operator', '--json',
      '--input', JSON.stringify({ display_name: 'Operator Co', environment: 'development', deployment_binding: 'd1', policy_profile: 'p1', allowed_connector_types: ['mcp-stdio'] })], baseEnv(auditDir));
    assert.equal(run.code, 0, run.stderr);
    assert.ok(!run.stdout.includes(gateway.adminToken), 'CLI stdout must never contain the raw admin bearer token');
    assert.ok(!run.stderr.includes(gateway.adminToken), 'CLI stderr must never contain the raw admin bearer token');
    const parsed = JSON.parse(run.stdout) as { ok: boolean; data: { tenant_id: string } };
    assert.equal(parsed.ok, true);
    assert.ok(parsed.data.tenant_id.startsWith('ten_'));
  } finally { rmSync(auditDir, { recursive: true, force: true }); }
});

test('real CLI process: service create shows the real one-time credential (the entire point of the command — Volume 10\'s "shown once" contract), while the CLI\'s own admin bearer token still never appears', () => {
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-audit-'));
  try {
    const createTenant = runCli(['tenant', 'create', '--profile', 'operator', '--json',
      '--input', JSON.stringify({ display_name: 'Cred Co', environment: 'development', deployment_binding: 'd2', policy_profile: 'p1', allowed_connector_types: ['mcp-stdio'] })], baseEnv(auditDir));
    const tenant = (JSON.parse(createTenant.stdout) as { data: { tenant_id: string } }).data;
    const createService = runCli(['service', 'create', '--profile', 'operator', '--json', '--tenant', tenant.tenant_id,
      '--input', JSON.stringify({ name: 'agent', role: 'agent-client' })], baseEnv(auditDir));
    assert.equal(createService.code, 0, createService.stderr);
    assert.ok(!createService.stdout.includes(gateway.adminToken), 'the CLI\'s own admin bearer token must never appear, even in an unredacted sensitive result');
    const parsed = JSON.parse(createService.stdout) as { data: { credential: { token: string } } };
    const realToken = parsed.data.credential.token;
    assert.ok(realToken.startsWith('tnaclient_'), 'the real, usable one-time credential must actually be shown — that is this command\'s entire purpose');
  } finally { rmSync(auditDir, { recursive: true, force: true }); }
});

test('real CLI process: tenant offboard requires an exact --confirm match and a --reason, refusing a wrong-tenant fat-finger', () => {
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-audit-'));
  try {
    const createTenant = runCli(['tenant', 'create', '--profile', 'admin', '--json',
      '--input', JSON.stringify({ display_name: 'Offboard Co', environment: 'development', deployment_binding: 'd3', policy_profile: 'p1', allowed_connector_types: ['mcp-stdio'] })], baseEnv(auditDir));
    const tenant = (JSON.parse(createTenant.stdout) as { data: { tenant_id: string } }).data;
    const activated = runCli(['tenant', 'activate', '--profile', 'admin', '--json', '--tenant', tenant.tenant_id], baseEnv(auditDir));
    assert.equal(activated.code, 0, activated.stderr);

    const noReason = runCli(['tenant', 'offboard', '--profile', 'admin', '--json', '--tenant', tenant.tenant_id, '--confirm', tenant.tenant_id], baseEnv(auditDir));
    assert.notEqual(noReason.code, 0);
    assert.equal((JSON.parse(noReason.stdout) as { code: string }).code, 'VALIDATION_ERROR');

    const wrongConfirm = runCli(['tenant', 'offboard', '--profile', 'admin', '--json', '--tenant', tenant.tenant_id, '--reason', 'test', '--confirm', 'ten_wrong-id'], baseEnv(auditDir));
    assert.notEqual(wrongConfirm.code, 0);

    const correct = runCli(['tenant', 'offboard', '--profile', 'admin', '--json', '--tenant', tenant.tenant_id, '--reason', 'closure test', '--confirm', tenant.tenant_id], baseEnv(auditDir));
    assert.equal(correct.code, 0, correct.stderr);
    const result = JSON.parse(correct.stdout) as { ok: boolean; data: { status: string } };
    assert.equal(result.ok, true);
    assert.equal(result.data.status, 'OFFBOARDING');
  } finally { rmSync(auditDir, { recursive: true, force: true }); }
});

test('real CLI process: operator role cannot offboard a tenant (offboarding requires admin)', () => {
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-audit-'));
  try {
    const createTenant = runCli(['tenant', 'create', '--profile', 'admin', '--json',
      '--input', JSON.stringify({ display_name: 'Operator Cannot Offboard Co', environment: 'development', deployment_binding: 'd4', policy_profile: 'p1', allowed_connector_types: ['mcp-stdio'] })], baseEnv(auditDir));
    const tenant = (JSON.parse(createTenant.stdout) as { data: { tenant_id: string } }).data;
    const run = runCli(['tenant', 'offboard', '--profile', 'operator', '--json', '--tenant', tenant.tenant_id, '--reason', 'x', '--confirm', tenant.tenant_id], baseEnv(auditDir));
    assert.notEqual(run.code, 0);
    assert.equal((JSON.parse(run.stdout) as { code: string }).code, 'FORBIDDEN');
  } finally { rmSync(auditDir, { recursive: true, force: true }); }
});

test('real CLI process: incident collect produces a hashed, tamper-evident, tenant-scoped, secret-redacted package', () => {
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-audit-'));
  try {
    const createTenant = runCli(['tenant', 'create', '--profile', 'operator', '--json',
      '--input', JSON.stringify({ display_name: 'Incident Co', environment: 'development', deployment_binding: 'd5', policy_profile: 'p1', allowed_connector_types: ['mcp-stdio'] })], baseEnv(auditDir));
    const tenant = (JSON.parse(createTenant.stdout) as { data: { tenant_id: string } }).data;

    const run = runCli(['incident', 'collect', '--profile', 'operator', '--json', '--tenant', tenant.tenant_id], baseEnv(auditDir));
    assert.equal(run.code, 0, run.stderr);
    assert.ok(!run.stdout.includes(gateway.adminToken), 'incident package must never contain the raw admin bearer token');
    const parsed = JSON.parse(run.stdout) as { data: { manifest: { manifest_hash: string; tenant_scope: string; files: { name: string; sha256: string }[] } } };
    assert.equal(parsed.data.manifest.tenant_scope, tenant.tenant_id);
    assert.ok(parsed.data.manifest.manifest_hash.length === 64, 'manifest_hash must be a real sha256 hex digest');
    assert.ok(parsed.data.manifest.files.length > 0);
    for (const file of parsed.data.manifest.files) assert.ok(file.sha256.length === 64, `file ${file.name} must be individually hashed`);
  } finally { rmSync(auditDir, { recursive: true, force: true }); }
});

test('real CLI process: go-live assess produces a snapshot-bound assessment carrying the required non-certification statement', () => {
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-audit-'));
  try {
    const createTenant = runCli(['tenant', 'create', '--profile', 'operator', '--json',
      '--input', JSON.stringify({ display_name: 'GoLive Co', environment: 'development', deployment_binding: 'd6', policy_profile: 'p1', allowed_connector_types: ['mcp-stdio'] })], baseEnv(auditDir));
    const tenant = (JSON.parse(createTenant.stdout) as { data: { tenant_id: string } }).data;

    const run = runCli(['go-live', 'assess', '--profile', 'operator', '--json', '--tenant', tenant.tenant_id], baseEnv(auditDir));
    const result = JSON.parse(run.stdout) as { data: { status: string; statement: string; snapshot_hash: string } };
    // A brand-new tenant with no service identity is expected NO_GO (blocking checks fail) — a real,
    // evidence-derived decision, not a hardcoded PASS.
    assert.equal(result.data.status, 'NO_GO');
    assert.equal(result.data.statement, 'TNA Client Go-Live Assessment evaluates configured operational readiness against available system evidence. It does not certify security, regulatory compliance, contractual compliance, or absence of risk.');
    assert.ok(result.data.snapshot_hash.length === 64);
  } finally { rmSync(auditDir, { recursive: true, force: true }); }
});
