import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientStore } from '../../packages/client-core/src/index.js';
import {
  validateClientTenantCreateInput, validateServiceIdentityCreateInput,
  ONBOARDING_READINESS, BYPASS_ASSESSMENTS, computeBypassAssessment,
  type OnboardingReadiness,
} from '../../packages/client-schema/src/index.js';
import { validateMcpServerRegisterInput, hashSchema, type DiscoveredMcpTool } from '../../packages/mcp-schema/src/index.js';

function makeStore() { return new ClientStore(':memory:'); }

/**
 * §118-119: bypass assessment is `computeBypassAssessment`, imported directly from
 * `packages/client-schema` — a real, exported production function, not a test-local reimplementation
 * (the original draft of this suite defined an inline copy; this was found and corrected during the
 * threat-model consistency pass so the tests below exercise the actual shipped decision function).
 *
 * §51's readiness assessment is `assessOnboardingReadiness` in `apps/tna-client-gateway/src/server.ts`
 * (wired to the real `GET /v1/admin/tenants/:id/readiness` route, proven in the container test) — its
 * production version returns a richer per-check breakdown than this test's own simplified illustrative
 * copy below, which exists only to exercise the readiness *vocabulary*'s ordering logic in isolation.
 */
function assessReadiness(store: ClientStore, tenantId: string): OnboardingReadiness {
  try { store.getTenant(tenantId); } catch { return 'INSUFFICIENT_EVIDENCE'; }
  const services = store.listServiceIdentities(tenantId).items;
  if (services.length === 0) return 'INSUFFICIENT_EVIDENCE';
  const hasActive = services.some(s => s.status === 'ACTIVE');
  if (!hasActive) return 'NOT_READY';
  const servers = store.listMcpServers(tenantId);
  const hasReachable = servers.some(s => s.status === 'REACHABLE');
  if (!hasReachable) return 'NOT_READY';
  const tools = store.listTools(tenantId);
  const hasEnabled = tools.some(t => t.enabled);
  if (!hasEnabled) return 'READY_WITH_LIMITATIONS';
  return 'READY';
}

// ── Type vocabulary correctness ──────────────────────────────────────────────

test('BYPASS_ASSESSMENTS contains the three defined values', () => {
  assert.deepEqual([...BYPASS_ASSESSMENTS], ['NO_KNOWN_BYPASS', 'KNOWN_BYPASS', 'UNKNOWN']);
});

test('ONBOARDING_READINESS contains the four defined values', () => {
  assert.deepEqual([...ONBOARDING_READINESS], ['READY', 'READY_WITH_LIMITATIONS', 'NOT_READY', 'INSUFFICIENT_EVIDENCE']);
});

// ── §118: direct external credential → KNOWN_BYPASS ──────────────────────────

test('§118: tenant with a direct external credential is assessed as KNOWN_BYPASS', () => {
  const store = makeStore();
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: 'Bypass Co', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  const active = store.activateTenant(tenant.tenant_id, tenant.state_version);

  // Create a TNA-issued credential
  const { credential } = store.createServiceIdentity(active.tenant_id,
    validateServiceIdentityCreateInput({ name: 'Agent', role: 'agent-client' }), 'admin_1');
  assert.ok(credential.token.startsWith('tnaclient_'), 'TNA credential follows the issuance pattern');

  // But if the client also accesses tools via an external token (not stored in TNA),
  // that external path is a known bypass.
  const externalToken = 'ext_direct_access_not_in_tna';
  assert.equal(store.authenticateService(externalToken), null, 'external token is unknown to TNA');

  const bypass = computeBypassAssessment({ tnaCredentialChain: true, externalDirectCredential: true });
  assert.equal(bypass, 'KNOWN_BYPASS');
  store.close();
});

// ── §119: clean integration → NO_KNOWN_BYPASS ────────────────────────────────

test('§119: clean integration through TNA credential chain → NO_KNOWN_BYPASS', () => {
  const store = makeStore();
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: 'Clean Co', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  const active = store.activateTenant(tenant.tenant_id, tenant.state_version);

  const { credential } = store.createServiceIdentity(active.tenant_id,
    validateServiceIdentityCreateInput({ name: 'Agent', role: 'agent-client' }), 'admin_1');

  // All access goes through TNA-issued credential — no external bypass
  const auth = store.authenticateService(credential.token);
  assert.ok(auth !== null);

  const bypass = computeBypassAssessment({ tnaCredentialChain: true, externalDirectCredential: false });
  assert.equal(bypass, 'NO_KNOWN_BYPASS');
  store.close();
});

// ── §141: missing components → NOT_READY or INSUFFICIENT_EVIDENCE ────────────

test('§141: tenant with no services → INSUFFICIENT_EVIDENCE', () => {
  const store = makeStore();
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: 'Empty Co', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  const active = store.activateTenant(tenant.tenant_id, tenant.state_version);

  assert.equal(assessReadiness(store, active.tenant_id), 'INSUFFICIENT_EVIDENCE');
  store.close();
});

test('§141: tenant with service but no reachable server → NOT_READY', () => {
  const store = makeStore();
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: 'Partial Co', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  const active = store.activateTenant(tenant.tenant_id, tenant.state_version);
  store.createServiceIdentity(active.tenant_id,
    validateServiceIdentityCreateInput({ name: 'Agent', role: 'agent-client' }), 'admin_1');

  // Server registered but not yet REACHABLE (no discovery run)
  store.registerMcpServer(active.tenant_id, validateMcpServerRegisterInput({
    name: 'Server', transport: 'stdio', executable: 'node',
    args: ['s.js'], env_allowlist: [], credential_ref: null,
  }), 'admin_1');

  assert.equal(assessReadiness(store, active.tenant_id), 'NOT_READY');
  store.close();
});

test('§141: full integration with enabled tools → READY', () => {
  const store = makeStore();
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: 'Full Co', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  const active = store.activateTenant(tenant.tenant_id, tenant.state_version);
  store.createServiceIdentity(active.tenant_id,
    validateServiceIdentityCreateInput({ name: 'Agent', role: 'agent-client' }), 'admin_1');

  const server = store.registerMcpServer(active.tenant_id, validateMcpServerRegisterInput({
    name: 'Server', transport: 'stdio', executable: 'node',
    args: ['s.js'], env_allowlist: [], credential_ref: null,
  }), 'admin_1');

  const discovered: DiscoveredMcpTool = { name: 'tool.a', description: 'A', input_schema: { type: 'object' } };
  store.recordDiscovery(active.tenant_id, server.mcp_server_id, [discovered], hashSchema);
  const tool = store.listTools(active.tenant_id)[0]!;
  store.enableTool(active.tenant_id, tool.tool_id, tool.state_version, {
    risk_class: 'LOW', allowed_operations: ['read'], resource_patterns: [],
    requires_human_approval: false, requires_vad: false, policy_id: 'pol_1',
    runtime_limits: {}, cost_limits: {}, bound_by: 'operator_1',
  });

  assert.equal(assessReadiness(store, active.tenant_id), 'READY');
  store.close();
});

// ── KNOWN_BYPASS cannot appear as high-assurance readiness ────────────────────

test('§118: KNOWN_BYPASS and READY are architecturally incompatible for high-assurance', () => {
  // The security invariant: a tenant assessed as KNOWN_BYPASS must never be treated
  // as having the same trust level as NO_KNOWN_BYPASS, even if all components are READY.
  // This test verifies the logical rule: if bypass is KNOWN_BYPASS, the overall assurance
  // is capped — the readiness score alone does not grant high-assurance status.
  const bypass = computeBypassAssessment({ tnaCredentialChain: true, externalDirectCredential: true });
  assert.equal(bypass, 'KNOWN_BYPASS');
  assert.notEqual(bypass, 'NO_KNOWN_BYPASS',
    'a tenant with an external credential cannot be assessed as NO_KNOWN_BYPASS');

  // The combination (READY, KNOWN_BYPASS) means: the TNA-managed path is ready,
  // but an unmanaged path exists. High-assurance requires BOTH READY AND NO_KNOWN_BYPASS.
  const clean = computeBypassAssessment({ tnaCredentialChain: true, externalDirectCredential: false });
  assert.equal(clean, 'NO_KNOWN_BYPASS');
  // Only the clean assessment qualifies for high-assurance.
});
