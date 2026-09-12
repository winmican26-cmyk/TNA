import { loadControlCenterConfig } from './config.js';
import { ControlCenterSessionStore } from './session-store.js';
import { loadTenantRegistry } from './tenant-registry.js';
import { PlatformProxyClient } from './platform-client.js';
import { ClientGatewayProxyClient } from './client-gateway-client.js';
import { LedgerProxyClient } from './ledger-client.js';
import { AuditorProxyClient } from './auditor-client.js';
import { ImprovementGovernorProxyClient } from './improvement-client.js';
import { createControlCenterServer } from './server.js';

const config = loadControlCenterConfig();
const sessions = new ControlCenterSessionStore(config.dbPath);
const tenants = loadTenantRegistry(config.tenantRegistryPath);
const platform = new PlatformProxyClient();
const clientGatewayClient = config.clientGateway ? new ClientGatewayProxyClient() : null;
const ledger = new LedgerProxyClient();
const auditor = new AuditorProxyClient();
const improvement = new ImprovementGovernorProxyClient();
const startedAt = Date.now();

const server = createControlCenterServer({
  sessions, tenants, platform, cookieSecure: config.cookieSecure, startedAt, staticRoot: config.staticRoot,
  clientGateway: config.clientGateway, clientGatewayClient, ledger, auditor, improvement,
  environment: config.environment, trustedOrigins: config.trustedOrigins,
});
server.listen(config.port, config.host, () => {
  process.stdout.write(`TNA Control Center BFF listening on http://${config.host}:${config.port}\n`);
});

function shutdown(): void {
  server.close(() => { sessions.close(); process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
