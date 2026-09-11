/**
 * TNA Deployment Engineering v0.1 — `tna backup` (section 80). Creates a consistent, hashed,
 * manifested backup of every component database (see `packages/deployment-ops`).
 *
 * Usage: node dist/scripts/tna-backup.js [--dir <name-under-the-backups-root>]
 * `--dir` is validated against path traversal (section 48) — it names a subdirectory under the fixed
 * backups root, never an arbitrary absolute path.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { createBackup, initDeploymentIdentity, assertSafePath } from '../packages/deployment-ops/src/index.js';
import { loadAppConfig } from '../apps/tna-platform/src/config.js';

function log(event: string, message: string): void { process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), event, message }) + '\n'); }
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = loadAppConfig(root);
  const identity = initDeploymentIdentity(config.dataDir, '0.1.0');
  const backupsRoot = join(dirname(config.dataDir), `${basename(config.dataDir)}-backups`);
  const requestedSubdir = arg('dir');
  if (requestedSubdir) assertSafePath(backupsRoot, requestedSubdir); // section 48: reject traversal/absolute-escape before it ever reaches the filesystem

  const manifest = createBackup(config.dataDir, backupsRoot, { deploymentId: identity.deployment_id, deploymentVersion: '0.1.0', configHash: config.configHash });
  log('BACKUP_CREATED', `backup_id=${manifest.backup_id} files=${manifest.files.length} path=${join(backupsRoot, manifest.backup_id)}`);
}

try { main(); } catch (error) { process.stderr.write(`tna backup failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }
