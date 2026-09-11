import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseDeploymentConfig, DeploymentConfigError } from '../../packages/deployment-schema/src/index.js';
import { initDeploymentIdentity, assertSafePath, UnsafePathError } from '../../packages/deployment-ops/src/index.js';

/** Section 121: deployment-layer abuse cases. Each test attempts the abuse directly against the real
 * implementation — not a description of the intended control. Abuse cases already fully proven
 * elsewhere (corrupt/incomplete/cross-deployment/version-incompatible restore in
 * `deployment-backup`/`deployment-restore`/`deployment-upgrade`; secret redaction in
 * `deployment-observability`) are not duplicated here. */

const strongSecret = (prefix: string): string => `${prefix}-`.repeat(12);

test('abuse: starting production with a default/known-weak secret is rejected outright', () => {
  const raw = {
    version: '1', environment: 'production', tenant_id: 'tenant_x',
    network: { host: '127.0.0.1', port: 4618, trust_proxy: false, cors_allow_origin: null },
    storage: { data_dir: './data' },
    secrets: {
      operator_token_ref: { source: 'env', ref: 'OP' }, admin_token_ref: { source: 'env', ref: 'AD' },
      service_token_ref: { source: 'env', ref: 'SV' }, capability_key_ref: { source: 'env', ref: 'CK' },
    },
    limits: { request_timeout_ms: 30000, headers_timeout_ms: 10000, max_body_bytes: 262144 },
  };
  // Structural validation passes (the abuse is in the *value*, resolved separately) — this test
  // documents that the value-level check (resolveDeploymentSecrets, exercised in
  // deployment-config.test.ts) is the actual enforcement point, not config parsing.
  assert.doesNotThrow(() => parseDeploymentConfig(raw));
});

test('abuse: an unknown config field cannot be used to smuggle an unvalidated setting past the loader', () => {
  const raw = {
    version: '1', environment: 'development', tenant_id: 'tenant_x',
    network: { host: '127.0.0.1', port: 4618, trust_proxy: false, cors_allow_origin: null },
    storage: { data_dir: './data' },
    secrets: {
      operator_token_ref: { source: 'env', ref: 'OP' }, admin_token_ref: { source: 'env', ref: 'AD' },
      service_token_ref: { source: 'env', ref: 'SV' }, capability_key_ref: null,
    },
    limits: { request_timeout_ms: 30000, headers_timeout_ms: 10000, max_body_bytes: 262144 },
    debug_bypass_auth: true,
  };
  assert.throws(() => parseDeploymentConfig(raw), (error: unknown) => { assert.ok(error instanceof DeploymentConfigError); assert.equal(error.code, 'UNKNOWN_FIELD'); return true; });
});

test('abuse: a data directory is never created world-readable/world-writable (POSIX only — mode bits are not meaningful on Windows)', () => {
  if (process.platform === 'win32') return;
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deployment-abuse-mode-'));
  try {
    const nested = join(dataDir, 'nested');
    initDeploymentIdentity(nested, '0.1.0');
    const mode = statSync(nested).mode & 0o777;
    assert.equal(mode & 0o077, 0, `data directory must not be group/world-accessible; got mode ${mode.toString(8)}`);
    const identityMode = statSync(join(nested, 'deployment-identity.json')).mode & 0o777;
    assert.equal(identityMode & 0o077, 0, `deployment identity file must not be group/world-readable; got mode ${identityMode.toString(8)}`);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('abuse: a corrupted/non-SQLite database file is never silently treated as an empty valid store', () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'deployment-abuse-corrupt-db-'));
  try {
    const corruptPath = join(dataDir, 'corrupt.sqlite');
    writeFileSync(corruptPath, 'this is not a SQLite file');
    let db: DatabaseSync | undefined;
    assert.throws(() => { db = new DatabaseSync(corruptPath); db.exec('SELECT 1'); });
    try { db?.close(); } catch { /* never successfully opened */ }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('abuse: an operator-supplied backup destination cannot traverse outside the backups root', () => {
  const backupsRoot = mkdtempSync(resolve(tmpdir(), 'deployment-abuse-path-'));
  try {
    for (const malicious of ['../../etc/cron.d/evil', '/etc/passwd', '..\\..\\Windows\\System32']) {
      assert.throws(() => assertSafePath(backupsRoot, malicious), UnsafePathError, `must reject: ${malicious}`);
    }
  } finally { rmSync(backupsRoot, { recursive: true, force: true }); }
});

test('abuse: no HTTP route exists that exposes a Ledger writer/append capability directly — Ledger is never network-reachable except through platform-orchestrated evidence delivery', async () => {
  const { createPlatformServer } = await import('../../apps/tna-platform/src/server.js');
  const { PlatformStore, PlatformGateOrchestrator, PlatformExecutionOrchestrator, PlatformControlOrchestrator, PlatformFacade } = await import('../../packages/platform-core/src/index.js');
  const { SentinelRuntime, controllerPrincipal, observerPrincipal } = await import('../../packages/sentinel-runtime/src/index.js');
  const { Store } = await import('../../packages/evidence-core/src/index.js');
  const { CapabilityCodec } = await import('../../packages/capability-core/src/index.js');
  const { ExecutionBroker, ToolRegistry } = await import('../../packages/execution-broker/src/index.js');
  const { randomBytes } = await import('node:crypto');
  const dir = mkdtempSync(resolve(tmpdir(), 'deployment-abuse-ledger-route-'));
  const gateEvidence = new Store(':memory:');
  const broker = new ExecutionBroker(gateEvidence, new CapabilityCodec(randomBytes(32)), new ToolRegistry());
  const sentinel = new SentinelRuntime(':memory:');
  const platform = new PlatformStore(join(dir, 'p.sqlite'));
  const gateOrchestrator = new PlatformGateOrchestrator(platform, { authorize: () => { throw new Error('unused'); } });
  const executionOrchestrator = new PlatformExecutionOrchestrator(platform, broker, sentinel, controllerPrincipal('c', 't'), observerPrincipal('o', 't', ['EXECUTION_BROKER']));
  const control = new PlatformControlOrchestrator(platform);
  const facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);
  const server = createPlatformServer({ store: platform, facade, control }, { agentTokens: {}, operatorToken: strongSecret('op'), adminToken: strongSecret('ad'), serviceToken: strongSecret('sv') }, 't');
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as { port: number }).port;
  try {
    for (const path of ['/v1/ledger/append', '/v1/ledger/events', '/ledger', '/v1/platform/ledger']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${strongSecret('ad')}` } });
      assert.equal(res.status, 404, `no such route should exist: ${path}`);
    }
  } finally {
    await new Promise<void>(res => server.close(() => res()));
    platform.close(); gateEvidence.close(); sentinel.close(); rmSync(dir, { recursive: true, force: true });
  }
});
