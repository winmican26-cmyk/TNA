import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { isRunningLockActive } from '../../packages/deployment-ops/src/index.js';

/**
 * Section 53-56, 72, 91: real-process graceful-shutdown and crash-recovery proof. These tests spawn
 * the actual `dist/apps/tna-platform/src/main.js` production entrypoint as a real OS child process —
 * not an in-process simulation — and drive it over real HTTP, matching this project's established
 * "a same-runtime call does not satisfy a distributed/process-level requirement" discipline.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const mainJs = resolve(repoRoot, 'dist/apps/tna-platform/src/main.js');
const AGENT_TOKEN = 'agent-token-'.repeat(3);

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}

interface Harness { readonly proc: ChildProcess; readonly baseUrl: string; readonly dataDir: string; readonly env: NodeJS.ProcessEnv }

async function spawnPlatform(dataDir: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TNA_ENV: 'development', TNA_TENANT_ID: 'tenant_demo', TNA_HOST: '127.0.0.1', TNA_PORT: String(port),
    TNA_DATA_DIR: dataDir,
    TNA_OPERATOR_TOKEN: 'op-'.repeat(20), TNA_ADMIN_TOKEN: 'ad-'.repeat(20), TNA_SERVICE_TOKEN: 'sv-'.repeat(20),
    TNA_PLATFORM_DEMO_AGENT_TOKEN: AGENT_TOKEN, TNA_PLATFORM_DEMO_AGENT_ID: 'shutdown-agent',
    ...extraEnv,
  };
  const proc = spawn(process.execPath, [mainJs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${baseUrl}/live`); if (res.status === 200) return { proc, baseUrl, dataDir, env }; }
    catch (error) { lastError = error; }
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error(`platform process never became live: ${String(lastError)}`);
}

async function waitForExit(proc: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs);
    proc.once('exit', code => { clearTimeout(timer); resolvePromise(code); });
  });
}

function adminHeaders(): Record<string, string> { return { Authorization: `Bearer ${'ad-'.repeat(20)}`, 'Content-Type': 'application/json' }; }

test('graceful shutdown (SIGTERM) releases the running lock and exits cleanly, leaving the data directory immediately reusable', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deployment-shutdown-graceful-'));
  try {
    const harness = await spawnPlatform(dataDir);
    assert.equal(isRunningLockActive(dataDir), true, 'a live process must hold the running lock');
    harness.proc.kill('SIGTERM');
    const code = await waitForExit(harness.proc);
    // Node's SIGTERM handling is only reliable on POSIX — on native Windows, `child.kill('SIGTERM')`
    // unconditionally force-terminates the process without ever running the JS signal handler (a
    // documented Node/Windows platform limitation, not a defect in main.ts's shutdown handler), so the
    // exit-code-0/handler-ran assertion is POSIX-only here. The authoritative graceful-shutdown proof —
    // a real `docker stop` delivering a genuine SIGTERM inside a real Linux container — is
    // `deployment-container.test.ts`, which runs the identical code path this test exercises.
    if (process.platform !== 'win32') assert.equal(code, 0, 'a graceful SIGTERM shutdown must exit 0');
    if (process.platform !== 'win32') assert.equal(isRunningLockActive(dataDir), false, 'graceful shutdown must release the running lock');

    // Regardless of platform, the data directory must be immediately reusable by a fresh instance
    // after the process is gone — no leftover lock permanently blocks recovery, no destructive
    // reinitialization (the stale-lock-reclaim path already proven by the SIGKILL test covers Windows).
    const restarted = await spawnPlatform(dataDir);
    const ready = await fetch(`${restarted.baseUrl}/ready`);
    assert.equal(ready.status, 200);
    restarted.proc.kill('SIGTERM');
    await waitForExit(restarted.proc);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('a hard crash (SIGKILL) leaves a stale lock that the next startup reclaims without operator intervention', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deployment-shutdown-crash-'));
  try {
    const harness = await spawnPlatform(dataDir);
    assert.equal(isRunningLockActive(dataDir), true);
    harness.proc.kill('SIGKILL');
    await waitForExit(harness.proc);
    // The lock file itself is still present (no clean-shutdown handler ran) — but a dead pid must not
    // be treated as a live owner (TNA-49/53: recovery must not require manual intervention).
    assert.ok(existsSync(join(dataDir, 'RUNNING.lock')));
    assert.equal(isRunningLockActive(dataDir), false, 'a crashed process\'s lock must be recognized as stale');

    const restarted = await spawnPlatform(dataDir);
    const ready = await fetch(`${restarted.baseUrl}/ready`);
    assert.equal(ready.status, 200, 'restart after a crash must succeed without manual lock removal');
    restarted.proc.kill('SIGTERM');
    await waitForExit(restarted.proc);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('an action left EXECUTING by a killed process is recovered to INDETERMINATE on restart — never fabricated as COMPLETED (TNA-48/53)', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deployment-shutdown-indeterminate-'));
  try {
    // Seed a real action directly at the PlatformStore data layer (bypassing Gate/Sentinel entirely —
    // Gate agent/envelope registration is a separate, not-yet-exposed operational concern, orthogonal
    // to what this test is proving) and force it into EXECUTING, simulating "the process was killed
    // while this action was genuinely mid-flight" — the only deterministic way to reproduce that exact
    // crash window without a racy real-time kill against a synchronous connector.
    let actionId: string;
    {
      const { PlatformStore } = await import('../../packages/platform-core/src/index.js');
      const store = new PlatformStore(join(dataDir, 'tna-platform.sqlite'));
      const action = store.createOrReturn({ version: '1.0', request_id: 'shutdown_exec_1', tenant_id: 'tenant_demo', agent_id: 'shutdown-agent', action: 'demo.echo.execute', tool: 'demo.echo', operation: 'execute', resource: 'demo', input: {}, requires_verification: false }, 'svc');
      actionId = action.platform_action_id;
      store.close();
      const db = new DatabaseSync(join(dataDir, 'tna-platform.sqlite'));
      db.prepare("UPDATE platform_actions SET state='EXECUTING' WHERE platform_action_id=?").run(actionId);
      db.close();
    }

    const restarted = await spawnPlatform(dataDir);
    const res = await fetch(`${restarted.baseUrl}/v1/platform/actions/${actionId}`, { headers: adminHeaders() });
    const recovered = await res.json() as { state: string };
    assert.equal(recovered.state, 'INDETERMINATE', 'a restart must never silently upgrade an interrupted execution to COMPLETED');
    restarted.proc.kill('SIGTERM');
    await waitForExit(restarted.proc);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
