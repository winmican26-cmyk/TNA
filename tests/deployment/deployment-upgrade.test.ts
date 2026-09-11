import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { Ledger, LedgerStore, writerPrincipal, readerPrincipal } from '../../packages/ledger-core/src/index.js';
import { PlatformStore, PlatformLedgerDispatcher } from '../../packages/platform-core/src/index.js';
import {
  createBackup, restoreBackup, verifyBackup, initDeploymentIdentity, assertVersionCompatible,
  VersionIncompatibleError, COMPONENT_VERSIONS,
} from '../../packages/deployment-ops/src/index.js';

/**
 * Section 49-52: the upgrade model this milestone actually implements is operational, not a schema
 * migration engine (`DeploymentConfig` is a fixed v1 schema; each accepted component already owns its
 * own internal ALTER TABLE discipline — see the Volume 8 distributed-evidence closure). What Volume 9
 * adds is the *procedure*: a validated backup must exist before an upgrade is attempted, and a failed
 * upgrade must leave either the running deployment or its pre-upgrade backup in a genuinely restorable
 * state — never a silently half-migrated store. These tests prove that procedure end to end against
 * real data, not just the mechanics already covered in `deployment-backup`/`deployment-restore`.
 */

const TENANT = 'tenant_upgrade';
const request = (id: string) => ({ version: '1.0', request_id: id, tenant_id: TENANT, agent_id: 'agent_a', action: 'log.write', tool: 'log.write', operation: 'write', resource: '/workspace/logs/x.log', input: { message: 'ok' }, requires_verification: false });

function tempDir(prefix: string): string { return mkdtempSync(resolve(tmpdir(), prefix)); }
function cleanup(...dirs: string[]): void { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }

async function seed(dataDir: string, requestId: string): Promise<{ actionId: string; correlationId: string }> {
  const platform = new PlatformStore(join(dataDir, 'tna-platform.sqlite'));
  const ledgerStore = new LedgerStore(join(dataDir, 'tna-ledger.sqlite'));
  const ledger = new Ledger(ledgerStore);
  const writer = writerPrincipal('w', TENANT, ['platform']);
  const action = platform.createOrReturn(request(requestId), 'svc');
  await new PlatformLedgerDispatcher(platform, { append: input => ledger.append(writer, input) }).dispatchOnce();
  platform.close(); ledgerStore.close();
  return { actionId: action.platform_action_id, correlationId: action.correlation_id };
}

test('upgrade procedure: a validated pre-upgrade backup exists and is provably restorable before any migration is attempted', async () => {
  const dataDir = tempDir('deployment-upgrade-preflight-');
  const backupsRoot = tempDir('deployment-upgrade-preflight-backups-');
  try {
    await seed(dataDir, 'upgrade_preflight');
    const identity = initDeploymentIdentity(dataDir, '0.1.0');
    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'pre-upgrade-hash' });
    const verification = verifyBackup(join(backupsRoot, manifest.backup_id));
    assert.equal(verification.valid, true, 'section 50: an upgrade must never begin without a validated backup already in hand');
  } finally { cleanup(dataDir, backupsRoot); }
});

test('upgrade failure: a pre-upgrade backup restores the exact prior state after the live data directory is left corrupted mid-upgrade', async () => {
  const dataDir = tempDir('deployment-upgrade-failure-');
  const backupsRoot = tempDir('deployment-upgrade-failure-backups-');
  try {
    const seedResult = await seed(dataDir, 'upgrade_failure');
    const identity = initDeploymentIdentity(dataDir, '0.1.0');
    const preUpgradeManifest = createBackup(dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'pre-upgrade-hash' });

    // Simulate a failed migration: the new code partially wrote to the live store before crashing,
    // leaving it unusable — never silently started on top of this (section 52).
    writeFileSync(join(dataDir, 'tna-platform.sqlite'), 'garbage: half-migrated, unusable');

    restoreBackup(join(backupsRoot, preUpgradeManifest.backup_id), dataDir);

    const platform = new PlatformStore(join(dataDir, 'tna-platform.sqlite'));
    const restoredAction = platform.get(TENANT, seedResult.actionId);
    assert.equal(restoredAction.state, 'RECEIVED');
    assert.equal(restoredAction.platform_action_id, seedResult.actionId);
    const ledgerStore = new LedgerStore(join(dataDir, 'tna-ledger.sqlite'));
    const ledger = new Ledger(ledgerStore);
    const events = ledger.getEventsByCorrelation(readerPrincipal('r', TENANT), seedResult.correlationId).items;
    assert.ok(events.length >= 1, 'evidence recorded before the failed upgrade must still be present after rollback');
    platform.close(); ledgerStore.close();
  } finally { cleanup(dataDir, backupsRoot); }
});

test('an upgrade to an incompatible component-version combination is rejected explicitly, never run silently', () => {
  const incompatible = { ...COMPONENT_VERSIONS, ledger: 'tna-ledger-v9.9.9' };
  assert.throws(() => assertVersionCompatible(incompatible), (error: unknown) => {
    assert.ok(error instanceof VersionIncompatibleError);
    assert.ok(error.mismatches.some(m => m.startsWith('ledger:')));
    return true;
  });
});

test('a compatible component-version combination (this build\'s own) is accepted', () => {
  assert.doesNotThrow(() => assertVersionCompatible(COMPONENT_VERSIONS));
});
