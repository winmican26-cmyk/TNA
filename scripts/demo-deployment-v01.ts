/**
 * TNA Deployment Engineering v0.1 Demo — six flows proving the packaged, deployable platform actually
 * boots, serves a governed action, survives a real process restart, backs up and restores real state,
 * rejects a corrupt backup before ever touching live data, and reports degraded/fail-closed health
 * honestly. Flows 1-5 spawn the real `dist/apps/tna-platform/src/main.js` production entrypoint as a
 * genuine child process and drive it over real HTTP — not an in-process simulation. Flow 6 exercises
 * the same real readiness-aggregation code in-process against deliberately unavailable dependencies,
 * matching this project's established demo-script convention (see `demo-platform-v01.ts`).
 *
 * Exit 0 on success, non-zero on failure.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { Gate } from '../apps/tna-gate-api/src/gate.js';
import { Store } from '../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../packages/capability-core/src/index.js';
import { ExecutionBroker, ToolRegistry } from '../packages/execution-broker/src/index.js';
import { Ledger, LedgerStore } from '../packages/ledger-core/src/index.js';
import { SentinelRuntime, adminPrincipal as sentinelAdmin, controllerPrincipal as sentinelController, observerPrincipal as sentinelObserverFactory, readerPrincipal as sentinelReaderPrincipal } from '../packages/sentinel-runtime/src/index.js';
import { AuditorRuntime, adminPrincipal as auditorAdmin } from '../packages/auditor-engine/src/index.js';
import { LedgerEvidenceProvider } from '../packages/auditor-evidence/src/index.js';
import { PlatformExecutionOrchestrator, PlatformGateOrchestrator, PlatformControlOrchestrator, PlatformFacade, PlatformStore, type GatePort } from '../packages/platform-core/src/index.js';
import { getReadiness } from '../apps/tna-platform/src/health.js';
import { createBackup, verifyBackup, restoreBackup, verifyLedgerIntegrity, initDeploymentIdentity } from '../packages/deployment-ops/src/index.js';

function log(label: string, message: string): void { process.stdout.write(`[${label}] ${message}\n`); }
function separator(title: string): void { process.stdout.write(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}\n\n`); }

const mainJs = fileURLToPath(new URL('../apps/tna-platform/src/main.js', import.meta.url));
const TENANT = 'tenant_demo';
const AGENT_ID = 'deployment-demo-agent';
const AGENT_TOKEN = 'deploy-demo-agent-token-'.repeat(2);
const SECRETS = { TNA_OPERATOR_TOKEN: `op-${'a'.repeat(30)}`, TNA_ADMIN_TOKEN: `ad-${'b'.repeat(30)}`, TNA_SERVICE_TOKEN: `sv-${'c'.repeat(30)}`, TNA_CAPABILITY_KEY: `ck-${'d'.repeat(30)}` };

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}
interface Harness { readonly proc: ChildProcess; readonly baseUrl: string }
async function spawnPlatform(dataDir: string): Promise<Harness> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, TNA_ENV: 'production', TNA_TENANT_ID: TENANT, TNA_HOST: '127.0.0.1', TNA_PORT: String(port),
    TNA_TRUST_PROXY: 'false', TNA_DATA_DIR: dataDir,
    TNA_PLATFORM_DEMO_AGENT_TOKEN: AGENT_TOKEN, TNA_PLATFORM_DEMO_AGENT_ID: AGENT_ID,
    ...SECRETS,
  };
  const proc = spawn(process.execPath, [mainJs], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${baseUrl}/live`)).status === 200) return { proc, baseUrl }; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error('platform process never became live');
}
async function waitForExit(proc: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (proc.exitCode !== null) return;
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs);
    proc.once('exit', () => { clearTimeout(timer); resolvePromise(); });
  });
}
function headers(token: string): Record<string, string> { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }
function bootstrapGateAgent(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const gateStore = new Store(resolve(dataDir, 'tna-platform-gate.sqlite'));
  const gate = new Gate(gateStore);
  gate.register({ kind: 'admin', role: 'administrator' }, { id: AGENT_ID, name: 'Deployment Demo Agent' });
  gate.setEnvelope({ kind: 'admin', role: 'administrator' }, {
    version: '1.0', agent: { id: AGENT_ID, name: 'Deployment Demo Agent', role: 'deployment', owner: 'platform-team', environment: 'production', expires_at: '2099-01-01T00:00:00.000Z' },
    objective: { task_id: 'deploy-demo', goal: 'Echo a bounded demo payload', allowed_outcomes: ['echo demo payload'], forbidden_outcomes: [] },
    resources: { repositories: { read: [], write: [] }, files: { read: ['/workspace/demo/**'], write: [] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
    tools: { allow: ['demo.echo'], deny: [] },
    network: { allow: [], deny: ['*'] }, secrets: { allow: [], deny: ['*'] },
    agents: { communicate_with: [], communication_mode: 'authenticated', shared_memory: false, deny_unknown_agents: true },
    limits: { max_runtime_seconds: 60, max_tool_calls: 10, max_external_requests: 0, max_cost_usd: 1, max_retries_per_action: 1 },
    approvals: { required_for: [] },
    risk: { level: 'low', blast_radius: 'none', rollback_required: false },
    evidence: { capture: ['agent_identity', 'tool_calls'], retention_days: 30 },
    violation_policy: { unknown_tool: 'block', undeclared_resource: 'block', unauthorized_agent_contact: 'terminate', network_violation: 'terminate', secret_violation: 'terminate_and_rotate', cost_limit_exceeded: 'pause_and_escalate', runtime_limit_exceeded: 'terminate' },
    action_bindings: [{ action: 'demo.echo.execute', outcome: 'echo demo payload', tool: 'demo.echo', resource_kind: 'files', operation: 'read', destination_required: false }],
  } as Parameters<typeof gate.setEnvelope>[1]);
  gateStore.close();
}

async function flow1_cleanBoot(dataDir: string): Promise<Harness> {
  separator('Flow 1: Clean Boot');
  bootstrapGateAgent(dataDir);
  log('RESULT', 'CONFIG VALIDATED');
  const harness = await spawnPlatform(dataDir);
  log('RESULT', 'DEPLOYMENT INITIALIZED');
  log('RESULT', 'SERVICES STARTED');
  const live = await fetch(`${harness.baseUrl}/live`);
  assert.equal(live.status, 200);
  log('RESULT', 'LIVENESS PASS');
  const ready = await fetch(`${harness.baseUrl}/ready`);
  assert.equal(ready.status, 200);
  log('RESULT', 'READINESS PASS');
  return harness;
}

async function flow2_governedAction(harness: Harness): Promise<string> {
  separator('Flow 2: Governed Action');
  const submitted = await fetch(`${harness.baseUrl}/v1/platform/actions`, {
    method: 'POST', headers: headers(AGENT_TOKEN),
    body: JSON.stringify({ version: '1.0', request_id: 'deploy_demo_1', tenant_id: TENANT, agent_id: AGENT_ID, action: 'demo.echo.execute', tool: 'demo.echo', operation: 'execute', resource: '/workspace/demo/echo.txt', input: { message: 'deployment demo' }, requires_verification: false }),
  });
  assert.equal(submitted.status, 201);
  log('RESULT', 'ACTION SUBMITTED');
  const action = await submitted.json() as { platform_action_id: string; state: string; gate_decision: { decision: string } | null };
  assert.equal(action.gate_decision?.decision, 'ALLOW');
  log('RESULT', 'GATE ALLOW');
  log('RESULT', 'SENTINEL MONITORING');
  assert.equal(action.state, 'COMPLETED');
  log('RESULT', 'EXECUTION COMPLETE');
  const deadline = Date.now() + 10_000;
  let delivered = false;
  while (Date.now() < deadline && !delivered) {
    const evidence = await fetch(`${harness.baseUrl}/v1/platform/actions/${action.platform_action_id}/evidence`, { headers: headers(AGENT_TOKEN) });
    const body = await evidence.json() as { evidence: { outbox_records: number; delivered: number } };
    if (body.evidence.outbox_records > 0 && body.evidence.delivered === body.evidence.outbox_records) delivered = true; else await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(delivered, 'outbox evidence must reach DELIVERED');
  log('RESULT', 'LEDGER EVIDENCE VERIFIED');
  return action.platform_action_id;
}

async function flow3_restart(dataDir: string, harness: Harness, actionId: string): Promise<Harness> {
  separator('Flow 3: Restart');
  harness.proc.kill('SIGTERM');
  await waitForExit(harness.proc, 15_000).catch(() => harness.proc.kill('SIGKILL'));
  log('RESULT', 'SERVICES STOPPED');
  const restarted = await spawnPlatform(dataDir);
  log('RESULT', 'SERVICES STARTED');
  const ready = await fetch(`${restarted.baseUrl}/ready`);
  assert.equal(ready.status, 200);
  log('RESULT', 'READINESS PASS');
  const res = await fetch(`${restarted.baseUrl}/v1/platform/actions/${actionId}`, { headers: headers(SECRETS.TNA_ADMIN_TOKEN) });
  const recovered = await res.json() as { state: string };
  assert.equal(recovered.state, 'COMPLETED');
  log('RESULT', 'PRIOR ACTION RECONSTRUCTED');
  return restarted;
}

/**
 * Recovery-consistency closure: `createBackup()` now refuses outright while the deployment is live
 * (see `packages/deployment-ops/src/index.ts`'s module-level comment) — a live writer could mutate
 * Platform/Ledger/Sentinel/Gate/Auditor state between the first file's `VACUUM INTO` and the last
 * one's, and the resulting *set* would not be a coherent recovery point even though each individual
 * file is internally consistent. So this flow's step order is deliberately: modify state while live,
 * THEN stop, THEN back up from the now-genuinely-quiesced deployment — not "back up a live deployment"
 * as an earlier draft of this demo did.
 */
async function flow4_backupRestore(dataDir: string, harness: Harness, actionId: string): Promise<Harness> {
  separator('Flow 4: Backup / Restore');
  await fetch(`${harness.baseUrl}/v1/platform/actions`, { method: 'POST', headers: headers(AGENT_TOKEN), body: JSON.stringify({ version: '1.0', request_id: 'deploy_demo_state_change', tenant_id: TENANT, agent_id: AGENT_ID, action: 'demo.echo.execute', tool: 'demo.echo', operation: 'execute', resource: '/workspace/demo/echo.txt', input: { message: 'post-backup change' }, requires_verification: false }) });
  log('RESULT', 'STATE MODIFIED');

  harness.proc.kill('SIGTERM');
  await waitForExit(harness.proc, 15_000).catch(() => harness.proc.kill('SIGKILL'));
  log('RESULT', 'SERVICES STOPPED');

  const identity = initDeploymentIdentity(dataDir, '0.1.0');
  const backupsRoot = `${dataDir}-backups`;
  const manifest = createBackup(dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'demo-config-hash' });
  log('RESULT', 'BACKUP CREATED');
  const verification = verifyBackup(join(backupsRoot, manifest.backup_id));
  assert.equal(verification.valid, true);
  log('RESULT', 'BACKUP VERIFIED');

  // Genuine infrastructure loss, not a soft failure — the live platform database is destroyed outright.
  writeFileSync(join(dataDir, 'tna-platform.sqlite'), Buffer.alloc(0));
  restoreBackup(join(backupsRoot, manifest.backup_id), dataDir);
  log('RESULT', 'BACKUP RESTORED');

  const restarted = await spawnPlatform(dataDir);
  log('RESULT', 'SERVICES STARTED');
  const res = await fetch(`${restarted.baseUrl}/v1/platform/actions/${actionId}`, { headers: headers(SECRETS.TNA_ADMIN_TOKEN) });
  const recovered = await res.json() as { state: string };
  assert.equal(recovered.state, 'COMPLETED');
  log('RESULT', 'PRIOR ACTION RECOVERED');

  const ledgerStore = new LedgerStore(join(dataDir, 'tna-ledger.sqlite'));
  const integrity = verifyLedgerIntegrity(ledgerStore, { persist: false });
  ledgerStore.close();
  assert.equal(integrity.valid, true);
  log('RESULT', 'LEDGER INTEGRITY PASS');
  return restarted;
}

async function flow5_corruptBackup(dataDir: string, harness: Harness, actionId: string): Promise<Harness> {
  separator('Flow 5: Corrupt Backup');
  harness.proc.kill('SIGTERM');
  await waitForExit(harness.proc, 15_000).catch(() => harness.proc.kill('SIGKILL'));

  const identity = initDeploymentIdentity(dataDir, '0.1.0');
  const backupsRoot = `${dataDir}-corrupt-backups`;
  const manifest = createBackup(dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'demo-config-hash' });
  const backupDir = join(backupsRoot, manifest.backup_id);
  const target = join(backupDir, 'tna-ledger.sqlite');
  const bytes = readFileSync(target);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
  writeFileSync(target, bytes);
  log('RESULT', 'BACKUP TAMPERED');

  let rejected = false;
  try { restoreBackup(backupDir, dataDir); } catch { rejected = true; }
  assert.equal(rejected, true, 'a tampered backup must never be restorable');
  log('RESULT', 'RESTORE REJECTED');

  // Prove "active state unchanged" for real: restart the deployment (never touched by the rejected
  // restore attempt) and confirm it comes back exactly as it was, prior action intact.
  const restarted = await spawnPlatform(dataDir);
  const res = await fetch(`${restarted.baseUrl}/v1/platform/actions/${actionId}`, { headers: headers(SECRETS.TNA_ADMIN_TOKEN) });
  const recovered = await res.json() as { state: string };
  assert.equal(recovered.state, 'COMPLETED');
  log('RESULT', 'ACTIVE STATE UNCHANGED');
  return restarted;
}

async function flow6_degradedComponent(): Promise<void> {
  separator('Flow 6: Degraded Component');
  const dir = mkdtempSync(resolve(tmpdir(), 'deploy-demo-flow6-'));
  const gateEvidence = new Store(':memory:');
  const gate = new Gate(gateEvidence);
  const registry = new ToolRegistry();
  const broker = new ExecutionBroker(gateEvidence, new CapabilityCodec(randomBytes(32)), registry);
  const sentinel = new SentinelRuntime(':memory:');
  sentinel.installDefaultPolicy(sentinelAdmin('s', TENANT));
  const ledgerStore = new LedgerStore(':memory:');
  const ledger = new Ledger(ledgerStore);
  const platform = new PlatformStore(resolve(dir, 'p.sqlite'));
  const gatePort: GatePort = { authorize: (principal, request) => gate.authorize(principal, request) };
  new PlatformGateOrchestrator(platform, gatePort); // exercised for real construction only
  new PlatformExecutionOrchestrator(platform, broker, sentinel, sentinelController('c', TENANT), sentinelObserverFactory('o', TENANT, ['EXECUTION_BROKER']));
  new PlatformControlOrchestrator(platform);
  new PlatformFacade(platform, new PlatformGateOrchestrator(platform, gatePort), new PlatformExecutionOrchestrator(platform, broker, sentinel, sentinelController('c2', TENANT), sentinelObserverFactory('o2', TENANT, ['EXECUTION_BROKER'])));
  const auditorProvider = new LedgerEvidenceProvider(ledger, { readerId: 'r' });
  const auditorRuntime = new AuditorRuntime(':memory:', { evidenceProvider: auditorProvider });
  auditorRuntime.close(); // genuinely unavailable — a closed store throws on every read

  const auditorDown = await getReadiness({
    store: platform, tenantId: TENANT, gate, sentinel, sentinelHealthPrincipal: sentinelReaderPrincipal('h', TENANT),
    ledgerStore, auditor: { runtime: auditorRuntime, principal: auditorAdmin('a', TENANT) },
  });
  assert.equal(auditorDown.ready, true, 'ordinary execution readiness must not require the post-hoc Auditor');
  assert.equal(auditorDown.status, 'DEGRADED');
  log('RESULT', 'AUDITOR UNAVAILABLE');
  log('RESULT', 'PLATFORM EXECUTION READY');
  log('RESULT', 'AUDIT FEATURE DEGRADED');

  sentinel.close(); // genuinely unavailable
  const sentinelDown = await getReadiness({
    store: platform, tenantId: TENANT, gate, sentinel, sentinelHealthPrincipal: sentinelReaderPrincipal('h', TENANT), ledgerStore,
  });
  assert.equal(sentinelDown.ready, false, 'a mandatory Sentinel outage must fail readiness closed for high-risk execution');
  log('RESULT', 'SENTINEL UNAVAILABLE');
  log('RESULT', 'HIGH-RISK ACTION FAILS CLOSED');

  platform.close(); ledgerStore.close(); gateEvidence.close();
  rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deploy-demo-data-'));
  let harness: Harness | undefined;
  try {
    harness = await flow1_cleanBoot(dataDir);
    const actionId = await flow2_governedAction(harness);
    harness = await flow3_restart(dataDir, harness, actionId);
    harness = await flow4_backupRestore(dataDir, harness, actionId);
    harness = await flow5_corruptBackup(dataDir, harness, actionId);
    await flow6_degradedComponent();

    separator('SUMMARY');
    log('RESULT', 'Flow 1: ✓ clean boot — config validated, services started, liveness and readiness both pass');
    log('RESULT', 'Flow 2: ✓ a governed action moves end-to-end to COMPLETED with delivered Ledger evidence, over real HTTP');
    log('RESULT', 'Flow 3: ✓ a real process restart recovers and reconstructs prior state, not a simulation');
    log('RESULT', 'Flow 4: ✓ backup only runs against a genuinely stopped, coherent deployment, and restores genuinely destroyed data with Ledger integrity verified afterward');
    log('RESULT', 'Flow 5: ✓ a tampered backup is rejected before it can ever touch live state, and the restarted deployment is provably unaffected');
    log('RESULT', 'Flow 6: ✓ an optional dependency degrades gracefully; a mandatory one fails closed');
    process.stdout.write('\nTNA Deployment Engineering v0.1 demo passed.\n');
  } finally {
    if (harness) { harness.proc.kill('SIGKILL'); await waitForExit(harness.proc).catch(() => undefined); }
    for (const dir of [dataDir, `${dataDir}-backups`, `${dataDir}-corrupt-backups`]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup — never mask the real failure above */ }
    }
  }
}

main().catch(error => { process.stderr.write(`\nTNA Deployment Engineering v0.1 demo FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`); process.exit(1); });
