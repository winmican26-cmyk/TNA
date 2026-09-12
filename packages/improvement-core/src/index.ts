import { realpathSync, existsSync, mkdirSync, readdirSync, statSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { resolve, sep, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ImprovementError } from '../../improvement-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12). Section 22-25: isolated mutation workspaces,
 * generalized from the exact real-path-resolution technique `academy/lib/lab-paths.ts` already proved in
 * Volume 11 (never a string-prefix check, which a symlink could defeat) — parameterized here by an
 * arbitrary workspace root rather than one fixed academy path, since every improvement generation gets
 * its own isolated workspace.
 */

export class WorkspaceSafetyError extends Error {
  public constructor(message: string) { super(message); this.name = 'WorkspaceSafetyError'; }
}

export function improvementWorkspacesRoot(): string {
  return resolve('improvement', '.workspaces');
}
export function generationWorkspacePath(generationId: string): string {
  return resolve(improvementWorkspacesRoot(), generationId);
}

/** Section 23: resolves `candidate` and asserts the REAL (symlink-resolved) path is a descendant of
 * `root` — never a plain string-prefix check. Mirrors `assertInsideLabWorkspace` exactly, generalized to
 * an explicit root parameter instead of one fixed academy path. */
export function assertInsideWorkspace(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  mkdirSync(resolvedRoot, { recursive: true });
  const resolvedCandidate = resolve(candidate);
  if (!existsSync(resolvedCandidate)) {
    if (!resolvedCandidate.startsWith(resolvedRoot + sep) && resolvedCandidate !== resolvedRoot) {
      throw new WorkspaceSafetyError(`Refusing: "${candidate}" resolves outside the workspace root (${resolvedRoot})`);
    }
    return resolvedCandidate;
  }
  const realRoot = realpathSync(resolvedRoot);
  const realCandidate = realpathSync(resolvedCandidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throw new WorkspaceSafetyError(`Refusing: "${candidate}" (real path ${realCandidate}) resolves outside the workspace root (${realRoot}) — possible symlink escape`);
  }
  return realCandidate;
}

/** Section 22: creates a fresh isolated candidate workspace by COPYING the parent source tree — the
 * accepted production tree is never mutated directly. `parentSourceRoot` is copied as a real, independent
 * filesystem tree; nothing in the resulting workspace is a live reference back to the parent. */
export function createIsolatedWorkspace(generationId: string, parentSourceRoot: string): string {
  const workspacePath = generationWorkspacePath(generationId);
  const verified = assertInsideWorkspace(improvementWorkspacesRoot(), workspacePath);
  if (existsSync(verified)) throw new ImprovementError('CONFLICT', `Workspace for generation ${generationId} already exists`);
  mkdirSync(verified, { recursive: true });
  cpSync(resolve(parentSourceRoot), verified, { recursive: true, dereference: true });
  return verified;
}

/** Section 22-23: destroys a generation's isolated workspace. Always path-verified before deletion — the
 * same discipline as every destructive Academy lab in Volume 11. */
export function destroyWorkspace(generationId: string): void {
  const workspacePath = generationWorkspacePath(generationId);
  const verified = assertInsideWorkspace(improvementWorkspacesRoot(), workspacePath);
  rmSync(verified, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// Section 20-21: source snapshot hashing — a deterministic hash of an entire directory tree, used for
// `source_hash_before`/`source_hash_after` and for computing the real changed-file list between two
// workspace snapshots (section 86-90's `classifyMutation`/`MutationDiffReport` consume this list).
// ---------------------------------------------------------------------------------------------

const DEFAULT_IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.workspaces']);

function walkFiles(root: string, current: string, ignored: ReadonlySet<string>, out: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, ignored, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
}

/** Section 21: a real content hash of every file under `root` (sorted relative paths, each file's own
 * content hash) — deterministic regardless of filesystem iteration order. Deliberately does not rely
 * solely on a mutable branch name (section 21: "do not rely solely on mutable branch names"); this is a
 * content-addressed snapshot of the tree as it actually exists on disk right now. */
export function hashDirectoryTree(root: string, options: { readonly ignoredDirNames?: ReadonlySet<string> } = {}): string {
  const resolvedRoot = resolve(root);
  const ignored = options.ignoredDirNames ?? DEFAULT_IGNORED_DIR_NAMES;
  const files: string[] = [];
  walkFiles(resolvedRoot, resolvedRoot, ignored, files);
  files.sort();
  const hasher = createHash('sha256');
  for (const relPath of files) {
    hasher.update(relPath);
    hasher.update('\0');
    hasher.update(createHash('sha256').update(readFileSync(join(resolvedRoot, relPath))).digest());
  }
  return hasher.digest('hex');
}

export interface FileDiff { readonly path: string; readonly change: 'added' | 'removed' | 'modified' }

/** Section 26-27, 86-90: the REAL changed-file list between two directory snapshots — the actual input
 * `classifyMutation` (in `improvement-schema`) needs, computed here rather than trusted from any
 * candidate-supplied claim of "what I changed". */
export function diffDirectoryTrees(beforeRoot: string, afterRoot: string, options: { readonly ignoredDirNames?: ReadonlySet<string> } = {}): readonly FileDiff[] {
  const ignored = options.ignoredDirNames ?? DEFAULT_IGNORED_DIR_NAMES;
  const beforeFiles: string[] = []; walkFiles(resolve(beforeRoot), resolve(beforeRoot), ignored, beforeFiles);
  const afterFiles: string[] = []; walkFiles(resolve(afterRoot), resolve(afterRoot), ignored, afterFiles);
  const beforeSet = new Map(beforeFiles.map(p => [p, hashFileAt(resolve(beforeRoot), p)]));
  const afterSet = new Map(afterFiles.map(p => [p, hashFileAt(resolve(afterRoot), p)]));
  const diffs: FileDiff[] = [];
  for (const [path, hash] of afterSet) {
    if (!beforeSet.has(path)) diffs.push({ path, change: 'added' });
    else if (beforeSet.get(path) !== hash) diffs.push({ path, change: 'modified' });
  }
  for (const path of beforeSet.keys()) if (!afterSet.has(path)) diffs.push({ path, change: 'removed' });
  return diffs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function hashFileAt(root: string, relPath: string): string { return createHash('sha256').update(readFileSync(join(root, relPath))).digest('hex'); }

/** Section 85: bound mutation scale — a "small improvement" that rewrites most of the repository should
 * trigger review, not pass silently. Returns real measured totals, never a candidate-asserted count. */
export function mutationScale(diffs: readonly FileDiff[], rootForByteCount: string): { readonly changedFiles: number; readonly changedBytes: number } {
  let changedBytes = 0;
  for (const diff of diffs) {
    if (diff.change === 'removed') continue;
    try { changedBytes += statSync(join(resolve(rootForByteCount), diff.path)).size; } catch { /* file may have been removed mid-scan; ignore */ }
  }
  return { changedFiles: diffs.length, changedBytes };
}

// ---------------------------------------------------------------------------------------------
// Section 24-25: candidate environment allowlisting — reuses the exact `SECRET_KEY_PATTERN` technique
// already proven (and, in Volume 11's own closure, actually fixed a real credential-leak defect with) in
// `academy/labs/incident-triage.ts`. A candidate mutation process must never inherit the invoking
// operator's own production credential env vars.
// ---------------------------------------------------------------------------------------------

const SECRET_SHAPED_ENV_KEY = /(api[_-]?key|apikey|secret|password|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|authorization|credential|signing[_-]?key|token)/i;

/** Section 24: builds a candidate process environment that strips every secret-shaped variable from the
 * parent, then layers on only the explicitly-declared allowlisted variables — a candidate mutation
 * process never sees a promotion credential, an unrelated tenant's credential, a tag-signing secret, or
 * any other secret-shaped var merely because the orchestrator's own shell happened to have it set. */
export function candidateEnvironment(explicitAllowlist: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!SECRET_SHAPED_ENV_KEY.test(key)) sanitized[key] = value;
  return { ...sanitized, ...explicitAllowlist };
}

/** Section 25: a hard structural check that a set of env var NAMES contains nothing secret-shaped — used
 * to verify a candidate's OWN declared env allowlist doesn't itself try to smuggle a credential name
 * through (e.g. a spec author accidentally or maliciously allowlisting `TNA_CLIENT_ADMIN_TOKEN`). */
export function assertNoSecretShapedNames(names: readonly string[]): void {
  const offending = names.filter(n => SECRET_SHAPED_ENV_KEY.test(n));
  if (offending.length > 0) throw new ImprovementError('INVALID_INPUT', `Candidate environment allowlist names a secret-shaped variable: ${offending.join(', ')}`);
}
