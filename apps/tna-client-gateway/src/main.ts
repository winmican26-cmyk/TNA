/**
 * TNA Client Integration & MCP Gateway v0.1 (Volume 10). Startup entry point — follows the exact
 * pattern of `apps/tna-platform/src/main.ts`: load config, open stores, wire dependencies, create
 * server, register shutdown handlers.
 *
 * Packaged-execution closure (TNA-64): this is the real production composition root. In 'governed'
 * mode (the default, and the only mode permitted in production — see `config.ts`), it constructs the
 * real Gate/Sentinel/PlatformStore/Ledger/ExecutionBroker composition from `governed-execution.ts` and
 * passes it into the server; if that construction fails for any reason, startup fails closed — the
 * process exits non-zero *before* `server.listen` is ever called, so there is no window in which a
 * partially-wired server accepts requests. There is no code path from a construction failure back to
 * an unmonitored/record-only server: 'record-only' is only ever reached by an explicit
 * `CLIENT_GATEWAY_MODE=record-only`, which `config.ts` already refuses outright in production.
 */

import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { ClientStore } from '../../../packages/client-core/src/index.js';
import { loadClientGatewayConfig } from './config.js';
import { createClientGatewayServer, type ClientGatewayServerDeps } from './server.js';
import { shutdownMcpClients } from './connectors.js';
import { buildGovernedIntegration, type GovernedIntegration } from './governed-execution.js';

const startedAt = Date.now();

// Section 15, 17: config is loaded and validated *before* anything durable is touched.
const config = loadClientGatewayConfig();

// Ensure the data directory exists
const dbDir = resolve(dirname(config.dbPath));
mkdirSync(dbDir, { recursive: true, mode: 0o700 });
mkdirSync(resolve(config.dataDir), { recursive: true, mode: 0o700 });

const store = new ClientStore(config.dbPath);
console.log(`[tna-client-gateway] Store opened at ${config.dbPath}`);

let governed: GovernedIntegration | null = null;
let dispatchTimer: ReturnType<typeof setInterval> | null = null;
const serverDeps: ClientGatewayServerDeps = { store, startedAt, mode: config.mode };

if (config.mode === 'governed') {
  // TNA-64: fail closed. A thrown error here must propagate out of this module and crash the process
  // before `server.listen` is reached — never caught, downgraded, or silently retried into a weaker
  // mode. `npm start`/the container's process supervisor sees a non-zero exit, exactly like any other
  // fatal startup failure in this project (a bad DeploymentConfig, an unreachable required file, etc.).
  governed = buildGovernedIntegration(store, resolve(config.dataDir));
  console.log('[tna-client-gateway] Governed execution wired: Gate -> Capability -> Sentinel -> ExecutionBroker -> MCP -> Ledger');
  Object.assign(serverDeps, {
    platformFacadeFor: governed.platformFacadeFor,
    syncGovernedTenant: governed.syncGovernedTenant,
  });
  dispatchTimer = setInterval(() => {
    governed!.dispatchOnce().catch(error => console.error('[tna-client-gateway] Ledger dispatch tick failed', error));
  }, 2000);
} else {
  console.warn(
    '[tna-client-gateway] CLIENT_GATEWAY_MODE=record-only — client actions are ONLY recorded, never ' +
    'executed through Gate/Capability/Sentinel/MCP. This mode provides NO GOVERNED EXECUTION ASSURANCE ' +
    'and is refused outright when NODE_ENV=production (see config.ts).',
  );
}

const server = createClientGatewayServer(serverDeps, config.adminToken);

server.listen(config.port, config.host, () => {
  console.log(`[tna-client-gateway] TNA Client Gateway listening on http://${config.host}:${config.port} (mode=${config.mode})`);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[tna-client-gateway] Graceful shutdown initiated (${signal})`);
  if (dispatchTimer) clearInterval(dispatchTimer);
  server.close(() => {
    void shutdownMcpClients().then(() => {
      governed?.close();
      store.close();
      console.log('[tna-client-gateway] Graceful shutdown complete');
      process.exit(0);
    });
  });
  server.closeIdleConnections();
});
