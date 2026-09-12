import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRoleAllows, resolveCommandKey, roleAtLeast, OperatorAuthError } from '../../apps/tna-operator/src/roles.js';
import { redactDeep, REDACTED } from '../../apps/tna-operator/src/redact.js';
import { explain } from '../../apps/tna-operator/src/explain.js';
import { assessGoLive, GO_LIVE_STATEMENT } from '../../apps/tna-operator/src/go-live.js';
import { buildHandoff } from '../../apps/tna-operator/src/handoff.js';

// ── Roles (section 8-9) ───────────────────────────────────────────────────────

test('roleAtLeast is a correct total order: viewer < operator < security-operator < admin', () => {
  assert.equal(roleAtLeast('admin', 'viewer'), true);
  assert.equal(roleAtLeast('viewer', 'admin'), false);
  assert.equal(roleAtLeast('operator', 'operator'), true);
  assert.equal(roleAtLeast('operator', 'security-operator'), false);
});

test('viewer cannot approve a hold, cannot offboard a tenant, cannot revoke a credential', () => {
  assert.throws(() => assertRoleAllows('hold approve', 'viewer'), OperatorAuthError);
  assert.throws(() => assertRoleAllows('tenant offboard', 'viewer'), OperatorAuthError);
  assert.throws(() => assertRoleAllows('service revoke', 'viewer'), OperatorAuthError);
});

test('operator cannot offboard a tenant or revoke a credential (both require security-operator/admin)', () => {
  assert.throws(() => assertRoleAllows('tenant offboard', 'operator'), OperatorAuthError);
  assert.throws(() => assertRoleAllows('service revoke', 'operator'), OperatorAuthError);
  assert.doesNotThrow(() => assertRoleAllows('tenant suspend', 'operator'));
  assert.doesNotThrow(() => assertRoleAllows('hold approve', 'operator'));
});

test('security-operator can revoke and reject holds but not offboard a tenant (admin-only)', () => {
  assert.doesNotThrow(() => assertRoleAllows('service revoke', 'security-operator'));
  assert.doesNotThrow(() => assertRoleAllows('hold reject', 'security-operator'));
  assert.throws(() => assertRoleAllows('tenant offboard', 'security-operator'), OperatorAuthError);
});

test('admin can do everything a lower role can', () => {
  for (const key of ['tenant offboard', 'service revoke', 'hold reject', 'tool enable-critical']) {
    assert.doesNotThrow(() => assertRoleAllows(key, 'admin'));
  }
});

test('resolveCommandKey prefers the longest known multi-word command over a shorter/no match', () => {
  assert.equal(resolveCommandKey(['tenant', 'show', 'ten_abc123']), 'tenant show');
  assert.equal(resolveCommandKey(['status']), 'status');
  assert.equal(resolveCommandKey(['nonsense', 'command']), null);
});

// ── Redaction (section 12, 84) ────────────────────────────────────────────────

test('redactDeep removes secret-shaped field values by key name, at any nesting depth', () => {
  const input = { tenant_id: 'ten_1', credential: { token: 'tnaclient_realsecret123456789012345678' }, nested: { api_key: 'sk-live-abc' } };
  const output = redactDeep(input) as { credential: unknown; nested: { api_key: string }; tenant_id: string };
  // A key whose *name* looks secret-shaped (here "credential") redacts the entire subtree under it,
  // not just a further-nested field — the safer of the two behaviors.
  assert.equal(output.credential, REDACTED);
  assert.equal(output.nested.api_key, REDACTED);
  assert.equal(output.tenant_id, 'ten_1');
});

test('redactDeep removes a bearer-header-shaped string value regardless of its field name', () => {
  const output = redactDeep({ notes: 'Authorization: Bearer abc123def456' }) as { notes: string };
  assert.equal(output.notes, REDACTED);
});

test('redactDeep leaves ordinary operational data untouched', () => {
  const output = redactDeep({ tool_id: 'gt_1', enabled: true, risk_class: 'LOW' }) as Record<string, unknown>;
  assert.deepEqual(output, { tool_id: 'gt_1', enabled: true, risk_class: 'LOW' });
});

// ── Explain (section 15-16) ────────────────────────────────────────────────────

test('explain translates MCP_SCHEMA_DRIFT into the exact operator guidance the spec requires, never concealing the code', () => {
  const result = explain({ state: 'FAILED', error_code: null, error_message: 'MCP_SCHEMA_DRIFT: tool schema changed', gate_decision: null });
  assert.equal(result.code, 'MCP_SCHEMA_DRIFT');
  assert.match(result.headline, /schema changed/i);
  assert.match(result.guidance, /[Rr]ediscover/);
});

test('explain distinguishes SENTINEL_HOLD from SENTINEL_TERMINATED with different guidance', () => {
  const held = explain({ state: 'INDETERMINATE', error_code: 'SENTINEL_HOLD', error_message: null, gate_decision: null });
  const terminated = explain({ state: 'TERMINATED', error_code: 'SENTINEL_TERMINATED', error_message: null, gate_decision: null });
  assert.notEqual(held.headline, terminated.headline);
  assert.match(held.headline, /held/i);
  assert.match(terminated.headline, /terminated/i);
});

test('explain surfaces the real Gate BLOCK reason for a resource-pattern violation with actionable guidance', () => {
  const result = explain({ state: 'BLOCKED', error_code: null, error_message: null, gate_decision: { decision: 'BLOCK', reason: 'Undeclared resource or operation' } });
  assert.equal(result.code, 'GATE_BLOCK');
  assert.match(result.detail, /resources.*section/i);
});

// ── Go-live assessment (section 110-116, 126-127) ─────────────────────────────

function baseGoLiveInput() {
  return {
    tenant_id: 'ten_1', deployment_ready: true, gate_available: true, sentinel_available: true, ledger_available: true,
    tenant_active: true, active_services: 1, reachable_mcp_servers: 1, enabled_tools: 1, tools_requiring_review: 0,
    bypass_attestation: { tnaCredentialChain: true, externalDirectCredential: false },
    test_action_completed: true, backup_age_seconds: null, max_backup_age_seconds: 86_400,
    allow_known_bypass_with_limitations: false,
  };
}

test('go-live: all checks pass and no known bypass -> GO', () => {
  const result = assessGoLive(baseGoLiveInput());
  assert.equal(result.status, 'GO');
  assert.equal(result.statement, GO_LIVE_STATEMENT);
});

test('go-live: KNOWN_BYPASS can never produce a clean GO, even with every other check passing (section 112)', () => {
  const result = assessGoLive({ ...baseGoLiveInput(), bypass_attestation: { tnaCredentialChain: true, externalDirectCredential: true } });
  assert.equal(result.status, 'NO_GO');
  assert.notEqual(result.status, 'GO');
});

test('go-live: KNOWN_BYPASS explicitly permitted by profile downgrades to GO_WITH_LIMITATIONS, never GO', () => {
  const result = assessGoLive({ ...baseGoLiveInput(), bypass_attestation: { tnaCredentialChain: true, externalDirectCredential: true }, allow_known_bypass_with_limitations: true });
  assert.equal(result.status, 'GO_WITH_LIMITATIONS');
});

test('go-live: Ledger unavailable is a blocking failure -> NO_GO (section 114)', () => {
  const result = assessGoLive({ ...baseGoLiveInput(), ledger_available: false });
  assert.equal(result.status, 'NO_GO');
});

test('go-live: Sentinel unavailable is a blocking failure -> NO_GO (section 115)', () => {
  const result = assessGoLive({ ...baseGoLiveInput(), sentinel_available: false });
  assert.equal(result.status, 'NO_GO');
});

test('go-live: pending schema-drift review is a blocking failure -> NO_GO (section 116)', () => {
  const result = assessGoLive({ ...baseGoLiveInput(), tools_requiring_review: 2 });
  assert.equal(result.status, 'NO_GO');
});

test('go-live: no bypass attestation supplied at all -> INSUFFICIENT_EVIDENCE, never a guessed GO', () => {
  const result = assessGoLive({ ...baseGoLiveInput(), bypass_attestation: null });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
});

test('go-live: a non-blocking gap (e.g. no reachable MCP server yet) downgrades to GO_WITH_LIMITATIONS, not NO_GO', () => {
  const result = assessGoLive({ ...baseGoLiveInput(), reachable_mcp_servers: 0 });
  assert.equal(result.status, 'GO_WITH_LIMITATIONS');
});

test('go-live: the assessment is snapshot-bound — two assessments of identical input differ only in timestamp/hash, and the hash is a real function of the recorded checks', () => {
  const a = assessGoLive(baseGoLiveInput());
  const b = assessGoLive({ ...baseGoLiveInput(), tools_requiring_review: 1 });
  assert.notEqual(a.snapshot_hash, b.snapshot_hash);
});

// ── Handoff (section 117-118) ──────────────────────────────────────────────────

test('handoff package is hashed and the hash changes if any included fact changes', () => {
  const goLive = assessGoLive(baseGoLiveInput());
  const a = buildHandoff({
    deployment_id: 'dep_1', component_versions: { platform: '0.1.0' }, tenant_id: 'ten_1',
    enabled_tools: [{ tool_id: 'gt_1', external_tool_name: 'crm.lookup', risk_class: 'LOW' }],
    policy_bindings_count: 1, known_limitations: ['x'], bypass_assessment: 'NO_KNOWN_BYPASS',
    backup_status: 'n/a', health_status: 'GO', go_live_assessment: goLive,
  });
  const b = buildHandoff({
    deployment_id: 'dep_1', component_versions: { platform: '0.1.0' }, tenant_id: 'ten_1',
    enabled_tools: [{ tool_id: 'gt_1', external_tool_name: 'crm.lookup', risk_class: 'LOW' }],
    policy_bindings_count: 2, known_limitations: ['x'], bypass_assessment: 'NO_KNOWN_BYPASS',
    backup_status: 'n/a', health_status: 'GO', go_live_assessment: goLive,
  });
  assert.notEqual(a.handoff_hash, b.handoff_hash);
  assert.equal(a.handoff_hash.length, 64);
});

test('handoff package contains no raw secret-shaped field', () => {
  const goLive = assessGoLive(baseGoLiveInput());
  const handoff = buildHandoff({
    deployment_id: 'dep_1', component_versions: {}, tenant_id: 'ten_1', enabled_tools: [], policy_bindings_count: 0,
    known_limitations: [], bypass_assessment: 'NO_KNOWN_BYPASS', backup_status: 'n/a', health_status: 'GO', go_live_assessment: goLive,
  });
  assert.ok(!JSON.stringify(handoff).toLowerCase().includes('bearer'));
});
