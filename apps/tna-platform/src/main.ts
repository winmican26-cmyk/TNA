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
import { SentinelRuntime, controllerPrincipal as sentinelControllerPrincipal, observerPrincipal as sentinelObserverPrincipal, adminPrincipal as sentinelAdminPrincipal } from '../../../packages/sentinel-runtime/src/index.js';
import { AuditorRuntime, adminPrincipal as auditorAdminPrincipal } from '../../../packages/auditor-engine/src/index.js';
import { LedgerEvidenceProvider } from '../../../packages/auditor-evidence/src/index.js';
import { PlatformStore, PlatformGateOrchestrator, PlatformExecutionOrchestrator, PlatformControlOrchestrator, PlatformFacade, PlatformLedgerDispatcher } from '../../../packages/platform-core/src/index.js';
import { GateActionAdapter } from './gate-adapter.js';
import { VadVerificationAdapter } from './vad-adapter.js';
import { buildToolRegistry, buildDefaultConnectorRegistry } from './connectors.js';
import { createPlatformServer } from './server.js';
import type { PlatformCredentials } from './writers.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const data = resolve(root, 'data');
const tenantId = process.env.TNA_PLATFORM_TENANT ?? 'tenant_demo';
const env = (name: string): string => process.env[name] ?? '';
const credentials: PlatformCredentials = {
  agentTokens: env('TNA_PLATFORM_DEMO_AGENT_TOKEN') && env('TNA_PLATFORM_DEMO_AGENT_ID')
    ? { [env('TNA_PLATFORM_DEMO_AGENT_TOKEN')]: env('TNA_PLATFORM_DEMO_AGENT_ID') } : {},
  operatorToken: env('TNA_PLATFORM_OPERATOR_TOKEN'), adminToken: env('TNA_PLATFORM_ADMIN_TOKEN'), serviceToken: env('TNA_PLATFORM_SERVICE_TOKEN'),
};
const port = Number(process.env.PORT ?? 4618);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

mkdirSync(data, { recursive: true });

// Gate + broker-mediated connector execution (section 52: platform owns its own Gate/broker store,
// separate from the standalone tna-gate-api app's own file).
const gateStore = new Store(resolve(data, 'tna-platform-gate.sqlite'));
const gate = new Gate(gateStore);
const connectors = buildDefaultConnectorRegistry();
const toolRegistry = buildToolRegistry(connectors, tenantId);
const capabilityKey = env('TNA_PLATFORM_CAPABILITY_KEY');
const broker = new ExecutionBroker(
  gateStore, new CapabilityCodec(capabilityKey.length >= 32 ? Buffer.from(capabilityKey, 'utf8') : randomBytes(32)), toolRegistry,
  { isAgentRevoked: agentId => gate.isAgentRevoked(agentId), isPolicyCurrent: decision => gate.isPolicyCurrent(decision), isDecisionCurrent: decision => gate.isPolicyCurrent(decision) },
);

// Sentinel — its own store, default deterministic containment/no revalidator (section 52).
const sentinel = new SentinelRuntime(resolve(data, 'tna-platform-sentinel.sqlite'));
try { sentinel.getActivePolicy(sentinelAdminPrincipal('platform-sentinel-admin', tenantId)); }
catch { sentinel.installDefaultPolicy(sentinelAdminPrincipal('platform-sentinel-admin', tenantId)); }

// Ledger — the integrated evidence backbone (section 32), the same file the standalone tna-ledger app writes.
const ledgerStore = new LedgerStore(resolve(data, 'tna-ledger.sqlite'));
const ledger = new Ledger(ledgerStore);

// Platform's own durable control-plane store + outbox.
const platform = new PlatformStore(resolve(data, 'tna-platform.sqlite'));
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
const auditorRuntime = new AuditorRuntime(resolve(data, 'tna-platform-auditor.sqlite'), { evidenceProvider: auditorEvidenceProvider });
const auditorPrincipal = auditorAdminPrincipal('platform-auditor-admin', tenantId);

const server = createPlatformServer({ store: platform, facade, control, auditor: { runtime: auditorRuntime, principal: auditorPrincipal } }, credentials, tenantId);

const dispatchTimer = setInterval(() => { dispatcher.dispatchOnce().catch(() => undefined); }, 2000);
server.listen(port, '127.0.0.1', () => process.stdout.write(`TNA Platform listening on http://127.0.0.1:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  clearInterval(dispatchTimer);
  server.close(() => { platform.close(); sentinel.close(); ledgerStore.close(); gateStore.close(); auditorRuntime.close(); process.exit(0); });
  server.closeIdleConnections();
});
