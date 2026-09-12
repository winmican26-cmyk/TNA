import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Gate, HttpError } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import {
  registerImprovementGovernor, authorizeImprovementOperation, expandGovernorWriteAccess, improvementApprover,
} from '../../packages/improvement-core/src/gate-integration.js';
import { ImprovementStore } from '../../packages/improvement-store/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section A-B: real Gate integration. Every
 * decision in this file comes from the actual, unmodified, accepted `Gate` class — never a fabricated
 * object shaped like a Gate decision.
 */

const AGENT_ID = 'improvement-governor-test';
const APPROVER_ROLE = 'improvement-approver';

function tmpGate(): { gate: Gate; store: Store; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-gate-test-'));
  const store = new Store(resolve(dir, 'gate.sqlite'));
  const gate = new Gate(store);
  return { gate, store, dir };
}
function cleanup(store: Store, dir: string): void { store.close(); rmSync(dir, { recursive: true, force: true }); }

test('a non-consequential improvement operation (build) is authorized directly against the governor\'s own envelope', () => {
  const { gate, store, dir } = tmpGate();
  try {
    registerImprovementGovernor(gate, AGENT_ID, { approverRole: APPROVER_ROLE });
    const decision = authorizeImprovementOperation(gate, AGENT_ID, 'build', 'gen_1');
    assert.equal(decision.decision, 'ALLOW');
  } finally { cleanup(store, dir); }
});

test('a consequential operation (promote) requires real approval — HOLD on first submission, and neither the governor agent nor an admin can approve it themselves', () => {
  const { gate, store, dir } = tmpGate();
  try {
    registerImprovementGovernor(gate, AGENT_ID, { approverRole: APPROVER_ROLE });
    const held = authorizeImprovementOperation(gate, AGENT_ID, 'promote', 'gen_1');
    assert.equal(held.decision, 'HOLD');

    const request = { agentId: AGENT_ID, action: 'improvement.promote', tool: 'improvement.promote', resource: '/improvement/generations/gen_1', estimatedCostUsd: 0 };
    let agentSelfApprovalRejected = false;
    try { gate.approve({ kind: 'agent', agentId: AGENT_ID }, { request }); }
    catch (error) { agentSelfApprovalRejected = error instanceof HttpError && error.status === 403; }
    assert.equal(agentSelfApprovalRejected, true, 'the governor agent itself must never be able to approve its own promotion');

    let adminApprovalRejected = false;
    try { gate.approve({ kind: 'admin', role: 'administrator' }, { request }); }
    catch (error) { adminApprovalRejected = error instanceof HttpError && error.status === 403; }
    assert.equal(adminApprovalRejected, true, 'an admin credential must never substitute for a distinct approver role');

    const approval = gate.approve(improvementApprover(APPROVER_ROLE), { request, expiresAt: new Date(Date.now() + 600_000).toISOString() }) as { approvalId: string };
    const resolved = authorizeImprovementOperation(gate, AGENT_ID, 'promote', 'gen_1', { approvalId: approval.approvalId });
    assert.equal(resolved.decision, 'ALLOW');
  } finally { cleanup(store, dir); }
});

test('a wrong-role approver cannot approve a promotion meant for a different approver role', () => {
  const { gate, store, dir } = tmpGate();
  try {
    registerImprovementGovernor(gate, AGENT_ID, { approverRole: APPROVER_ROLE });
    authorizeImprovementOperation(gate, AGENT_ID, 'rollback', 'gen_1');
    const request = { agentId: AGENT_ID, action: 'improvement.rollback', tool: 'improvement.rollback', resource: '/improvement/generations/gen_1', estimatedCostUsd: 0 };
    let rejected = false;
    try { gate.approve(improvementApprover('some-unrelated-role'), { request, expiresAt: new Date(Date.now() + 600_000).toISOString() }); }
    catch (error) { rejected = error instanceof HttpError && error.status === 403; }
    assert.equal(rejected, true);
  } finally { cleanup(store, dir); }
});

test('mandatory proof: a candidate\'s authority-expansion request never itself grants authority — Gate BLOCKs the same write action before AND after the request exists, and only ALLOWs once a trusted approver decides it AND the governor envelope is separately, explicitly widened', () => {
  const { gate, store, dir } = tmpGate();
  const storeDir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-expansion-test-'));
  const improvementStore = new ImprovementStore(resolve(storeDir, 'improvement.sqlite'));
  try {
    registerImprovementGovernor(gate, AGENT_ID, { approverRole: APPROVER_ROLE }); // writableResourcePatterns defaults to []
    const writeRequest = { agentId: AGENT_ID, action: 'improvement.invoke_candidate_tool', tool: 'improvement.invoke_candidate_tool', resource: '/improvement/generations/gen_1/write-target', estimatedCostUsd: 0 };

    const beforeRequest = gate.authorize({ kind: 'agent', agentId: AGENT_ID }, writeRequest);
    assert.equal(beforeRequest.decision, 'BLOCK', 'a write outside the declared envelope scope is a real BLOCK, not a HOLD — there is no approval rule for it at all');

    // The candidate raises a real AuthorityExpansionRequest — this is data, not authority.
    const system = improvementStore.createSystem('ten_a', 'candidate-system', 'candidate-agent');
    const generation = improvementStore.createGeneration({
      tenantId: 'ten_a', systemId: system.system_id, parentGenerationId: null, candidateVersion: 'v1', improvementClass: 'CLASS_2_TOOL',
      specHash: 'spec_hash_1', sourceHashBefore: 'src_hash_1',
      authorityProfileBefore: { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 1000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [] },
      createdBy: 'candidate-agent',
    });
    const expansionRequest = improvementStore.createAuthorityExpansionRequest({
      tenantId: 'ten_a', generationId: generation.generation_id,
      requestedDelta: { added_operations: ['write'], added_tools: [], added_resources: [], added_destinations: [], added_filesystem_scope: ['/improvement/generations/gen_1/write-target'], added_credentials: [], removed_operations: [], removed_tools: [], removed_resources: [], network_access_gained: false, external_side_effects_gained: false, budget_increased: false, runtime_increased: false, parallelism_increased: false, is_expansion: true, is_reduction: false, delta_hash: 'delta_hash_1' },
      reason: 'need to write generated output', risk: 'MEDIUM', requestedBy: 'candidate-agent',
    });
    assert.equal(expansionRequest.status, 'PENDING');

    // The mere existence of a PENDING request changes nothing about Gate's own decision.
    const stillBlocked = gate.authorize({ kind: 'agent', agentId: AGENT_ID }, writeRequest);
    assert.equal(stillBlocked.decision, 'BLOCK', 'a PENDING authority-expansion request must never itself be treated as authority by Gate');

    // A trusted approver decides the request — this ALSO changes nothing about Gate directly (structural
    // proof below: ImprovementStore has no import of Gate at all).
    const decided = improvementStore.decideAuthorityExpansionRequest('ten_a', expansionRequest.request_id, expansionRequest.state_version, 'APPROVED', 'trusted-human-approver', 'reviewed and safe');
    assert.equal(decided.status, 'APPROVED');
    const stillBlockedAfterApproval = gate.authorize({ kind: 'agent', agentId: AGENT_ID }, writeRequest);
    assert.equal(stillBlockedAfterApproval.decision, 'BLOCK', 'approving the request in the store alone must never widen Gate authority — only a separate, explicit Gate envelope change can');

    // Only the separate, explicit, trusted governor action actually widens Gate's own envelope.
    expandGovernorWriteAccess(gate, AGENT_ID, { approverRole: APPROVER_ROLE, writableResourcePatterns: ['/improvement/generations/gen_1/**'] });
    const nowAllowed = gate.authorize({ kind: 'agent', agentId: AGENT_ID }, writeRequest);
    assert.equal(nowAllowed.decision, 'ALLOW');
  } finally {
    cleanup(store, dir);
    improvementStore.close();
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('structural proof: improvement-store never imports Gate — an authority-expansion decision cannot itself reach Gate through any code path', () => {
  const storeSource = readFileSync(fileURLToPath(new URL('../../../packages/improvement-store/src/index.ts', import.meta.url)), 'utf8');
  const importLines = storeSource.split('\n').filter(line => line.trim().startsWith('import'));
  for (const forbidden of ['tna-gate-api', '/gate.js', 'gate-integration']) {
    assert.ok(!importLines.some(line => line.includes(forbidden)), `improvement-store must not import ${forbidden}`);
  }
});
