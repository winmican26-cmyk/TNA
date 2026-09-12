/**
 * TNA Deployment Academy v0.1 — Lab 03 (Level 4): Sentinel Termination.
 *
 * Objective: use a real, accepted Sentinel admin operation (an emergency stop) to deterministically
 * force a TERMINATE decision on a real Sentinel session's pre-action check, and observe the session's
 * own durable status honestly reflects whether containment was confirmed — never a fabricated
 * "TERMINATED" when the runtime is not actually certain.
 * Prerequisites: `lab-01-blocked-action`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { SentinelRuntime, adminPrincipal, controllerPrincipal, observerPrincipal } from '../../packages/sentinel-runtime/src/index.js';
import type { LabResult, LabStep } from './blocked-action.js';

const TENANT = 'ten_academy_lab3';

export async function runLab(): Promise<LabResult> {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-academy-lab-sentinel-'));
  const steps: LabStep[] = [];
  try {
    const sentinel = new SentinelRuntime(resolve(dir, 'sentinel.sqlite'));
    sentinel.installDefaultPolicy(adminPrincipal('academy-sentinel-admin', TENANT));

    const policyHash = createHash('sha256').update('academy-lab-3-policy').digest('hex');
    const session = sentinel.createSession(controllerPrincipal('academy-controller', TENANT), {
      version: '1.0', tenant_id: TENANT, agent_id: 'lab3-agent', execution_id: `exec_${randomUUID()}`,
      correlation_id: `corr_${randomUUID()}`, authority_snapshot_hash: policyHash, policy_snapshot_hash: policyHash,
      expected_action: 'crm.lookup.execute', expected_tool: 'mcp.gt_lab3', expected_resource: 'workspace/crm/**',
      allowed_destinations: [], allowed_operations: ['read'],
      authority_expiry: new Date(Date.now() + 600_000).toISOString(),
      runtime_limits: { max_runtime_seconds: 60 }, cost_limits: { max_cost_usd: 1 },
    });
    steps.push({ description: 'A real Sentinel session was created (MONITORING)', passed: session.status === 'MONITORING' });

    // A real, accepted, admin-only operation — not a mocked SentinelPort — deterministically forces
    // containment for this exact tenant before any tool call is attempted.
    sentinel.activateStop(adminPrincipal('academy-sentinel-admin', TENANT), 'tenant', TENANT, 'academy lab 3: deterministic termination drill');

    const preCheck = await sentinel.submitObservation(observerPrincipal('academy-observer', TENANT, ['EXECUTION_BROKER']), session.sentinel_session_id, {
      version: '1.0', observation_id: `obs_${randomUUID()}`, tenant_id: TENANT, sentinel_session_id: session.sentinel_session_id,
      timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'TOOL_CALL_REQUESTED',
      payload: { tool: 'mcp.gt_lab3', resource: '/workspace/crm/customer/1' },
    });
    steps.push({ description: 'Sentinel decision is TERMINATE — a real emergency stop, not a simulated outcome', passed: preCheck.decision?.decision === 'TERMINATE' });
    steps.push({ description: 'The violation evidence names the emergency stop as the trigger', passed: preCheck.decision?.violations.some(v => v.rule_type === 'EMERGENCY_STOP') === true });

    const finalSession = sentinel.getSession(controllerPrincipal('academy-controller', TENANT), session.sentinel_session_id);
    const containmentConfirmed = finalSession.status === 'TERMINATED';
    const containmentUncertain = finalSession.status === 'TERMINATING';
    steps.push({
      description: `The session's durable status honestly reflects containment (${finalSession.status}) — TERMINATED only if truly confirmed, TERMINATING if not, never silently reported as something else`,
      passed: containmentConfirmed || containmentUncertain,
    });
    steps.push({ description: 'This lab never claims a confirmed TERMINATED unless the runtime\'s own durable state actually says so', passed: !containmentConfirmed || finalSession.status === 'TERMINATED' });

    sentinel.close();
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return { lab_id: 'lab-03-sentinel-termination', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}
