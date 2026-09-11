/**
 * TNA Deployment Engineering v0.1 — `tna restore` (section 81, 43). Restores a validated backup over
 * the configured data directory. Requires explicit confirmation (`--force` or
 * `TNA_CONFIRM_RESTORE=yes`) before replacing existing deployment state, matching section 81's
 * "require explicit confirmation or noninteractive override when replacing existing deployment state."
 * Services must already be stopped — `restoreBackup` itself refuses while the running lock is held.
 *
 * Usage: node dist/scripts/tna-restore.js --backup <backup_id> [--force] [--cross-deployment]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { LedgerStore } from '../packages/ledger-core/src/index.js';
import { restoreBackup, verifyLedgerIntegrity } from '../packages/deployment-ops/src/index.js';
import { loadAppConfig } from '../apps/tna-platform/src/config.js';

function log(event: string, message: string): void { process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), event, message }) + '\n'); }
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

function main(): void {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = loadAppConfig(root);
  const backupId = arg('backup');
  if (!backupId) throw new Error('Usage: tna restore --backup <backup_id> [--force] [--cross-deployment]');
  const confirmed = flag('force') || process.env.TNA_CONFIRM_RESTORE === 'yes';
  if (!confirmed) throw new Error('Refusing to restore without explicit confirmation — pass --force or set TNA_CONFIRM_RESTORE=yes');

  const backupsRoot = join(dirname(config.dataDir), `${basename(config.dataDir)}-backups`);
  const backupDir = join(backupsRoot, backupId);
  const manifest = restoreBackup(backupDir, config.dataDir, { force: flag('cross-deployment') });
  log('RESTORE_COMPLETE', `backup_id=${manifest.backup_id} files=${manifest.files.length}`);

  const ledgerStore = new LedgerStore(join(config.dataDir, 'tna-ledger.sqlite'));
  const integrity = verifyLedgerIntegrity(ledgerStore, { persist: false });
  ledgerStore.close();
  log(integrity.valid ? 'LEDGER_INTEGRITY_PASS' : 'LEDGER_INTEGRITY_FAIL', `streams_checked=${integrity.streamsChecked} invalid=${integrity.invalidStreams.length}`);
  if (!integrity.valid) throw new Error('Restored Ledger failed integrity verification');
}

try { main(); } catch (error) { process.stderr.write(`tna restore failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }
