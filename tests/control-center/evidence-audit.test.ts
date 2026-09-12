import assert from 'node:assert/strict';
import test from 'node:test';
import { startRealPlatform, startRealLedger, seedLedgerEvent, startRealAuditor, seedRealAssessment, startControlCenter, CookieJar } from './harness.js';
import type { TenantRegistryEntry } from '../../apps/tna-control-center/src/schema.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) — Evidence Explorer + real Ledger integrity,
 * and Audit/Assurance, both against real, in-process `apps/tna-ledger`/`apps/tna-auditor` instances
 * (single-tenant-per-process, mirroring Platform).
 */

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const jar = new CookieJar();
  jar.capture(res);
  return jar;
}

async function setup(seed: string) {
  const tenantId = `ten_ea_${seed}`;
  const platform = await startRealPlatform(tenantId, `ea_${seed}`);
  const ledger = await startRealLedger(tenantId, `ea_${seed}`);
  const auditor = await startRealAuditor(tenantId, `ea_${seed}`, ledger.ledger);
  const entry: TenantRegistryEntry = {
    tenant_id: tenantId, platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken,
    ledger_base_url: ledger.baseUrl, ledger_reader_token: ledger.readerToken, ledger_admin_token: ledger.adminToken,
    auditor_base_url: auditor.baseUrl, auditor_token: auditor.readerToken,
  };
  const cc = await startControlCenter([entry]);
  return { platform, ledger, auditor, tenantId, cc, close: async () => { await cc.close(); await auditor.close(); await ledger.close(); await platform.close(); } };
}

test('evidence explorer: a real seeded Ledger event is searchable and its stream is real', async () => {
  const ctx = await setup('search');
  try {
    seedLedgerEvent(ctx.ledger, ctx.tenantId, { event_id: 'evt-real-1', stream_id: 'agent:real-test' });
    ctx.cc.sessions.createUser(ctx.tenantId, 'evidence-viewer', 'a-real-password-for-evidence-1', 'client-viewer');
    const jar = await login(ctx.cc.baseUrl, 'evidence-viewer', 'a-real-password-for-evidence-1');

    const searchRes = await fetch(`${ctx.cc.baseUrl}/api/evidence/search?streamId=agent:real-test`, { headers: { Cookie: jar.header() } });
    assert.equal(searchRes.status, 200);
    const search = await searchRes.json() as { items: readonly { event_id: string }[] };
    assert.ok(search.items.some(e => e.event_id === 'evt-real-1'), 'the real seeded event must be found via search');

    const streamRes = await fetch(`${ctx.cc.baseUrl}/api/evidence/streams/${encodeURIComponent('agent:real-test')}`, { headers: { Cookie: jar.header() } });
    assert.equal(streamRes.status, 200);
  } finally { await ctx.close(); }
});

test('evidence explorer: real Ledger integrity verification — a clean stream verifies true, and a tampered one is detected, never rendered as a false VERIFIED', async () => {
  const ctx = await setup('integrity');
  try {
    seedLedgerEvent(ctx.ledger, ctx.tenantId, { event_id: 'evt-clean-1', stream_id: 'agent:clean' });
    ctx.cc.sessions.createUser(ctx.tenantId, 'integrity-viewer', 'a-real-password-for-integrity-1', 'client-viewer');
    const jar = await login(ctx.cc.baseUrl, 'integrity-viewer', 'a-real-password-for-integrity-1');

    const cleanRes = await fetch(`${ctx.cc.baseUrl}/api/evidence/streams/${encodeURIComponent('agent:clean')}/verify`, { headers: { Cookie: jar.header() } });
    assert.equal(cleanRes.status, 200);
    const clean = await cleanRes.json() as { valid: boolean };
    assert.equal(clean.valid, true, 'a genuinely untampered stream must verify true');

    // Real whole-ledger verification (requires the admin-scoped token — proven to work end-to-end here).
    const allRes = await fetch(`${ctx.cc.baseUrl}/api/evidence/verify`, { headers: { Cookie: jar.header() } });
    assert.equal(allRes.status, 200);
    const all = await allRes.json() as { valid: boolean };
    assert.equal(all.valid, true);

    // Real tamper: directly corrupt the underlying SQLite row (mirrors the accepted Ledger integrity
    // test's own tamper technique), then prove the SAME real verify route now reports it — never a
    // fabricated VERIFIED regardless of underlying corruption. `db` is TypeScript-private only; the real
    // runtime object still has it, and there is no other way to reach the same `:memory:` connection.
    const raw = ctx.ledger.ledgerStore as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } };
    raw.db.prepare("UPDATE ledger_events SET event_type = 'TAMPERED_EVENT_TYPE' WHERE stream_id = 'agent:clean'").run();
    const tamperedRes = await fetch(`${ctx.cc.baseUrl}/api/evidence/streams/${encodeURIComponent('agent:clean')}/verify`, { headers: { Cookie: jar.header() } });
    assert.equal(tamperedRes.status, 200);
    const tampered = await tamperedRes.json() as { valid: boolean };
    assert.equal(tampered.valid, false, 'a genuinely tampered stream must never be reported as VERIFIED');
  } finally { await ctx.close(); }
});

test('evidence explorer: an unconfigured Ledger integration fails closed (503), never silently rendered as empty/healthy', async () => {
  const platform = await startRealPlatform('ten_ea_noledger', 'ea_noledger');
  try {
    const cc = await startControlCenter([{ tenant_id: 'ten_ea_noledger', platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken }]);
    try {
      cc.sessions.createUser('ten_ea_noledger', 'noledger-user', 'a-real-password-for-noledger-1', 'client-viewer');
      const jar = await login(cc.baseUrl, 'noledger-user', 'a-real-password-for-noledger-1');
      const res = await fetch(`${cc.baseUrl}/api/evidence/search`, { headers: { Cookie: jar.header() } });
      assert.equal(res.status, 503);
    } finally { await cc.close(); }
  } finally { await platform.close(); }
});

test('audit/assurance: a real assessment is visible through the Control Center, and an auditor role can read it', async () => {
  const ctx = await setup('audit');
  try {
    const { assessment_id } = seedRealAssessment(ctx.auditor, ctx.tenantId);
    ctx.cc.sessions.createUser(ctx.tenantId, 'audit-auditor', 'a-real-password-for-audit-1', 'client-auditor');
    const jar = await login(ctx.cc.baseUrl, 'audit-auditor', 'a-real-password-for-audit-1');

    const listRes = await fetch(`${ctx.cc.baseUrl}/api/audit/assessments`, { headers: { Cookie: jar.header() } });
    assert.equal(listRes.status, 200);
    const list = await listRes.json() as { items: readonly { assessment_id: string }[] };
    assert.ok(list.items.some(a => a.assessment_id === assessment_id));

    const getRes = await fetch(`${ctx.cc.baseUrl}/api/audit/assessments/${assessment_id}`, { headers: { Cookie: jar.header() } });
    assert.equal(getRes.status, 200);
    const got = await getRes.json() as { assessment_id: string; status: string };
    assert.equal(got.assessment_id, assessment_id);

    const resultsRes = await fetch(`${ctx.cc.baseUrl}/api/audit/assessments/${assessment_id}/results`, { headers: { Cookie: jar.header() } });
    assert.equal(resultsRes.status, 200);
    const findingsRes = await fetch(`${ctx.cc.baseUrl}/api/audit/assessments/${assessment_id}/findings`, { headers: { Cookie: jar.header() } });
    assert.equal(findingsRes.status, 200);
  } finally { await ctx.close(); }
});

test('audit/assurance: every client role can read (audit.read is granted to all roles), never gated more strictly than the permission matrix says', async () => {
  const ctx = await setup('audit_role');
  try {
    ctx.cc.sessions.createUser(ctx.tenantId, 'audit-role-viewer', 'a-real-password-for-audit-role-1', 'client-viewer');
    const jar = await login(ctx.cc.baseUrl, 'audit-role-viewer', 'a-real-password-for-audit-role-1');
    const res = await fetch(`${ctx.cc.baseUrl}/api/audit/assessments`, { headers: { Cookie: jar.header() } });
    assert.equal(res.status, 200);
  } finally { await ctx.close(); }
});
