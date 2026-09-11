import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientStore } from '../../packages/client-core/src/index.js';
import {
  ClientError, validateClientTenantCreateInput, validateServiceIdentityCreateInput,
} from '../../packages/client-schema/src/index.js';

function makeStore() { return new ClientStore(':memory:'); }

function setup(store: ClientStore) {
  const tenant = store.createTenant(validateClientTenantCreateInput({
    display_name: 'Cred Co', environment: 'development',
    deployment_binding: 'dep_1', policy_profile: 'default',
    allowed_connector_types: ['mcp-stdio'],
  }), 'admin_1');
  const active = store.activateTenant(tenant.tenant_id, tenant.state_version);
  const { identity, credential } = store.createServiceIdentity(active.tenant_id,
    validateServiceIdentityCreateInput({ name: 'Agent', role: 'agent-client' }), 'admin_1');
  return { tenant: active, identity, credential };
}

// ── §8, 56: credential rotation ─────────────────────────────────────────────

test('§8: original credential authenticates successfully', () => {
  const store = makeStore();
  const { credential } = setup(store);

  const auth = store.authenticateService(credential.token);
  assert.ok(auth !== null, 'original credential must authenticate');
  assert.equal(auth.status, 'ACTIVE');
  store.close();
});

test('§56: rotate → new credential works, old credential fails (no dual-valid window)', () => {
  const store = makeStore();
  const { tenant, identity, credential: oldCred } = setup(store);

  // Rotate
  const { credential: newCred, identity: rotated } = store.rotateCredential(
    tenant.tenant_id, identity.service_id, identity.state_version);
  assert.notEqual(newCred.token, oldCred.token, 'new token must differ');
  assert.notEqual(rotated.credential_ref, identity.credential_ref, 'credential_ref must change');
  assert.ok(rotated.state_version > identity.state_version, 'state_version must bump');

  // New works
  const authNew = store.authenticateService(newCred.token);
  assert.ok(authNew !== null, 'new credential must authenticate after rotation');

  // Old fails
  const authOld = store.authenticateService(oldCred.token);
  assert.equal(authOld, null, 'old credential must fail after rotation — no dual-valid window');
  store.close();
});

test('§137: rotation on a revoked identity fails', () => {
  const store = makeStore();
  const { tenant, identity } = setup(store);

  const revoked = store.revokeServiceIdentity(tenant.tenant_id, identity.service_id, identity.state_version);
  assert.throws(
    () => store.rotateCredential(tenant.tenant_id, revoked.service_id, revoked.state_version),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'SERVICE_IDENTITY_REVOKED'); return true; },
  );
  store.close();
});

test('§56: CAS conflict on concurrent rotation (stale expectedVersion)', () => {
  const store = makeStore();
  const { tenant, identity } = setup(store);

  // First rotation succeeds, bumping version
  store.rotateCredential(tenant.tenant_id, identity.service_id, identity.state_version);

  // Second rotation with the stale version → conflict
  assert.throws(
    () => store.rotateCredential(tenant.tenant_id, identity.service_id, identity.state_version),
    (e: unknown) => { assert.ok(e instanceof ClientError); assert.equal(e.code, 'CONFLICT'); return true; },
  );
  store.close();
});
