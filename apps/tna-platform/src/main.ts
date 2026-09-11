import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Gate } from '../../tna-gate-api/src/gate.js';
import { Store } from '../../../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../../../packages/capability-core/src/index.js';
import { ExecutionBroker } from '../../../packages/execution-broker/src/index.js';
import { LedgerStore, Ledger } from '../../../packages/ledger-core/src/index.js';
import { platformWriter, platformLedgerReader } from '../../tna-ledger/src/writers.js';
import { SentinelRuntime, controllerPrincipal as sentinelControllerPrincipal, observerPrincipal as sentinelObserverPrincipal, readerPrincipal as sentinelReaderPrincipal, adminPrincipal as sentinelAdminPrincipal } from '../../../packages/sentinel-runtime/src/index.js';
import { AuditorRuntime, adminPrincipal as auditorAdminPrincipal } from '../../../packages/auditor-engine/src/index.js';
import { LedgerEvidenceProvider } from '../../../packages/auditor-evidence/src/index.js';
import { PlatformStore, PlatformGateOrchestrator, PlatformExecutionOrchestrator, PlatformControlOrchestrator, PlatformFacade, PlatformLedgerDispatcher } from '../../../packages/platform-core/src/index.js';
import { buildPlatformMetrics } from '../../../packages/deployment-health/src/index.js';
import { initDeploymentIdentity, acquireRunningLock, releaseRunningLock } from '../../../packages/deployment-ops/src/index.js';
import { GateActionAdapter } from './gate-adapter.js';
import { VadVerificationAdapter } from './vad-adapter.js';
import { buildToolRegistry, buildDefaultConnectorRegistry } from './connectors.js';
import { createPlatformServer } from './server.js';
import { createLogger } from './logging.js';
import { refreshOutboxGauges } from './diagnostics.js';
import { loadAppConfig } from './config.js';
import type { PlatformCredentials } from './writers.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const logger = createLogger('tna-platform');
const startedAt = Date.now();

// Section 15, 17, TNA-55: config is loaded and validated *before* anything durable is touched — an
// invalid or insecure configuration must never reach the point of opening a database file.
const config = loadAppConfig(root);
const tenantId = config.deployment.tenant_id;
const port = config.deployment.network.port;

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
// Section 53, 72, 99: a running-process lock — a fresh restart recovers a stale (crashed) lock exactly
// like the platform's own outbox lease does; a still-live sibling process is never silently overwritten.
acquireRunningLock(config.dataDir);
const identity = initDeploymentIdentity(config.dataDir, '0.1.0');
logger.log('info', 'Deployment identity resolved', { event: 'DEPLOYMENT_IDENTITY', deployment_id: identity.deployment_id, config_hash: config.configHash, environment: config.deployment.environment });

// Section 3 explicitly excludes full external customer IAM from this milestone — a single static
// agent credential (env-provided, outside the strict DeploymentConfig schema) is the v0.1 stand-in,
// unchanged in spirit from Volume 8's own demo credential. A real multi-agent identity provider is a
// future milestone's concern, not invented here.
const demoAgentToken = process.env.TNA_PLATFORM_DEMO_AGENT_TOKEN ?? '';
const demoAgentId = process.env.TNA_PLATFORM_DEMO_AGENT_ID ?? '';
const credentials: PlatformCredentials = {
  agentTokens: demoAgentToken && demoAgentId ? { [demoAgentToken]: demoAgentId } : {},
  operatorToken: config.secrets.operatorToken, adminToken: config.secrets.adminToken, serviceToken: config.secrets.serviceToken,
};

// Gate + broker-mediated connector execution (section 52: platform owns its own Gate/broker store,
// separate from the standalone tna-gate-api app's own file).
const gateStore = new Store(resolve(config.dataDir, 'tna-platform-gate.sqlite'));
const gate = new Gate(gateStore);
const connectors = buildDefaultConnectorRegistry();
const toolRegistry = buildToolRegistry(connectors, tenantId);
const capabilityKeyBuffer = config.secrets.capabilityKey ? Buffer.from(config.secrets.capabilityKey, 'utf8') : randomBytes(32);
if (config.ephemeralCapabilityKey) logger.log('warn', 'No capability_key_ref configured — using a random in-memory key (only acceptable outside production)', { event: 'EPHEMERAL_CAPABILITY_KEY', environment: config.deployment.environment });
const broker = new ExecutionBroker(
  gateStore, new CapabilityCodec(capabilityKeyBuffer), toolRegistry,
  { isAgentRevoked: agentId => gate.isAgentRevoked(agentId), isPolicyCurrent: decision => gate.isPolicyCurrent(decision), isDecisionCurrent: decision => gate.isPolicyCurrent(decision) },
);

// Sentinel — its own store, default deterministic containment/no revalidator (section 52).
const sentinel = new SentinelRuntime(resolve(config.dataDir, 'tna-platform-sentinel.sqlite'));
try { sentinel.getActivePolicy(sentinelAdminPrincipal('platform-sentinel-admin', tenantId)); }
catch { sentinel.installDefaultPolicy(sentinelAdminPrincipal('platform-sentinel-admin', tenantId)); }

// Ledger — the integrated evidence backbone (section 32), the same file the standalone tna-ledger app writes.
const ledgerStore = new LedgerStore(resolve(config.dataDir, 'tna-ledger.sqlite'));
const ledger = new Ledger(ledgerStore);

// Platform's own durable control-plane store + outbox.
const platform = new PlatformStore(resolve(config.dataDir, 'tna-platform.sqlite'));
const gateOrchestrator = new PlatformGateOrchestrator(platform, new GateActionAdapter(gate));
const executionOrchestrator = new PlatformExecutionOrchestrator(
  platform, broker, sentinel, sentinelControllerPrincipal('platform-sentinel-controller', tenantId),
  sentinelObserverPrincipal('platform-execution-broker', tenantId, ['EXECUTION_BROKER']), new VadVerificationAdapter(),
);
const control = new PlatformControlOrchestrator(platform);
const facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);
const dispatcher = new PlatformLedgerDispatcher(platform, { append: input => ledger.append(platformWriter(tenantId), input) });
void platformLedgerReader; // reserved for a future read-side platform Ledger reconstruction endpoint

// Auditor — post-hoc only (section 43), never in the critical execution path above.
const auditorEvidenceProvider = new LedgerEvidenceProvider(ledger, { readerId: 'ledger-reader-platform-auditor' });
const auditorRuntime = new AuditorRuntime(resolve(config.dataDir, 'tna-platform-auditor.sqlite'), { evidenceProvider: auditorEvidenceProvider });
const auditorPrincipal = auditorAdminPrincipal('platform-auditor-admin', tenantId);

const metrics = buildPlatformMetrics();
const server = createPlatformServer({
  store: platform, facade, control, auditor: { runtime: auditorRuntime, principal: auditorPrincipal },
  health: {
    store: platform, tenantId, gate, sentinel, sentinelHealthPrincipal: sentinelReaderPrincipal('platform-health-probe', tenantId),
    ledgerStore, auditor: { runtime: auditorRuntime, principal: auditorPrincipal },
  },
  metrics, startedAt, configHash: config.configHash, deploymentId: identity.deployment_id,
}, credentials, tenantId);

const dispatchTimer = setInterval(() => {
  dispatcher.dispatchOnce()
    .then(result => { if (result.failed > 0) metrics.inc('outbox_delivery_failures_total', result.failed); refreshOutboxGauges(metrics, platform, tenantId); })
    .catch(error => logger.log('error', 'Outbox dispatch tick failed', { event: 'OUTBOX_DISPATCH_ERROR', error_code: error instanceof Error ? error.message : 'unknown' }));
}, 2000);

server.listen(port, config.deployment.network.host, () => {
  logger.log('info', `TNA Platform listening on http://${config.deployment.network.host}:${port}`, { event: 'SERVER_LISTENING', environment: config.deployment.environment });
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.log('info', 'Graceful shutdown initiated', { event: 'SHUTDOWN_STARTED', signal });
  // Section 53-55: stop accepting new work and stop claiming new outbox deliveries immediately — an
  // in-flight claim already owned by this process is left exactly as it is; its lease will either be
  // completed by this process before exit or, if not, recovered by lease expiry (section 54: never
  // stolen preemptively, never falsely marked delivered).
  clearInterval(dispatchTimer);
  server.close(() => {
    platform.close(); sentinel.close(); ledgerStore.close(); gateStore.close(); auditorRuntime.close();
    releaseRunningLock(config.dataDir);
    logger.log('info', 'Graceful shutdown complete', { event: 'SHUTDOWN_COMPLETE' });
    process.exit(0);
  });
  server.closeIdleConnections();
});
