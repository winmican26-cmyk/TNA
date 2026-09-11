import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SentinelRuntime } from '../../../packages/sentinel-runtime/src/index.js';
import { admin } from './writers.js';
import { createSentinelServer, type SentinelCredentials } from './server.js';

// Resolve from this compiled module, never from an arbitrary caller's working directory.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const data = resolve(root, 'data');
const tenantId = process.env.TNA_SENTINEL_TENANT ?? 'tenant_demo';
const env = (name: string): string => process.env[name] ?? '';
const credentials: SentinelCredentials = {
  observerGateToken: env('TNA_SENTINEL_OBSERVER_GATE_TOKEN'), observerBrokerToken: env('TNA_SENTINEL_OBSERVER_BROKER_TOKEN'),
  observerIsolationToken: env('TNA_SENTINEL_OBSERVER_ISOLATION_TOKEN'), observerEgressToken: env('TNA_SENTINEL_OBSERVER_EGRESS_TOKEN'),
  observerSecretBrokerToken: env('TNA_SENTINEL_OBSERVER_SECRET_BROKER_TOKEN'), observerToolAdapterToken: env('TNA_SENTINEL_OBSERVER_TOOL_ADAPTER_TOKEN'),
  observerVadToken: env('TNA_SENTINEL_OBSERVER_VAD_TOKEN'), observerSystemToken: env('TNA_SENTINEL_OBSERVER_SYSTEM_TOKEN'),
  readerToken: env('TNA_SENTINEL_READER_TOKEN'), controllerToken: env('TNA_SENTINEL_CONTROLLER_TOKEN'), adminToken: env('TNA_SENTINEL_ADMIN_TOKEN'),
};
const port = Number(process.env.PORT ?? 4517);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

mkdirSync(data, { recursive: true });
const runtime = new SentinelRuntime(resolve(data, 'tna-sentinel.sqlite'));
try { runtime.getActivePolicy(admin(tenantId)); } catch { runtime.installDefaultPolicy(admin(tenantId)); }
const server = createSentinelServer(runtime, credentials, tenantId);
server.listen(port, '127.0.0.1', () => process.stdout.write(`TNA Sentinel listening on http://127.0.0.1:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  server.close(() => { runtime.close(); process.exit(0); });
  server.closeIdleConnections();
});
