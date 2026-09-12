/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12) — packaged smoke test. Boots the real, compiled
 * `tna-improvement-governor` binary (never an imported function) and drives it through one real
 * propose -> authorize -> build -> evaluate -> canary -> promote flow using the real, compiled `tna`
 * operator CLI binary. Exit 0 on success, non-zero on failure.
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

const GOVERNOR_MAIN = resolve('dist', 'apps', 'tna-improvement-governor', 'src', 'main.js');
const OPERATOR_MAIN = resolve('dist', 'apps', 'tna-operator', 'src', 'main.js');
const FIXTURE_ROOT = resolve('improvement', 'fixtures', 'demo-agent');
const ADMIN_TOKEN_ENV = 'SMOKE_IMPROVEMENT_ADMIN_TOKEN';

async function main(): Promise<void> {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-smoke-governor-'));
  const profileDir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-smoke-profiles-'));
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-smoke-audit-'));
  const adminToken = `smoke-improvement-admin-${'x'.repeat(20)}`;
  let governor: ChildProcess | undefined;
  try {
    const port = await freePort();
    governor = spawn(execPath, [GOVERNOR_MAIN], {
      env: {
        ...process.env, TNA_IMPROVEMENT_ADMIN_TOKEN: adminToken, TNA_IMPROVEMENT_DB_PATH: resolve(dataDir, 'improvement.sqlite'),
        TNA_IMPROVEMENT_GATE_DB_PATH: resolve(dataDir, 'gate.sqlite'), TNA_IMPROVEMENT_LEDGER_DB_PATH: resolve(dataDir, 'ledger.sqlite'),
        TNA_IMPROVEMENT_SENTINEL_DB_PATH: resolve(dataDir, 'sentinel.sqlite'), TNA_IMPROVEMENT_HOST: '127.0.0.1', TNA_IMPROVEMENT_PORT: String(port),
        TNA_IMPROVEMENT_TENANT_ID: 'ten_smoke',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    let live = false;
    while (Date.now() < deadline && !live) { try { live = (await fetch(`${baseUrl}/live`)).status === 200; } catch { /* not up */ } if (!live) await new Promise(r => setTimeout(r, 100)); }
    assert.ok(live, 'improvement governor did not become live');
    line('IMPROVEMENT GOVERNOR LIVE');

    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json() as { ready: boolean }).ready, true);
    line('IMPROVEMENT GOVERNOR READY (Gate/VAD/Sentinel/Ledger all real and reachable)');

    writeFileSync(resolve(profileDir, 'smoke.json'), JSON.stringify({ role: 'operator', devMode: true, improvementGovernorUrl: baseUrl, improvementGovernorTokenEnv: ADMIN_TOKEN_ENV }));
    writeFileSync(resolve(profileDir, 'smoke-admin.json'), JSON.stringify({ role: 'admin', devMode: true, improvementGovernorUrl: baseUrl, improvementGovernorTokenEnv: ADMIN_TOKEN_ENV }));
    writeFileSync(resolve(profileDir, 'smoke-approver.json'), JSON.stringify({ role: 'security-operator', devMode: true, improvementGovernorUrl: baseUrl, improvementGovernorTokenEnv: ADMIN_TOKEN_ENV }));
    const env = { ...process.env, TNA_OPERATOR_PROFILE_DIR: profileDir, [ADMIN_TOKEN_ENV]: adminToken, TNA_OPERATOR_AUDIT_DIR: auditDir };
    function runCli(args: readonly string[]) { return spawnSync(execPath, [OPERATOR_MAIN, ...args], { env, encoding: 'utf8' }); }

    const ceiling = { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 60_000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] };
    const capability = { tools: [], operations: ['read'], resources: [], destinations: [], filesystem_writes: false, network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [] };
    const manifest = { manifest_id: 'm1', manifest_version: 1, entries: [{ test_id: 't1', path: 'regression.mjs', content_hash: null, required: true, source: 'accepted' }], manifest_hash: 'h1' };

    const proposed = runCli(['improvement', 'propose', '--profile', 'smoke', '--json', '--input', JSON.stringify({
      systemId: 'sys_smoke', systemName: 'smoke-agent', parentGenerationId: null, parentWorkspacePath: FIXTURE_ROOT,
      objective: 'smoke test improvement', improvementClass: 'CLASS_1_CODE', allowedMutationPaths: ['router.mjs'],
      authorityCeiling: ceiling, candidateVersion: 'v1', createdBy: 'smoke', requiredBenchmarks: ['routing-accuracy'],
    })]);
    assert.equal(proposed.status, 0, proposed.stderr);
    assert.ok(!proposed.stdout.includes(adminToken), 'CLI output must never contain the raw improvement-governor admin bearer token');
    const generationId = (JSON.parse(proposed.stdout) as { data: { generation: { generation_id: string } } }).data.generation.generation_id;
    line('IMPROVEMENT PROPOSED');

    assert.equal(runCli(['improvement', 'authorize', generationId, '--profile', 'smoke', '--json']).status, 0);
    line('IMPROVEMENT AUTHORIZED');
    assert.equal(runCli(['improvement', 'build', generationId, '--profile', 'smoke', '--json', '--input', '{}']).status, 0);
    line('IMPROVEMENT BUILT');

    const evaluated = runCli(['improvement', 'evaluate', generationId, '--profile', 'smoke', '--json', '--input', JSON.stringify({
      regressionTestCommand: [execPath, 'regression.mjs'], benchmarks: [{ benchmarkId: 'routing-accuracy', command: [execPath, 'benchmark.mjs'], threshold: 0.0, parentScore: 0.75 }],
      parentCapabilityProfile: capability, candidateCapabilityProfile: capability, candidateAuthorityProfile: ceiling,
      requiredTestManifestBefore: manifest, requiredTestManifestAfter: manifest, evaluationProfileHash: 'smoke-eval-profile',
    })]);
    assert.equal(evaluated.status, 0, evaluated.stderr);
    line('IMPROVEMENT EVALUATED (real VAD + real regression/benchmark evidence): PROMOTE-eligible');

    const canaryApproval = runCli(['improvement', 'approve', generationId, '--profile', 'smoke-approver', '--json', '--reason', 'smoke', '--operation', 'start_canary']);
    const canaryApprovalId = (JSON.parse(canaryApproval.stdout) as { data: { approval: { approvalId: string } } }).data.approval.approvalId;
    assert.equal(runCli(['improvement', 'canary', generationId, '--profile', 'smoke', '--json', '--approval', canaryApprovalId]).status, 0);
    line('IMPROVEMENT CANARY STARTED (real Sentinel session)');

    const promoteApproval = runCli(['improvement', 'approve', generationId, '--profile', 'smoke-approver', '--json', '--reason', 'smoke', '--operation', 'promote']);
    const promoteApprovalId = (JSON.parse(promoteApproval.stdout) as { data: { approval: { approvalId: string } } }).data.approval.approvalId;
    const promoted = runCli(['improvement', 'promote', generationId, '--profile', 'smoke-admin', '--json', '--reason', 'smoke', '--confirm', generationId, '--approval', promoteApprovalId]);
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.equal((JSON.parse(promoted.stdout) as { data: { generation: { status: string } } }).data.generation.status, 'PROMOTED');
    line('IMPROVEMENT PROMOTED');

    const evidence = runCli(['improvement', 'evidence', generationId, '--profile', 'smoke', '--json']);
    assert.equal(evidence.status, 0, evidence.stderr);
    assert.equal((JSON.parse(evidence.stdout) as { data: { reconstruction: { finalState: string } } }).data.reconstruction.finalState, 'PROMOTED');
    line('EVIDENCE RECONSTRUCTED FROM REAL LEDGER');

    const viewerProfilePath = resolve(profileDir, 'smoke-viewer.json');
    writeFileSync(viewerProfilePath, JSON.stringify({ role: 'viewer', devMode: true, improvementGovernorUrl: baseUrl, improvementGovernorTokenEnv: ADMIN_TOKEN_ENV }));
    const viewerAttempt = runCli(['improvement', 'propose', '--profile', 'smoke-viewer', '--json', '--input', '{}']);
    assert.notEqual(viewerAttempt.status, 0);
    assert.equal((JSON.parse(viewerAttempt.stdout) as { code: string }).code, 'FORBIDDEN');
    line('ROLE BOUNDARY ENFORCED');

    line('SMOKE PASSED');
    process.stdout.write('TNA Recursive Improvement Governance v0.1 packaged smoke test passed.\n');
  } finally {
    if (governor) governor.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 200));
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

main().catch(error => { process.stderr.write(`smoke test failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
