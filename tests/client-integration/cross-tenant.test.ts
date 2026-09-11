import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientStore, toolPlatformId } from '../../packages/client-core/src/index.js';
import {
  ClientError, validateClientTenantCreateInput, validateServiceIdentityCreateInput,
} from '../../packages/client-schema/src/index.js';
import { validateMcpServerRegisterInput, hashSchema, type DiscoveredMcpTool } from '../../packages/mcp-schema/src/index.js';

function makeStore() { return new ClientStore(':memory:'); }

function createActiveTenantWithService(store: ClientStore, name: string) {
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: name, environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  const active = store.activateTenant(tenant.tenant_id, tenant.state_version);
  const { identity, credential } = store.createServiceIdentity(active.tenant_id,
    validateServiceIdentityCreateInput({ name: 'Agent', role: 'agent-client' }), 'admin_1');
  return { tenant: active, identity, credential };
}

const sameToolSchema: DiscoveredMcpTool = { name: 'shared.tool_name', description: 'Same name tool', input_schema: { type: 'object' } };

// ── §38: tenant A credential only authenticates to tenant A ──────────────────

test('§38: authenticateService maps a credential to exactly one tenant', () => {
  const store = makeStore();
  const a = createActiveTenantWithService(store, 'Tenant A');
  const b = createActiveTenantWithService(store, 'Tenant B');

  const authA = store.authenticateService(a.credential.token);
  assert.ok(authA !== null);
  assert.equal(authA.tenant_id, a.tenant.tenant_id);
  assert.notEqual(authA.tenant_id, b.tenant.tenant_id);

  const authB = store.authenticateService(b.credential.token);
  assert.ok(authB !== null);
  assert.equal(authB.tenant_id, b.tenant.tenant_id);
  store.close();
});

// ── §38: tenant A credential cannot access tenant B tools ────────────────────

test('§38: listing/getting tenant B tools with tenant A scope → NOT_FOUND or empty', () => {
  const store = makeStore();
  const a = createActiveTenantWithService(store, 'Tenant A');
  const b = createActiveTenantWithService(store, 'Tenant B');

  // Register a server and tool under tenant B
  const server = store.registerMcpServer(b.tenant.tenant_id, validateMcpServerRegisterInput({
    name: 'BServer', transport: 'stdio', executable: 'node',
    args: ['b.js'], env_allowlist: [], credential_ref: null,
  }), 'admin_1');
  store.recordDiscovery(b.tenant.tenant_id, server.mcp_server_id, [sameToolSchema], hashSchema);
  const bTools = store.listTools(b.tenant.tenant_id);
  assert.equal(bTools.length, 1);

  // Tenant A scope sees nothing
  const aTools = store.listTools(a.tenant.tenant_id);
  assert.equal(aTools.length, 0, 'tenant A must not see tenant B tools');

  // Direct get with tenant A scope and tenant B tool id → NOT_FOUND
  assert.throws(
    () => store.getTool(a.tenant.tenant_id, bTools[0]!.tool_id),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'NOT_FOUND'); return true; },
  );
  store.close();
});

// ── §38: tenant A cannot discover tenant B servers ───────────────────────────

test('§38: listMcpServers is tenant-scoped — tenant A cannot see tenant B servers', () => {
  const store = makeStore();
  const a = createActiveTenantWithService(store, 'Tenant A');
  const b = createActiveTenantWithService(store, 'Tenant B');

  store.registerMcpServer(b.tenant.tenant_id, validateMcpServerRegisterInput({
    name: 'BServer', transport: 'stdio', executable: 'node',
    args: ['b.js'], env_allowlist: [], credential_ref: null,
  }), 'admin_1');

  assert.equal(store.listMcpServers(a.tenant.tenant_id).length, 0);
  assert.equal(store.listMcpServers(b.tenant.tenant_id).length, 1);
  store.close();
});

// ── §38: tenant A cannot view tenant B actions ───────────────────────────────

test('§38: getClientAction is tenant-scoped — tenant A cannot read tenant B actions', () => {
  const store = makeStore();
  const a = createActiveTenantWithService(store, 'Tenant A');
  const b = createActiveTenantWithService(store, 'Tenant B');

  store.recordClientAction({
    tenant_id: b.tenant.tenant_id, client_action_id: 'act_1', service_id: b.identity.service_id,
    mcp_server_id: null, governed_tool_id: null, config_snapshot_hash: 'h1', created_at: new Date().toISOString(),
  });

  // Tenant B can read it
  assert.ok(store.getClientAction(b.tenant.tenant_id, 'act_1') !== null);

  // Tenant A cannot
  assert.equal(store.getClientAction(a.tenant.tenant_id, 'act_1'), null);
  store.close();
});

// ── §39: same tool name on different tenants → independent registrations ─────

test('§39: same external tool name on different tenants yields independent governed tools', () => {
  const store = makeStore();
  const a = createActiveTenantWithService(store, 'Tenant A');
  const b = createActiveTenantWithService(store, 'Tenant B');

  for (const { tenant } of [a, b]) {
    const server = store.registerMcpServer(tenant.tenant_id, validateMcpServerRegisterInput({
      name: 'SharedName', transport: 'stdio', executable: 'node',
      args: ['shared.js'], env_allowlist: [], credential_ref: null,
    }), 'admin_1');
    store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [sameToolSchema], hashSchema);
  }

  const aTools = store.listTools(a.tenant.tenant_id);
  const bTools = store.listTools(b.tenant.tenant_id);
  assert.equal(aTools.length, 1);
  assert.equal(bTools.length, 1);
  assert.notEqual(aTools[0]!.tool_id, bTools[0]!.tool_id, 'tool_ids must be distinct across tenants');
  assert.equal(aTools[0]!.external_tool_name, bTools[0]!.external_tool_name, 'external names can be the same');
  store.close();
});

// ── §108-109: toolPlatformId prevents identity collision ─────────────────────

test('§108-109: toolPlatformId is UUID-based — prevents name-based impersonation', () => {
  const store = makeStore();
  const a = createActiveTenantWithService(store, 'Tenant A');
  const b = createActiveTenantWithService(store, 'Tenant B');

  for (const { tenant } of [a, b]) {
    const server = store.registerMcpServer(tenant.tenant_id, validateMcpServerRegisterInput({
      name: 'Server', transport: 'stdio', executable: 'node',
      args: ['s.js'], env_allowlist: [], credential_ref: null,
    }), 'admin_1');
    store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, [sameToolSchema], hashSchema);
  }

  const aToolId = store.listTools(a.tenant.tenant_id)[0]!.tool_id;
  const bToolId = store.listTools(b.tenant.tenant_id)[0]!.tool_id;

  // Platform-facing IDs are distinct even though external names are identical
  const aPlatformId = toolPlatformId(aToolId);
  const bPlatformId = toolPlatformId(bToolId);
  assert.notEqual(aPlatformId, bPlatformId, 'platform IDs must never collide');
  assert.ok(aPlatformId.startsWith('mcp.gt_'));
  assert.ok(bPlatformId.startsWith('mcp.gt_'));
  store.close();
});
