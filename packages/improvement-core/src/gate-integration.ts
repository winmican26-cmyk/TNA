import { Gate } from '../../../apps/tna-gate-api/src/gate.js';
import type { Principal } from '../../../packages/agent-identity/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section A-B: real Gate integration for
 * consequential improvement operations. This module never invents its own authorization semantics — it
 * builds ordinary Gate `AuthorizationRequest`/envelope objects and calls the real, accepted `Gate` class
 * (`apps/tna-gate-api/src/gate.ts`, unmodified). The candidate is never the requesting OR the approving
 * principal for a consequential improvement operation — only the trusted governor agent identity
 * authorizes, and only a genuine `{kind:'approver'}` principal (never the agent, never an admin
 * substituting for one — Gate's own accepted role model already enforces this, unchanged) can approve a
 * HELD one.
 */

export const IMPROVEMENT_OPERATIONS = [
  'authorize_generation', 'build', 'invoke_candidate_tool', 'start_canary', 'promote', 'rollback', 'authority_expansion',
] as const;
export type ImprovementOperation = typeof IMPROVEMENT_OPERATIONS[number];

const ADMIN: Principal = { kind: 'admin', role: 'administrator' };

function governorEnvelope(agentId: string, options: { readonly approverRole: string; readonly writableResourcePatterns: readonly string[] }) {
  return {
    version: '1.0' as const,
    agent: { id: agentId, name: `Improvement Governor (${agentId})`, role: 'improvement-governor', owner: 'tna-improvement-governor', environment: 'production', expires_at: new Date(Date.now() + 365 * 24 * 3600_000).toISOString() },
    objective: { task_id: 'recursive-improvement', goal: 'Propose, evaluate, and promote governed improvement generations', allowed_outcomes: ['generation promoted', 'generation rejected', 'generation rolled back'], forbidden_outcomes: ['self-promotion', 'authority self-expansion'] },
    resources: {
      repositories: { read: [], write: [] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] },
      files: { read: ['/improvement/**'], write: [...options.writableResourcePatterns] },
    },
    tools: { allow: IMPROVEMENT_OPERATIONS.map(op => `improvement.${op}`), deny: [] },
    network: { allow: [], deny: ['*'] }, secrets: { allow: [], deny: ['*'] },
    agents: { communicate_with: [], communication_mode: 'authenticated' as const, shared_memory: false, deny_unknown_agents: true },
    // `max_retries_per_action` bounds ALLOWs of a given action for the agent's entire envelope lifetime
    // (Gate's own documented semantics — see docs/authority-envelope-v1.md — not scoped per resource/
    // generation). The governor authorizes the SAME action names (authorize_generation/build/etc.)
    // repeatedly across every distinct generation it will ever process, so this must be sized to the
    // governor's whole operating lifetime, not to a single generation's retry allowance — matching
    // `max_tool_calls` (the real, still-bounded ceiling) rather than a small fixed number that would
    // otherwise silently BLOCK legitimate authorize calls for the 5th+ distinct generation.
    limits: { max_runtime_seconds: 3600, max_tool_calls: 1000, max_external_requests: 0, max_cost_usd: 100, max_retries_per_action: 1000 },
    approvals: {
      required_for: [
        { action: 'improvement.promote', approver_role: options.approverRole },
        { action: 'improvement.rollback', approver_role: options.approverRole },
        { action: 'improvement.start_canary', approver_role: options.approverRole },
        { action: 'improvement.authority_expansion', approver_role: options.approverRole },
      ],
    },
    risk: { level: 'high' as const, blast_radius: 'tenant' as const, rollback_required: true },
    evidence: { capture: ['agent_identity', 'policy_hash', 'tool_calls', 'timestamps'], retention_days: 365 },
    violation_policy: { unknown_tool: 'block' as const, undeclared_resource: 'block' as const, unauthorized_agent_contact: 'terminate' as const, network_violation: 'terminate' as const, secret_violation: 'terminate_and_rotate' as const, cost_limit_exceeded: 'pause_and_escalate' as const, runtime_limit_exceeded: 'terminate' as const },
    // Only `invoke_candidate_tool` binds to a WRITE resource match (section B: this is the one operation
    // an authority-expansion request can legitimately widen). Every other governor-internal operation
    // (authorize/build/evaluate/canary/promote/rollback bookkeeping) matches against the always-present
    // `resources.files.read: ['/improvement/**']` scope — the trusted governor does not need incremental
    // per-operation authority expansion for its own already-trusted machinery.
    action_bindings: IMPROVEMENT_OPERATIONS.map(op => ({
      action: `improvement.${op}`, outcome: op === 'promote' ? 'generation promoted' : op === 'rollback' ? 'generation rolled back' : 'generation rejected',
      tool: `improvement.${op}`, resource_kind: 'files' as const, operation: op === 'invoke_candidate_tool' ? 'write' as const : 'read' as const, destination_required: false,
    })),
  };
}

/** Registers the trusted improvement-governor agent identity with a real Gate envelope. The envelope's
 * `tools.allow` covers every improvement operation, but `approvals.required_for` gates the
 * consequential/high-risk ones (`promote`, `rollback`, `start_canary`, `authority_expansion`) behind a
 * real distinct approver role — never the governor agent itself. `writableResourcePatterns` starts empty
 * for a freshly-registered governor; only an explicit, separate `expandGovernorWriteAccess` call (never a
 * side effect of anything the candidate does) can widen it. */
export function registerImprovementGovernor(gate: Gate, agentId: string, options: { readonly approverRole: string; readonly writableResourcePatterns?: readonly string[] }): void {
  gate.register(ADMIN, { id: agentId, name: `Improvement Governor (${agentId})` });
  gate.setEnvelope(ADMIN, governorEnvelope(agentId, { approverRole: options.approverRole, writableResourcePatterns: options.writableResourcePatterns ?? [] }));
}

/** Section 14, 52: the ONLY way a governor's writable resource scope grows — always a distinct,
 * explicit, trusted-administrator call, never invoked automatically by an `AuthorityExpansionRequest`
 * being marked APPROVED in the store (that store has no import of Gate at all — see
 * `tests/improvement/gate-integration.test.ts`'s structural proof). A real caller invokes this only
 * after `ImprovementStore.decideAuthorityExpansionRequest` has independently recorded `APPROVED`. */
export function expandGovernorWriteAccess(gate: Gate, agentId: string, options: { readonly approverRole: string; readonly writableResourcePatterns: readonly string[] }): void {
  gate.setEnvelope(ADMIN, governorEnvelope(agentId, options));
}

/** The real Gate authorization call for one consequential improvement operation. Returns Gate's own,
 * real `Decision` — never a fabricated object shaped like one. */
export function authorizeImprovementOperation(gate: Gate, agentId: string, operation: ImprovementOperation, generationId: string, options: { readonly resource?: string; readonly estimatedCostUsd?: number; readonly approvalId?: string } = {}) {
  return gate.authorize({ kind: 'agent', agentId }, {
    agentId, action: `improvement.${operation}`, tool: `improvement.${operation}`,
    resource: options.resource ?? `/improvement/generations/${generationId}`,
    estimatedCostUsd: options.estimatedCostUsd ?? 0,
    ...(options.approvalId ? { approvalId: options.approvalId } : {}),
  });
}

/** A genuine, distinct approver principal — never the governor agent, never an admin. Constructing one
 * of these does not itself grant anything; it is only accepted by `gate.approve()` if it also matches
 * the envelope's own `approvals.required_for` rule for the action in question. */
export function improvementApprover(role: string): Principal { return { kind: 'approver', role }; }
