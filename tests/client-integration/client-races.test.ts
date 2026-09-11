import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientStore } from '../../packages/client-core/src/index.js';
import {
  ClientError, validateClientTenantCreateInput, validateServiceIdentityCreateInput,
} from '../../packages/client-schema/src/index.js';
import {
  validateMcpServerRegisterInput, hashSchema, type DiscoveredMcpTool,
} from '../../packages/mcp-schema/src/index.js';

function makeStore() { return new ClientStore(':memory:'); }

function setupFullTenant(store: ClientStore) {
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: 'Race Co', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  const active = store.activateTenant(tenant.tenant_id, tenant.state_version);
  const { identity, credential } = store.createServiceIdentity(active.tenant_id,
    validateServiceIdentityCreateInput({ name: 'Agent', role: 'agent-client' }), 'admin_1');
  const server = store.registerMcpServer(active.tenant_id, validateMcpServerRegisterInput({
    name: 'CRM', transport: 'stdio', executable: 'node',
    args: ['crm.js'], env_allowlist: [], credential_ref: null,
  }), 'admin_1');
  const discovered: DiscoveredMcpTool = { name: 'crm.lookup', description: 'Lookup', input_schema: { type: 'object' } };
  store.recordDiscovery(active.tenant_id, server.mcp_server_id, [discovered], hashSchema);
  const tool = store.listTools(active.tenant_id, server.mcp_server_id)[0]!;
  return { tenant: active, identity, credential, server, tool };
}

// ── §56: credential rotation vs concurrent request ───────────────────────────

test('§56: credential rotation with stale expectedVersion → CAS conflict', () => {
  const store = makeStore();
  const { tenant, identity } = setupFullTenant(store);

  // First rotation succeeds
  const { identity: rotated } = store.rotateCredential(tenant.tenant_id, identity.service_id, identity.state_version);
  assert.ok(rotated.state_version > identity.state_version);

  // Second rotation using the original stale version → conflict
  assert.throws(
    () => store.rotateCredential(tenant.tenant_id, identity.service_id, identity.state_version),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'CONFLICT'); return true; },
  );
  store.close();
});

// ── §101: tool enable + disable concurrent → CAS conflict ────────────────────

test('§101: tool enable then disable with stale version → CAS conflict', () => {
  const store = makeStore();
  const { tenant, tool } = setupFullTenant(store);

  // Enable the tool (version bumps)
  store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version, {
    risk_class: 'LOW', allowed_operations: ['read'], resource_patterns: [],
    requires_human_approval: false, requires_vad: false, policy_id: 'pol_1',
    runtime_limits: {}, cost_limits: {}, bound_by: 'operator_1',
  });

  // Attempt to disable using the pre-enable version → conflict
  assert.throws(
    () => store.disableTool(tenant.tenant_id, tool.tool_id, tool.state_version),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'CONFLICT'); return true; },
  );
  store.close();
});

test('§101: concurrent enable attempts — second one hits CAS conflict', () => {
  const store = makeStore();
  const { tenant, tool } = setupFullTenant(store);
  const decision = {
    risk_class: 'LOW' as const, allowed_operations: ['read'], resource_patterns: [],
    requires_human_approval: false, requires_vad: false, policy_id: 'pol_1',
    runtime_limits: {}, cost_limits: {}, bound_by: 'operator_1',
  };

  // First enable succeeds
  store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version, decision);

  // Second enable with same (now stale) version → conflict
  assert.throws(
    () => store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version, decision),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'CONFLICT'); return true; },
  );
  store.close();
});

// ── §57: tool disable during execution setup ─────────────────────────────────

test('§57: tool disabled between check and execution — state reflects disabled', () => {
  const store = makeStore();
  const { tenant, tool } = setupFullTenant(store);

  // Enable the tool
  store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version, {
    risk_class: 'LOW', allowed_operations: ['read'], resource_patterns: [],
    requires_human_approval: false, requires_vad: false, policy_id: 'pol_1',
    runtime_limits: {}, cost_limits: {}, bound_by: 'operator_1',
  });
  const enabledTool = store.getTool(tenant.tenant_id, tool.tool_id);
  assert.equal(enabledTool.enabled, true);

  // Simulate: execution setup reads the tool, then someone disables it
  store.disableTool(tenant.tenant_id, tool.tool_id, enabledTool.state_version);

  // A re-read before actual execution sees disabled
  const rereads = store.getTool(tenant.tenant_id, tool.tool_id);
  assert.equal(rereads.enabled, false, 'tool must appear disabled if disabled between check and use');
  store.close();
});

// ── §58: schema drift during execution setup ─────────────────────────────────

test('§58: schema drift between enable and execution — tool is POLICY_REVIEW_REQUIRED', () => {
  const store = makeStore();
  const { tenant, server, tool } = setupFullTenant(store);

  // Enable the tool
  store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version, {
    risk_class: 'LOW', allowed_operations: ['read'], resource_patterns: [],
    requires_human_approval: false, requires_vad: false, policy_id: 'pol_1',
    runtime_limits: {}, cost_limits: {}, bound_by: 'operator_1',
  });
  const enabledHash = store.getTool(tenant.tenant_id, tool.tool_id).schema_hash;

  // Simulate: between approval and execution, schema drifts
  const drifted: DiscoveredMcpTool = { name: 'crm.lookup', description: 'Lookup v2', input_schema: { type: 'object', properties: { id: { type: 'number' } } } };
  store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [drifted], hashSchema);

  const afterDrift = store.getTool(tenant.tenant_id, tool.tool_id);
  assert.equal(afterDrift.enabled, false);
  assert.equal(afterDrift.review_status, 'POLICY_REVIEW_REQUIRED');
  assert.notEqual(afterDrift.schema_hash, enabledHash, 'schema_hash must have changed');
  store.close();
});

// ── §102: offboard vs action submit race ─────────────────────────────────────

test('§102: offboarding between eligibility check and action submit', () => {
  const store = makeStore();
  const { tenant } = setupFullTenant(store);

  // Caller checks eligibility (ACTIVE) — passes
  store.assertActionEligible(tenant.tenant_id);

  // Meanwhile, admin begins offboarding
  const fresh = store.getTenant(tenant.tenant_id);
  store.beginOffboarding(fresh.tenant_id, fresh.state_version, 'urgent', 'admin_1');

  // A second eligibility check now fails — the action must not proceed
  assert.throws(
    () => store.assertActionEligible(tenant.tenant_id),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'TENANT_NOT_ACTIVE'); return true; },
  );
  store.close();
});

// ── suspend vs action submit race ────────────────────────────────────────────

test('suspend vs action submit race: suspension between checks blocks the action', () => {
  const store = makeStore();
  const { tenant } = setupFullTenant(store);

  // First check passes (ACTIVE)
  store.assertActionEligible(tenant.tenant_id);

  // Suspension fires
  const fresh = store.getTenant(tenant.tenant_id);
  store.suspendTenant(fresh.tenant_id, fresh.state_version, 'fraud alert');

  // Second check fails
  assert.throws(
    () => store.assertActionEligible(tenant.tenant_id),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'TENANT_NOT_ACTIVE'); return true; },
  );
  store.close();
});
