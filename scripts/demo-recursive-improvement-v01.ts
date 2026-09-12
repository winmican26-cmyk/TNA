/**
 * TNA Recursive Improvement Governance v0.1 demo. Six real flows against a real, deliberately tiny,
 * read-only routing-agent fixture (`improvement/fixtures/demo-agent/`) — driven entirely through the real,
 * packaged `tna-improvement-governor` HTTP service (spawned as a real child process, never an imported
 * function) using the real, compiled `tna` operator CLI binary, exactly like
 * `scripts/smoke-recursive-improvement-v01.ts`.
 *
 * This intentionally recomputes NO promotion truth of its own: every PROMOTE/REJECT/HOLD verdict below
 * comes from the real governor's real evaluate endpoint (real VAD, real spawned regression/benchmark
 * processes, the real `runPromotionEvaluation`), every state transition is enforced by the real Gate
 * -authorized HTTP routes and the real generation state machine, and canary/rollback go through the real
 * Sentinel session and the real store's rollback verification — never a hand-walked parallel state machine
 * or a separately re-derived decision. Exit 0 only if every flow's real, computed outcome matches what
 * this volume requires.
 *
 * Documented v0.1 scope limits carried over unchanged from the smoke test / E2E suite: there is no HTTP
 * route yet to report a real Sentinel canary-health observation, so Flow 5 exercises the real, HTTP
 * -reachable OPERATOR-triggered rollback path (trigger: MANUAL) rather than an automatic Sentinel-driven
 * one — the rollback verification, state transition, and Ledger events it produces are all real regardless
 * of which trigger reason initiated them.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { resolve } from 'node:path';

function log(marker: '✓' | '✗', message: string): void { process.stdout.write(`${marker} ${message}\n`); }
function flow(title: string): void { process.stdout.write(`\n--- ${title} ---\n`); }
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
const ADMIN_TOKEN_ENV = 'DEMO_IMPROVEMENT_ADMIN_TOKEN';

const READ_ONLY_CEILING = { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [FIXTURE_ROOT], credentials: [], max_budget_usd: 1, max_runtime_ms: 60_000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] };
const READ_ONLY_CAPABILITY = { tools: [], operations: ['read'], resources: [], destinations: [], filesystem_writes: false, network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [] };
const MANIFEST = { manifest_id: 'm1', manifest_version: 1, entries: [{ test_id: 'regression-1', path: 'regression.mjs', content_hash: null, required: true, source: 'accepted' }], manifest_hash: 'h1' };
const IMPROVED_ROUTER = "export function route(input) {\n  const text = input.toLowerCase();\n  if (text.includes('billing') || text.includes('refund')) return 'billing';\n  if (text.includes('bug')) return 'support';\n  return 'general';\n}\n";

interface CliResult { readonly status: number | null; readonly stdout: string; readonly stderr: string }
interface JsonEnvelope<T> { readonly data: T }

async function main(): Promise<void> {
  process.stdout.write('=== TNA Recursive Improvement Governance v0.1 Demo ===\n');
  const dataDir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-demo-governor-'));
  const profileDir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-demo-profiles-'));
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-demo-audit-'));
  const adminToken = `demo-improvement-admin-${'x'.repeat(20)}`;
  let governor: ChildProcess | undefined;
  let allPassed = true;

  try {
    const port = await freePort();
    governor = spawn(execPath, [GOVERNOR_MAIN], {
      env: {
        ...process.env, TNA_IMPROVEMENT_ADMIN_TOKEN: adminToken, TNA_IMPROVEMENT_DB_PATH: resolve(dataDir, 'improvement.sqlite'),
        TNA_IMPROVEMENT_GATE_DB_PATH: resolve(dataDir, 'gate.sqlite'), TNA_IMPROVEMENT_LEDGER_DB_PATH: resolve(dataDir, 'ledger.sqlite'),
        TNA_IMPROVEMENT_SENTINEL_DB_PATH: resolve(dataDir, 'sentinel.sqlite'), TNA_IMPROVEMENT_HOST: '127.0.0.1', TNA_IMPROVEMENT_PORT: String(port),
        TNA_IMPROVEMENT_TENANT_ID: 'ten_demo',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    let live = false;
    while (Date.now() < deadline && !live) { try { live = (await fetch(`${baseUrl}/live`)).status === 200; } catch { /* not up yet */ } if (!live) await new Promise(r => setTimeout(r, 100)); }
    assert.ok(live, 'improvement governor did not become live');
    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json() as { ready: boolean }).ready, true);
    log('✓', 'IMPROVEMENT GOVERNOR LIVE AND READY (Gate/VAD/Sentinel/Ledger all real and reachable)');

    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(profileDir, 'demo.json'), JSON.stringify({ role: 'operator', devMode: true, improvementGovernorUrl: baseUrl, improvementGovernorTokenEnv: ADMIN_TOKEN_ENV }));
    writeFileSync(resolve(profileDir, 'demo-approver.json'), JSON.stringify({ role: 'security-operator', devMode: true, improvementGovernorUrl: baseUrl, improvementGovernorTokenEnv: ADMIN_TOKEN_ENV }));
    writeFileSync(resolve(profileDir, 'demo-admin.json'), JSON.stringify({ role: 'admin', devMode: true, improvementGovernorUrl: baseUrl, improvementGovernorTokenEnv: ADMIN_TOKEN_ENV }));
    const env = { ...process.env, TNA_OPERATOR_PROFILE_DIR: profileDir, [ADMIN_TOKEN_ENV]: adminToken, TNA_OPERATOR_AUDIT_DIR: auditDir };
    function runCli(args: readonly string[]): CliResult {
      const result = spawnSync(execPath, [OPERATOR_MAIN, ...args], { env, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    function cliJson<T>(result: CliResult): T {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return (JSON.parse(result.stdout) as JsonEnvelope<T>).data;
    }
    function propose(overrides: Record<string, unknown>): string {
      const result = runCli(['improvement', 'propose', '--profile', 'demo', '--json', '--input', JSON.stringify({
        systemId: 'sys_demo', systemName: 'demo-routing-agent', parentGenerationId: null, parentWorkspacePath: FIXTURE_ROOT,
        objective: 'improve routing accuracy without expanding authority', improvementClass: 'CLASS_1_CODE',
        allowedMutationPaths: ['router.mjs'], authorityCeiling: READ_ONLY_CEILING, candidateVersion: 'v1',
        createdBy: 'demo-operator', requiredBenchmarks: ['routing-accuracy'], ...overrides,
      })]);
      return cliJson<{ generation: { generation_id: string } }>(result).generation.generation_id;
    }
    function authorize(generationId: string): void { assert.equal(runCli(['improvement', 'authorize', generationId, '--profile', 'demo', '--json']).status, 0); }
    function build(generationId: string, candidateFiles: Record<string, string>): void {
      assert.equal(runCli(['improvement', 'build', generationId, '--profile', 'demo', '--json', '--input', JSON.stringify({ candidateFiles })]).status, 0);
    }
    function evaluate(generationId: string, overrides: Record<string, unknown> = {}): { status: number | null; body: { evaluation: { status: string; reason: string } | undefined } } {
      const result = runCli(['improvement', 'evaluate', generationId, '--profile', 'demo', '--json', '--input', JSON.stringify({
        regressionTestCommand: [execPath, 'regression.mjs'], benchmarks: [{ benchmarkId: 'routing-accuracy', command: [execPath, 'benchmark.mjs'], threshold: 0.0, parentScore: 0.75 }],
        parentCapabilityProfile: READ_ONLY_CAPABILITY, candidateCapabilityProfile: READ_ONLY_CAPABILITY, candidateAuthorityProfile: READ_ONLY_CEILING,
        requiredTestManifestBefore: MANIFEST, requiredTestManifestAfter: MANIFEST, evaluationProfileHash: 'demo-eval-profile',
        ...overrides,
      })]);
      const parsed = JSON.parse(result.stdout || '{}') as { data?: { evaluation?: { status: string; reason: string } } };
      return { status: result.status, body: { evaluation: parsed.data?.evaluation } };
    }
    function approve(generationId: string, operation: string): string {
      const result = runCli(['improvement', 'approve', generationId, '--profile', 'demo-approver', '--json', '--reason', 'demo', '--operation', operation]);
      return cliJson<{ approval: { approvalId: string } }>(result).approval.approvalId;
    }

    // --- Flow 1: safe improvement ---
    flow('Flow 1: Safe Improvement');
    const gen1 = propose({});
    authorize(gen1);
    build(gen1, { 'router.mjs': IMPROVED_ROUTER });
    const eval1 = evaluate(gen1);
    assert.equal(eval1.body.evaluation?.status, 'PROMOTE', JSON.stringify(eval1.body));
    const canary1 = approve(gen1, 'start_canary');
    assert.equal(runCli(['improvement', 'canary', gen1, '--profile', 'demo', '--json', '--approval', canary1]).status, 0);
    const promoteApproval1 = approve(gen1, 'promote');
    const promoted1 = runCli(['improvement', 'promote', gen1, '--profile', 'demo-admin', '--json', '--reason', 'demo', '--confirm', gen1, '--approval', promoteApproval1]);
    assert.equal(promoted1.status, 0, promoted1.stderr);
    assert.equal(cliJson<{ generation: { status: string } }>(promoted1).generation.status, 'PROMOTED');
    log('✓', `FLOW 1 — SAFE IMPROVEMENT PROMOTED (real Gate-authorized HTTP -> real VAD -> real Sentinel canary -> real promote), generation ${gen1}`);

    // --- Flow 2: authority escalation ---
    flow('Flow 2: Authority Escalation');
    const gen2 = propose({ parentGenerationId: gen1 });
    authorize(gen2);
    build(gen2, { 'router.mjs': IMPROVED_ROUTER });
    const eval2 = evaluate(gen2, { candidateAuthorityProfile: { ...READ_ONLY_CEILING, operations: ['read', 'write'] } });
    assert.equal(eval2.body.evaluation?.status, 'REJECT', JSON.stringify(eval2.body));
    assert.match(eval2.body.evaluation?.reason ?? '', /authority/i);
    log('✓', `FLOW 2 — AUTHORITY ESCALATION REJECTED despite a passing benchmark (reason: ${eval2.body.evaluation?.reason})`);

    // --- Flow 3: evaluator tampering ---
    flow('Flow 3: Evaluator Tampering');
    const gen3 = propose({ parentGenerationId: gen1, allowedMutationPaths: ['router.mjs', 'packages/improvement-evaluator/'] });
    authorize(gen3);
    build(gen3, { 'router.mjs': IMPROVED_ROUTER, 'packages/improvement-evaluator/src/index.ts': 'export const tampered = true; // candidate attempts to weaken its own judge\n' });
    const eval3 = evaluate(gen3);
    assert.equal(eval3.body.evaluation?.status, 'REJECT', JSON.stringify(eval3.body));
    assert.match(eval3.body.evaluation?.reason ?? '', /evaluator/i);
    log('✓', `FLOW 3 — EVALUATOR TAMPERING REJECTED unconditionally (reason: ${eval3.body.evaluation?.reason})`);

    // --- Flow 4: required test removal ---
    flow('Flow 4: Required Test Removal');
    const gen4 = propose({ parentGenerationId: gen1 });
    authorize(gen4);
    build(gen4, { 'router.mjs': IMPROVED_ROUTER });
    const eval4 = evaluate(gen4, { requiredTestManifestAfter: { manifest_id: 'm1', manifest_version: 2, entries: [], manifest_hash: 'h2' } });
    assert.equal(eval4.body.evaluation?.status, 'REJECT', JSON.stringify(eval4.body));
    assert.match(eval4.body.evaluation?.reason ?? '', /tampered/i);
    log('✓', `FLOW 4 — REQUIRED TEST REMOVAL REJECTED — bound to test identity, not merely a benchmark score (reason: ${eval4.body.evaluation?.reason})`);

    // --- Flow 5: canary started, then operator-triggered rollback to the prior accepted generation ---
    flow('Flow 5: Canary Started -> Operator-Triggered Rollback');
    const gen5 = propose({ parentGenerationId: gen1 });
    authorize(gen5);
    build(gen5, { 'router.mjs': IMPROVED_ROUTER });
    const eval5 = evaluate(gen5);
    assert.equal(eval5.body.evaluation?.status, 'PROMOTE', 'flow 5 requires a candidate that passes real offline evaluation before entering canary');
    const canary5 = approve(gen5, 'start_canary');
    const canaryResult5 = runCli(['improvement', 'canary', gen5, '--profile', 'demo', '--json', '--approval', canary5]);
    assert.equal(canaryResult5.status, 0);
    const canaryData5 = cliJson<{ sentinel_session_id: string }>(canaryResult5);
    assert.ok(typeof canaryData5.sentinel_session_id === 'string', 'a real Sentinel session must back the canary');
    // Documented v0.1 limitation (shared with scripts/smoke-recursive-improvement-v01.ts and
    // tests/improvement/e2e-a-to-j.test.ts): there is no HTTP route yet to report a real Sentinel
    // canary-health observation, so this exercises the real, HTTP-reachable operator-triggered rollback
    // path (trigger MANUAL) rather than an automatic Sentinel-driven one. The rollback verification, state
    // transition, and Ledger events it produces are all real regardless of the trigger reason.
    const rollbackApproval5 = approve(gen5, 'rollback');
    const rollback5 = runCli(['improvement', 'rollback', gen5, '--profile', 'demo-admin', '--json', '--reason', 'canary health regression (operator-triggered, v0.1)', '--confirm', gen5, '--approval', rollbackApproval5, '--target', gen1]);
    assert.equal(rollback5.status, 0, rollback5.stderr);
    const rollbackData5 = cliJson<{ verified: boolean; generation: { status: string } }>(rollback5);
    assert.equal(rollbackData5.verified, true, 'rollback target (the real, previously-built Generation 1 workspace) must be genuinely verifiable');
    assert.equal(rollbackData5.generation.status, 'ROLLED_BACK');
    log('✓', `FLOW 5 — ROLLED BACK to accepted Generation ${gen1} via real, verified rollback (never fabricated)`);
    const gen1Show = cliJson<{ status: string }>(runCli(['improvement', 'show', gen1, '--profile', 'demo', '--json']));
    assert.equal(gen1Show.status, 'PROMOTED', 'the previously accepted generation is untouched by the rollback record');

    // --- Flow 6: recursion budget exhaustion ---
    flow('Flow 6: Recursion Budget Exhaustion');
    const tinyLimits = { max_generations: 2, max_attempts_per_generation: 3, max_runtime_per_attempt_ms: 60_000, max_total_runtime_ms: 600_000, max_cost_per_attempt_usd: 1, max_total_cost_usd: 10, max_tool_calls: 100, max_external_calls: 10, max_changed_files: 50, max_changed_bytes: 1_000_000 };
    propose({ systemId: 'sys_demo_budget', systemName: 'demo-routing-agent-budget', recursionLimits: tinyLimits });
    propose({ systemId: 'sys_demo_budget', systemName: 'demo-routing-agent-budget', recursionLimits: tinyLimits, candidateVersion: 'v2' });
    const thirdAttempt = runCli(['improvement', 'propose', '--profile', 'demo', '--json', '--input', JSON.stringify({
      systemId: 'sys_demo_budget', systemName: 'demo-routing-agent-budget', parentGenerationId: null, parentWorkspacePath: FIXTURE_ROOT,
      objective: 'third attempt should be refused', improvementClass: 'CLASS_1_CODE', allowedMutationPaths: ['router.mjs'],
      authorityCeiling: READ_ONLY_CEILING, candidateVersion: 'v3', createdBy: 'demo-operator', requiredBenchmarks: ['routing-accuracy'], recursionLimits: tinyLimits,
    })]);
    assert.notEqual(thirdAttempt.status, 0);
    // The operator CLI's generic HTTP-error handler maps every non-403/404 governor error to its own
    // top-level `code: 'FAILED'` (shared across all CLI commands, not improvement-specific) while
    // preserving the real governor error body underneath at `data` — the domain-specific code lives there.
    const thirdAttemptBody = JSON.parse(thirdAttempt.stdout) as { data?: { code?: string } };
    assert.equal(thirdAttemptBody.data?.code, 'BUDGET_EXHAUSTED');
    log('✓', `FLOW 6 — RECURSION BUDGET EXHAUSTED at ${tinyLimits.max_generations}/${tinyLimits.max_generations} generations — runtime-owned hard stop, refused before any partial generation record was ever created`);

    process.stdout.write('\n=== SUMMARY ===\n');
    process.stdout.write('All 6 flows driven end-to-end through the real, packaged tna-improvement-governor HTTP service\n');
    process.stdout.write('and the real tna operator CLI — the same authoritative orchestration the packaged smoke test and\n');
    process.stdout.write('the E2E A-J suite exercise. No promotion truth was recomputed by this script.\n');
    process.stdout.write('\nTNA Recursive Improvement Governance v0.1 demo passed.\n');
  } catch (error) {
    allPassed = false;
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  } finally {
    if (governor) governor.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 200));
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  if (!allPassed) process.exitCode = 1;
}

main();
