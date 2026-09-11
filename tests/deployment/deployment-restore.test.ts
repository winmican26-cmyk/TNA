import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { Ledger, LedgerStore, writerPrincipal, readerPrincipal } from '../../packages/ledger-core/src/index.js';
import { PlatformStore, PlatformLedgerDispatcher } from '../../packages/platform-core/src/index.js';
import {
  createBackup, restoreBackup, verifyBackup, acquireRunningLock, releaseRunningLock, isRunningLockActive,
  DeploymentLockError, VersionIncompatibleError, initDeploymentIdentity, readDeploymentIdentity, COMPONENT_VERSIONS,
} from '../../packages/deployment-ops/src/index.js';

const TENANT = 'tenant_restore';
const request = (id: string) => ({ version: '1.0', request_id: id, tenant_id: TENANT, agent_id: 'agent_a', action: 'log.write', tool: 'log.write', operation: 'write', resource: '/workspace/logs/x.log', input: { message: 'ok' }, requires_verification: false });

function tempDir(prefix: string): string { return mkdtempSync(resolve(tmpdir(), prefix)); }
function cleanup(...dirs: string[]): void { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }

/** Builds a real data directory with a genuine platform action delivered to a genuine Ledger — not
 * placeholder tables — so the restore test proves real evidence survives, not just bytes. */
async function seedRealDeployment(dataDir: string): Promise<{ actionId: string; correlationId: string }> {
  const platform = new PlatformStore(join(dataDir, 'tna-platform.sqlite'));
  const ledgerStore = new LedgerStore(join(dataDir, 'tna-ledger.sqlite'));
  const ledger = new Ledger(ledgerStore);
  const writer = writerPrincipal('w', TENANT, ['platform']);
  const action = platform.createOrReturn(request('restore_1'), 'svc');
  const dispatcher = new PlatformLedgerDispatcher(platform, { append: input => ledger.append(writer, input) });
  await dispatcher.dispatchOnce();
  platform.close(); ledgerStore.close();
  return { actionId: action.platform_action_id, correlationId: action.correlation_id };
}

test('real restore: actions performed, backed up, runtime state destroyed, restored, and reconstructed identically', async () => {
  const dataDir = tempDir('deployment-restore-data-');
  const backupsRoot = tempDir('deployment-restore-backups-');
  try {
    const seed = await seedRealDeployment(dataDir);
    const identity = initDeploymentIdentity(dataDir, '0.1.0');
    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'hash1' });
    assert.equal(verifyBackup(join(backupsRoot, manifest.backup_id)).valid, true);

    // Destroy/replace runtime DB state — simulating real infrastructure loss, not a soft failure.
    rmSync(join(dataDir, 'tna-platform.sqlite'));
    rmSync(join(dataDir, 'tna-ledger.sqlite'));
    writeFileSync(join(dataDir, 'tna-platform.sqlite'), 'not a real database');

    restoreBackup(join(backupsRoot, manifest.backup_id), dataDir);

    const platform = new PlatformStore(join(dataDir, 'tna-platform.sqlite'));
    const ledgerStore = new LedgerStore(join(dataDir, 'tna-ledger.sqlite'));
    const ledger = new Ledger(ledgerStore);
    const reader = readerPrincipal('r', TENANT);
    const restoredAction = platform.get(TENANT, seed.actionId);
    assert.equal(restoredAction.platform_action_id, seed.actionId);
    const events = ledger.getEventsByCorrelation(reader, seed.correlationId).items;
    assert.ok(events.length >= 1, 'Ledger evidence must survive restore, not just the platform state');
    platform.close(); ledgerStore.close();
  } finally { cleanup(dataDir, backupsRoot); }
});

test('restore refuses to run while a live process still owns the data directory', async () => {
  const dataDir = tempDir('deployment-restore-locked-');
  const backupsRoot = tempDir('deployment-restore-locked-backups-');
  try {
    await seedRealDeployment(dataDir);
    const identity = initDeploymentIdentity(dataDir, '0.1.0');
    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'hash1' });
    acquireRunningLock(dataDir);
    assert.equal(isRunningLockActive(dataDir), true);
    assert.throws(() => restoreBackup(join(backupsRoot, manifest.backup_id), dataDir), DeploymentLockError);
    releaseRunningLock(dataDir);
    assert.equal(isRunningLockActive(dataDir), false);
    assert.doesNotThrow(() => restoreBackup(join(backupsRoot, manifest.backup_id), dataDir));
  } finally { cleanup(dataDir, backupsRoot); }
});

test('a stale lock from a dead process is reclaimed, not a permanent restore lockout', () => {
  const dataDir = tempDir('deployment-restore-stale-lock-');
  try {
    writeFileSync(join(dataDir, 'RUNNING.lock'), JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }));
    assert.equal(isRunningLockActive(dataDir), false, 'a pid that is not alive must not be treated as a live owner');
    acquireRunningLock(dataDir); // must not throw despite a pre-existing (stale) lock file
    assert.equal(isRunningLockActive(dataDir), true);
  } finally { cleanup(dataDir); }
});

test('restore rejects an incompatible component-version set with VERSION_INCOMPATIBLE, not a generic error', async () => {
  const dataDir = tempDir('deployment-restore-version-');
  const backupsRoot = tempDir('deployment-restore-version-backups-');
  try {
    await seedRealDeployment(dataDir);
    const identity = initDeploymentIdentity(dataDir, '0.1.0');
    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'hash1' });
    const backupDir = join(backupsRoot, manifest.backup_id);
    const patched = { ...manifest, component_versions: { ...COMPONENT_VERSIONS, ledger: 'tna-ledger-v9.9-incompatible' } };
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(patched, null, 2));
    assert.throws(() => restoreBackup(backupDir, dataDir), (error: unknown) => {
      assert.ok(error instanceof VersionIncompatibleError);
      assert.ok(error.mismatches.some(m => m.includes('ledger')));
      return true;
    });
  } finally { cleanup(dataDir, backupsRoot); }
});

test('restore refuses to silently mix a backup from a different deployment without an explicit force', async () => {
  const dataDirA = tempDir('deployment-restore-depA-');
  const dataDirB = tempDir('deployment-restore-depB-');
  const backupsRoot = tempDir('deployment-restore-mix-backups-');
  try {
    await seedRealDeployment(dataDirA);
    const identityA = initDeploymentIdentity(dataDirA, '0.1.0');
    const manifest = createBackup(dataDirA, backupsRoot, { deploymentId: identityA.deployment_id, deploymentVersion: '0.1.0', configHash: 'hash1' });

    await seedRealDeployment(dataDirB);
    const identityB = initDeploymentIdentity(dataDirB, '0.1.0');
    assert.notEqual(identityA.deployment_id, identityB.deployment_id);

    const backupDir = join(backupsRoot, manifest.backup_id);
    assert.throws(() => restoreBackup(backupDir, dataDirB), /deployment .* into deployment .* without an explicit force/);
    assert.doesNotThrow(() => restoreBackup(backupDir, dataDirB, { force: true }));
    const restoredIdentity = readDeploymentIdentity(dataDirB);
    assert.ok(restoredIdentity); // identity file itself is not a .sqlite file, untouched by restore
  } finally { cleanup(dataDirA, dataDirB, backupsRoot); }
});
