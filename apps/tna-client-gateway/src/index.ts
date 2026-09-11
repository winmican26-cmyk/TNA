/**
 * TNA Client Integration & MCP Gateway v0.1 (Volume 10). Re-exports for the client gateway
 * entrypoint — mirrors `apps/tna-platform/src/index.ts`.
 */
export { loadClientGatewayConfig, type ClientGatewayConfig } from './config.js';
export { createClientGatewayServer, HttpError, type ClientGatewayServerDeps } from './server.js';
export { buildMcpConnector, buildToolRegistry, registerMcpConnectors, shutdownMcpClients, type McpToolConnector } from './connectors.js';
export { buildGovernedIntegration, buildTenantGateEnvelope, type GovernedIntegration } from './governed-execution.js';
