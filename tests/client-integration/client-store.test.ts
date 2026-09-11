import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientStore } from '../../packages/client-core/src/index.js';
import {
  ClientError, validateClientTenantCreateInput, validateServiceIdentityCreateInput,
} from '../../packages/client-schema/src/index.js';
import { validateMcpServerRegisterInput, hashSchema } from '../../packages/mcp-schema/src/index.js';

function makeStore() { return new ClientStore(':memory:'); }

function validTenantInput() {
  return validateClientTenantCreateInput({
    display_name: 'Acme Corp', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  });
}

function createActiveTenant(store: ClientStore) {
  const tenant = store.createTenant(validTenantInput(), 'admin_1');
  return store.activateTenant(tenant.tenant_id, tenant.state_version);
}

// ── Tenant CRUD + lifecycle transitions ──────────────────────────────────────

test('createTenant yields PENDING status with state_version 0 and a ten_ prefixed id', () => {
  const store = makeStore();
  const tenant = store.createTenant(validTenantInput(), 'admin_1');
  assert.equal(tenant.status, 'PENDING');
  assert.equal(tenant.state_version, 0);
  assert.ok(tenant.tenant_id.startsWith('ten_'));
  assert.equal(tenant.display_name, 'Acme Corp');
  assert.equal(tenant.suspended_reason, null);
  assert.equal(tenant.offboarding_reason, null);
  store.close();
});

test('lifecycle: PENDING → ACTIVE → SUSPENDED → ACTIVE (resume clears suspended_reason)', () => {
  const store = makeStore();
  const t0 = store.createTenant(validTenantInput(), 'admin_1');
  assert.equal(t0.status, 'PENDING');

  const t1 = store.activateTenant(t0.tenant_id, t0.state_version);
  assert.equal(t1.status, 'ACTIVE');
  assert.equal(t1.state_version, 1);

  const t2 = store.suspendTenant(t1.tenant_id, t1.state_version, 'billing dispute');
  assert.equal(t2.status, 'SUSPENDED');
  assert.equal(t2.suspended_reason, 'billing dispute');

  const t3 = store.resumeTenant(t2.tenant_id, t2.state_version);
  assert.equal(t3.status, 'ACTIVE');
  assert.equal(t3.suspended_reason, null, 'resume must clear the suspended_reason');
  store.close();
});

test('lifecycle: ACTIVE → OFFBOARDING → OFFBOARDED', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);

  const t1 = store.beginOffboarding(tenant.tenant_id, tenant.state_version, 'contract ended', 'admin_1');
  assert.equal(t1.status, 'OFFBOARDING');
  assert.equal(t1.offboarding_reason, 'contract ended');

  const t2 = store.completeOffboarding(t1.tenant_id, t1.state_version);
  assert.equal(t2.status, 'OFFBOARDED');
  store.close();
});

test('invalid transition: OFFBOARDED cannot be reactivated or resumed', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);
  const t1 = store.beginOffboarding(tenant.tenant_id, tenant.state_version, 'done', 'admin_1');
  const t2 = store.completeOffboarding(t1.tenant_id, t1.state_version);

  // Cannot activate (expects PENDING)
  assert.throws(() => store.activateTenant(t2.tenant_id, t2.state_version),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'CONFLICT'); return true; });

  // Cannot resume (expects SUSPENDED)
  assert.throws(() => store.resumeTenant(t2.tenant_id, t2.state_version),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'CONFLICT'); return true; });
  store.close();
});

test('CAS version conflict: stale expectedVersion on tenant transition is rejected', () => {
  const store = makeStore();
  const t0 = store.createTenant(validTenantInput(), 'admin_1');
  store.activateTenant(t0.tenant_id, t0.state_version); // bumps to version 1

  // Attempt with stale version 0
  assert.throws(() => store.suspendTenant(t0.tenant_id, 0, 'late'),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'CONFLICT'); return true; });
  store.close();
});

// ── Service identity CRUD + revocation ───────────────────────────────────────

test('service identity CRUD: create, get, list, revoke', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);

  const svcInput = validateServiceIdentityCreateInput({ name: 'My Agent', role: 'agent-client' });
  const { identity, credential } = store.createServiceIdentity(tenant.tenant_id, svcInput, 'admin_1');
  assert.equal(identity.status, 'ACTIVE');
  assert.equal(identity.role, 'agent-client');
  assert.ok(identity.service_id.startsWith('svc_'));
  assert.ok(credential.token.startsWith('tnaclient_'));

  const fetched = store.getServiceIdentity(tenant.tenant_id, identity.service_id);
  assert.equal(fetched.service_id, identity.service_id);

  const list = store.listServiceIdentities(tenant.tenant_id);
  assert.equal(list.items.length, 1);

  const revoked = store.revokeServiceIdentity(tenant.tenant_id, identity.service_id, identity.state_version);
  assert.equal(revoked.status, 'REVOKED');
  store.close();
});

// ── Offboarding cascades (§9, 52) ────────────────────────────────────────────

test('§9/52: offboarding cascades revoke services, disable tools, disable MCP servers', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);

  // Service identity
  const { identity: svc } = store.createServiceIdentity(tenant.tenant_id,
    validateServiceIdentityCreateInput({ name: 'Agent', role: 'agent-client' }), 'admin_1');

  // MCP server
  const mcpInput = validateMcpServerRegisterInput({
    name: 'CRM Server', transport: 'stdio', executable: 'node',
    args: ['server.js'], env_allowlist: [], credential_ref: null,
  });
  const server = store.registerMcpServer(tenant.tenant_id, mcpInput, 'admin_1');

  // Discover + enable a tool
  store.recordDiscovery(tenant.tenant_id, server.mcp_server_id,
    [{ name: 'crm.lookup', description: 'Lookup', input_schema: { type: 'object' } }], hashSchema);
  const tool = store.listTools(tenant.tenant_id, server.mcp_server_id)[0]!;
  store.enableTool(tenant.tenant_id, tool.tool_id, tool.state_version, {
    risk_class: 'LOW', allowed_operations: ['read'], resource_patterns: ['crm.*'],
    requires_human_approval: false, requires_vad: false, policy_id: 'pol_1',
    runtime_limits: {}, cost_limits: {}, bound_by: 'operator_1',
  });

  // Begin offboarding
  const fresh = store.getTenant(tenant.tenant_id);
  store.beginOffboarding(fresh.tenant_id, fresh.state_version, 'termination', 'admin_1');

  // Cascades verified
  assert.equal(store.getServiceIdentity(tenant.tenant_id, svc.service_id).status, 'REVOKED');
  const afterTool = store.getTool(tenant.tenant_id, tool.tool_id);
  assert.equal(afterTool.enabled, false);
  assert.equal(afterTool.review_status, 'DISABLED');
  assert.equal(store.getMcpServer(tenant.tenant_id, server.mcp_server_id).status, 'DISABLED');
  store.close();
});

// ── Suspension blocks new actions (§10, 54) ──────────────────────────────────

test('§10/54: suspension blocks new consequential actions via assertActionEligible', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);
  store.suspendTenant(tenant.tenant_id, tenant.state_version, 'investigation');

  assert.throws(() => store.assertActionEligible(tenant.tenant_id),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'TENANT_NOT_ACTIVE'); return true; });
  store.close();
});

test('§54: suspension blocks new service identity creation', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);
  store.suspendTenant(tenant.tenant_id, tenant.state_version, 'hold');

  assert.throws(() => store.createServiceIdentity(tenant.tenant_id,
    validateServiceIdentityCreateInput({ name: 'Blocked', role: 'agent-client' }), 'admin_1'),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'TENANT_NOT_ACTIVE'); return true; });
  store.close();
});

// ── Historical config/snapshot integrity (§23, §67, consistency pass) ────────

test('§23/67: a recorded client action\'s config_snapshot_hash is never retroactively rewritten by a later config change', () => {
  const store = makeStore();
  const tenant = createActiveTenant(store);
  const service = store.createServiceIdentity(tenant.tenant_id, validateServiceIdentityCreateInput({ name: 'Agent', role: 'agent-client' }), 'admin_1');

  // Snapshot the integration config at the moment an action is (conceptually) submitted, and record it.
  const hashAtSubmission = store.computeIntegrationConfigHash(tenant.tenant_id);
  store.recordClientAction({
    tenant_id: tenant.tenant_id, client_action_id: 'ca_snapshot_test', service_id: service.identity.service_id,
    mcp_server_id: null, governed_tool_id: null, config_snapshot_hash: hashAtSubmission, created_at: new Date().toISOString(),
  });

  // Now genuinely change the tenant's integration state — register a new MCP server, which changes
  // what `computeIntegrationConfigHash` would compute going forward.
  store.registerMcpServer(tenant.tenant_id, validateMcpServerRegisterInput({
    name: 'New Server', transport: 'stdio', executable: 'node', args: ['s.js'], env_allowlist: [], credential_ref: null,
  }), 'admin_1');
  const hashAfterChange = store.computeIntegrationConfigHash(tenant.tenant_id);
  assert.notEqual(hashAfterChange, hashAtSubmission, 'sanity: the integration config must genuinely have changed');

  // The already-recorded action's snapshot must be completely unaffected — no UPDATE path exists for
  // client_actions at all (INSERT-only by construction), proven here by reading it back unchanged.
  const recovered = store.getClientAction(tenant.tenant_id, 'ca_snapshot_test');
  assert.equal(recovered?.config_snapshot_hash, hashAtSubmission, 'a recorded action\'s config snapshot must never be rewritten by a later configuration change');
  store.close();
});
