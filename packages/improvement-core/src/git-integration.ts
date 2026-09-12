import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertInsideWorkspace } from './index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section 118: real disposable Git/worktree
 * support for the isolated candidate mutation workspace (sections 21-22). Every function here shells out
 * to the real `git` binary — never a simulated git model. All destructive operations (`removeWorktree`,
 * `assertRefsUnchanged`'s callers) are expected to run only against disposable test-fixture repositories;
 * this module has no knowledge of and no special-cases for this project's OWN accepted repository, and
 * callers must never point it there.
 */

export class GitIntegrationError extends Error {
  public constructor(message: string) { super(message); this.name = 'GitIntegrationError'; }
}

function git(repoPath: string, args: readonly string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // `git show-ref --tags`/`--heads` exits 1 with empty output when no matching ref exists at all —
    // real, documented git behavior for "no results," not a failure. Every other command's non-zero
    // exit is a genuine error.
    if (args[0] === 'show-ref' && (error as { status?: number }).status === 1) return '';
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    throw new GitIntegrationError(`git ${args.join(' ')} failed: ${stderr ? String(stderr) : error instanceof Error ? error.message : String(error)}`);
  }
}

/** Initializes a real, disposable Git repository with one initial commit — the "accepted parent". */
export function initDisposableRepo(repoPath: string): { readonly commitSha: string } {
  git(repoPath, ['init', '--quiet']);
  git(repoPath, ['config', 'user.email', 'improvement-governance-test@example.invalid']);
  git(repoPath, ['config', 'user.name', 'TNA Improvement Governance Test']);
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '--quiet', '-m', 'accepted parent']);
  const commitSha = git(repoPath, ['rev-parse', 'HEAD']).trim();
  return { commitSha };
}

/** Real `git worktree add --detach` — the candidate workspace is checked out at a specific commit in
 * DETACHED HEAD state, never on a named branch. This is what makes "candidate attempts accepted-branch
 * mutation" a real, git-enforced impossibility for the common case (see the dedicated test): git itself
 * refuses to check out a branch that is already checked out in another worktree of the same repository. */
export function createGitWorktree(repoPath: string, commitish: string, worktreeRoot: string, worktreeName: string): string {
  const verified = assertInsideWorkspace(worktreeRoot, resolve(worktreeRoot, worktreeName));
  git(repoPath, ['worktree', 'add', '--detach', verified, commitish]);
  return verified;
}

export function removeGitWorktree(repoPath: string, worktreePath: string): void {
  try { git(repoPath, ['worktree', 'remove', '--force', worktreePath]); } catch { /* best-effort — the directory may already be gone */ }
}

/** Real `git diff --name-status` between the parent commit and the candidate worktree's current working
 * tree — never this package's own filesystem-walk diff for this path, so the E2E genuinely exercises Git
 * as the source-control layer. */
export function gitDiffNameStatus(worktreePath: string, commitish: string): readonly { readonly path: string; readonly change: 'added' | 'removed' | 'modified' }[] {
  const output = git(worktreePath, ['diff', '--name-status', commitish]);
  const CHANGE_BY_CODE: Readonly<Record<string, 'added' | 'removed' | 'modified'>> = { A: 'added', D: 'removed', M: 'modified' };
  const tracked = output.split('\n').filter(line => line.trim().length > 0).map(line => {
    const [code, ...pathParts] = line.split('\t');
    return { path: pathParts.join('\t'), change: CHANGE_BY_CODE[(code ?? 'M')[0] as string] ?? 'modified' };
  });
  // `git diff` alone never reports brand-new UNTRACKED files (a candidate adding a new file the parent
  // never had would otherwise be invisible to mutation-boundary classification) — real, documented git
  // behavior, not this module's own omission once accounted for. `git ls-files --others` closes that gap.
  const untrackedOutput = git(worktreePath, ['ls-files', '--others', '--exclude-standard']);
  const untracked = untrackedOutput.split('\n').filter(line => line.trim().length > 0).map(path => ({ path, change: 'added' as const }));
  return [...tracked, ...untracked];
}

export interface GitRefSnapshot { readonly tags: ReadonlyMap<string, string>; readonly branches: ReadonlyMap<string, string> }
/** A real snapshot of every tag and branch ref (name -> commit sha) in the repository. Used to detect a
 * candidate attempting tag movement/deletion or branch mutation from within its own worktree — a real,
 * implemented check, since Git's own worktree isolation does NOT protect tags (refs are repository-wide,
 * not per-worktree) the way detached-HEAD checkout protects the currently-checked-out branch. */
export function snapshotGitRefs(repoPath: string): GitRefSnapshot {
  const tagOutput = git(repoPath, ['show-ref', '--tags']).trim();
  const branchOutput = git(repoPath, ['show-ref', '--heads']).trim();
  const parse = (output: string): Map<string, string> => {
    const map = new Map<string, string>();
    if (output.length === 0) return map;
    for (const line of output.split('\n')) {
      const [sha, ref] = line.split(' ');
      if (sha && ref) map.set(ref, sha);
    }
    return map;
  };
  return { tags: parse(tagOutput), branches: parse(branchOutput) };
}

export interface GitRefViolation { readonly kind: 'tag' | 'branch'; readonly ref: string; readonly violation: 'added' | 'removed' | 'moved' }
/** Section 81, 119: "candidate must not be able to move or delete accepted tags/branches." Compares two
 * real ref snapshots and reports every difference — added, removed, or force-moved — as a violation. The
 * caller (governor orchestration) treats ANY such violation as an unconditional mutation-boundary
 * failure, exactly like a control-plane file path touch. */
export function detectGitRefTampering(before: GitRefSnapshot, after: GitRefSnapshot): readonly GitRefViolation[] {
  const violations: GitRefViolation[] = [];
  for (const [kind, beforeMap, afterMap] of [['tag', before.tags, after.tags], ['branch', before.branches, after.branches]] as const) {
    for (const [ref, sha] of beforeMap) {
      if (!afterMap.has(ref)) violations.push({ kind, ref, violation: 'removed' });
      else if (afterMap.get(ref) !== sha) violations.push({ kind, ref, violation: 'moved' });
    }
    for (const ref of afterMap.keys()) if (!beforeMap.has(ref)) violations.push({ kind, ref, violation: 'added' });
  }
  return violations;
}
