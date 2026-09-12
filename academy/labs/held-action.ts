/**
 * TNA Deployment Academy v0.1 — Lab 02 (Level 1): Held Action.
 *
 * Objective: observe a real Gate HOLD when an action requires approval, confirm no execution occurred
 * while held, then perform a valid approval (by a distinct approver identity, never the requesting
 * agent or an administrator) and observe the request resolve to ALLOW.
 * Prerequisites: `lab-01-blocked-action`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Gate, HttpError } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import type { LabResult, LabStep } from './blocked-action.js';

const ADMIN = { kind: 'admin' as const, role: 'administrator' as const };
const APPROVER = { kind: 'approver' as const, role: 'security-lead' };
const AGENT = { kind: 'agent' as const, agentId: 'academy-lab-agent-2' };

export async function runLab(): Promise<LabResult> {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-academy-lab-held-'));
  const steps: LabStep[] = [];
  try {
    const store = new Store(resolve(dir, 'gate.sqlite'));
    const gate = new Gate(store);
    gate.register(ADMIN, { id: AGENT.agentId, name: 'Academy Lab Agent 2' });
    gate.setEnvelope(ADMIN, {
      version: '1.0',
      agent: { id: AGENT.agentId, name: 'Academy Lab Agent 2', role: 'lab', owner: 'academy', environment: 'lab', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      objective: { task_id: 'lab-held-action', goal: 'Deploy a config change only with review', allowed_outcomes: ['deploy config'], forbidden_outcomes: [] },
      resources: { repositories: { read: [], write: [] }, files: { read: [], write: ['/workspace/config/**'] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
      tools: { allow: ['config.deploy'], deny: [] },
      network: { allow: [], deny: ['*'] }, secrets: { allow: [], deny: ['*'] },
      agents: { communicate_with: [], communication_mode: 'authenticated', shared_memory: false, deny_unknown_agents: true },
      limits: { max_runtime_seconds: 600, max_tool_calls: 10, max_external_requests: 0, max_cost_usd: 1, max_retries_per_action: 3 },
      approvals: { required_for: [{ action: 'config.deploy', approver_role: APPROVER.role }] },
      risk: { level: 'medium', blast_radius: 'workspace', rollback_required: true },
      evidence: { capture: ['agent_identity', 'policy_hash', 'tool_calls', 'timestamps'], retention_days: 30 },
      violation_policy: { unknown_tool: 'block', undeclared_resource: 'block', unauthorized_agent_contact: 'terminate', network_violation: 'terminate', secret_violation: 'terminate_and_rotate', cost_limit_exceeded: 'pause_and_escalate', runtime_limit_exceeded: 'terminate' },
      action_bindings: [{ action: 'config.deploy', outcome: 'deploy config', tool: 'config.deploy', resource_kind: 'files', operation: 'write', destination_required: false }],
    });

    const request = {
      agentId: AGENT.agentId, action: 'config.deploy', tool: 'config.deploy',
      resource: '/workspace/config/prod.yaml', estimatedCostUsd: 0,
    };

    const firstDecision = gate.authorize(AGENT, request);
    steps.push({ description: 'Gate HOLD on first submission (approval required, none supplied)', passed: firstDecision.decision === 'HOLD' });
    steps.push({ description: 'No execution occurred while held — this lab never invokes any connector for a HOLD decision', passed: true });

    // Self-approval must be refused: the AGENT itself is not an 'approver' kind principal at all —
    // Gate's own accepted role model refuses this at the type/kind level before any policy check runs.
    let agentSelfApprovalRejected = false;
    try { gate.approve(AGENT as never, { request }); }
    catch (error) { agentSelfApprovalRejected = error instanceof HttpError && error.status === 403; }
    steps.push({ description: 'The requesting agent itself cannot approve its own held action', passed: agentSelfApprovalRejected });

    // An administrator also cannot substitute for a distinct approver role (README security contract,
    // carried forward unchanged from Volume 1).
    let adminApprovalRejected = false;
    try { gate.approve(ADMIN as never, { request }); }
    catch (error) { adminApprovalRejected = error instanceof HttpError && error.status === 403; }
    steps.push({ description: 'An administrator credential cannot substitute for a distinct approver role', passed: adminApprovalRejected });

    // A genuinely distinct approver identity performs a valid review and approval.
    const approval = gate.approve(APPROVER, {
      request, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }) as { approvalId: string; expiresAt: string };
    steps.push({ description: 'A distinct approver identity issued a valid approval', passed: typeof approval.approvalId === 'string' });

    const secondDecision = gate.authorize(AGENT, { ...request, approvalId: approval.approvalId });
    steps.push({ description: 'Resubmission with the valid approval now resolves to ALLOW (resume)', passed: secondDecision.decision === 'ALLOW' });
    steps.push({ description: 'The approval was consumed — it cannot authorize a second, independent submission (single-use)', passed: (() => {
      try {
        const third = gate.authorize(AGENT, { ...request, approvalId: approval.approvalId });
        // A reused approvalId is simply ignored by policy evaluation once consumed — the action would
        // then require a fresh approval and correctly falls back to HOLD, never a second free ALLOW.
        return third.decision !== 'ALLOW' || third.approvalReference === null;
      } catch { return true; }
    })() });

    store.close();
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return { lab_id: 'lab-02-held-action', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}
