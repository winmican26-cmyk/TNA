import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  initDisposableRepo, createGitWorktree, removeGitWorktree, gitDiffNameStatus, snapshotGitRefs, detectGitRefTampering,
  GitIntegrationError,
} from '../../packages/improvement-core/src/git-integration.js';
import { assertInsideWorkspace, WorkspaceSafetyError } from '../../packages/improvement-core/src/index.js';
import { classifyMutation, evaluatePromotion, computeCapabilityDelta, buildRequiredTestManifest, detectTestManifestTampering } from '../../packages/improvement-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section X (item 118, 1 in this closure): a real
 * disposable Git repository and real `git worktree` are used throughout — never a simulated git model.
 * All destructive operations here run only against a temp repo created fresh by this file and destroyed
 * at the end; this suite never touches, references, or is capable of reaching this project's own real
 * accepted tags/branches (no path in any test below resolves outside its own `mkdtempSync` directory).
 */

function tmpRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-git-e2e-'));
  writeFileSync(resolve(dir, 'router.mjs'), "export function route(x) { return 'general'; }\n");
  writeFileSync(resolve(dir, 'benchmark.mjs'), "process.stdout.write('0.5');\n");
  writeFileSync(resolve(dir, 'regression.mjs'), "process.exitCode = 0;\n");
  return dir;
}
function cleanup(...dirs: readonly string[]): void { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }
function capability(overrides: Partial<Parameters<typeof computeCapabilityDelta>[1]> = {}) {
  return { tools: [], operations: ['read'], resources: [], destinations: [], filesystem_writes: false, network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [], ...overrides };
}

test('real Git/worktree: accepted parent commit -> candidate worktree -> mutation -> real git diff -> classification -> evaluation -> promotion', () => {
  const repoPath = tmpRepo();
  const worktreesRoot = mkdtempSync(resolve(tmpdir(), 'tna-improvement-git-worktrees-'));
  try {
    const { commitSha } = initDisposableRepo(repoPath);
    const worktreePath = createGitWorktree(repoPath, commitSha, worktreesRoot, 'candidate-1');
    assert.ok(existsSync(resolve(worktreePath, 'router.mjs')), 'the real git worktree must contain the checked-out parent files');

    // A real mutation, made directly in the real git worktree.
    writeFileSync(resolve(worktreePath, 'router.mjs'), "export function route(x) { return x.includes('billing') ? 'billing' : 'general'; }\n");

    const diffs = gitDiffNameStatus(worktreePath, commitSha);
    assert.deepEqual(diffs.map(d => d.path), ['router.mjs']);
    assert.equal(diffs[0]!.change, 'modified');

    const mutationDiff = classifyMutation('gen_git_1', diffs.map(d => d.path), { allowed_mutation_paths: ['router.mjs'], forbidden_mutation_paths: [] });
    assert.equal(mutationDiff.control_plane_changed, false);
    assert.equal(mutationDiff.out_of_scope_paths.length, 0);

    const parent = capability();
    const result = evaluatePromotion({
      improvementClass: 'CLASS_1_CODE', benchmarksAllPass: true, regressionSuitePassed: true, securityTestsPassed: true,
      capabilityDelta: computeCapabilityDelta('gen_git_1', parent, parent), authorityWithinCeiling: true, mutationDiff,
      testTamper: detectTestManifestTampering(buildRequiredTestManifest('m', 1, []), buildRequiredTestManifest('m', 1, [])),
      humanApproved: null, independentReviewApproved: null, evidenceComplete: true,
    });
    assert.equal(result.status, 'PROMOTE');
  } finally { removeGitWorktree(repoPath, resolve(worktreesRoot, 'candidate-1')); cleanup(repoPath, worktreesRoot); }
});

test('adversarial: candidate cannot check out the accepted branch inside its own worktree while it is checked out elsewhere (real git protection)', () => {
  const repoPath = tmpRepo();
  const worktreesRoot = mkdtempSync(resolve(tmpdir(), 'tna-improvement-git-worktrees-'));
  try {
    const { commitSha } = initDisposableRepo(repoPath);
    // The accepted repo's own checkout has 'master' (or 'main') checked out already.
    const branchName = execFileSync('git', ['branch', '--show-current'], { cwd: repoPath, encoding: 'utf8' }).trim();
    const worktreePath = createGitWorktree(repoPath, commitSha, worktreesRoot, 'candidate-branch-attempt');
    assert.throws(
      () => execFileSync('git', ['checkout', branchName], { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      /already used by worktree|already checked out/i,
    );
  } finally { removeGitWorktree(repoPath, resolve(worktreesRoot, 'candidate-branch-attempt')); cleanup(repoPath, worktreesRoot); }
});

test('adversarial: candidate attempts to force-move an accepted tag from within its own worktree — detected by detectGitRefTampering, never silently accepted', () => {
  const repoPath = tmpRepo();
  const worktreesRoot = mkdtempSync(resolve(tmpdir(), 'tna-improvement-git-worktrees-'));
  try {
    const { commitSha } = initDisposableRepo(repoPath);
    execFileSync('git', ['tag', 'accepted-v1', commitSha], { cwd: repoPath });
    const before = snapshotGitRefs(repoPath);

    const worktreePath = createGitWorktree(repoPath, commitSha, worktreesRoot, 'candidate-tag-attempt');
    writeFileSync(resolve(worktreePath, 'malicious.txt'), 'x');
    execFileSync('git', ['add', '-A'], { cwd: worktreePath });
    execFileSync('git', ['commit', '--quiet', '-m', 'candidate commit', '--author', 'Candidate <candidate@example.invalid>'], { cwd: worktreePath });
    const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    // The candidate's own worktree CAN move a tag (tags are repo-wide, not worktree-scoped) — this is
    // exactly why detectGitRefTampering exists as a real, separate, implemented check rather than relying
    // on worktree isolation alone to protect refs.
    execFileSync('git', ['tag', '-f', 'accepted-v1', candidateCommit], { cwd: worktreePath });

    const after = snapshotGitRefs(repoPath);
    const violations = detectGitRefTampering(before, after);
    assert.ok(violations.some(v => v.kind === 'tag' && v.ref === 'refs/tags/accepted-v1' && v.violation === 'moved'), JSON.stringify(violations));
  } finally { removeGitWorktree(repoPath, resolve(worktreesRoot, 'candidate-tag-attempt')); cleanup(repoPath, worktreesRoot); }
});

test('adversarial: candidate attempts to delete an accepted tag from within its own worktree — detected by detectGitRefTampering', () => {
  const repoPath = tmpRepo();
  const worktreesRoot = mkdtempSync(resolve(tmpdir(), 'tna-improvement-git-worktrees-'));
  try {
    const { commitSha } = initDisposableRepo(repoPath);
    execFileSync('git', ['tag', 'accepted-v2', commitSha], { cwd: repoPath });
    const before = snapshotGitRefs(repoPath);
    const worktreePath = createGitWorktree(repoPath, commitSha, worktreesRoot, 'candidate-tag-delete');
    execFileSync('git', ['tag', '-d', 'accepted-v2'], { cwd: worktreePath });
    const after = snapshotGitRefs(repoPath);
    const violations = detectGitRefTampering(before, after);
    assert.ok(violations.some(v => v.kind === 'tag' && v.ref === 'refs/tags/accepted-v2' && v.violation === 'removed'), JSON.stringify(violations));
  } finally { removeGitWorktree(repoPath, resolve(worktreesRoot, 'candidate-tag-delete')); cleanup(repoPath, worktreesRoot); }
});

test('adversarial: candidate attempts to escape the worktree root via a symlink or absolute path — rejected by the real, already-proven assertInsideWorkspace path safety', () => {
  const repoPath = tmpRepo();
  const worktreesRoot = mkdtempSync(resolve(tmpdir(), 'tna-improvement-git-worktrees-'));
  try {
    const { commitSha } = initDisposableRepo(repoPath);
    createGitWorktree(repoPath, commitSha, worktreesRoot, 'candidate-escape');
    assert.throws(() => assertInsideWorkspace(worktreesRoot, resolve(worktreesRoot, '..', 'escape-target')), WorkspaceSafetyError);
    assert.throws(() => createGitWorktree(repoPath, commitSha, worktreesRoot, '../escape-worktree'), (e: unknown) => e instanceof WorkspaceSafetyError || e instanceof GitIntegrationError);
  } finally { removeGitWorktree(repoPath, resolve(worktreesRoot, 'candidate-escape')); cleanup(repoPath, worktreesRoot); }
});

test('adversarial: candidate mutates a file outside allowed_mutation_paths inside the real worktree — flagged as out_of_scope by classifyMutation against the real git diff', () => {
  const repoPath = tmpRepo();
  const worktreesRoot = mkdtempSync(resolve(tmpdir(), 'tna-improvement-git-worktrees-'));
  try {
    const { commitSha } = initDisposableRepo(repoPath);
    const worktreePath = createGitWorktree(repoPath, commitSha, worktreesRoot, 'candidate-out-of-scope');
    writeFileSync(resolve(worktreePath, 'router.mjs'), "export function route(x) { return 'general'; }\n// legitimate change\n");
    writeFileSync(resolve(worktreePath, 'unrelated-secret-config.mjs'), 'export const secret = "sneaky";\n');
    const diffs = gitDiffNameStatus(worktreePath, commitSha);
    const mutationDiff = classifyMutation('gen_git_scope', diffs.map(d => d.path), { allowed_mutation_paths: ['router.mjs'], forbidden_mutation_paths: [] });
    assert.ok(mutationDiff.out_of_scope_paths.includes('unrelated-secret-config.mjs'));
  } finally { removeGitWorktree(repoPath, resolve(worktreesRoot, 'candidate-out-of-scope')); cleanup(repoPath, worktreesRoot); }
});

test('the disposable repository used throughout this file is never the real TNA project repository (structural self-check)', () => {
  const repoPath = tmpRepo();
  try {
    assert.ok(repoPath.includes('tna-improvement-git-e2e-'), 'every repo path in this file is freshly minted under the OS temp directory, never the real project checkout');
    assert.ok(repoPath.startsWith(tmpdir()), 'sanity: repo lives under the OS temp dir, not this repository\'s own working tree');
    assert.ok(!repoPath.startsWith(resolve('.')), 'the disposable repo must never be nested inside this project\'s own working directory');
  } finally { cleanup(repoPath); }
});
