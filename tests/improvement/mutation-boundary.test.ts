import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  assertInsideWorkspace, WorkspaceSafetyError, createIsolatedWorkspace, destroyWorkspace, improvementWorkspacesRoot,
  hashDirectoryTree, diffDirectoryTrees, mutationScale, candidateEnvironment, assertNoSecretShapedNames,
} from '../../packages/improvement-core/src/index.js';
import { ImprovementError } from '../../packages/improvement-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section 22-25: isolated mutation workspace,
 * path safety (`../` traversal, symlink escape), real diff computation, and candidate environment
 * sanitization. Mirrors the exact path-safety proof pattern already established for Volume 11's academy
 * labs (`tests/academy/lab-safety.test.ts`) — never a string-prefix check.
 */

test('assertInsideWorkspace accepts a real path inside the root and rejects ../ traversal', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-workspace-test-'));
  try {
    const root = resolve(dir, 'root');
    mkdirSync(root, { recursive: true });
    assert.doesNotThrow(() => assertInsideWorkspace(root, resolve(root, 'gen_1', 'file.txt')));
    assert.throws(() => assertInsideWorkspace(root, resolve(root, '..', 'escape.txt')), WorkspaceSafetyError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('assertInsideWorkspace rejects an absolute path entirely outside the workspace root', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-workspace-test-'));
  try {
    const root = resolve(dir, 'root');
    mkdirSync(root, { recursive: true });
    const outside = mkdtempSync(resolve(tmpdir(), 'tna-improvement-outside-'));
    try { assert.throws(() => assertInsideWorkspace(root, outside), WorkspaceSafetyError); }
    finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('assertInsideWorkspace rejects a symlink/junction that resolves outside the workspace root', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-workspace-test-'));
  try {
    const root = resolve(dir, 'root');
    mkdirSync(root, { recursive: true });
    const outside = mkdtempSync(resolve(tmpdir(), 'tna-improvement-outside-'));
    const linkPath = resolve(root, 'escape-link');
    try {
      symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => assertInsideWorkspace(root, linkPath), WorkspaceSafetyError);
    } finally {
      try { rmSync(linkPath, { force: true, recursive: true }); } catch { /* best-effort */ }
      rmSync(outside, { recursive: true, force: true });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createIsolatedWorkspace copies the parent tree without mutating it, and destroyWorkspace path-verifies before deleting', () => {
  const parentDir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-parent-'));
  try {
    writeFileSync(resolve(parentDir, 'app.ts'), 'export const x = 1;');
    mkdirSync(resolve(parentDir, 'sub'));
    writeFileSync(resolve(parentDir, 'sub', 'b.ts'), 'export const y = 2;');

    const generationId = `gen_test_${Date.now()}`;
    const workspace = createIsolatedWorkspace(generationId, parentDir);
    try {
      assert.ok(workspace.startsWith(improvementWorkspacesRoot()) || workspace === improvementWorkspacesRoot());
      writeFileSync(resolve(workspace, 'app.ts'), 'export const x = 999; // mutated');
      const parentContent = readFileSync(resolve(parentDir, 'app.ts'), 'utf8');
      assert.equal(parentContent, 'export const x = 1;', 'the parent source tree must never be mutated by editing the workspace copy');
    } finally {
      destroyWorkspace(generationId);
    }
    assert.equal(existsSync(workspace), false);
  } finally { rmSync(parentDir, { recursive: true, force: true }); }
});

test('createIsolatedWorkspace refuses to create a workspace that already exists for the same generation id', () => {
  const parentDir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-parent-'));
  try {
    writeFileSync(resolve(parentDir, 'app.ts'), 'x');
    const generationId = `gen_dup_${Date.now()}`;
    createIsolatedWorkspace(generationId, parentDir);
    try {
      assert.throws(() => createIsolatedWorkspace(generationId, parentDir), ImprovementError);
    } finally { destroyWorkspace(generationId); }
  } finally { rmSync(parentDir, { recursive: true, force: true }); }
});

test('hashDirectoryTree is deterministic regardless of directory-entry iteration order and changes when content changes', () => {
  const dirA = mkdtempSync(resolve(tmpdir(), 'tna-improvement-hash-a-'));
  const dirB = mkdtempSync(resolve(tmpdir(), 'tna-improvement-hash-b-'));
  try {
    writeFileSync(resolve(dirA, 'a.ts'), 'content-a');
    writeFileSync(resolve(dirA, 'b.ts'), 'content-b');
    writeFileSync(resolve(dirB, 'b.ts'), 'content-b');
    writeFileSync(resolve(dirB, 'a.ts'), 'content-a');
    assert.equal(hashDirectoryTree(dirA), hashDirectoryTree(dirB), 'identical content must hash identically regardless of write order');

    writeFileSync(resolve(dirB, 'a.ts'), 'content-a-modified');
    assert.notEqual(hashDirectoryTree(dirA), hashDirectoryTree(dirB));
  } finally { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); }
});

test('diffDirectoryTrees reports real added/modified/removed files, and mutationScale measures real bytes changed', () => {
  const before = mkdtempSync(resolve(tmpdir(), 'tna-improvement-diff-before-'));
  const after = mkdtempSync(resolve(tmpdir(), 'tna-improvement-diff-after-'));
  try {
    writeFileSync(resolve(before, 'keep.ts'), 'unchanged');
    writeFileSync(resolve(before, 'remove.ts'), 'gone-soon');
    writeFileSync(resolve(before, 'modify.ts'), 'v1');
    writeFileSync(resolve(after, 'keep.ts'), 'unchanged');
    writeFileSync(resolve(after, 'modify.ts'), 'v2-longer-content');
    writeFileSync(resolve(after, 'new.ts'), 'brand new file');

    const diffs = diffDirectoryTrees(before, after);
    const byPath = new Map(diffs.map(d => [d.path, d.change]));
    assert.equal(byPath.get('remove.ts'), 'removed');
    assert.equal(byPath.get('modify.ts'), 'modified');
    assert.equal(byPath.get('new.ts'), 'added');
    assert.equal(byPath.has('keep.ts'), false, 'an unchanged file must not appear in the diff at all');

    const scale = mutationScale(diffs, after);
    assert.equal(scale.changedFiles, 3);
    assert.ok(scale.changedBytes > 0);
  } finally { rmSync(before, { recursive: true, force: true }); rmSync(after, { recursive: true, force: true }); }
});

test('candidateEnvironment strips every secret-shaped variable from the parent process and applies only the explicit allowlist', () => {
  process.env.TNA_IMPROVEMENT_TEST_DECOY_TOKEN = 'should-never-propagate';
  try {
    const env = candidateEnvironment({ SAFE_VAR: 'ok' });
    assert.equal(env.TNA_IMPROVEMENT_TEST_DECOY_TOKEN, undefined, 'a secret-shaped var from the parent environment must be stripped');
    assert.equal(env.SAFE_VAR, 'ok');
  } finally { delete process.env.TNA_IMPROVEMENT_TEST_DECOY_TOKEN; }
});

test('assertNoSecretShapedNames rejects a candidate-declared allowlist that itself names a secret-shaped variable', () => {
  assert.throws(() => assertNoSecretShapedNames(['SAFE_VAR', 'TNA_CLIENT_ADMIN_TOKEN']), ImprovementError);
  assert.doesNotThrow(() => assertNoSecretShapedNames(['SAFE_VAR', 'PATH']));
});
