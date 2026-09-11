import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientStore } from '../../packages/client-core/src/index.js';
import { validateClientTenantCreateInput } from '../../packages/client-schema/src/index.js';
import {
  McpError, validateMcpServerRegisterInput, hashSchema, MAX_TOOLS_PER_SERVER,
  type DiscoveredMcpTool,
} from '../../packages/mcp-schema/src/index.js';

function makeStore() { return new ClientStore(':memory:'); }

function setupTenantAndServer(store: ClientStore) {
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: 'Disc Co', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  const active = store.activateTenant(tenant.tenant_id, tenant.state_version);
  const server = store.registerMcpServer(active.tenant_id, validateMcpServerRegisterInput({
    name: 'CRM', transport: 'stdio', executable: 'node',
    args: ['crm.js'], env_allowlist: [], credential_ref: null,
  }), 'admin_1');
  return { tenant: active, server };
}

const toolA: DiscoveredMcpTool = { name: 'crm.lookup', description: 'Lookup customer', input_schema: { type: 'object', properties: { id: { type: 'string' } } } };
const toolB: DiscoveredMcpTool = { name: 'crm.update', description: 'Update customer', input_schema: { type: 'object', properties: { id: { type: 'string' }, data: { type: 'object' } } } };

// ── §16, 61: discovery registers new tools as DISCOVERED (not ENABLED) ───────

test('§16/61: first discovery registers tools as DISCOVERED, not auto-ENABLED', () => {
  const store = makeStore();
  const { tenant, server } = setupTenantAndServer(store);

  const result = store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [toolA, toolB], hashSchema);
  assert.equal(result.created.length, 2);
  assert.equal(result.driftDetected.length, 0);
  assert.equal(result.removed.length, 0);

  const tools = store.listTools(tenant.tenant_id, server.mcp_server_id);
  assert.equal(tools.length, 2);
  for (const tool of tools) {
    assert.equal(tool.review_status, 'DISCOVERED', `tool ${tool.external_tool_name} must be DISCOVERED`);
    assert.equal(tool.enabled, false, `tool ${tool.external_tool_name} must not be auto-enabled`);
    assert.equal(tool.risk_class, null, 'risk_class must be null until classified by operator');
  }
  store.close();
});

// ── §18-19, 59: schema drift detection ───────────────────────────────────────

test('§18/59: schema drift → POLICY_REVIEW_REQUIRED and disabled', () => {
  const store = makeStore();
  const { tenant, server } = setupTenantAndServer(store);

  // First discovery
  store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [toolA], hashSchema);
  const tool = store.listTools(tenant.tenant_id, server.mcp_server_id)[0]!;
  const originalHash = tool.schema_hash;

  // Enable the tool
  store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version, {
    risk_class: 'LOW', allowed_operations: ['read'], resource_patterns: [],
    requires_human_approval: false, requires_vad: false, policy_id: 'pol_1',
    runtime_limits: {}, cost_limits: {}, bound_by: 'operator_1',
  });
  assert.equal(store.getTool(tenant.tenant_id, tool.tool_id).enabled, true);

  // Rediscovery with changed schema
  const driftedTool: DiscoveredMcpTool = { ...toolA, input_schema: { type: 'object', properties: { id: { type: 'string' }, region: { type: 'string' } } } };
  const result = store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [driftedTool], hashSchema);
  assert.equal(result.driftDetected.length, 1, 'drift must be detected');
  assert.ok(result.driftDetected.includes(tool.tool_id));

  const after = store.getTool(tenant.tenant_id, tool.tool_id);
  assert.equal(after.enabled, false, 'drifted tool must be disabled');
  assert.equal(after.review_status, 'POLICY_REVIEW_REQUIRED');
  assert.notEqual(after.schema_hash, originalHash, 'schema_hash must be updated');
  store.close();
});

// ── §60: tool removal ────────────────────────────────────────────────────────

test('§60: tool absent from rediscovery → REMOVED and disabled', () => {
  const store = makeStore();
  const { tenant, server } = setupTenantAndServer(store);

  // First discovery: two tools
  store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [toolA, toolB], hashSchema);
  assert.equal(store.listTools(tenant.tenant_id, server.mcp_server_id).length, 2);

  // Rediscovery: only toolA present — toolB is gone
  const result = store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [toolA], hashSchema);
  assert.equal(result.removed.length, 1, 'one tool must be marked removed');

  const removedTool = store.listTools(tenant.tenant_id, server.mcp_server_id).find(t => t.external_tool_name === 'crm.update')!;
  assert.equal(removedTool.review_status, 'REMOVED');
  assert.equal(removedTool.enabled, false);
  store.close();
});

// ── §61: new tool in rediscovery → DISCOVERED not auto-ENABLED ───────────────

test('§61: new tool appearing in rediscovery is DISCOVERED, not auto-ENABLED', () => {
  const store = makeStore();
  const { tenant, server } = setupTenantAndServer(store);

  // First discovery: only toolA
  store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [toolA], hashSchema);

  // Enable toolA
  const ta = store.listTools(tenant.tenant_id, server.mcp_server_id)[0]!;
  store.enableTool(tenant.tenant_id, ta.tool_id, ta.state_version, {
    risk_class: 'LOW', allowed_operations: ['read'], resource_patterns: [],
    requires_human_approval: false, requires_vad: false, policy_id: 'pol_1',
    runtime_limits: {}, cost_limits: {}, bound_by: 'operator_1',
  });

  // Rediscovery: toolA (unchanged) + new toolB
  const result = store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [toolA, toolB], hashSchema);
  assert.equal(result.created.length, 1, 'one new tool discovered');

  const newTool = store.listTools(tenant.tenant_id, server.mcp_server_id).find(t => t.external_tool_name === 'crm.update')!;
  assert.equal(newTool.review_status, 'DISCOVERED');
  assert.equal(newTool.enabled, false, 'new tool must not inherit enabled status from other tools');
  store.close();
});

// ── §147: MAX_TOOLS_PER_SERVER enforced ──────────────────────────────────────

test('§147: discovery exceeding MAX_TOOLS_PER_SERVER is rejected', () => {
  const store = makeStore();
  const { tenant, server } = setupTenantAndServer(store);

  const tooMany: DiscoveredMcpTool[] = [];
  for (let i = 0; i <= MAX_TOOLS_PER_SERVER; i++) {
    tooMany.push({ name: `tool_${i}`, description: `Tool ${i}`, input_schema: {} });
  }

  assert.throws(
    () => store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, tooMany, hashSchema),
    (e: unknown) => { assert.ok(e instanceof McpError); return true; },
  );
  store.close();
});

// ── Discovery updates server status to REACHABLE ─────────────────────────────

test('successful discovery sets MCP server status to REACHABLE', () => {
  const store = makeStore();
  const { tenant, server } = setupTenantAndServer(store);
  assert.equal(server.status, 'REGISTERED');

  store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [toolA], hashSchema);
  const after = store.getMcpServer(tenant.tenant_id, server.mcp_server_id);
  assert.equal(after.status, 'REACHABLE');
  store.close();
});
