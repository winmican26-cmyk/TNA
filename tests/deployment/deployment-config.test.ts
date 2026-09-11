import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDeploymentConfig, loadDeploymentConfigFromEnv, resolveDeploymentSecrets, computeConfigHash,
  DeploymentConfigError, redact, isWeakSecret, type DeploymentConfig,
} from '../../packages/deployment-schema/src/index.js';

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1', environment: 'development', tenant_id: 'tenant_demo',
    network: { host: '127.0.0.1', port: 4618, trust_proxy: false, cors_allow_origin: null },
    storage: { data_dir: './data' },
    secrets: {
      operator_token_ref: { source: 'env', ref: 'OP_TOKEN' },
      admin_token_ref: { source: 'env', ref: 'ADMIN_TOKEN' },
      service_token_ref: { source: 'env', ref: 'SVC_TOKEN' },
      capability_key_ref: null,
    },
    limits: { request_timeout_ms: 30000, headers_timeout_ms: 10000, max_body_bytes: 262144 },
    ...overrides,
  };
}

test('valid development config parses cleanly', () => {
  const config = parseDeploymentConfig(baseConfig());
  assert.equal(config.environment, 'development');
  assert.equal(config.network.port, 4618);
});

test('valid production config requires a capability_key_ref', () => {
  const config = parseDeploymentConfig(baseConfig({
    environment: 'production',
    secrets: {
      operator_token_ref: { source: 'env', ref: 'OP_TOKEN' }, admin_token_ref: { source: 'env', ref: 'ADMIN_TOKEN' },
      service_token_ref: { source: 'env', ref: 'SVC_TOKEN' }, capability_key_ref: { source: 'env', ref: 'CAP_KEY' },
    },
    network: { host: '127.0.0.1', port: 4618, trust_proxy: false, cors_allow_origin: null },
  }));
  assert.equal(config.environment, 'production');
});

test('production without capability_key_ref fails startup, not a silent random key', () => {
  assert.throws(() => parseDeploymentConfig(baseConfig({ environment: 'production' })), (error: unknown) => {
    assert.ok(error instanceof DeploymentConfigError);
    assert.equal(error.code, 'MISSING_REQUIRED');
    return true;
  });
});

test('unknown top-level field is rejected', () => {
  assert.throws(() => parseDeploymentConfig(baseConfig({ mystery_field: 'x' })), (error: unknown) => {
    assert.ok(error instanceof DeploymentConfigError); assert.equal(error.code, 'UNKNOWN_FIELD'); return true;
  });
});

test('unknown nested field is rejected', () => {
  const raw = baseConfig();
  (raw.network as Record<string, unknown>).extra = 'nope';
  assert.throws(() => parseDeploymentConfig(raw), (error: unknown) => { assert.ok(error instanceof DeploymentConfigError); assert.equal(error.code, 'UNKNOWN_FIELD'); return true; });
});

test('invalid port is rejected', () => {
  assert.throws(() => parseDeploymentConfig(baseConfig({ network: { host: '127.0.0.1', port: 70000, trust_proxy: false, cors_allow_origin: null } })),
    (error: unknown) => { assert.ok(error instanceof DeploymentConfigError); assert.equal(error.code, 'INVALID_VALUE'); return true; });
  assert.throws(() => parseDeploymentConfig(baseConfig({ network: { host: '127.0.0.1', port: 0, trust_proxy: false, cors_allow_origin: null } })));
});

test('invalid timeout is rejected', () => {
  assert.throws(() => parseDeploymentConfig(baseConfig({ limits: { request_timeout_ms: -1, headers_timeout_ms: 10000, max_body_bytes: 262144 } })));
});

test('negative resource limit is rejected', () => {
  assert.throws(() => parseDeploymentConfig(baseConfig({ limits: { request_timeout_ms: 30000, headers_timeout_ms: 10000, max_body_bytes: -5 } })));
});

test('missing required storage path is rejected', () => {
  assert.throws(() => parseDeploymentConfig(baseConfig({ storage: { data_dir: '' } })));
});

test('invalid environment value is rejected', () => {
  assert.throws(() => parseDeploymentConfig(baseConfig({ environment: 'staging' })));
});

test('malformed tenant config is rejected', () => {
  assert.throws(() => parseDeploymentConfig(baseConfig({ tenant_id: '../../etc' })));
  assert.throws(() => parseDeploymentConfig(baseConfig({ tenant_id: '' })));
});

test('production CORS wildcard is rejected', () => {
  const raw = baseConfig({
    environment: 'production',
    secrets: { operator_token_ref: { source: 'env', ref: 'A' }, admin_token_ref: { source: 'env', ref: 'B' }, service_token_ref: { source: 'env', ref: 'C' }, capability_key_ref: { source: 'env', ref: 'D' } },
    network: { host: '127.0.0.1', port: 4618, trust_proxy: false, cors_allow_origin: '*' },
  });
  assert.throws(() => parseDeploymentConfig(raw), (error: unknown) => { assert.ok(error instanceof DeploymentConfigError); assert.equal(error.code, 'INSECURE_PRODUCTION_DEFAULT'); return true; });
});

test('production binding to 0.0.0.0 without trust_proxy is rejected', () => {
  const raw = baseConfig({
    environment: 'production',
    secrets: { operator_token_ref: { source: 'env', ref: 'A' }, admin_token_ref: { source: 'env', ref: 'B' }, service_token_ref: { source: 'env', ref: 'C' }, capability_key_ref: { source: 'env', ref: 'D' } },
    network: { host: '0.0.0.0', port: 4618, trust_proxy: false, cors_allow_origin: null },
  });
  assert.throws(() => parseDeploymentConfig(raw), (error: unknown) => { assert.ok(error instanceof DeploymentConfigError); assert.equal(error.code, 'INSECURE_PRODUCTION_DEFAULT'); return true; });
});

test('resolveDeploymentSecrets rejects a weak production secret', () => {
  const config: DeploymentConfig = parseDeploymentConfig(baseConfig({
    environment: 'production',
    secrets: {
      operator_token_ref: { source: 'env', ref: 'OP_TOKEN' }, admin_token_ref: { source: 'env', ref: 'ADMIN_TOKEN' },
      service_token_ref: { source: 'env', ref: 'SVC_TOKEN' }, capability_key_ref: { source: 'env', ref: 'CAP_KEY' },
    },
  }));
  const env = { OP_TOKEN: 'changeme', ADMIN_TOKEN: 'a'.repeat(40), SVC_TOKEN: 'b'.repeat(40), CAP_KEY: 'c'.repeat(40) };
  assert.throws(() => resolveDeploymentSecrets(config, env), (error: unknown) => { assert.ok(error instanceof DeploymentConfigError); assert.equal(error.code, 'WEAK_SECRET'); return true; });
});

test('resolveDeploymentSecrets rejects duplicate production tokens', () => {
  const config = parseDeploymentConfig(baseConfig({
    environment: 'production',
    secrets: {
      operator_token_ref: { source: 'env', ref: 'OP_TOKEN' }, admin_token_ref: { source: 'env', ref: 'ADMIN_TOKEN' },
      service_token_ref: { source: 'env', ref: 'SVC_TOKEN' }, capability_key_ref: { source: 'env', ref: 'CAP_KEY' },
    },
  }));
  const same = 'x'.repeat(40);
  const env = { OP_TOKEN: same, ADMIN_TOKEN: same, SVC_TOKEN: 'y'.repeat(40), CAP_KEY: 'z'.repeat(40) };
  assert.throws(() => resolveDeploymentSecrets(config, env));
});

test('resolveDeploymentSecrets succeeds with strong distinct production secrets', () => {
  const config = parseDeploymentConfig(baseConfig({
    environment: 'production',
    secrets: {
      operator_token_ref: { source: 'env', ref: 'OP_TOKEN' }, admin_token_ref: { source: 'env', ref: 'ADMIN_TOKEN' },
      service_token_ref: { source: 'env', ref: 'SVC_TOKEN' }, capability_key_ref: { source: 'env', ref: 'CAP_KEY' },
    },
  }));
  const env = { OP_TOKEN: 'op-'.repeat(20), ADMIN_TOKEN: 'ad-'.repeat(20), SVC_TOKEN: 'sv-'.repeat(20), CAP_KEY: 'ck-'.repeat(20) };
  const resolved = resolveDeploymentSecrets(config, env);
  assert.equal(resolved.operatorToken, env.OP_TOKEN);
  assert.equal(resolved.capabilityKey, env.CAP_KEY);
});

test('isWeakSecret flags known weak values, short values, and uniform values', () => {
  assert.equal(isWeakSecret('changeme'), true);
  assert.equal(isWeakSecret('short'), true);
  assert.equal(isWeakSecret('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
  assert.equal(isWeakSecret('N4$kQz9!vR7pWm2XeT8yLb5cUoAh1sDf6gJi'), false);
});

test('computeConfigHash excludes secret values but includes secret reference identifiers', () => {
  const config = parseDeploymentConfig(baseConfig());
  const hashA = computeConfigHash(config);
  const configDifferentRef = parseDeploymentConfig(baseConfig({
    secrets: { operator_token_ref: { source: 'env', ref: 'DIFFERENT_ENV_VAR' }, admin_token_ref: { source: 'env', ref: 'ADMIN_TOKEN' }, service_token_ref: { source: 'env', ref: 'SVC_TOKEN' }, capability_key_ref: null },
  }));
  assert.notEqual(hashA, computeConfigHash(configDifferentRef), 'changing which secret is referenced must change the hash');
  const configSameShapeDifferentPort = parseDeploymentConfig(baseConfig({ network: { host: '127.0.0.1', port: 4619, trust_proxy: false, cors_allow_origin: null } }));
  assert.notEqual(hashA, computeConfigHash(configSameShapeDifferentPort));
  assert.equal(hashA, computeConfigHash(parseDeploymentConfig(baseConfig())), 'identical config must hash identically');
});

test('loadDeploymentConfigFromEnv builds a strict config from TNA_* env vars', () => {
  const env = { TNA_ENV: 'development', TNA_TENANT_ID: 'tenant_x', TNA_PORT: '5000', OP: 'x', TNA_OPERATOR_TOKEN: 'op', TNA_ADMIN_TOKEN: 'ad', TNA_SERVICE_TOKEN: 'sv' };
  const config = loadDeploymentConfigFromEnv(env);
  assert.equal(config.network.port, 5000);
  assert.equal(config.tenant_id, 'tenant_x');
});

test('loadDeploymentConfigFromEnv rejects a non-numeric port', () => {
  const env = { TNA_ENV: 'development', TNA_PORT: 'not-a-number', TNA_OPERATOR_TOKEN: 'op', TNA_ADMIN_TOKEN: 'ad', TNA_SERVICE_TOKEN: 'sv' };
  assert.throws(() => loadDeploymentConfigFromEnv(env));
});

test('redact scrubs secret-shaped fields and bearer-token-shaped strings, never mutating input', () => {
  const input = { admin_token: 'super-secret-value', nested: { api_key: 'k', note: 'fine' }, header: 'Bearer abc.def.ghi', ok: 'plain value' };
  const output = redact(input) as Record<string, unknown>;
  assert.equal(output.admin_token, '[REDACTED]');
  assert.equal((output.nested as Record<string, unknown>).api_key, '[REDACTED]');
  assert.equal((output.nested as Record<string, unknown>).note, 'fine');
  assert.equal(output.header, '[REDACTED]');
  assert.equal(output.ok, 'plain value');
  assert.equal(input.admin_token, 'super-secret-value', 'redact must not mutate its input');
});
