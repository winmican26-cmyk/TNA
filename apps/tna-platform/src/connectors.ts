import { ToolRegistry, type ToolDefinition, type ToolHandlerContext } from '../../../packages/execution-broker/src/index.js';
import { ConnectorRegistry, DEMO_ECHO_CONNECTOR, type ToolConnector } from '../../../packages/platform-connectors/src/index.js';

/** Mirrors `ExecutionBroker`'s own private `operation()` rule (execution-broker/src/index.ts): capability
 * binding always uses 'write' for `production.deploy` and 'read' for every other action — a Gate/Broker
 * internal convention, not a platform policy. See `platform-gate-integration-v0.1.md`. */
function brokerAllowedOperations(action: string): readonly string[] { return action === 'production.deploy' ? ['write'] : ['read']; }

/**
 * Adapts a trusted `ToolConnector` (section 57) into a Gate `ToolRegistry` entry so execution is
 * always broker-mediated (section 22, 24) — the connector's own `execute()` becomes the registered
 * `ToolHandler`, never callable directly from the platform API. `resourceType`/`networkRequired` are
 * the connector's own declared metadata; `allowedOperations` is Gate/Broker's own internal binding
 * convention (see `brokerAllowedOperations`), independent of the connector's own operation semantics.
 */
export function buildToolRegistry(connectors: ConnectorRegistry, tenantId: string): ToolRegistry {
  const registry = new ToolRegistry();
  for (const connector of connectors.list(tenantId)) {
    const definition: ToolDefinition = {
      name: connector.tool, action: connector.action, resourceType: 'platform-connector',
      allowedOperations: brokerAllowedOperations(connector.action), networkRequired: connector.network_required,
      credentialsRequired: [],
      handler: async (context: ToolHandlerContext) => {
        const result = await connector.execute({
          platform_action_id: context.decisionId, execution_id: context.executionId, agent_id: context.agentId,
          decision_id: context.decisionId, tenant_id: tenantId, operation: context.operation, resource: context.resource,
          destination: context.destination, input: context.input,
        });
        return result.output;
      },
    };
    registry.register(definition);
  }
  return registry;
}

/** Trusted startup registration (section 76) — the only connector wired into the demo/default
 * deployment. Registering additional connectors here (never from caller/request input) is how a real
 * deployment would extend the tool surface. */
export function buildDefaultConnectorRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(DEMO_ECHO_CONNECTOR);
  return registry;
}
export type { ToolConnector };
