/**
 * TNA Deployment Academy v0.1 — Lab 13 (Level 2): Incident Triage.
 *
 * Objective: inject one controlled, real failure (a client gateway that is not actually running at the
 * configured endpoint) and use the real, packaged `tna doctor` / `tna incident collect` commands to
 * correctly identify the condition — never assume it, read the real tool's real output.
 * Prerequisites: `lab-07-mcp-discovery`.
 */
import { spawnSync } from 'node:child_process';
import { execPath } from 'node:process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { LabResult, LabStep } from './blocked-action.js';

const OPERATOR_MAIN = resolve('dist', 'apps', 'tna-operator', 'src', 'main.js');
const ADMIN_TOKEN_ENV = 'ACADEMY_LAB13_TOKEN';
// Section (threat model): "production credentials appearing in lab state" — this lab spawns a real CLI
// process and must not blindly forward the invoking shell's own environment, which could carry a real
// operator's production credential env vars (e.g. a real TNA_CLIENT_ADMIN_TOKEN). Only this lab's own
// synthetic placeholder credential is ever set for the child process; any secret-shaped var inherited
// from the parent shell is stripped first, even though the target gateway is unreachable regardless.
const SECRET_SHAPED_ENV_KEY = /(api[_-]?key|apikey|secret|password|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|authorization|credential|signing[_-]?key|token)/i;
function sanitizedParentEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!SECRET_SHAPED_ENV_KEY.test(key)) clean[key] = value;
  return clean;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}

export async function runLab(): Promise<LabResult> {
  const steps: LabStep[] = [];
  const profileDir = mkdtempSync(resolve(tmpdir(), 'tna-academy-lab13-profiles-'));
  const auditDir = mkdtempSync(resolve(tmpdir(), 'tna-academy-lab13-audit-'));
  try {
    // The injected fault: a client gateway URL that nothing is actually listening on.
    const deadPort = await freePort();
    writeFileSync(resolve(profileDir, 'lab13.json'), JSON.stringify({
      role: 'operator', devMode: true, clientGatewayUrl: `http://127.0.0.1:${deadPort}`, clientGatewayAdminTokenEnv: ADMIN_TOKEN_ENV,
    }));
    const env = { ...sanitizedParentEnv(), TNA_OPERATOR_PROFILE_DIR: profileDir, [ADMIN_TOKEN_ENV]: 'unused-token-for-unreachable-gateway', TNA_OPERATOR_AUDIT_DIR: auditDir };

    const doctorRun = spawnSync(execPath, [OPERATOR_MAIN, 'doctor', '--profile', 'lab13', '--json'], { env, encoding: 'utf8' });
    // spawnSync blocks until the child exits, so by this line the process (pid noted for
    // tests/academy/process-cleanup.test.ts) is already terminated — orphaning it is not possible.
    steps.push({ description: `The real packaged tna doctor command (pid ${doctorRun.pid}) ran against the injected fault and has already exited`, passed: doctorRun.status !== null });
    const doctorResult = JSON.parse(doctorRun.stdout) as { ok: boolean; data: { overall: string; checks: { check_id: string; status: string }[] } };
    steps.push({ description: 'doctor correctly reports overall FAIL, not a false PASS', passed: doctorResult.ok === false && doctorResult.data.overall === 'FAIL' });
    const gatewayCheck = doctorResult.data.checks.find(c => c.check_id === 'client_gateway.readiness');
    steps.push({ description: 'doctor correctly attributes the failure to client_gateway.readiness specifically, not a generic error', passed: gatewayCheck?.status === 'FAIL' });

    const incidentRun = spawnSync(execPath, [OPERATOR_MAIN, 'incident', 'collect', '--profile', 'lab13', '--json'], { env, encoding: 'utf8' });
    const incidentResult = JSON.parse(incidentRun.stdout) as { ok: boolean; data: { doctor: { overall: string } } };
    steps.push({ description: 'incident collect also ran against the same real, still-broken state', passed: incidentRun.status === 0 });
    steps.push({ description: 'The collected incident package\'s own embedded doctor report agrees with the standalone doctor run — one consistent, real picture of the fault', passed: incidentResult.data.doctor.overall === 'FAIL' });
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return { lab_id: 'lab-13-incident-triage', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}
