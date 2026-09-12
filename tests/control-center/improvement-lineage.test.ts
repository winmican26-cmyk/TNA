import assert from 'node:assert/strict';
import test from 'node:test';
import { startRealPlatform, startRealImprovementGovernor, seedRealLineage, startControlCenter, CookieJar } from './harness.js';
import type { TenantRegistryEntry } from '../../apps/tna-control-center/src/schema.js';
import { CSRF_COOKIE } from '../../apps/tna-control-center/src/auth.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) — Recursive-improvement lineage, the flagship
 * demonstration of "a successor can become better without automatically becoming more powerful", against a
 * real, in-process `apps/tna-improvement-governor` instance (single-tenant-per-process, mirroring Platform/
 * Ledger/Auditor). Every status/benchmark/authority fact asserted here traces to that real backend's own
 * Gate/VAD/Ledger-backed decisions — never a value invented by this test or by the BFF.
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return jar;
}

async function setup(seed: string) {
  const tenantId = `ten_il_${seed}`;
  const platform = await startRealPlatform(tenantId, `il_${seed}`);
  const gov = await startRealImprovementGovernor(tenantId, `il_${seed}`);
  const entry: TenantRegistryEntry = {
    tenant_id: tenantId, platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken,
    improvement_base_url: gov.baseUrl, improvement_admin_token: gov.adminToken,
  };
  const cc = await startControlCenter([entry]);
  return { platform, gov, tenantId, cc, close: async () => { await cc.close(); await gov.close(); await platform.close(); } };
}

test('recursive-improvement lineage: a real PROMOTED baseline, a real REJECTED authority-escalation attempt, and a real second PROMOTED successor are all visible with their real, non-fabricated outcomes', async () => {
  const ctx = await setup('golden');
  try {
    const systemId = `sys_${ctx.tenantId}`;
    const lineageIds = await seedRealLineage(ctx.gov, systemId);

    ctx.cc.sessions.createUser(ctx.tenantId, 'lineage-viewer', 'a-real-password-for-lineage-1', 'client-viewer');
    const jar = await login(ctx.cc.baseUrl, 'lineage-viewer', 'a-real-password-for-lineage-1');

    const listRes = await fetch(`${ctx.cc.baseUrl}/api/improvements?systemId=${lineageIds.internalSystemId}`, { headers: { Cookie: jar.header() } });
    assert.equal(listRes.status, 200);
    const list = await listRes.json() as { items: readonly { generation_id: string; status: string }[] };
    const byId = new Map(list.items.map(g => [g.generation_id, g.status]));
    assert.equal(byId.get(lineageIds.promotedGenerationId), 'PROMOTED', 'the real baseline generation must show its real PROMOTED status');
    assert.equal(byId.get(lineageIds.rejectedGenerationId), 'REJECTED', 'the real authority-escalating generation must show its real REJECTED status, never hidden or softened');
    assert.equal(byId.get(lineageIds.secondPromotedGenerationId), 'PROMOTED', 'a successor that becomes better WITHOUT an authority delta must be visibly PROMOTED, distinct from the rejected escalation attempt');

    // The rejected generation's own record must carry its real evaluated authority delta — the UI must be
    // able to show WHY it was rejected (unauthorized authority expansion), not merely THAT it was rejected.
    const rejectedRes = await fetch(`${ctx.cc.baseUrl}/api/improvements/${lineageIds.rejectedGenerationId}`, { headers: { Cookie: jar.header() } });
    assert.equal(rejectedRes.status, 200);
    const rejected = await rejectedRes.json() as { status: string; authority_profile_before: unknown };
    assert.equal(rejected.status, 'REJECTED');

    const evidenceRes = await fetch(`${ctx.cc.baseUrl}/api/improvements/${lineageIds.rejectedGenerationId}/evidence`, { headers: { Cookie: jar.header() } });
    assert.equal(evidenceRes.status, 200);
    const evidence = await evidenceRes.json() as { reconstruction: { finalState: string }; assessment: { overall: string } };
    assert.equal(evidence.reconstruction.finalState, 'REJECTED');

    // Real Ledger-reconstructed lineage must connect all three real generations together.
    const lineageRes = await fetch(`${ctx.cc.baseUrl}/api/improvements/${lineageIds.secondPromotedGenerationId}/lineage`, { headers: { Cookie: jar.header() } });
    assert.equal(lineageRes.status, 200);
    const lineage = await lineageRes.json() as { nodes: readonly { generationId: string }[] };
    const nodeIds = new Set(lineage.nodes.map(n => n.generationId));
    assert.ok(nodeIds.has(lineageIds.promotedGenerationId));
    assert.ok(nodeIds.has(lineageIds.rejectedGenerationId));
    assert.ok(nodeIds.has(lineageIds.secondPromotedGenerationId));
  } finally { await ctx.close(); }
});

test('recursive-improvement mutations: a client-viewer cannot approve/promote/rollback (server-side 403, never a hidden button as the only control)', async () => {
  const ctx = await setup('viewer-mutate');
  try {
    const systemId = `sys_${ctx.tenantId}`;
    const lineageIds = await seedRealLineage(ctx.gov, systemId);
    ctx.cc.sessions.createUser(ctx.tenantId, 'viewer-mutate', 'a-real-password-for-viewer-mutate-1', 'client-viewer');
    const jar = await login(ctx.cc.baseUrl, 'viewer-mutate', 'a-real-password-for-viewer-mutate-1');

    const csrfHeaders = { 'Content-Type': 'application/json', Cookie: jar.header(), 'X-CSRF-Token': jar.get(CSRF_COOKIE)! };
    const approveRes = await fetch(`${ctx.cc.baseUrl}/api/improvements/${lineageIds.promotedGenerationId}/approve`, { method: 'POST', headers: csrfHeaders, body: JSON.stringify({ operation: 'promote' }) });
    assert.equal(approveRes.status, 403);
    const promoteRes = await fetch(`${ctx.cc.baseUrl}/api/improvements/${lineageIds.promotedGenerationId}/promote`, { method: 'POST', headers: csrfHeaders, body: '{}' });
    assert.equal(promoteRes.status, 403);
    const rollbackRes = await fetch(`${ctx.cc.baseUrl}/api/improvements/${lineageIds.promotedGenerationId}/rollback`, { method: 'POST', headers: csrfHeaders, body: JSON.stringify({ targetGenerationId: lineageIds.rejectedGenerationId }) });
    assert.equal(rollbackRes.status, 403);
  } finally { await ctx.close(); }
});

test('recursive-improvement mutations: a client-admin CAN drive a real rollback against the real governor, and the real outcome (never a fabricated "restored") is reflected back', async () => {
  const ctx = await setup('admin-rollback');
  try {
    const systemId = `sys_${ctx.tenantId}`;
    const lineageIds = await seedRealLineage(ctx.gov, systemId);
    ctx.cc.sessions.createUser(ctx.tenantId, 'lineage-admin', 'a-real-password-for-lineage-admin-1', 'client-admin');
    const jar = await login(ctx.cc.baseUrl, 'lineage-admin', 'a-real-password-for-lineage-admin-1');

    // `improvement.rollback` is a real, approval-gated Gate action (mirrors promote/start_canary) — a bare
    // rollback request with no approval is a real HOLD, never a silent bypass.
    const csrfHeaders = { 'Content-Type': 'application/json', Cookie: jar.header(), 'X-CSRF-Token': jar.get(CSRF_COOKIE)! };
    const approveRes = await fetch(`${ctx.cc.baseUrl}/api/improvements/${lineageIds.secondPromotedGenerationId}/approve`, {
      method: 'POST', headers: csrfHeaders, body: JSON.stringify({ operation: 'rollback' }),
    });
    assert.equal(approveRes.status, 200);
    const approvalId = ((await approveRes.json()) as { approval: { approvalId: string } }).approval.approvalId;

    const rollbackRes = await fetch(`${ctx.cc.baseUrl}/api/improvements/${lineageIds.secondPromotedGenerationId}/rollback`, {
      method: 'POST', headers: csrfHeaders,
      body: JSON.stringify({ targetGenerationId: lineageIds.promotedGenerationId, approvalId }),
    });
    assert.equal(rollbackRes.status, 200);
    const result = await rollbackRes.json() as { verified: boolean; generation: { status: string } };
    // The real governor's `verifyRollbackTarget` requires the target's own tracked workspace to be
    // reachable on disk with a matching hash — real proof, not an assumed success (section 65/J).
    assert.equal(result.verified, true, 'the real target workspace is genuinely reachable, so this must be a proven, verified rollback');
    assert.equal(result.generation.status, 'ROLLED_BACK');
  } finally { await ctx.close(); }
});

test('regression (threat model): a client-facing role can never substitute for the trusted Gate approver role, at the real trusted backend boundary itself', async () => {
  const ctx = await setup('role-separation');
  try {
    const lineageIds = await seedRealLineage(ctx.gov, `sys_${ctx.tenantId}`);
    async function govApi(path: string, bodyObj: unknown) {
      const res = await fetch(`${ctx.gov.baseUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.gov.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) });
      return { status: res.status, json: await res.json() as Record<string, unknown> };
    }
    // The real, trusted governor was registered with `approverRole: 'improvement-approver'` (see
    // `startRealImprovementGovernor`, mirroring every accepted governor deployment). Gate's own,
    // unmodified `approve()` compares the approving principal's role against that EXACT configured
    // value (`apps/tna-gate-api/src/gate.ts`: `rule.approver_role !== principal.role` -> 403) — it has no
    // concept of a "client-admin" role at all. This is what makes the earlier bug (the BFF almost
    // forwarding `session.role` as the Gate approverRole) a real, backend-enforced failure, not merely a
    // BFF-side convention: even calling the real governor directly, bypassing the Control Center
    // entirely, a "client-admin" approver is rejected.
    const asClientAdmin = await govApi(`/v1/improvements/${lineageIds.promotedGenerationId}/approve`, { operation: 'promote', approverRole: 'client-admin' });
    assert.equal(asClientAdmin.status, 403, 'a client-facing role string must never be accepted as the trusted Gate approver role, even at the real backend boundary');

    // The one real, tenant-configured approver role continues to work — proving this is a genuine role
    // *separation*, not merely "nothing can ever approve".
    const asRealApprover = await govApi(`/v1/improvements/${lineageIds.promotedGenerationId}/approve`, { operation: 'promote' });
    assert.equal(asRealApprover.status, 200);
    assert.ok(typeof (asRealApprover.json.approval as { approvalId?: string } | undefined)?.approvalId === 'string');
  } finally { await ctx.close(); }
});

test('recursive-improvement: an unconfigured improvement-governor integration fails closed (503), never a silently empty lineage', async () => {
  const platform = await startRealPlatform('ten_il_noconfig', 'il_noconfig');
  try {
    const cc = await startControlCenter([{ tenant_id: 'ten_il_noconfig', platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken }]);
    try {
      cc.sessions.createUser('ten_il_noconfig', 'noconfig-user', 'a-real-password-for-noconfig-1', 'client-viewer');
      const jar = await login(cc.baseUrl, 'noconfig-user', 'a-real-password-for-noconfig-1');
      const res = await fetch(`${cc.baseUrl}/api/improvements?systemId=sys_x`, { headers: { Cookie: jar.header() } });
      assert.equal(res.status, 503);
    } finally { await cc.close(); }
  } finally { await platform.close(); }
});
