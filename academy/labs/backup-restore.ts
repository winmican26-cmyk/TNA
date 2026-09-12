/**
 * TNA Deployment Academy v0.1 — Lab 11 (Level 3): Backup & Restore.
 *
 * Objective: use Volume 9's accepted stop-required backup model directly — stop writers, create a
 * backup, verify its manifest, destroy the lab's own data directory, restore, and confirm the restored
 * state reconstructs the same prior action and Ledger evidence.
 * Prerequisites: `lab-05-ledger-reconstruction`.
 */
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LedgerStore, Ledger, writerPrincipal } from '../../packages/ledger-core/src/index.js';
import { PlatformStore } from '../../packages/platform-core/src/index.js';
import {
  initDeploymentIdentity, acquireRunningLock, releaseRunningLock, createBackup, verifyBackup, restoreBackup, verifyLedgerIntegrity,
} from '../../packages/deployment-ops/src/index.js';
import type { LabResult, LabStep } from './blocked-action.js';

const TENANT = 'ten_academy_lab11';

export async function runLab(): Promise<LabResult> {
  const root = mkdtempSync(resolve(tmpdir(), 'tna-academy-lab-backup-'));
  const dataDir = resolve(root, 'data');
  const backupsDir = resolve(root, 'backups');
  const steps: LabStep[] = [];
  try {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(backupsDir, { recursive: true });
    const identity = initDeploymentIdentity(dataDir, '0.1.0');

    // Real prior state: a real Ledger event and a real platform action, both durable SQLite files under
    // the exact component filenames the accepted backup/restore model expects.
    const ledgerStore = new LedgerStore(resolve(dataDir, 'tna-ledger.sqlite'));
    const ledger = new Ledger(ledgerStore);
    ledger.append(writerPrincipal('academy-lab-writer', TENANT, ['platform']), {
      version: '1.0', event_id: `evt_${randomUUID()}`, event_type: 'PLATFORM_ACTION_COMPLETED', tenant_id: TENANT,
      stream_id: 'platform:lab11-action', actor: { type: 'AGENT', id: 'academy-lab-11-agent' },
      correlation_id: `corr_${randomUUID()}`, source_component: 'platform', payload: { note: 'pre-backup evidence' },
    });
    ledgerStore.close();

    const platform = new PlatformStore(resolve(dataDir, 'tna-platform.sqlite'));
    const action = platform.createOrReturn({
      version: '1.0', request_id: 'lab11-request', tenant_id: TENANT, agent_id: 'academy-lab-11-agent',
      action: 'demo.echo.execute', tool: 'demo.echo', operation: 'read', resource: 'academy-lab-11',
      input: { message: 'backup me' }, requires_verification: false,
    }, 'academy-lab');
    platform.close();

    // Section: "stop writers" — the accepted model refuses a backup while the running lock is held.
    acquireRunningLock(dataDir);
    let refusedWhileLive = false;
    try { createBackup(dataDir, backupsDir, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'lab11-config-hash' }); }
    catch { refusedWhileLive = true; }
    steps.push({ description: 'A backup is refused outright while the deployment is still "running" (writers not stopped)', passed: refusedWhileLive });

    releaseRunningLock(dataDir);
    const manifest = createBackup(dataDir, backupsDir, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: 'lab11-config-hash' });
    steps.push({ description: 'A real backup was created once writers were stopped', passed: manifest.files.length >= 2 });

    const backupDir = resolve(backupsDir, manifest.backup_id);
    const verification = verifyBackup(backupDir);
    steps.push({ description: 'The backup manifest verifies (hashes match, Ledger database present)', passed: verification.valid });

    // "Destroy lab state" — this is the lab's OWN disposable data directory, never a real deployment.
    rmSync(dataDir, { recursive: true, force: true });
    steps.push({ description: 'Lab data directory was destroyed', passed: !existsSync(dataDir) });

    restoreBackup(backupDir, dataDir, { expectedDeploymentId: identity.deployment_id });
    steps.push({ description: 'Restore completed from the verified backup', passed: existsSync(resolve(dataDir, 'tna-platform.sqlite')) && existsSync(resolve(dataDir, 'tna-ledger.sqlite')) });

    const restoredPlatform = new PlatformStore(resolve(dataDir, 'tna-platform.sqlite'));
    const restoredAction = restoredPlatform.get(TENANT, action.platform_action_id);
    steps.push({ description: 'The prior action is genuinely reconstructible after restore, with the same identity', passed: restoredAction.platform_action_id === action.platform_action_id });
    restoredPlatform.close();

    const restoredLedgerStore = new LedgerStore(resolve(dataDir, 'tna-ledger.sqlite'));
    const ledgerCheck = verifyLedgerIntegrity(restoredLedgerStore);
    steps.push({ description: 'The restored Ledger still verifies clean', passed: ledgerCheck.valid && ledgerCheck.streamsChecked > 0 });
    restoredLedgerStore.close();
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return { lab_id: 'lab-11-backup-restore', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}
