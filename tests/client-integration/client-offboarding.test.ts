import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientStore } from '../../packages/client-core/src/index.js';
import {
  ClientError, validateClientTenantCreateInput, validateServiceIdentityCreateInput,
} from '../../packages/client-schema/src/index.js';
import { validateMcpServerRegisterInput, hashSchema, type DiscoveredMcpTool } from '../../packages/mcp-schema/src/index.js';

function makeStore() { return new ClientStore(':memory:'); }

function createActiveTenant(store: ClientStore) {
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: 'Offboard Co', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  return store.activateTenant(tenant.tenant_id, tenant.state_version);
}

function registerServerAndTools(store: ClientStore, tenantId: string) {
  const server = store.registerMcpServer(tenantId, validateMcpServerRegisterInput({
    name: 'CRM', transport: 'stdio', executable: 'node',
    args: ['crm.js'], env_allowlist: [], credential_ref: null,
  }), 'admin_1');
  const discovered: DiscoveredMcpTool[] = [
    { name: 'crm.lookup', description: 'Lookup', input_schema: { type: 'object' } },
    { name: 'crm.update', description: 'Update', input_schema: { type: 'object', properties: { id: { type: 'string' } } } },
  ];
  store.recordDiscovery(tenantId, server.mcp_server_id, discovered, hashSchema);
  return server;
}

// ── §52-53: full offboarding flow ────────────────────────────────────────────

test('§52: full offboarding flow — disable tools, revoke services, block new actions, preserve history', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);

  // Set up service, server, tools
  const { identity: svc } = store.createServiceIdentity(tenant.tenant_id,
    validateServiceIdentityCreateInput({ name: 'Agent', role: 'agent-client' }), 'admin_1');
  const server = registerServerAndTools(store, tenant.tenant_id);
  const tools = store.listTools(tenant.tenant_id, server.mcp_server_id);

  // Enable both tools
  for (const tool of tools) {
    store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version, {
      risk_class: 'LOW', allowed_operations: ['read'], resource_patterns: [],
      requires_human_approval: false, requires_vad: false, policy_id: 'pol_1',
      runtime_limits: {}, cost_limits: {}, bound_by: 'operator_1',
    });
  }

  // Record a client action (historical evidence)
  store.recordClientAction({
    tenant_id: tenant.tenant_id, client_action_id: 'act_pre_offboard',
    service_id: svc.service_id, mcp_server_id: server.mcp_server_id,
    governed_tool_id: tools[0]!.tool_id,
    config_snapshot_hash: store.computeIntegrationConfigHash(tenant.tenant_id),
    created_at: new Date().toISOString(),
  });

  // Begin offboarding
  const fresh = store.getTenant(tenant.tenant_id);
  store.beginOffboarding(fresh.tenant_id, fresh.state_version, 'contract end', 'admin_1');

  // Verify: services revoked
  assert.equal(store.getServiceIdentity(tenant.tenant_id, svc.service_id).status, 'REVOKED');

  // Verify: tools disabled
  for (const tool of tools) {
    const after = store.getTool(tenant.tenant_id, tool.tool_id);
    assert.equal(after.enabled, false);
  }

  // Verify: server disabled
  assert.equal(store.getMcpServer(tenant.tenant_id, server.mcp_server_id).status, 'DISABLED');

  // Verify: new actions blocked
  assert.throws(() => store.assertActionEligible(tenant.tenant_id),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'TENANT_NOT_ACTIVE'); return true; });

  // Verify: historical evidence preserved (§53: history is never deleted)
  const action = store.getClientAction(tenant.tenant_id, 'act_pre_offboard');
  assert.ok(action !== null, 'historical action record must survive offboarding');

  // Complete offboarding
  const offboarding = store.getTenant(tenant.tenant_id);
  const final = store.completeOffboarding(offboarding.tenant_id, offboarding.state_version);
  assert.equal(final.status, 'OFFBOARDED');
  store.close();
});

// ── §53: evidence still readable after offboarding ───────────────────────────

test('§53: evidence (action records) remain readable after OFFBOARDED', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);
  const { identity } = store.createServiceIdentity(tenant.tenant_id,
    validateServiceIdentityCreateInput({ name: 'Agent', role: 'agent-client' }), 'admin_1');

  store.recordClientAction({
    tenant_id: tenant.tenant_id, client_action_id: 'evidence_1',
    service_id: identity.service_id, mcp_server_id: null, governed_tool_id: null,
    config_snapshot_hash: 'h1', created_at: new Date().toISOString(),
  });

  // Offboard fully
  const fresh = store.getTenant(tenant.tenant_id);
  const off = store.beginOffboarding(fresh.tenant_id, fresh.state_version, 'done', 'admin_1');
  store.completeOffboarding(off.tenant_id, off.state_version);

  // Evidence still readable
  const evidence = store.getClientAction(tenant.tenant_id, 'evidence_1');
  assert.ok(evidence !== null);
  assert.equal(evidence.client_action_id, 'evidence_1');
  store.close();
});

// ── §139: OFFBOARDED tenant cannot create new service identities ─────────────

test('§139: OFFBOARDED tenant cannot create new service identities', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);
  const fresh = store.getTenant(tenant.tenant_id);
  const off = store.beginOffboarding(fresh.tenant_id, fresh.state_version, 'done', 'admin_1');
  store.completeOffboarding(off.tenant_id, off.state_version);

  assert.throws(
    () => store.createServiceIdentity(tenant.tenant_id,
      validateServiceIdentityCreateInput({ name: 'New Agent', role: 'agent-client' }), 'admin_1'),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'TENANT_NOT_ACTIVE'); return true; },
  );
  store.close();
});

// ── §139: OFFBOARDED tenant cannot register new MCP servers ──────────────────

test('§139: OFFBOARDED tenant cannot register new MCP servers', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);
  const fresh = store.getTenant(tenant.tenant_id);
  const off = store.beginOffboarding(fresh.tenant_id, fresh.state_version, 'done', 'admin_1');
  store.completeOffboarding(off.tenant_id, off.state_version);

  assert.throws(
    () => store.registerMcpServer(tenant.tenant_id, validateMcpServerRegisterInput({
      name: 'New Server', transport: 'stdio', executable: 'node',
      args: ['new.js'], env_allowlist: [], credential_ref: null,
    }), 'admin_1'),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'TENANT_NOT_ACTIVE'); return true; },
  );
  store.close();
});

// ── Offboarding from SUSPENDED state ─────────────────────────────────────────

test('offboarding from SUSPENDED state succeeds (active or suspended tenants can offboard)', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);
  const suspended = store.suspendTenant(tenant.tenant_id, tenant.state_version, 'hold');

  const off = store.beginOffboarding(suspended.tenant_id, suspended.state_version, 'permanent', 'admin_1');
  assert.equal(off.status, 'OFFBOARDING');

  const final = store.completeOffboarding(off.tenant_id, off.state_version);
  assert.equal(final.status, 'OFFBOARDED');
  store.close();
});

// ── Double offboarding ───────────────────────────────────────────────────────

test('double offboarding: already-OFFBOARDED tenant cannot begin offboarding again', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);
  const fresh = store.getTenant(tenant.tenant_id);
  const off = store.beginOffboarding(fresh.tenant_id, fresh.state_version, 'done', 'admin_1');
  const final = store.completeOffboarding(off.tenant_id, off.state_version);

  assert.throws(
    () => store.beginOffboarding(final.tenant_id, final.state_version, 'again', 'admin_1'),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'CONFLICT'); return true; },
  );
  store.close();
});
