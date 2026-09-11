import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';

/**
 * Section 91-93, 8-10: builds and runs the ACTUAL production Docker image — never a static inspection
 * of the Dockerfile. Requires a local Docker daemon; these tests are part of the ordinary deployment
 * test group, not gated behind an opt-in flag, per section 91's explicit instruction not to declare
 * container packaging validated without really running it.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const IMAGE = 'tna-platform:deployment-test';
const PROD_SECRETS = {
  TNA_OPERATOR_TOKEN: `op-${'x'.repeat(30)}`, TNA_ADMIN_TOKEN: `ad-${'y'.repeat(30)}`,
  TNA_SERVICE_TOKEN: `sv-${'z'.repeat(30)}`, TNA_CAPABILITY_KEY: `ck-${'w'.repeat(30)}`,
};

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
}
function dockerQuiet(args: string[]): { code: number; stdout: string; stderr: string } {
  try { const stdout = execFileSync('docker', args, { encoding: 'utf8', cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }); return { code: 0, stdout, stderr: '' }; }
  catch (error) { const e = error as { status?: number; stdout?: string; stderr?: string }; return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }; }
}
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}
async function waitUntilLive(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/live`); if (res.status === 200) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`container never became live on port ${port}`);
}

let dockerAvailable = true;
before(() => {
  const check = dockerQuiet(['version', '--format', '{{.Server.Version}}']);
  if (check.code !== 0) { dockerAvailable = false; return; }
  docker(['build', '-f', 'deploy/docker/Dockerfile', '-t', IMAGE, '.']);
});
after(() => { try { execFileSync('docker', ['rmi', '-f', IMAGE], { cwd: repoRoot }); } catch { /* best-effort */ } });

test('real container: fresh-machine boot, non-root execution, readiness, real SIGTERM shutdown, and repeat boot preserving deployment identity', async t => {
  if (!dockerAvailable) { t.skip('Docker daemon not available'); return; }
  const name = `tna-platform-test-${randomUUID().slice(0, 8)}`;
  const volume = `tna-platform-test-vol-${randomUUID().slice(0, 8)}`;
  const port = await freePort();
  try {
    docker(['volume', 'create', volume]);
    // A brand-new, empty named volume — section 92: no reliance on developer-machine residue.
    docker([
      'run', '-d', '--name', name, '-p', `${port}:4618`, '-v', `${volume}:/data`,
      '-e', 'TNA_ENV=production', '-e', 'TNA_TENANT_ID=tenant_demo', '-e', 'TNA_HOST=0.0.0.0',
      '-e', 'TNA_TRUST_PROXY=true', '-e', 'TNA_DATA_DIR=/data',
      ...Object.entries(PROD_SECRETS).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      IMAGE,
    ]);
    await waitUntilLive(port);

    // Section 9: non-root, tested, not merely documented.
    const uid = docker(['exec', name, 'id', '-u']).trim();
    assert.notEqual(uid, '0', 'the container process must not run as root');

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(ready.status, 200);

    const diagBefore = await fetch(`http://127.0.0.1:${port}/diagnostics`, { headers: { Authorization: `Bearer ${PROD_SECRETS.TNA_ADMIN_TOKEN}` } });
    assert.equal(diagBefore.status, 200);
    const deploymentIdBefore = (await diagBefore.json() as { deployment_id: string }).deployment_id;
    assert.ok(deploymentIdBefore.startsWith('dep_'));

    // Section 53, 56, 91: `docker stop` sends a REAL SIGTERM to PID 1 inside a real Linux container —
    // this is the authoritative graceful-shutdown proof the native-Windows test host cannot provide
    // (see deployment-shutdown.test.ts's note on Node's Windows SIGTERM limitation).
    docker(['stop', '--time', '10', name]);
    const exitCode = docker(['inspect', name, '--format', '{{.State.ExitCode}}']).trim();
    assert.equal(exitCode, '0', 'a graceful SIGTERM shutdown inside the real container must exit 0');
    const logs = docker(['logs', name]);
    assert.ok(logs.includes('"event":"SHUTDOWN_COMPLETE"'), 'the structured shutdown log must actually be emitted');

    // Section 93: repeat boot on the same (still-populated) volume, without wiping it — no destructive
    // reinitialization, and the deployment identity survives the restart.
    docker(['start', name]);
    await waitUntilLive(port);
    const diagAfter = await fetch(`http://127.0.0.1:${port}/diagnostics`, { headers: { Authorization: `Bearer ${PROD_SECRETS.TNA_ADMIN_TOKEN}` } });
    const deploymentIdAfter = (await diagAfter.json() as { deployment_id: string }).deployment_id;
    assert.equal(deploymentIdAfter, deploymentIdBefore, 'deployment_id must survive a repeat boot on the same volume');
  } finally {
    try { docker(['rm', '-f', name]); } catch { /* best-effort cleanup */ }
    try { docker(['volume', 'rm', volume]); } catch { /* best-effort cleanup */ }
  }
});

test('real container: can run with a read-only root filesystem and an explicit writable /data volume', async t => {
  if (!dockerAvailable) { t.skip('Docker daemon not available'); return; }
  const name = `tna-platform-test-ro-${randomUUID().slice(0, 8)}`;
  const volume = `tna-platform-test-ro-vol-${randomUUID().slice(0, 8)}`;
  const port = await freePort();
  try {
    docker(['volume', 'create', volume]);
    docker([
      'run', '-d', '--name', name, '-p', `${port}:4618`, '-v', `${volume}:/data`,
      '--read-only', '--tmpfs', '/tmp',
      '-e', 'TNA_ENV=production', '-e', 'TNA_TENANT_ID=tenant_demo', '-e', 'TNA_HOST=0.0.0.0',
      '-e', 'TNA_TRUST_PROXY=true', '-e', 'TNA_DATA_DIR=/data',
      ...Object.entries(PROD_SECRETS).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      IMAGE,
    ]);
    await waitUntilLive(port);
    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(ready.status, 200, 'the platform must boot and become ready with a read-only root filesystem');
  } finally {
    try { docker(['rm', '-f', name]); } catch { /* best-effort cleanup */ }
    try { docker(['volume', 'rm', volume]); } catch { /* best-effort cleanup */ }
  }
});
