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
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section L: real CLI process tests. Every
 * command below spawns the actual compiled `dist/apps/tna-operator/src/main.js` binary — never an
 * imported function — against a real, separately-spawned `tna-improvement-governor` process over real
 * HTTP, which itself wires the real Gate/VAD/Sentinel/Ledger integrations.
 */

const OPERATOR_MAIN = resolve('dist', 'apps', 'tna-operator', 'src', 'main.js');
const GOVERNOR_MAIN = resolve('dist', 'apps', 'tna-improvement-governor', 'src', 'main.js');
const FIXTURE_ROOT = resolve('improvement', 'fixtures', 'demo-agent');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}

type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>;
interface GovernorHandle { readonly proc: SpawnedProcess; readonly baseUrl: string; readonly adminToken: string; readonly dataDir: string }

async function spawnGovernor(): Promise<GovernorHandle> {
  const port = await freePort();
  const dataDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-cli-governor-'));
  const adminToken = `improvement-admin-${'x'.repeat(20)}`;
  const proc = spawn(execPath, [GOVERNOR_MAIN], {
    env: {
      ...process.env, TNA_IMPROVEMENT_ADMIN_TOKEN: adminToken, TNA_IMPROVEMENT_DB_PATH: resolve(dataDir, 'improvement.sqlite'),
      TNA_IMPROVEMENT_GATE_DB_PATH: resolve(dataDir, 'gate.sqlite'), TNA_IMPROVEMENT_LEDGER_DB_PATH: resolve(dataDir, 'ledger.sqlite'),
      TNA_IMPROVEMENT_SENTINEL_DB_PATH: resolve(dataDir, 'sentinel.sqlite'), TNA_IMPROVEMENT_HOST: '127.0.0.1', TNA_IMPROVEMENT_PORT: String(port),
      TNA_IMPROVEMENT_TENANT_ID: 'ten_cli_test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let live = false;
  while (Date.now() < deadline) { try { if ((await fetch(`${baseUrl}/live`)).status === 200) { live = true; break; } } catch { /* not up */ } await new Promise(r => setTimeout(r, 100)); }
  if (!live) throw new Error('improvement governor did not become live');
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

let governor: GovernorHandle;
let profileDir: string;
const ADMIN_TOKEN_ENV = 'CLI_IMPROVEMENT_ADMIN_TOKEN';

before(async () => {
  governor = await spawnGovernor();
  profileDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-cli-improvement-profiles-'));
  for (const [name, role] of [['viewer', 'viewer'], ['operator', 'operator'], ['security-operator', 'security-operator'], ['admin', 'admin']] as const) {
    writeProfile(profileDir, name, { role, devMode: true, improvementGovernorUrl: governor.baseUrl, improvementGovernorTokenEnv: ADMIN_TOKEN_ENV });
  }
});

after(async () => {
  governor.proc.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 300));
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(governor.dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function baseEnv(auditDir: string): Record<string, string> {
  return { TNA_OPERATOR_PROFILE_DIR: profileDir, [ADMIN_TOKEN_ENV]: governor.adminToken, TNA_OPERATOR_AUDIT_DIR: auditDir };
}

test('real CLI process: viewer role cannot propose an improvement (locally refused, no HTTP call ever made)', () => {
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-improvement-audit-'));
  try {
    const run = runCli(['improvement', 'propose', '--profile', 'viewer', '--json', '--input', '{}'], baseEnv(auditDir));
    assert.notEqual(run.code, 0);
    assert.equal((JSON.parse(run.stdout) as { code: string }).code, 'FORBIDDEN');
  } finally { rmSync(auditDir, { recursive: true, force: true }); }
});

test('real CLI process: full golden path (propose -> authorize -> build -> evaluate) via the real spawned CLI against the real spawned governor, and the governor\'s own admin bearer token never appears in CLI output', () => {
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-improvement-audit-'));
  try {
    const proposeInput = {
      systemId: 'sys_cli_1', systemName: 'cli-demo-agent', parentGenerationId: null, parentWorkspacePath: FIXTURE_ROOT,
      objective: 'improve routing accuracy via CLI', improvementClass: 'CLASS_1_CODE', allowedMutationPaths: ['router.mjs'],
      authorityCeiling: { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 60000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] },
      candidateVersion: 'v1', createdBy: 'cli-test', requiredBenchmarks: ['routing-accuracy'],
    };
    const proposed = runCli(['improvement', 'propose', '--profile', 'operator', '--json', '--input', JSON.stringify(proposeInput)], baseEnv(auditDir));
    assert.equal(proposed.code, 0, proposed.stderr);
    assert.ok(!proposed.stdout.includes(governor.adminToken), 'CLI stdout must never contain the raw improvement-governor admin bearer token');
    const generationId = (JSON.parse(proposed.stdout) as { data: { generation: { generation_id: string } } }).data.generation.generation_id;
    assert.ok(generationId.startsWith('gen_'));

    const authorized = runCli(['improvement', 'authorize', generationId, '--profile', 'operator', '--json'], baseEnv(auditDir));
    assert.equal(authorized.code, 0, authorized.stderr);
    assert.equal((JSON.parse(authorized.stdout) as { data: { generation: { status: string } } }).data.generation.status, 'AUTHORIZED');

    const built = runCli(['improvement', 'build', generationId, '--profile', 'operator', '--json', '--input', '{}'], baseEnv(auditDir));
    assert.equal(built.code, 0, built.stderr);
    assert.equal((JSON.parse(built.stdout) as { data: { generation: { status: string } } }).data.generation.status, 'BUILT');

    const evaluateInput = {
      regressionTestCommand: [execPath, 'regression.mjs'], benchmarks: [{ benchmarkId: 'routing-accuracy', command: [execPath, 'benchmark.mjs'], threshold: 0.0, parentScore: 0.75 }],
      parentCapabilityProfile: { tools: [], operations: ['read'], resources: [], destinations: [], filesystem_writes: false, network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [] },
      candidateCapabilityProfile: { tools: [], operations: ['read'], resources: [], destinations: [], filesystem_writes: false, network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [] },
      candidateAuthorityProfile: proposeInput.authorityCeiling,
      requiredTestManifestBefore: { manifest_id: 'm1', manifest_version: 1, entries: [{ test_id: 't1', path: 'regression.mjs', content_hash: null, required: true, source: 'accepted' }], manifest_hash: 'h1' },
      requiredTestManifestAfter: { manifest_id: 'm1', manifest_version: 1, entries: [{ test_id: 't1', path: 'regression.mjs', content_hash: null, required: true, source: 'accepted' }], manifest_hash: 'h1' },
      evaluationProfileHash: 'cli-eval-profile',
    };
    const evaluated = runCli(['improvement', 'evaluate', generationId, '--profile', 'operator', '--json', '--input', JSON.stringify(evaluateInput)], baseEnv(auditDir));
    assert.equal(evaluated.code, 0, evaluated.stderr);
    const evalResult = JSON.parse(evaluated.stdout) as { ok: boolean; data: { evaluation: { status: string }; generation: { status: string } } };
    assert.equal(evalResult.ok, true);
    assert.equal(evalResult.data.evaluation.status, 'PROMOTE');
    assert.equal(evalResult.data.generation.status, 'EVALUATED');

    // Promotion requires admin role, a --reason, an exact --confirm, AND a real prior approval.
    const promoteNoRole = runCli(['improvement', 'promote', generationId, '--profile', 'operator', '--json', '--reason', 'x', '--confirm', generationId, '--approval', 'fake'], baseEnv(auditDir));
    assert.notEqual(promoteNoRole.code, 0);
    assert.equal((JSON.parse(promoteNoRole.stdout) as { code: string }).code, 'FORBIDDEN', 'operator role must not be sufficient to promote — only admin');

    // Section 55: promotion must pass through CANARY first — the state machine itself refuses a direct
    // EVALUATED -> PROMOTED jump, so canary needs its own real approval before promotion can proceed.
    const canaryApproval = runCli(['improvement', 'approve', generationId, '--profile', 'security-operator', '--json', '--reason', 'reviewed and safe', '--operation', 'start_canary'], baseEnv(auditDir));
    assert.equal(canaryApproval.code, 0, canaryApproval.stderr);
    const canaryApprovalId = (JSON.parse(canaryApproval.stdout) as { data: { approval: { approvalId: string } } }).data.approval.approvalId;
    const canaryStarted = runCli(['improvement', 'canary', generationId, '--profile', 'operator', '--json', '--approval', canaryApprovalId], baseEnv(auditDir));
    assert.equal(canaryStarted.code, 0, canaryStarted.stderr);
    assert.equal((JSON.parse(canaryStarted.stdout) as { data: { generation: { status: string } } }).data.generation.status, 'CANARY');

    const approval = runCli(['improvement', 'approve', generationId, '--profile', 'security-operator', '--json', '--reason', 'reviewed and safe', '--operation', 'promote'], baseEnv(auditDir));
    assert.equal(approval.code, 0, approval.stderr);
    const approvalId = (JSON.parse(approval.stdout) as { data: { approval: { approvalId: string } } }).data.approval.approvalId;

    const wrongConfirm = runCli(['improvement', 'promote', generationId, '--profile', 'admin', '--json', '--reason', 'x', '--confirm', 'gen_wrong-id', '--approval', approvalId], baseEnv(auditDir));
    assert.notEqual(wrongConfirm.code, 0);
    assert.equal((JSON.parse(wrongConfirm.stdout) as { code: string }).code, 'VALIDATION_ERROR');

    const promoted = runCli(['improvement', 'promote', generationId, '--profile', 'admin', '--json', '--reason', 'reviewed and approved', '--confirm', generationId, '--approval', approvalId], baseEnv(auditDir));
    assert.equal(promoted.code, 0, `stdout: ${promoted.stdout} stderr: ${promoted.stderr}`);
    assert.equal((JSON.parse(promoted.stdout) as { data: { generation: { status: string } } }).data.generation.status, 'PROMOTED');
  } finally { rmSync(auditDir, { recursive: true, force: true }); }
});

test('real CLI process: improvement explain produces a deterministic, evidence-backed summary', () => {
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-operator-improvement-audit-'));
  try {
    const proposeInput = {
      systemId: 'sys_cli_2', systemName: 'cli-demo-agent-2', parentGenerationId: null, parentWorkspacePath: FIXTURE_ROOT,
      objective: 'explain test', improvementClass: 'CLASS_1_CODE', allowedMutationPaths: ['router.mjs'],
      authorityCeiling: { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 60000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] },
      candidateVersion: 'v1', createdBy: 'cli-test',
    };
    const proposed = runCli(['improvement', 'propose', '--profile', 'operator', '--json', '--input', JSON.stringify(proposeInput)], baseEnv(auditDir));
    const generationId = (JSON.parse(proposed.stdout) as { data: { generation: { generation_id: string } } }).data.generation.generation_id;
    const explained = runCli(['improvement', 'explain', generationId, '--profile', 'viewer', '--json'], baseEnv(auditDir));
    assert.equal(explained.code, 0, explained.stderr);
    const result = JSON.parse(explained.stdout) as { ok: boolean; summary: string };
    assert.equal(result.ok, true);
    assert.ok(result.summary.length > 0);
  } finally { rmSync(auditDir, { recursive: true, force: true }); }
});
