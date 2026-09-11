/**
 * TNA Client Integration & MCP Gateway v0.1 (Volume 10). MCP connector wiring (§41-42).
 *
 * `buildMcpConnector` creates a `ToolConnector` whose `execute()` method spawns/reuses an
 * `McpStdioClient` for the registered MCP server, calls the tool through the MCP protocol, and
 * returns the result. This connector is registered in the `ConnectorRegistry` so the execution
 * flow is:
 *
 *   ClientAction → PlatformAction → Gate → Capability → Sentinel → ExecutionBroker →
 *     MCP connector → MCP server → Tool
 *
 * Follows the exact pattern from `apps/tna-platform/src/connectors.ts` — adapts `ToolConnector`
 * into Gate's `ToolRegistry` shape via `buildToolRegistry()`.
 */

import { ToolRegistry, type ToolDefinition, type ToolHandlerContext } from '../../../packages/execution-broker/src/index.js';
import { ConnectorRegistry, type ToolConnectorContext, type McpToolConnector } from '../../../packages/platform-connectors/src/index.js';
import { McpStdioClient, type McpToolCallResult } from '../../../packages/mcp-gateway/src/index.js';
import { McpError, toolPlatformId, type GovernedToolDefinition, type McpServerRegistration } from '../../../packages/mcp-schema/src/index.js';
import type { ClientStore } from '../../../packages/client-core/src/index.js';

/** Cache of live MCP stdio clients keyed by `tenantId\0serverId`. Shared across connectors
 * registered for the same MCP server — avoids spawning duplicate child processes for the same
 * server when multiple tools from that server are invoked in sequence. */
const clientCache = new Map<string, McpStdioClient>();

async function getOrCreateClient(server: McpServerRegistration): Promise<McpStdioClient> {
  const key = `${server.tenant_id}\0${server.mcp_server_id}`;
  const existing = clientCache.get(key);
  if (existing && existing.pid !== null) return existing;
  // Clean up any stale entry
  clientCache.delete(key);
  const client = new McpStdioClient({
    executable: server.executable,
    args: server.args,
    envAllowlist: server.env_allowlist as string[],
  });
  await client.connect();
  clientCache.set(key, client);
  return client;
}

/**
 * §41-42: Builds a `ToolConnector` for a specific governed MCP tool. The connector's `execute()`
 * method spawns/reuses an McpStdioClient for the registered MCP server, calls the tool through the
 * MCP protocol, and returns the result. The connector identity is the governed tool's platform id
 * (`mcp.<tool_id>`) — never the raw external tool name — so two MCP servers exposing tools of the
 * same name can never collide (§108-109).
 */
export function buildMcpConnector(
  tenantId: string,
  serverId: string,
  tool: GovernedToolDefinition,
  store: ClientStore,
): McpToolConnector {
  const platformId = toolPlatformId(tool.tool_id);
  return {
    connector_id: `connector-mcp-${tool.tool_id}`,
    tenant_id: tenantId,
    tool: platformId,
    action: `${platformId}.execute`,
    allowed_operations: tool.allowed_operations as string[],
    risk_classification: tool.risk_class === 'CRITICAL' ? 'HIGH' : (tool.risk_class === 'HIGH' ? 'HIGH' : (tool.risk_class === 'MEDIUM' ? 'MEDIUM' : 'LOW')),
    network_required: false,
    mcp_server_id: serverId,
    mcp_tool_name: tool.external_tool_name,
    async execute(context: ToolConnectorContext): Promise<{ output: unknown; cost_usd?: number }> {
      const server = store.getMcpServer(tenantId, serverId);
      if (server.status === 'DISABLED') {
        throw new McpError('MCP_SERVER_UNAVAILABLE', `MCP server ${serverId} is disabled`);
      }
      const currentTool = store.getTool(tenantId, tool.tool_id);
      if (!currentTool.enabled) {
        throw new McpError('MCP_TOOL_DISABLED', `Tool ${tool.tool_id} is disabled`);
      }
      let client: McpStdioClient;
      try {
        client = await getOrCreateClient(server);
      } catch (error) {
        // Invalidate cache on connection failure
        const key = `${server.tenant_id}\0${server.mcp_server_id}`;
        clientCache.delete(key);
        throw error instanceof McpError ? error : new McpError('MCP_SERVER_UNAVAILABLE', `Failed to connect to MCP server: ${error instanceof Error ? error.message : String(error)}`);
      }
      let result: McpToolCallResult;
      try {
        result = await client.callTool(tool.external_tool_name, context.input);
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError('MCP_PROTOCOL_ERROR', error instanceof Error ? error.message : String(error));
      }
      if (result.is_error) {
        throw new McpError('MCP_PROTOCOL_ERROR', `MCP tool returned an error: ${JSON.stringify(result.content).slice(0, 500)}`);
      }
      return { output: result.content, cost_usd: 0 };
    },
  };
}

/** Mirrors `ExecutionBroker`'s own private `operation()` rule: capability binding always uses 'write'
 * for `production.deploy` and 'read' for every other action — a Gate/Broker internal convention. */
function brokerAllowedOperations(action: string): readonly string[] {
  return action === 'production.deploy' ? ['write'] : ['read'];
}

/**
 * Adapts trusted `ToolConnector`s (§57) into a Gate `ToolRegistry` so execution is always
 * broker-mediated (§22, 24) — the connector's own `execute()` becomes the registered `ToolHandler`,
 * never callable directly from an API surface. Same pattern as `tna-platform/src/connectors.ts`.
 */
export function buildToolRegistry(connectors: ConnectorRegistry, tenantId: string, into: ToolRegistry = new ToolRegistry()): ToolRegistry {
  const registry = into;
  for (const connector of connectors.list(tenantId)) {
    const definition: ToolDefinition = {
      name: connector.tool,
      action: connector.action,
      resourceType: 'mcp-connector',
      allowedOperations: brokerAllowedOperations(connector.action),
      networkRequired: connector.network_required,
      credentialsRequired: [],
      handler: async (context: ToolHandlerContext) => {
        const result = await connector.execute({
          platform_action_id: context.decisionId,
          execution_id: context.executionId,
          agent_id: context.agentId,
          decision_id: context.decisionId,
          tenant_id: tenantId,
          operation: context.operation,
          resource: context.resource,
          destination: context.destination,
          input: context.input,
        });
        return result.output;
      },
    };
    try { registry.register(definition); } catch { /* already registered — idempotent re-sync (§ packaged-path closure) */ }
  }
  return registry;
}

/** Registers MCP connectors for all enabled governed tools belonging to a tenant. */
export function registerMcpConnectors(registry: ConnectorRegistry, store: ClientStore, tenantId: string): void {
  const tools = store.listTools(tenantId);
  for (const tool of tools) {
    if (!tool.enabled) continue;
    const connector = buildMcpConnector(tenantId, tool.provider_id, tool, store);
    try {
      registry.register(connector);
    } catch {
      // Already registered — skip (idempotent startup)
    }
  }
}

/** Shut down all cached MCP clients for graceful cleanup. */
export async function shutdownMcpClients(): Promise<void> {
  const shutdowns: Promise<void>[] = [];
  for (const [key, client] of clientCache) {
    shutdowns.push(client.shutdown().catch(() => { /* best-effort */ }));
    clientCache.delete(key);
  }
  await Promise.all(shutdowns);
}

export type { McpToolConnector };
