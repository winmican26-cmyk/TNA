/**
 * TNA Deployment Academy v0.1 — Level 1 Lab: Blocked Action.
 *
 * Objective: observe a real Gate BLOCK decision when an agent attempts an action outside its authority
 * envelope, and confirm no execution of any kind occurred.
 * Prerequisites: Level 1 concepts (agents vs tools, authority, Gate).
 *
 * This lab runs entirely in-process against the REAL accepted `Gate`/`Store` classes — never a stub or
 * simulation of Gate's decision logic.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';

export interface LabStep { readonly description: string; readonly passed: boolean }
export interface LabResult { readonly lab_id: string; readonly passed: boolean; readonly steps: readonly LabStep[] }

const ADMIN = { kind: 'admin' as const, role: 'administrator' as const };
const AGENT = { kind: 'agent' as const, agentId: 'academy-lab-agent' };

export async function runLab(): Promise<LabResult> {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-academy-lab-blocked-'));
  const steps: LabStep[] = [];
  try {
    const store = new Store(resolve(dir, 'gate.sqlite'));
    const gate = new Gate(store);
    gate.register(ADMIN, { id: AGENT.agentId, name: 'Academy Lab Agent' });
    gate.setEnvelope(ADMIN, {
      version: '1.0',
      agent: { id: AGENT.agentId, name: 'Academy Lab Agent', role: 'lab', owner: 'academy', environment: 'lab', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      objective: { task_id: 'lab-blocked-action', goal: 'Only ever read customer records', allowed_outcomes: ['read customer data'], forbidden_outcomes: [] },
      resources: { repositories: { read: [], write: [] }, files: { read: ['/workspace/crm/**'], write: [] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
      tools: { allow: ['crm.lookup'], deny: [] },
      network: { allow: [], deny: ['*'] }, secrets: { allow: [], deny: ['*'] },
      agents: { communicate_with: [], communication_mode: 'authenticated', shared_memory: false, deny_unknown_agents: true },
      limits: { max_runtime_seconds: 600, max_tool_calls: 10, max_external_requests: 0, max_cost_usd: 1, max_retries_per_action: 3 },
      approvals: { required_for: [] }, risk: { level: 'low', blast_radius: 'none', rollback_required: false },
      evidence: { capture: ['agent_identity', 'policy_hash', 'tool_calls', 'timestamps'], retention_days: 30 },
      violation_policy: { unknown_tool: 'block', undeclared_resource: 'block', unauthorized_agent_contact: 'terminate', network_violation: 'terminate', secret_violation: 'terminate_and_rotate', cost_limit_exceeded: 'pause_and_escalate', runtime_limit_exceeded: 'terminate' },
      action_bindings: [{ action: 'crm.lookup', outcome: 'read customer data', tool: 'crm.lookup', resource_kind: 'files', operation: 'read', destination_required: false }],
    });

    // The student's exercise: attempt a WRITE action (delete a customer record) that this agent's
    // envelope never authorized.
    const decision = gate.authorize(AGENT, {
      agentId: AGENT.agentId, action: 'crm.delete_customer', tool: 'crm.delete',
      resource: '/workspace/crm/customer/42', estimatedCostUsd: 0,
    });

    steps.push({ description: 'Gate decision is BLOCK', passed: decision.decision === 'BLOCK' });
    steps.push({ description: 'Gate never issued a decision above BLOCK severity (no ALLOW leaked)', passed: decision.decision !== 'ALLOW' });
    steps.push({ description: 'Real Ledger-adjacent evidence: the decision was durably recorded', passed: gate.decision(ADMIN, decision.decisionId).decisionId === decision.decisionId });
    store.close();
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    // Windows can briefly hold the SQLite file handle open right after close() — best-effort cleanup,
    // not a correctness concern for the lab result itself (already computed above).
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return { lab_id: 'lab-01-blocked-action', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}
