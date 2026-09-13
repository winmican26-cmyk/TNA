import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Gate, HttpError } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { registerImprovementGovernor, authorizeImprovementOperation, improvementApprover } from '../../packages/improvement-core/src/gate-integration.js';
import { ImprovementStore } from '../../packages/improvement-store/src/index.js';

/**
 * TNA Volume 12 post-acceptance reliability remediation. `apps/tna-improvement-governor/src/main.ts`
 * calls `registerImprovementGovernor()` unconditionally on every process start — including a restart
 * against an already-populated Gate store, which is the real, expected shape of a production
 * container restart. This file proves that restart path is safe: the same governor identity restarting
 * against its own persisted Gate database must never crash, never create a duplicate identity, never
 * widen or weaken authority, and must fail closed if the persisted identity is ever genuinely
 * inconsistent with the expected trusted governor shape.
 */

const AGENT_ID = 'improvement-governor-restart-test';
const APPROVER_ROLE = 'improvement-approver';

function tmpGate(): { gate: Gate; store: Store; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-restart-test-'));
  const store = new Store(resolve(dir, 'gate.sqlite'));
  const gate = new Gate(store);
  return { gate, store, dir };
}
function cleanup(store: Store, dir: string): void { store.close(); rmSync(dir, { recursive: true, force: true }); }
/** Reopens the SAME on-disk store under a fresh `Store`/`Gate` instance — this is what actually happens
 * on a real container restart (a brand-new process, the same `/data` volume). Calling `registerImprovementGovernor`
 * against the ORIGINAL in-memory `gate` object would not reproduce the bug the same way a real restart
 * does, since nothing here relies on in-process state surviving. */
function reopen(dir: string): Gate { return new Gate(new Store(resolve(dir, 'gate.sqlite'))); }

test('fresh startup: registers the governor and installs the expected envelope', () => {
  const { gate, store, dir } = tmpGate();
  try {
    registerImprovementGovernor(gate, AGENT_ID, { approverRole: APPROVER_ROLE });
    const decision = authorizeImprovementOperation(gate, AGENT_ID, 'build', 'gen_1');
    assert.equal(decision.decision, 'ALLOW');
  } finally { cleanup(store, dir); }
});

test('clean restart with the same persisted Gate store does not throw (regression for the reproduced crash-loop)', () => {
  const { gate, store, dir } = tmpGate();
  try {
    registerImprovementGovernor(gate, AGENT_ID, { approverRole: APPROVER_ROLE });
    const restarted = reopen(dir);
    assert.doesNotThrow(() => registerImprovementGovernor(restarted, AGENT_ID, { approverRole: APPROVER_ROLE }));
    restarted.store.close();
  } finally { cleanup(store, dir); }
});

test('second restart also does not throw (proves this is real idempotency, not a one-shot fluke)', () => {
  const { gate, store, dir } = tmpGate();
  try {
    registerImprovementGovernor(gate, AGENT_ID, { approverRole: APPROVER_ROLE });
    for (let i = 0; i < 2; i++) {
      const restarted = reopen(dir);
      assert.doesNotThrow(() => registerImprovementGovernor(restarted, AGENT_ID, { approverRole: APPROVER_ROLE }));
      restarted.store.close();
    }
  } finally { cleanup(store, dir); }
});

test('an existing, expected governor identity is never re-registered as a duplicate', () => {
  const { gate, store, dir } = tmpGate();
  try {
    registerImprovementGovernor(gate, AGENT_ID, { approverRole: APPROVER_ROLE });
    const restarted = reopen(dir);
    registerImprovementGovernor(restarted, AGENT_ID, { approverRole: APPROVER_ROLE });
    // `Gate.register` itself is the ground truth for "no duplicate": calling it again directly (bypassing
    // the governor helper) against this now-twice-bootstrapped store must still see exactly one agent
    // record and therefore still reject a genuine duplicate attempt with the real 409 — proving the fix
    // did not, say, delete-and-recreate the agent row or otherwise paper over Gate's own uniqueness rule.
    let stillRejectsRealDuplicate = false;
    try { restarted.register({ kind: 'admin', role: 'administrator' }, { id: AGENT_ID, name: 'Improvement Governor (imposter)' }); }
    catch (error) { stillRejectsRealDuplicate = error instanceof HttpError && error.status === 409; }
    assert.equal(stillRejectsRealDuplicate, true);
    restarted.store.close();
  } finally { cleanup(store, dir); }
});

test('approval boundaries are unchanged after a restart: the governor still cannot self-approve its own promotion', () => {
  const { gate, store, dir } = tmpGate();
  try {
    registerImprovementGovernor(gate, AGENT_ID, { approverRole: APPROVER_ROLE });
    const restarted = reopen(dir);
    registerImprovementGovernor(restarted, AGENT_ID, { approverRole: APPROVER_ROLE });

    const held = authorizeImprovementOperation(restarted, AGENT_ID, 'promote', 'gen_restart');
    assert.equal(held.decision, 'HOLD');
    const request = { agentId: AGENT_ID, action: 'improvement.promote', tool: 'improvement.promote', resource: '/improvement/generations/gen_restart', estimatedCostUsd: 0 };

    let agentSelfApprovalRejected = false;
    try { restarted.approve({ kind: 'agent', agentId: AGENT_ID }, { request }); }
    catch (error) { agentSelfApprovalRejected = error instanceof HttpError && error.status === 403; }
    assert.equal(agentSelfApprovalRejected, true);

    let adminApprovalRejected = false;
    try { restarted.approve({ kind: 'admin', role: 'administrator' }, { request }); }
    catch (error) { adminApprovalRejected = error instanceof HttpError && error.status === 403; }
    assert.equal(adminApprovalRejected, true);

    const approval = restarted.approve(improvementApprover(APPROVER_ROLE), { request, expiresAt: new Date(Date.now() + 600_000).toISOString() }) as { approvalId: string };
    const resolved = authorizeImprovementOperation(restarted, AGENT_ID, 'promote', 'gen_restart', { approvalId: approval.approvalId });
    assert.equal(resolved.decision, 'ALLOW');
    restarted.store.close();
  } finally { cleanup(store, dir); }
});

test('authority ceiling is unchanged after a restart: a write outside the declared envelope scope is still BLOCKed, never widened by re-bootstrapping', () => {
  const { gate, store, dir } = tmpGate();
  try {
    registerImprovementGovernor(gate, AGENT_ID, { approverRole: APPROVER_ROLE });
    const restarted = reopen(dir);
    registerImprovementGovernor(restarted, AGENT_ID, { approverRole: APPROVER_ROLE });

    const writeRequest = { agentId: AGENT_ID, action: 'improvement.invoke_candidate_tool', tool: 'improvement.invoke_candidate_tool', resource: '/improvement/generations/gen_restart/write-target', estimatedCostUsd: 0 };
    const decision = restarted.authorize({ kind: 'agent', agentId: AGENT_ID }, writeRequest);
    assert.equal(decision.decision, 'BLOCK', 'restart bootstrap must re-establish the SAME unwidened envelope, never a wider one');
    restarted.store.close();
  } finally { cleanup(store, dir); }
});

test('a persisted identity that does not match the expected trusted governor shape fails closed rather than being silently reconciled', () => {
  const { gate, store, dir } = tmpGate();
  try {
    // Simulate a genuinely divergent identity: something else registered under this exact agent id with
    // a different name (e.g. a real configuration collision, not this governor's own prior bootstrap) and
    // set its own, unrelated envelope shape.
    const ADMIN = { kind: 'admin' as const, role: 'administrator' };
    gate.register(ADMIN, { id: AGENT_ID, name: 'Some Unrelated Agent' });
    gate.setEnvelope(ADMIN, {
      version: '1.0' as const,
      agent: { id: AGENT_ID, name: 'Some Unrelated Agent', role: 'unrelated', owner: 'someone-else', environment: 'production', expires_at: new Date(Date.now() + 3600_000).toISOString() },
      objective: { task_id: 'unrelated', goal: 'unrelated', allowed_outcomes: ['unrelated outcome'], forbidden_outcomes: [] },
      resources: { repositories: { read: [], write: [] }, files: { read: [], write: [] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
      tools: { allow: ['unrelated.tool'], deny: [] },
      network: { allow: [], deny: ['*'] }, secrets: { allow: [], deny: ['*'] },
      agents: { communicate_with: [], communication_mode: 'authenticated' as const, shared_memory: false as const, deny_unknown_agents: true as const },
      limits: { max_runtime_seconds: 60, max_tool_calls: 1, max_external_requests: 0, max_cost_usd: 1, max_retries_per_action: 1 },
      approvals: { required_for: [] },
      risk: { level: 'low' as const, blast_radius: 'none', rollback_required: false },
      evidence: { capture: ['agent_identity'] as const, retention_days: 1 },
      violation_policy: { unknown_tool: 'block' as const, undeclared_resource: 'block' as const, unauthorized_agent_contact: 'terminate' as const, network_violation: 'terminate' as const, secret_violation: 'terminate_and_rotate' as const, cost_limit_exceeded: 'pause_and_escalate' as const, runtime_limit_exceeded: 'terminate' as const },
      action_bindings: [{ action: 'unrelated.action', outcome: 'unrelated outcome', tool: 'unrelated.tool', resource_kind: 'files' as const, operation: 'read' as const, destination_required: false }],
    });

    const restarted = reopen(dir);
    assert.throws(() => registerImprovementGovernor(restarted, AGENT_ID, { approverRole: APPROVER_ROLE }), /does not match the expected trusted/i);
    restarted.store.close();
  } finally { cleanup(store, dir); }
});

test('a generation created before a restart remains reconstructible/usable after it, per existing v0.1 semantics', () => {
  const { gate, store, dir } = tmpGate();
  const storeDir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-restart-store-test-'));
  const improvementDbPath = resolve(storeDir, 'improvement.sqlite');
  try {
    registerImprovementGovernor(gate, AGENT_ID, { approverRole: APPROVER_ROLE });
    const before = authorizeImprovementOperation(gate, AGENT_ID, 'authorize_generation', 'gen_persist');
    assert.equal(before.decision, 'ALLOW');

    const improvementStore = new ImprovementStore(improvementDbPath);
    const system = improvementStore.createSystem('ten_restart', 'restart-candidate-system', 'candidate-agent');
    const generation = improvementStore.createGeneration({
      tenantId: 'ten_restart', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v1', improvementClass: 'CLASS_2_TOOL',
      specHash: 'spec_hash_restart', sourceHashBefore: 'src_hash_restart',
      authorityProfileBefore: { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 1000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] },
      createdBy: 'candidate-agent',
    });
    improvementStore.close();

    // Real restart: fresh Gate instance over the same file, AND a fresh ImprovementStore instance over
    // the same file — nothing kept in process memory survives, exactly like a container restart.
    const restarted = reopen(dir);
    registerImprovementGovernor(restarted, AGENT_ID, { approverRole: APPROVER_ROLE });
    const reopenedImprovementStore = new ImprovementStore(improvementDbPath);
    try {
      const reconstructed = reopenedImprovementStore.getGeneration('ten_restart', generation.generation_id);
      assert.ok(reconstructed, 'the generation created before restart must still be reconstructible after it');
      assert.equal(reconstructed.generation_id, generation.generation_id);
      assert.equal(reconstructed.spec_hash, 'spec_hash_restart');

      const after = authorizeImprovementOperation(restarted, AGENT_ID, 'authorize_generation', generation.generation_id);
      assert.equal(after.decision, 'ALLOW', 'authorization for a pre-restart generation must still succeed after restart, per existing v0.1 semantics');
    } finally { reopenedImprovementStore.close(); }
    restarted.store.close();
  } finally { cleanup(store, dir); rmSync(storeDir, { recursive: true, force: true }); }
});
