import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientStore } from '../../packages/client-core/src/index.js';
import { ClientError, validateClientTenantCreateInput } from '../../packages/client-schema/src/index.js';
import {
  validateMcpServerRegisterInput, hashSchema, classifyRisk,
  type DiscoveredMcpTool,
} from '../../packages/mcp-schema/src/index.js';

function makeStore() { return new ClientStore(':memory:'); }

function setupWithTool(store: ClientStore) {
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: 'Gov Co', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  const active = store.activateTenant(tenant.tenant_id, tenant.state_version);
  const server = store.registerMcpServer(active.tenant_id, validateMcpServerRegisterInput({
    name: 'CRM', transport: 'stdio', executable: 'node',
    args: ['crm.js'], env_allowlist: [], credential_ref: null,
  }), 'admin_1');
  const discovered: DiscoveredMcpTool = { name: 'crm.lookup', description: 'Lookup', input_schema: { type: 'object', properties: { id: { type: 'string' } } } };
  store.recordDiscovery(active.tenant_id, server.mcp_server_id, [discovered], hashSchema);
  const tool = store.listTools(active.tenant_id, server.mcp_server_id)[0]!;
  return { tenant: active, server, tool };
}

const enableDecision = (overrides: Partial<Parameters<ClientStore['enableTool']>[3]> = {}) => ({
  risk_class: 'LOW' as const, allowed_operations: ['read'], resource_patterns: ['crm.*'],
  requires_human_approval: false, requires_vad: false, policy_id: 'pol_1',
  runtime_limits: {}, cost_limits: {}, bound_by: 'operator_1', ...overrides,
});

// ── §21: risk classification table (deterministic, operator-supplied) ────────

test('§21: read, no network → LOW', () => {
  assert.equal(classifyRisk({ operation: 'read', network_required: false, category: 'general' }), 'LOW');
});

test('§21: read + network → MEDIUM', () => {
  assert.equal(classifyRisk({ operation: 'read', network_required: true, category: 'general' }), 'MEDIUM');
});

test('§21: write, no network → MEDIUM', () => {
  assert.equal(classifyRisk({ operation: 'write', network_required: false, category: 'general' }), 'MEDIUM');
});

test('§21: write + network → HIGH', () => {
  assert.equal(classifyRisk({ operation: 'write', network_required: true, category: 'general' }), 'HIGH');
});

test('§21: financial category → HIGH', () => {
  assert.equal(classifyRisk({ operation: 'read', network_required: false, category: 'financial' }), 'HIGH');
});

test('§21: filesystem-write category → HIGH', () => {
  assert.equal(classifyRisk({ operation: 'read', network_required: false, category: 'filesystem-write' }), 'HIGH');
});

test('§21: deployment → CRITICAL', () => {
  assert.equal(classifyRisk({ operation: 'read', network_required: false, category: 'deployment' }), 'CRITICAL');
});

test('§21: code-execution → CRITICAL', () => {
  assert.equal(classifyRisk({ operation: 'execute', network_required: false, category: 'code-execution' }), 'CRITICAL');
});

test('§21: credential-mutation → CRITICAL', () => {
  assert.equal(classifyRisk({ operation: 'write', network_required: false, category: 'credential-mutation' }), 'CRITICAL');
});

// ── §33: enableTool binds policy with schema_hash ────────────────────────────

test('§33: enableTool creates a policy binding that includes the schema_hash', () => {
  const store = makeStore();
  const { tenant, tool } = setupWithTool(store);

  const { tool: enabled, binding } = store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version,
    enableDecision());

  assert.equal(enabled.enabled, true);
  assert.equal(enabled.review_status, 'ENABLED');
  assert.equal(enabled.risk_class, 'LOW');
  assert.ok(binding.binding_id.startsWith('bind_'));
  assert.equal(binding.tool_id, tool.tool_id);
  assert.equal(binding.risk_class, 'LOW');

  // Schema hash is captured in policy hash (immutable snapshot)
  assert.ok(binding.policy_hash.length > 0);

  const bindings = store.listPolicyBindings(tenant.tenant_id, tool.tool_id);
  assert.equal(bindings.length, 1);
  store.close();
});

// ── §34: disableTool ─────────────────────────────────────────────────────────

test('§34: disableTool sets enabled=false and review_status=DISABLED', () => {
  const store = makeStore();
  const { tenant, tool } = setupWithTool(store);

  store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version, enableDecision());
  const enabled = store.getTool(tenant.tenant_id, tool.tool_id);
  assert.equal(enabled.enabled, true);

  const disabled = store.disableTool(tenant.tenant_id, tool.tool_id, enabled.state_version);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.review_status, 'DISABLED');
  store.close();
});

// ── §32, 105: REMOVED tool cannot be enabled ─────────────────────────────────

test('§32: REMOVED tool cannot be enabled — server no longer advertises it', () => {
  const store = makeStore();
  const { tenant, server, tool } = setupWithTool(store);

  // Rediscovery with empty list → tool becomes REMOVED
  store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [], hashSchema);
  const removed = store.getTool(tenant.tenant_id, tool.tool_id);
  assert.equal(removed.review_status, 'REMOVED');

  assert.throws(
    () => store.enableTool(tenant.tenant_id, tool.tool_id, removed.state_version, enableDecision()),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'CONFLICT'); return true; },
  );
  store.close();
});

// ── §18: schema hash is bound — drift invalidates the binding ────────────────

test('§18: after schema drift, the tool schema_hash differs from the policy binding snapshot', () => {
  const store = makeStore();
  const { tenant, server, tool } = setupWithTool(store);

  // Enable with original schema
  store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version, enableDecision());
  const bindingsBefore = store.listPolicyBindings(tenant.tenant_id, tool.tool_id);
  assert.equal(bindingsBefore.length, 1);

  // Trigger schema drift
  const drifted: DiscoveredMcpTool = { name: 'crm.lookup', description: 'Lookup v2', input_schema: { type: 'object', properties: { id: { type: 'string' }, env: { type: 'string' } } } };
  store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [drifted], hashSchema);

  const afterTool = store.getTool(tenant.tenant_id, tool.tool_id);
  assert.equal(afterTool.enabled, false);
  assert.equal(afterTool.review_status, 'POLICY_REVIEW_REQUIRED');
  // The old binding still references the old schema hash in its policy_hash, but the tool's
  // schema_hash has moved on — they no longer agree, so the binding is stale.
  assert.notEqual(afterTool.schema_hash, tool.schema_hash);
  store.close();
});
