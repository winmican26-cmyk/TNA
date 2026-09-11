import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, realpathSync, unlinkSync, renameSync,
} from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { LedgerStore } from '../../ledger-store/src/index.js';
import { verifyStream } from '../../ledger-integrity/src/index.js';

/**
 * TNA Deployment Engineering v0.1 (Volume 9). Deployment identity, version compatibility, and a
 * consistent SQLite backup/restore/verify model (section 39-52, 75, 100). Every backup uses SQLite's
 * own supported `VACUUM INTO` snapshot mechanism (TNA-54: "Backups are part of the trust boundary") —
 * never a raw file copy, which is not safe against a concurrently open WAL-mode database.
 */

export const DEPLOYMENT_CONFIG_SCHEMA_VERSION = '1' as const;

// ---------------------------------------------------------------------------------------------
// Deployment identity (section 75)
// ---------------------------------------------------------------------------------------------

export interface DeploymentIdentity {
  readonly deployment_id: string;
  readonly created_at: string;
  readonly deployment_version: string;
}
const IDENTITY_FILE = 'deployment-identity.json';

export function initDeploymentIdentity(dataDir: string, deploymentVersion: string, now: () => string = () => new Date().toISOString()): DeploymentIdentity {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, IDENTITY_FILE);
  const existing = readDeploymentIdentity(dataDir);
  if (existing) return existing;
  const identity: DeploymentIdentity = { deployment_id: `dep_${randomUUID()}`, created_at: now(), deployment_version: deploymentVersion };
  writeFileSync(path, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}
export function readDeploymentIdentity(dataDir: string): DeploymentIdentity | null {
  const path = join(dataDir, IDENTITY_FILE);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as DeploymentIdentity; } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Version compatibility (section 36, 100). Tied to the actual accepted git tags — a version string
// here is traceable to a real accepted commit, not an arbitrary label.
// ---------------------------------------------------------------------------------------------

export const COMPONENT_VERSIONS = {
  platform: 'tna-platform-v0.1', gate: 'tna-gate-v0.3', ledger: 'tna-ledger-v0.1',
  sentinel: 'tna-sentinel-v0.1', vad: 'vad-engine-v0.1', auditor: 'tna-auditor-v0.1',
} as const;
export type ComponentName = keyof typeof COMPONENT_VERSIONS;

/** Recovery-consistency closure (section 10 of the review): a backup manifest must bind schema
 * versions, not merely component release versions. This project has no schema-version numbering
 * independent of a component's own accepted release tag — every schema change so far has shipped
 * inside an accepted version bump (see Volume 8's distributed-evidence closure, which added outbox
 * lease columns as part of `tna-platform-v0.1` itself). `SCHEMA_VERSIONS` is therefore, honestly,
 * identical to `COMPONENT_VERSIONS` today — a distinct field so a future milestone that *does*
 * introduce independent schema versioning has a place to put it without changing the manifest shape. */
export const SCHEMA_VERSIONS: Readonly<Record<string, string>> = COMPONENT_VERSIONS;

export class VersionIncompatibleError extends Error {
  public constructor(public readonly mismatches: readonly string[]) {
    super(`VERSION_INCOMPATIBLE: ${mismatches.join('; ')}`);
    this.name = 'VersionIncompatibleError';
  }
}
/** Compares a recorded component-version map (from a backup manifest, or a running deployment) against
 * this build's own `COMPONENT_VERSIONS`. Throws `VersionIncompatibleError` — never a generic/opaque
 * database error (section 100) — on any mismatch or missing entry. */
export function assertVersionCompatible(recorded: Readonly<Record<string, string>>): void {
  const mismatches: string[] = [];
  for (const [component, expected] of Object.entries(COMPONENT_VERSIONS)) {
    const actual = recorded[component];
    if (actual === undefined) mismatches.push(`${component}: no recorded version`);
    else if (actual !== expected) mismatches.push(`${component}: recorded ${actual}, this build expects ${expected}`);
  }
  if (mismatches.length > 0) throw new VersionIncompatibleError(mismatches);
}

// ---------------------------------------------------------------------------------------------
// Running lock (section 53, 99, 72). A crude but effective single-host mutual-exclusion marker: a
// restore must never run against a data directory a live process still owns, and a live process must
// never believe it is the only owner of a data directory another live process already claimed.
// ---------------------------------------------------------------------------------------------

const LOCK_FILE = 'RUNNING.lock';
export class DeploymentLockError extends Error { public constructor(message: string) { super(message); this.name = 'DeploymentLockError'; } }

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
export function acquireRunningLock(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, LOCK_FILE);
  if (existsSync(path)) {
    const held = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; started_at: string };
    if (isPidAlive(held.pid)) throw new DeploymentLockError(`Data directory ${dataDir} is already owned by a live process (pid ${held.pid})`);
    // stale lock from an unclean shutdown — reclaimed, matching the same "restart recovers, never
    // permanently locks out a legitimate owner" discipline the platform outbox lease already applies.
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
}
export function releaseRunningLock(dataDir: string): void {
  const path = join(dataDir, LOCK_FILE);
  try { unlinkSync(path); } catch { /* already released or never acquired */ }
}
export function isRunningLockActive(dataDir: string): boolean {
  const path = join(dataDir, LOCK_FILE);
  if (!existsSync(path)) return false;
  try {
    const held = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    return isPidAlive(held.pid);
  } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Backup path safety (section 48). Applied to any operator-supplied backup source/destination.
// ---------------------------------------------------------------------------------------------

export class UnsafePathError extends Error { public constructor(message: string) { super(message); this.name = 'UnsafePathError'; } }

/** Resolves `candidate` against `baseDir` and rejects traversal outside it, an absolute path escape,
 * or a symlink escape via the nearest existing ancestor directory. */
export function assertSafePath(baseDir: string, candidate: string): string {
  const base = resolve(baseDir);
  const resolved = resolve(base, candidate);
  if (resolved !== base && !resolved.startsWith(base + sep)) throw new UnsafePathError(`Path escapes the allowed directory: ${candidate}`);
  let probe = resolved;
  while (!existsSync(probe)) { const parent = resolve(probe, '..'); if (parent === probe) break; probe = parent; }
  if (existsSync(probe)) {
    const real = realpathSync(probe);
    const realBase = realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + sep)) throw new UnsafePathError(`Path escapes the allowed directory via a symlink: ${candidate}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------------
// Backup / restore (section 39-47, 98-99)
//
// Recovery-consistency closure. `VACUUM INTO` proves each *individual* database file is internally
// consistent. It does not, by itself, prove the *set* of files taken across several sequential
// `VACUUM INTO` calls represents one coherent recovery point — a live writer could mutate Platform,
// Ledger, Sentinel, Gate, or Auditor state between the first file's snapshot and the last one's,
// producing a set where (for example) a Ledger event exists for a Platform state transition the
// restored Platform database doesn't yet show. TNA Deployment Engineering v0.1 closes this the
// simplest, most rigorously provable way available to a single-host, single-composed-process
// architecture: **`createBackup()` requires the deployment's own `RUNNING.lock` to be inactive**
// (mirroring the exact discipline `restoreBackup()` already applied). No live writer means no
// component database can be mutating while any of the others are snapshotted — the set is therefore
// genuinely coherent, not merely file-by-file consistent. A live, in-process "quiesce" mode (reject
// new work, drain in-flight requests, resolve uncertain work, flush the outbox, snapshot, then resume)
// was considered and rejected for v0.1: it would require a new intra-process admin/control protocol —
// new deployment-feature surface — for a guarantee the existing stop-then-backup discipline already
// provides with no new surface at all. See `docs/deployment/deployment-v0.1-recovery-consistency-closure.md`.
//
// Truthful terminology (do not overclaim): this is **a quiesced, verified deployment backup set
// containing individually consistent component database snapshots from one controlled recovery
// boundary** — not a globally ACID snapshot, not a distributed transaction, not a point-in-time atomic
// snapshot across independently-running systems (none of those exist here; nothing is independently
// running at backup time).
// ---------------------------------------------------------------------------------------------

export interface BackupManifest {
  readonly version: '1';
  readonly backup_id: string;
  readonly created_at: string;
  readonly deployment_id: string;
  readonly deployment_version: string;
  readonly component_versions: Readonly<Record<string, string>>;
  readonly schema_versions: Readonly<Record<string, string>>;
  readonly config_hash: string;
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
}
const MANIFEST_FILE = 'manifest.json';

function sha256File(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

/** Enumerates the SQLite database files directly present in a data directory — deliberately
 * non-recursive and extension-filtered, so identity/lock files never get swept into a "database" file
 * set. */
export function listComponentDatabaseFiles(dataDir: string): readonly string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir).filter(name => name.endsWith('.sqlite') && statSync(join(dataDir, name)).isFile()).sort();
}

export class BackupQuiesceError extends Error { public constructor(message: string) { super(message); this.name = 'BackupQuiesceError'; } }

/**
 * Snapshots every component database in `dataDir` into a fresh, atomically-published backup directory
 * under `backupsRootDir`, using SQLite's own `VACUUM INTO` per file (section 39), and writes a hashed
 * `BackupManifest` binding the whole recovery set (section 41-42, 10 of the recovery-consistency
 * review).
 *
 * **Refuses outright if the deployment is live** (`isRunningLockActive(dataDir)`) — cross-component
 * consistency for this milestone's single-composed-process architecture is provided by requiring the
 * writer to be stopped, not by an in-process quiesce protocol (see the module-level comment above).
 *
 * All-or-nothing (section 6-7): every snapshot is written into a hidden, uniquely-named staging
 * directory first; the manifest is written last, inside that same staging directory; only then is the
 * whole directory atomically renamed into its final, publishable name. A failure at any point — an
 * unreadable/corrupt source database, a disk error, anything — leaves no directory under the final
 * `bkp_*` name at all, so a partial attempt can never be mistaken for a restorable backup by `verifyBackup`
 * or by an operator browsing the backups root.
 */
export function createBackup(
  dataDir: string, backupsRootDir: string,
  opts: { deploymentId: string; deploymentVersion: string; configHash: string; now?: () => string },
): BackupManifest {
  if (isRunningLockActive(dataDir)) {
    throw new BackupQuiesceError(`Refusing to back up ${dataDir} while a live process owns it — stop the deployment first (see docs/deployment/deployment-backup-v0.1.md)`);
  }
  const now = opts.now ?? (() => new Date().toISOString());
  const backupId = `bkp_${randomUUID()}`;
  const finalDir = join(backupsRootDir, backupId);
  const stagingDir = join(backupsRootDir, `.${backupId}.partial`);
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  try {
    const files: { path: string; sha256: string; bytes: number }[] = [];
    for (const dbFile of listComponentDatabaseFiles(dataDir)) {
      const src = join(dataDir, dbFile);
      const dest = join(stagingDir, dbFile);
      const db = new DatabaseSync(src);
      try { db.prepare('VACUUM INTO ?').run(dest); } finally { db.close(); }
      files.push({ path: dbFile, sha256: sha256File(dest), bytes: statSync(dest).size });
    }
    const manifest: BackupManifest = {
      version: '1', backup_id: backupId, created_at: now(), deployment_id: opts.deploymentId,
      deployment_version: opts.deploymentVersion, component_versions: COMPONENT_VERSIONS,
      schema_versions: SCHEMA_VERSIONS, config_hash: opts.configHash, files,
    };
    writeFileSync(join(stagingDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    // Atomic publish: a single rename (same parent directory, same filesystem) is the one moment this
    // backup starts existing under a name `verifyBackup`/`restoreBackup` will ever look for.
    renameSync(stagingDir, finalDir);
    return manifest;
  } catch (error) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort — never mask the real failure */ }
    throw error;
  }
}

export interface BackupVerification { readonly valid: boolean; readonly reasons: readonly string[]; readonly manifest: BackupManifest | null }

/** Recomputes every listed file's hash and confirms it matches the manifest (section 42, 46-47).
 * A missing manifest, a missing file, a size/hash mismatch, or an empty file set are all rejected —
 * never partially trusted. */
export function verifyBackup(backupDir: string): BackupVerification {
  const manifestPath = join(backupDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return { valid: false, reasons: ['manifest.json is missing'], manifest: null };
  let manifest: BackupManifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest; }
  catch { return { valid: false, reasons: ['manifest.json is not valid JSON'], manifest: null }; }
  const reasons: string[] = [];
  if (manifest.version !== '1') reasons.push(`unsupported manifest version: ${manifest.version}`);
  if (!manifest.deployment_id) reasons.push('manifest is missing deployment_id');
  if (!manifest.component_versions || typeof manifest.component_versions !== 'object') reasons.push('manifest is missing component_versions');
  if (!manifest.schema_versions || typeof manifest.schema_versions !== 'object') reasons.push('manifest is missing schema_versions');
  if (!manifest.config_hash) reasons.push('manifest is missing config_hash');
  if (!manifest.files || manifest.files.length === 0) reasons.push('backup contains no database files');
  if (!manifest.files?.some(f => f.path === 'tna-ledger.sqlite')) reasons.push('backup is missing the required Ledger database (tna-ledger.sqlite)');
  for (const file of manifest.files ?? []) {
    const path = join(backupDir, basename(file.path));
    if (!existsSync(path)) { reasons.push(`file listed in manifest is missing: ${file.path}`); continue; }
    const actualSize = statSync(path).size;
    if (actualSize !== file.bytes) { reasons.push(`file size mismatch for ${file.path}: expected ${file.bytes}, found ${actualSize}`); continue; }
    const actualHash = sha256File(path);
    if (actualHash !== file.sha256) reasons.push(`hash mismatch for ${file.path} — backup is corrupt or tampered`);
  }
  return { valid: reasons.length === 0, reasons, manifest };
}

export interface RestoreOptions {
  readonly expectedDeploymentId?: string | undefined;
  readonly force?: boolean | undefined;
}
/**
 * Restores a verified backup over a data directory (section 43). Every check below runs — in this
 * exact order — before a single byte of `dataDir` is touched (section 11 of the recovery-consistency
 * review: "do not replace live state first and discover incompatibility afterward"):
 *
 * 1. read + verify the manifest and every artifact hash (`verifyBackup`)
 * 2. verify no live process still owns `dataDir` (section 99)
 * 3. verify deployment identity match, or an explicit `force` override (section 44)
 * 4. verify component *and* schema version compatibility (section 100, 10 of the review)
 *
 * Only after all four pass does the destructive copy happen — proven directly by
 * `deployment-backup-consistency.test.ts`'s "rejected restore leaves active state fully intact, and a
 * corrected retry still succeeds" test.
 */
export function restoreBackup(backupDir: string, dataDir: string, opts: RestoreOptions = {}): BackupManifest {
  const verification = verifyBackup(backupDir);
  if (!verification.valid || !verification.manifest) throw new Error(`Refusing to restore an invalid backup: ${verification.reasons.join('; ')}`);
  if (isRunningLockActive(dataDir)) throw new DeploymentLockError(`Refusing to restore into ${dataDir} while a live process owns it — stop services first`);
  const currentIdentity = readDeploymentIdentity(dataDir);
  const expected = opts.expectedDeploymentId ?? currentIdentity?.deployment_id;
  if (expected !== undefined && verification.manifest.deployment_id !== expected && opts.force !== true) {
    throw new Error(`Refusing to restore backup from deployment ${verification.manifest.deployment_id} into deployment ${expected} without an explicit force override`);
  }
  assertVersionCompatible(verification.manifest.component_versions);
  assertVersionCompatible(verification.manifest.schema_versions);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const file of verification.manifest.files) {
    const src = join(backupDir, basename(file.path));
    const dest = join(dataDir, basename(file.path));
    try { rmSync(dest); } catch { /* nothing to remove on a fresh data directory */ }
    writeFileSync(dest, readFileSync(src), { mode: 0o600 });
  }
  return verification.manifest;
}

// ---------------------------------------------------------------------------------------------
// Ledger integrity (section 102). Thin, read-only wrapper over the accepted `ledger-integrity`
// package's own per-stream verification — this package adds no new integrity algorithm.
// ---------------------------------------------------------------------------------------------

export interface LedgerIntegrityResult { readonly valid: boolean; readonly streamsChecked: number; readonly invalidStreams: readonly string[] }
export function verifyLedgerIntegrity(ledgerStore: LedgerStore, opts: { persist?: boolean } = {}): LedgerIntegrityResult {
  const persist = opts.persist ?? false;
  const streams = ledgerStore.listAllStreams();
  const invalid: string[] = [];
  for (const stream of streams) {
    const result = verifyStream(ledgerStore, stream.tenant_id, stream.stream_id, { persist });
    if (!result.valid) invalid.push(`${stream.tenant_id}/${stream.stream_id}: ${result.reason ?? 'invalid'}`);
  }
  return { valid: invalid.length === 0, streamsChecked: streams.length, invalidStreams: invalid };
}
