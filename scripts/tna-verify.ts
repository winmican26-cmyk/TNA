/**
 * TNA Deployment Engineering v0.1 — `tna verify` (section 82). Read-only: configuration, component
 * health, database accessibility, Ledger integrity, and version-compatibility self-consistency. Never
 * mutates production work — the Ledger integrity check runs with `persist: false`.
 *
 * Exit 0 when the deployment is READY (AVAILABLE or DEGRADED); exit 1 when NOT READY or when Ledger
 * integrity verification fails.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Gate } from '../apps/tna-gate-api/src/gate.js';
import { Store } from '../packages/evidence-core/src/index.js';
import { Ledger, LedgerStore } from '../packages/ledger-core/src/index.js';
import { SentinelRuntime, readerPrincipal as sentinelReaderPrincipal } from '../packages/sentinel-runtime/src/index.js';
import { AuditorRuntime, adminPrincipal as auditorAdmin } from '../packages/auditor-engine/src/index.js';
import { LedgerEvidenceProvider } from '../packages/auditor-evidence/src/index.js';
import { PlatformStore } from '../packages/platform-core/src/index.js';
import { assertVersionCompatible, COMPONENT_VERSIONS, verifyLedgerIntegrity } from '../packages/deployment-ops/src/index.js';
import { aggregateReadiness, runProbe } from '../packages/deployment-health/src/index.js';
import { loadAppConfig } from '../apps/tna-platform/src/config.js';

function log(event: string, message: string): void { process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), event, message }) + '\n'); }

async function main(): Promise<boolean> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = loadAppConfig(root);
  log('CONFIG_VALIDATED', `environment=${config.deployment.environment} config_hash=${config.configHash}`);

  try { assertVersionCompatible(COMPONENT_VERSIONS); log('VERSION_COMPATIBLE', Object.entries(COMPONENT_VERSIONS).map(([k, v]) => `${k}=${v}`).join(' ')); }
  catch (error) { log('VERSION_INCOMPATIBLE', error instanceof Error ? error.message : String(error)); return false; }

  const gateStore = new Store(resolve(config.dataDir, 'tna-platform-gate.sqlite'));
  const gate = new Gate(gateStore);
  const sentinel = new SentinelRuntime(resolve(config.dataDir, 'tna-platform-sentinel.sqlite'));
  const ledgerStore = new LedgerStore(resolve(config.dataDir, 'tna-ledger.sqlite'));
  const platform = new PlatformStore(resolve(config.dataDir, 'tna-platform.sqlite'));
  const auditorRuntime = new AuditorRuntime(resolve(config.dataDir, 'tna-platform-auditor.sqlite'), { evidenceProvider: new LedgerEvidenceProvider(new Ledger(ledgerStore), { readerId: 'verify-ledger-reader' }) });

  const components = await Promise.all([
    runProbe('platform_store', true, () => platform.list(config.deployment.tenant_id, { limit: 1 })),
    runProbe('gate', true, () => gate.isAgentRevoked('__verify_probe__')),
    runProbe('sentinel', true, () => sentinel.getActivePolicy(sentinelReaderPrincipal('verify-probe', config.deployment.tenant_id))),
    runProbe('ledger', true, () => ledgerStore.listAllStreams()),
    runProbe('auditor', false, () => auditorRuntime.listAssessments(auditorAdmin('verify-probe', config.deployment.tenant_id), 1)),
  ]);
  const readiness = aggregateReadiness(components);
  for (const component of components) log('COMPONENT_HEALTH', `${component.component}=${component.status}${component.message ? ` (${component.message})` : ''}`);
  log('READINESS', readiness.status);

  const integrity = verifyLedgerIntegrity(ledgerStore, { persist: false });
  log(integrity.valid ? 'LEDGER_INTEGRITY_PASS' : 'LEDGER_INTEGRITY_FAIL', `streams_checked=${integrity.streamsChecked} invalid=${integrity.invalidStreams.length}`);

  gateStore.close(); sentinel.close(); ledgerStore.close(); platform.close(); auditorRuntime.close();
  return readiness.ready && integrity.valid;
}

main().then(ok => { log('VERIFY_RESULT', ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1); })
  .catch(error => { process.stderr.write(`tna verify failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
