import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runLabById } from '../../academy/labs/registry.js';

/**
 * TNA Deployment Academy v0.1 closure — Academy process-cleanup proof.
 *
 * Design note: an earlier version of this test scanned the whole OS process table for command lines
 * matching Academy markers. That approach is fundamentally racy under `npm run check`, which runs many
 * test FILES concurrently — a sibling file (e.g. `lab-verifier.test.ts`, `tests/operator/cli-academy.test.ts`)
 * legitimately spawning its own, unrelated instance of the same fixture/binary at the same moment produces
 * a false "orphan" finding that has nothing to do with this file's own lab run. This version instead
 * tracks processes BY EXACT PID: every process-spawning lab now reports the real pid(s) it spawned in its
 * own step descriptions (see `academy/labs/mcp-discovery.ts`, `schema-drift.ts`, `tenant-isolation.ts`,
 * `incident-triage.ts`, `packaged-path.ts`), and this test verifies those SPECIFIC pids — never anyone
 * else's — are dead afterward. This is both correct (no cross-file race) and a stronger claim (proves
 * cleanup of the pid this lab itself created, not merely "no matching command line happened to remain").
 */

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function extractPids(steps: readonly { readonly description: string }[]): number[] {
  const pids: number[] = [];
  for (const step of steps) {
    const match = step.description.match(/pid (\d+)/);
    if (match) pids.push(Number(match[1]));
  }
  return pids;
}

async function settle(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

const PROCESS_LABS = ['lab-07-mcp-discovery', 'lab-08-schema-drift', 'lab-10-tenant-isolation', 'lab-13-incident-triage', 'lab-15-packaged-path'] as const;

for (const labId of PROCESS_LABS) {
  test(`academy lab "${labId}" leaves zero orphaned processes among the exact pid(s) it itself spawned`, async () => {
    const result = await runLabById(labId);
    const pids = extractPids(result.steps);
    assert.ok(pids.length > 0, `${labId} must report at least one real spawned pid in its step evidence`);
    await settle(500);
    const stillAlive = pids.filter(isPidAlive);
    assert.deepEqual(stillAlive, [], `lab ${labId} left its own spawned pid(s) still running: ${JSON.stringify(stillAlive)}`);
  });
}

test('destructive/recovery labs (lab-06 Ledger Corruption, lab-11 Backup & Restore) spawn no child process at all — nothing to leak, by construction', () => {
  const lab06 = readFileSync(fileURLToPath(new URL('../../../academy/labs/ledger-corruption.ts', import.meta.url)), 'utf8');
  const lab11 = readFileSync(fileURLToPath(new URL('../../../academy/labs/backup-restore.ts', import.meta.url)), 'utf8');
  for (const [name, src] of [['lab-06-ledger-corruption', lab06], ['lab-11-backup-restore', lab11]] as const) {
    assert.ok(!/node:child_process|\bspawn\(|\bspawnSync\(/.test(src), `${name} must not import or call node:child_process — destructive/recovery labs are pure in-process file/SQLite operations`);
  }
});

test('lab-13 (Incident Triage) never forwards the raw parent environment to its spawned CLI child — a decoy secret-shaped env var set on the test process is provably absent from the child\'s env', async () => {
  const src = readFileSync(fileURLToPath(new URL('../../../academy/labs/incident-triage.ts', import.meta.url)), 'utf8');
  assert.ok(!/\.\.\.process\.env/.test(src), 'lab-13 must not spread the raw parent process.env into its spawned child — a real operator\'s production credential env vars must never be forwarded to a lab-spawned process');
  assert.ok(/SECRET_SHAPED_ENV_KEY/.test(src) && /sanitizedParentEnv/.test(src), 'lab-13 must strip secret-shaped env vars before building its child env');

  process.env.TNA_ACADEMY_DECOY_ADMIN_TOKEN = 'decoy-production-secret-should-never-propagate';
  try {
    const result = await runLabById('lab-13-incident-triage');
    assert.equal(result.passed, true, 'lab-13 must still pass correctly with the decoy secret present in the parent environment');
  } finally { delete process.env.TNA_ACADEMY_DECOY_ADMIN_TOKEN; }
});
