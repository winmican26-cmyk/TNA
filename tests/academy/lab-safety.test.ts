import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertLabModeEnabled, assertInsideLabWorkspace, academyLabWorkspaceRoot, AcademyPathSafetyError } from '../../academy/lib/lab-paths.js';

/**
 * TNA Deployment Academy v0.1. Section 89-91: destructive academy operations must refuse to run without
 * explicit `ACADEMY_LAB_MODE=true`, and must refuse any path outside the lab workspace — real path
 * resolution, not string-prefix matching.
 */

test('a destructive academy operation refuses to run without ACADEMY_LAB_MODE=true', () => {
  assert.throws(() => assertLabModeEnabled({}), AcademyPathSafetyError);
  assert.throws(() => assertLabModeEnabled({ ACADEMY_LAB_MODE: 'false' }), AcademyPathSafetyError);
  assert.doesNotThrow(() => assertLabModeEnabled({ ACADEMY_LAB_MODE: 'true' }));
});

test('a path traversal attempt (../../) outside the lab workspace is rejected', () => {
  const escapeAttempt = resolve(academyLabWorkspaceRoot(), '..', '..', '..', 'etc', 'passwd');
  assert.throws(() => assertInsideLabWorkspace(escapeAttempt), AcademyPathSafetyError);
});

test('an absolute path entirely outside the lab workspace is rejected', () => {
  assert.throws(() => assertInsideLabWorkspace(resolve('C:', 'Windows', 'System32')), AcademyPathSafetyError);
});

test('a real path inside the lab workspace is accepted', () => {
  const root = academyLabWorkspaceRoot();
  mkdirSync(root, { recursive: true });
  const inside = resolve(root, 'some-lab-file.txt');
  const verified = assertInsideLabWorkspace(inside);
  assert.ok(verified.startsWith(root));
});

test('academy-reset only ever targets the academy lab workspace, never an arbitrary directory', () => {
  const root = academyLabWorkspaceRoot();
  assert.ok(root.includes('academy'));
  assert.ok(root.includes('.lab-state'));
});

test('a symlink pointing outside the lab workspace is rejected even though its literal path looks internal', () => {
  // Windows requires elevation (or Developer Mode) for a true symbolic link, but an NTFS junction point
  // needs neither and is resolved by `realpathSync` exactly the same way — so this test uses a real
  // symlink on POSIX and a real junction on Windows, never skipping the underlying security property.
  const root = academyLabWorkspaceRoot();
  mkdirSync(root, { recursive: true });
  const outsideTarget = resolve(root, '..', '..', 'lab-escape-target');
  mkdirSync(outsideTarget, { recursive: true });
  const linkPath = resolve(root, 'escape-link');
  try {
    symlinkSync(outsideTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertInsideLabWorkspace(linkPath), AcademyPathSafetyError);
  } finally {
    try { rmSync(linkPath, { force: true, recursive: true }); } catch { /* best-effort */ }
    try { rmSync(outsideTarget, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('cleanup: remove any lab-state artifacts this suite created', () => {
  const root = academyLabWorkspaceRoot();
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  assert.ok(true);
});
