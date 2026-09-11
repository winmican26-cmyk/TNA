import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createBackup, verifyBackup, listComponentDatabaseFiles, assertSafePath, UnsafePathError, COMPONENT_VERSIONS,
} from '../../packages/deployment-ops/src/index.js';

function makeDataDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'deployment-backup-'));
  for (const name of ['tna-platform.sqlite', 'tna-ledger.sqlite', 'tna-platform-sentinel.sqlite']) {
    const db = new DatabaseSync(join(dir, name));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run(`seed-${name}`);
    db.close();
  }
  return dir;
}
function cleanup(...dirs: string[]): void { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }

test('createBackup snapshots every component database via VACUUM INTO and hashes each file', () => {
  const dataDir = makeDataDir();
  const backupsRoot = mkdtempSync(resolve(tmpdir(), 'deployment-backups-'));
  try {
    assert.deepEqual([...listComponentDatabaseFiles(dataDir)], ['tna-ledger.sqlite', 'tna-platform-sentinel.sqlite', 'tna-platform.sqlite']);
    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: 'dep_test', deploymentVersion: '0.1.0', configHash: 'abc123' });
    assert.equal(manifest.files.length, 3);
    assert.equal(manifest.deployment_id, 'dep_test');
    assert.deepEqual(manifest.component_versions, COMPONENT_VERSIONS);
    for (const file of manifest.files) assert.ok(existsSync(join(backupsRoot, manifest.backup_id, file.path)));
    const verification = verifyBackup(join(backupsRoot, manifest.backup_id));
    assert.equal(verification.valid, true, verification.reasons.join('; '));
  } finally { cleanup(dataDir, backupsRoot); }
});

test('corrupt backup (one byte flipped) fails verification before it could ever be restored', () => {
  const dataDir = makeDataDir();
  const backupsRoot = mkdtempSync(resolve(tmpdir(), 'deployment-backups-'));
  try {
    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: 'dep_test', deploymentVersion: '0.1.0', configHash: 'abc123' });
    const backupDir = join(backupsRoot, manifest.backup_id);
    const target = join(backupDir, 'tna-ledger.sqlite');
    const bytes = readFileSync(target);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeFileSync(target, bytes);
    const verification = verifyBackup(backupDir);
    assert.equal(verification.valid, false);
    assert.ok(verification.reasons.some(r => r.includes('hash mismatch') || r.includes('size mismatch')));
  } finally { cleanup(dataDir, backupsRoot); }
});

test('partial backup missing the Ledger database is rejected', () => {
  const dataDir = makeDataDir();
  const backupsRoot = mkdtempSync(resolve(tmpdir(), 'deployment-backups-'));
  try {
    const manifest = createBackup(dataDir, backupsRoot, { deploymentId: 'dep_test', deploymentVersion: '0.1.0', configHash: 'abc123' });
    const backupDir = join(backupsRoot, manifest.backup_id);
    rmSync(join(backupDir, 'tna-ledger.sqlite'));
    const patched = { ...manifest, files: manifest.files.filter(f => f.path !== 'tna-ledger.sqlite') };
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(patched, null, 2));
    const verification = verifyBackup(backupDir);
    assert.equal(verification.valid, false);
    assert.ok(verification.reasons.some(r => r.includes('Ledger')));
  } finally { cleanup(dataDir, backupsRoot); }
});

test('missing manifest entirely is rejected, not treated as an empty-but-valid backup', () => {
  const emptyDir = mkdtempSync(resolve(tmpdir(), 'deployment-empty-backup-'));
  try {
    const verification = verifyBackup(emptyDir);
    assert.equal(verification.valid, false);
    assert.ok(verification.reasons.some(r => r.includes('manifest.json is missing')));
  } finally { cleanup(emptyDir); }
});

test('assertSafePath rejects traversal and absolute escape for operator-provided backup paths', () => {
  const base = mkdtempSync(resolve(tmpdir(), 'deployment-safe-base-'));
  try {
    assert.throws(() => assertSafePath(base, '../../etc/passwd'), UnsafePathError);
    assert.throws(() => assertSafePath(base, '/etc/passwd'), UnsafePathError);
    assert.doesNotThrow(() => assertSafePath(base, 'subdir/backup-1'));
  } finally { cleanup(base); }
});
