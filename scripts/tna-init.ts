/**
 * TNA Deployment Engineering v0.1 — `tna init` (section 76). Validates configuration, creates the data
 * directory and every component database (triggering each accepted component's own internal schema
 * creation — never reimplemented here), generates a deployment identity, and verifies filesystem
 * permissions. Never touches production data through any other code path — this is the one explicit,
 * operator-invoked initialization step (section 76: "Do not silently initialize production data
 * directories during arbitrary API requests").
 *
 * Exit 0 on success, non-zero on any validation/initialization failure.
 */
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Store } from '../packages/evidence-core/src/index.js';
import { Ledger, LedgerStore } from '../packages/ledger-core/src/index.js';
import { SentinelRuntime, adminPrincipal as sentinelAdmin } from '../packages/sentinel-runtime/src/index.js';
import { AuditorRuntime } from '../packages/auditor-engine/src/index.js';
import { LedgerEvidenceProvider } from '../packages/auditor-evidence/src/index.js';
import { PlatformStore } from '../packages/platform-core/src/index.js';
import { initDeploymentIdentity } from '../packages/deployment-ops/src/index.js';
import { loadAppConfig } from '../apps/tna-platform/src/config.js';

function log(event: string, message: string): void { process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), event, message }) + '\n'); }

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = loadAppConfig(root);
  log('CONFIG_VALIDATED', `environment=${config.deployment.environment} tenant=${config.deployment.tenant_id} config_hash=${config.configHash}`);

  const gateStore = new Store(resolve(config.dataDir, 'tna-platform-gate.sqlite'));
  const ledgerStore = new LedgerStore(resolve(config.dataDir, 'tna-ledger.sqlite'));
  const sentinel = new SentinelRuntime(resolve(config.dataDir, 'tna-platform-sentinel.sqlite'));
  try { sentinel.getActivePolicy(sentinelAdmin('init-sentinel-admin', config.deployment.tenant_id)); }
  catch { sentinel.installDefaultPolicy(sentinelAdmin('init-sentinel-admin', config.deployment.tenant_id)); }
  const platform = new PlatformStore(resolve(config.dataDir, 'tna-platform.sqlite'));
  const auditorRuntime = new AuditorRuntime(resolve(config.dataDir, 'tna-platform-auditor.sqlite'), { evidenceProvider: new LedgerEvidenceProvider(new Ledger(ledgerStore), { readerId: 'init-ledger-reader' }) });
  log('DATABASES_INITIALIZED', 'gate, ledger, sentinel, platform, and auditor schemas are present');
  gateStore.close(); ledgerStore.close(); sentinel.close(); platform.close(); auditorRuntime.close();

  const identity = initDeploymentIdentity(config.dataDir, '0.1.0');
  log('DEPLOYMENT_IDENTITY', `deployment_id=${identity.deployment_id} created_at=${identity.created_at}`);

  if (process.platform === 'win32') {
    log('PERMISSIONS_SKIPPED', 'POSIX file-mode verification is not meaningful on Windows; verified by the real container test instead');
  } else {
    const mode = statSync(config.dataDir).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`data directory ${config.dataDir} is group/world-accessible (mode ${mode.toString(8)}) — refusing to proceed`);
    log('PERMISSIONS_VERIFIED', `data directory mode ${mode.toString(8)}`);
  }

  log('INIT_COMPLETE', `deployment ${identity.deployment_id} initialized at ${config.dataDir}`);
}

main().catch(error => { process.stderr.write(`tna init failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
