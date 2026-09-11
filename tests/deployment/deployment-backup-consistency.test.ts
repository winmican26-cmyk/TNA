import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { LedgerStore } from '../../packages/ledger-core/src/index.js';
import { PlatformStore } from '../../packages/platform-core/src/index.js';
import {
  createBackup, verifyBackup, restoreBackup, verifyLedgerIntegrity, initDeploymentIdentity,
  isRunningLockActive, listComponentDatabaseFiles, BackupQuiesceError, DeploymentLockError,
} from '../../packages/deployment-ops/src/index.js';

/**
 * TNA Deployment Engineering v0.1 — Final Recovery-Consistency Review.
 *
 * `VACUUM INTO` proves each *individual* database snapshot is internally consistent. It does not, on
 * its own, prove the *set* of files taken by several sequential `VACUUM INTO` calls represents one
 * coherent recovery point — a live writer could mutate Platform, Ledger, Sentinel, Gate, or Auditor
 * state between the first file's snapshot and the last one's. `createBackup()` now refuses outright
 * when the deployment's own `RUNNING.lock` is live (see `packages/deployment-ops/src/index.ts`'s
 * module-level comment for the full analysis and the chosen "stop, don't quiesce-in-place" model).
 * These tests prove that gate is real, and that the whole recovery set it protects is genuinely
 * restorable end to end — not a static reading of the code.
 */

const mainJs = fileURLToPath(new URL('../../apps/tna-platform/src/main.js', import.meta.url));
const TENANT = 'tenant_demo';
const AGENT_ID = 'consistency-demo-agent';
const AGENT_TOKEN = 'consistency-agent-token-'.repeat(2);
const SECRETS = { TNA_OPERATOR_TOKEN: `op-${'a'.repeat(30)}`, TNA_ADMIN_TOKEN: `ad-${'b'.repeat(30)}`, TNA_SERVICE_TOKEN: `sv-${'c'.repeat(30)}` };

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
    ...process.env, TNA_ENV: 'development', TNA_TENANT_ID: TENANT, TNA_HOST: '127.0.0.1', TNA_PORT: String(port),
    TNA_DATA_DIR: dataDir, TNA_PLATFORM_DEMO_AGENT_TOKEN: AGENT_TOKEN, TNA_PLATFORM_DEMO_AGENT_ID: AGENT_ID, ...SECRETS,
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
/** Mirrors `scripts/demo-deployment-v01.ts`'s own proven-working envelope shape exactly (same
 * resource_kind/operation pairing that produces a genuine Gate ALLOW for `demo.echo.execute`). */
function bootstrapGateAgent(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const gateStore = new Store(resolve(dataDir, 'tna-platform-gate.sqlite'));
  const gate = new Gate(gateStore);
  gate.register({ kind: 'admin', role: 'administrator' }, { id: AGENT_ID, name: 'Consistency Demo Agent' });
  gate.setEnvelope({ kind: 'admin', role: 'administrator' }, {
    version: '1.0', agent: { id: AGENT_ID, name: 'Consistency Demo Agent', role: 'deployment', owner: 'platform-team', environment: 'production', expires_at: '2099-01-01T00:00:00.000Z' },
    objective: { task_id: 'consistency-demo', goal: 'Echo a bounded demo payload', allowed_outcomes: ['echo demo payload'], forbidden_outcomes: [] },
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
function cleanup(...dirs: string[]): void { for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } } }

test('cross-component quiesced backup: backup is refused against a genuinely live deployment, and succeeds once it is stopped', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deploy-consistency-quiesce-'));
  const backupsRoot = `${dataDir}-backups`;
  let harness: Harness | undefined;
  try {
    bootstrapGateAgent(dataDir);
    harness = await spawnPlatform(dataDir);
    assert.equal(isRunningLockActive(dataDir), true, 'sanity: the live process holds the running lock');

    assert.throws(() => createBackup(dataDir, backupsRoot, { deploymentId: 'dep_x', deploymentVersion: '0.1.0', configHash: 'h' }), BackupQuiesceError);
    // The rejected backup attempt must not have disturbed the still-live deployment in any way.
    const stillReady = await fetch(`${harness.baseUrl}/ready`);
    assert.equal(stillReady.status, 200, 'a rejected backup attempt must leave the live deployment completely unaffected');

    harness.proc.kill('SIGTERM');
    await waitForExit(harness.proc, 15_000).catch(() => harness?.proc.kill('SIGKILL'));
    harness = undefined;

    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: 'dep_x', deploymentVersion: '0.1.0', configHash: 'h' });
    assert.equal(verifyBackup(join(backupsRoot, manifest.backup_id)).valid, true, 'backup taken while genuinely stopped must be valid');
  } finally { if (harness) harness.proc.kill('SIGKILL'); cleanup(dataDir, backupsRoot); }
});

test('restore while writers are active is refused (RESTORE_REFUSED); active state is untouched; restore succeeds once stopped', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deploy-consistency-restore-refused-'));
  const backupsRoot = `${dataDir}-backups`;
  let harness: Harness | undefined;
  try {
    bootstrapGateAgent(dataDir);
    harness = await spawnPlatform(dataDir);
    const identity = initDeploymentIdentity(dataDir, '0.1.0');
    // A prior, independently-taken backup to attempt restoring while the deployment is live.
    harness.proc.kill('SIGTERM');
    await waitForExit(harness.proc, 15_000).catch(() => harness?.proc.kill('SIGKILL'));
    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'h' });
    harness = await spawnPlatform(dataDir); // bring it back up, now genuinely live again

    assert.throws(() => restoreBackup(join(backupsRoot, manifest.backup_id), dataDir), DeploymentLockError);
    const stillReady = await fetch(`${harness.baseUrl}/ready`);
    assert.equal(stillReady.status, 200, 'a rejected restore attempt must leave the live deployment completely unaffected');

    harness.proc.kill('SIGTERM');
    await waitForExit(harness.proc, 15_000).catch(() => harness?.proc.kill('SIGKILL'));
    harness = undefined;
    assert.doesNotThrow(() => restoreBackup(join(backupsRoot, manifest.backup_id), dataDir));
  } finally { if (harness) harness.proc.kill('SIGKILL'); cleanup(dataDir, backupsRoot); }
});

test('partial backup creation failure produces no valid/publishable manifest and leaves the live deployment unchanged', () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deploy-consistency-partial-'));
  const backupsRoot = `${dataDir}-backups`;
  try {
    for (const name of ['tna-platform.sqlite', 'tna-ledger.sqlite', 'tna-platform-sentinel.sqlite', 'tna-platform-gate.sqlite', 'tna-platform-auditor.sqlite']) {
      const db = new DatabaseSync(join(dataDir, name));
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run(`seed-${name}`);
      db.close();
    }
    const before = new Set(listComponentDatabaseFiles(dataDir));
    const sentinelPath = join(dataDir, 'tna-platform-sentinel.sqlite');
    const originalSentinelBytes = readFileSync(sentinelPath);
    // Simulate "Sentinel DB snapshot fails" — the file exists but is not a readable SQLite database by
    // the time VACUUM INTO reaches it (Platform/Ledger/Auditor/Gate, which sort earlier, succeed first).
    writeFileSync(sentinelPath, 'not a real sqlite database, snapshot must fail');

    mkdirSync(backupsRoot, { recursive: true });
    assert.throws(() => createBackup(dataDir, backupsRoot, { deploymentId: 'dep_partial', deploymentVersion: '0.1.0', configHash: 'h' }));

    const entries = readdirSync(backupsRoot);
    assert.deepEqual(entries.filter(e => e.startsWith('bkp_')), [], 'a failed backup attempt must not publish anything under a normal backup name');
    assert.deepEqual(entries.filter(e => e.includes('.partial')), [], 'the staging directory must be cleaned up on failure, not left lying around');

    // The live deployment itself — including the untouched-but-never-reached tna-platform.sqlite — must
    // be completely unaffected by the failed backup attempt.
    assert.deepEqual(new Set(listComponentDatabaseFiles(dataDir)), before);
    const platformDb = new DatabaseSync(join(dataDir, 'tna-platform.sqlite'));
    const row = platformDb.prepare('SELECT v FROM t').get() as { v: string };
    assert.equal(row.v, 'seed-tna-platform.sqlite');
    platformDb.close();
    writeFileSync(sentinelPath, originalSentinelBytes); // restore for cleanup hygiene, not required by the assertion above
  } finally { cleanup(dataDir, backupsRoot); }
});

test('a version-incompatible backup is rejected before any replacement, and a corrected subsequent restore still succeeds cleanly', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deploy-consistency-version-'));
  const backupsRoot = `${dataDir}-backups`;
  try {
    const platform = new PlatformStore(join(dataDir, 'tna-platform.sqlite'));
    const ledgerStore = new LedgerStore(join(dataDir, 'tna-ledger.sqlite'));
    const action = platform.createOrReturn({ version: '1.0', request_id: 'version_test_1', tenant_id: TENANT, agent_id: 'a', action: 'log.write', tool: 'log.write', operation: 'write', resource: '/workspace/logs/x.log', input: {}, requires_verification: false }, 'svc');
    platform.close(); ledgerStore.close();

    const identity = initDeploymentIdentity(dataDir, '0.1.0');
    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'h' });
    const backupDir = join(backupsRoot, manifest.backup_id);
    const manifestPath = join(backupDir, 'manifest.json');
    const originalManifestJson = readFileSync(manifestPath, 'utf8');
    const patched = { ...manifest, component_versions: { ...manifest.component_versions, gate: 'tna-gate-v9.9-incompatible' } };
    writeFileSync(manifestPath, JSON.stringify(patched, null, 2));

    assert.throws(() => restoreBackup(backupDir, dataDir));
    // Nothing was touched by the rejected attempt — the original, untampered data is still exactly there.
    const reopened = new PlatformStore(join(dataDir, 'tna-platform.sqlite'));
    const stillThere = reopened.get(TENANT, action.platform_action_id);
    assert.equal(stillThere.platform_action_id, action.platform_action_id);
    reopened.close();

    // A corrected backup (untampered manifest restored) restores cleanly, proving the earlier rejection
    // left the restore machinery itself in a fully working state, not a half-broken one.
    writeFileSync(manifestPath, originalManifestJson);
    assert.doesNotThrow(() => restoreBackup(backupDir, dataDir));
  } finally { cleanup(dataDir, backupsRoot); }
});

test('cross-component recovery: a governed action with a pending Ledger evidence obligation survives destroy-and-restore end to end, through the real deployment', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deploy-consistency-e2e-'));
  const backupsRoot = `${dataDir}-backups`;
  let harness: Harness | undefined;
  try {
    bootstrapGateAgent(dataDir);
    harness = await spawnPlatform(dataDir);

    // 1-2. Execute a governed action — real Gate ALLOW, real Platform/Sentinel state.
    const submitted = await fetch(`${harness.baseUrl}/v1/platform/actions`, {
      method: 'POST', headers: headers(AGENT_TOKEN),
      body: JSON.stringify({ version: '1.0', request_id: 'e2e_1', tenant_id: TENANT, agent_id: AGENT_ID, action: 'demo.echo.execute', tool: 'demo.echo', operation: 'execute', resource: '/workspace/demo/echo.txt', input: { message: 'consistency e2e' }, requires_verification: false }),
    });
    assert.equal(submitted.status, 201);
    const action = await submitted.json() as { platform_action_id: string; state: string; correlation_id: string };
    assert.equal(action.state, 'COMPLETED');

    // 3. Leave at least one durable evidence obligation pending — killed well within main.ts's 2000ms
    // dispatch-tick interval, so the outbox record genuinely cannot have been delivered yet.
    harness.proc.kill('SIGKILL');
    await waitForExit(harness.proc, 15_000).catch(() => undefined);
    harness = undefined;

    const preBackupCheck = new PlatformStore(join(dataDir, 'tna-platform.sqlite'));
    const pendingBefore = preBackupCheck.listOutbox(TENANT, action.platform_action_id);
    preBackupCheck.close();
    assert.ok(pendingBefore.some(o => o.status === 'PENDING' || o.status === 'DELIVERING'), 'sanity: the evidence obligation must genuinely still be undelivered before backup');

    // 4-5. Enter supported backup mode (the process is stopped — its crashed lock is stale) and create
    // a complete backup.
    assert.equal(isRunningLockActive(dataDir), false);
    const identity = initDeploymentIdentity(dataDir, '0.1.0');
    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'h' });
    assert.equal(verifyBackup(join(backupsRoot, manifest.backup_id)).valid, true);

    // 6. Destroy all live deployment databases — genuine infrastructure loss.
    for (const dbFile of listComponentDatabaseFiles(dataDir)) writeFileSync(join(dataDir, dbFile), Buffer.alloc(0));

    // 7. Restore the entire deployment.
    restoreBackup(join(backupsRoot, manifest.backup_id), dataDir);

    // 8-9. Restart and run readiness.
    harness = await spawnPlatform(dataDir);
    const ready = await fetch(`${harness.baseUrl}/ready`);
    assert.equal(ready.status, 200);

    // 10. Reconstruct the action.
    const reconstructed = await fetch(`${harness.baseUrl}/v1/platform/actions/${action.platform_action_id}`, { headers: headers(SECRETS.TNA_ADMIN_TOKEN) });
    const reconstructedAction = await reconstructed.json() as { state: string; platform_action_id: string };
    assert.equal(reconstructedAction.platform_action_id, action.platform_action_id);
    // 13. Platform status must reflect the truthful, already-committed outcome — neither silently
    // mutated to something else nor fabricated into a different result by the recovery process.
    assert.equal(reconstructedAction.state, 'COMPLETED');

    // 11. Resume pending evidence delivery — the restarted dispatcher's own 2s tick delivers it.
    const deadline = Date.now() + 10_000;
    let delivered = false;
    while (Date.now() < deadline && !delivered) {
      const evidence = await fetch(`${harness.baseUrl}/v1/platform/actions/${action.platform_action_id}/evidence`, { headers: headers(SECRETS.TNA_ADMIN_TOKEN) });
      const body = await evidence.json() as { evidence: { outbox_records: number; delivered: number } };
      if (body.evidence.outbox_records > 0 && body.evidence.delivered === body.evidence.outbox_records) delivered = true; else await new Promise(r => setTimeout(r, 200));
    }
    assert.ok(delivered, 'the pending obligation must resume delivery after restore, using the same deterministic event id (Volume 8 outbox idempotency)');

    // 12. Verify Ledger integrity.
    const ledgerStore = new LedgerStore(join(dataDir, 'tna-ledger.sqlite'));
    const integrity = verifyLedgerIntegrity(ledgerStore, { persist: false });
    ledgerStore.close();
    assert.equal(integrity.valid, true);
  } finally { if (harness) harness.proc.kill('SIGKILL'); cleanup(dataDir, backupsRoot); }
});

test('backup manifest binds the whole recovery set: schema_versions is present and tampering with any bound field invalidates the set', () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deploy-consistency-manifest-'));
  const backupsRoot = `${dataDir}-backups`;
  try {
    const db = new DatabaseSync(join(dataDir, 'tna-ledger.sqlite'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.close();
    const identity = initDeploymentIdentity(dataDir, '0.1.0');
    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'config-hash-abc' });

    assert.ok(manifest.schema_versions && Object.keys(manifest.schema_versions).length > 0);
    for (const field of ['deployment_id', 'deployment_version', 'component_versions', 'schema_versions', 'config_hash', 'created_at', 'files'] as const) {
      assert.ok(manifest[field] !== undefined, `manifest must bind ${field}`);
    }

    const backupDir = join(backupsRoot, manifest.backup_id);
    const tampered = { ...manifest, schema_versions: { ...manifest.schema_versions, gate: 'tampered-version' } };
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(tampered, null, 2));
    assert.throws(() => restoreBackup(backupDir, dataDir), /VERSION_INCOMPATIBLE/);
  } finally { cleanup(dataDir, backupsRoot); }
});
