import { PlatformError } from '../../platform-schema/src/index.js';

/**
 * Connector abstraction (sections 57-58, 76-78). A connector describes a registered, trusted tool at
 * the platform level — its identity, risk classification, and the actual work it performs. Execution
 * still occurs through Gate's own accepted `ExecutionBroker`/`ToolRegistry` mediation (section 22-24):
 * `platform-core` adapts `ToolConnector.execute` into Gate's `ToolHandler` shape and registers it with
 * a broker instance the platform owns — the connector never bypasses authorization, capability
 * binding, or Sentinel observation. This package only defines identity/metadata and the deterministic
 * demo implementation; it performs no authorization or mediation itself.
 */

export const CONNECTOR_RISK_CLASSIFICATIONS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ConnectorRiskClassification = typeof CONNECTOR_RISK_CLASSIFICATIONS[number];

export interface ToolConnectorContext {
  readonly platform_action_id: string;
  readonly execution_id: string;
  readonly agent_id: string;
  readonly decision_id: string;
  readonly tenant_id: string;
  readonly operation: string;
  readonly resource: string;
  readonly destination: string | null;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ToolConnectorResult {
  readonly output: unknown;
  readonly cost_usd?: number;
}

/**
 * A connector's own declared identity (section 77). `tool` is the stable id the platform, Gate,
 * Sentinel, and Ledger all key on — a connector cannot silently report a different tool at execution
 * time; if it does, Sentinel's own `TOOL_NOT_ALLOWED` rule catches the drift against the session's
 * `expected_tool` binding (section 78), since `platform-core` always submits the *registered* tool id
 * in its observations, never whatever a misbehaving connector claims internally.
 */
export interface ToolConnector {
  readonly connector_id: string;
  /** Trusted startup binding. A connector registered for one tenant cannot be resolved by another. */
  readonly tenant_id?: string;
  readonly tool: string;
  readonly action: string;
  readonly allowed_operations: readonly string[];
  readonly risk_classification: ConnectorRiskClassification;
  readonly network_required: boolean;
  execute(context: ToolConnectorContext): Promise<ToolConnectorResult> | ToolConnectorResult;
}

/**
 * Explicit trusted registry (section 76). An agent cannot submit handler code, a shell command, or a
 * URL and have the platform execute it as a new tool — only a connector registered here, by trusted
 * startup configuration, is ever reachable. `PlatformActionRequest.tool` is looked up here; an
 * unknown tool fails closed with `CONNECTOR_UNKNOWN` before any authorization call is even made.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, ToolConnector>();
  public register(connector: ToolConnector): void {
    const key = `${connector.tenant_id ?? '*'}\u0000${connector.tool}`;
    if (this.connectors.has(key)) throw new PlatformError('INVALID_INPUT', `Connector for tool "${connector.tool}" is already registered for this tenant`);
    this.connectors.set(key, connector);
  }
  /** Tenant-scoped resolution. Legacy unscoped connectors are deliberately not a cross-tenant fallback. */
  public get(tenantId: string, tool: string): ToolConnector | null { return this.connectors.get(`${tenantId}\u0000${tool}`) ?? null; }
  public list(tenantId: string): readonly ToolConnector[] { return [...this.connectors.values()].filter(connector => connector.tenant_id === tenantId); }
}

/**
 * Harmless, deterministic demo connector (section 58). Echoes its bounded input back as output; no
 * production credentials, no filesystem/network/process access, no side effects beyond the in-memory
 * result — safe to run unattended in tests and the demo.
 */
export const DEMO_ECHO_CONNECTOR: ToolConnector = {
  connector_id: 'connector-demo-echo',
  tenant_id: 'tenant_demo',
  tool: 'demo.echo',
  action: 'demo.echo.execute',
  allowed_operations: ['execute'],
  risk_classification: 'LOW',
  network_required: false,
  execute(context: ToolConnectorContext): ToolConnectorResult {
    return { output: { echoed: context.input, resource: context.resource }, cost_usd: 0 };
  },
};

/**
 * A second demo connector whose handler deliberately reports a *different* tool identity than it was
 * registered under — used only by the abuse-case/drift test proving Sentinel's `expected_tool`
 * binding catches a connector that misrepresents itself (section 78). Never wired into the real demo
 * flows.
 */
export function buildDriftingConnector(registeredTool: string, misrepresentedTool: string): ToolConnector {
  return {
    connector_id: `connector-drift-${registeredTool}`,
    tool: registeredTool,
    action: `${registeredTool}.execute`,
    allowed_operations: ['execute'],
    risk_classification: 'LOW',
    network_required: false,
    execute(context: ToolConnectorContext): ToolConnectorResult {
      return { output: { claimedTool: misrepresentedTool, input: context.input } };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// MCP boundary (sections 59-63). A clean adapter shape for future MCP tool support — NOT a working
// MCP client/transport in v0.1 (see docs/platform/platform-mcp-boundary-v0.1.md). An `McpToolConnector`
// is still, structurally, just a `ToolConnector`: it receives no special trust, no bypass of
// authorization/capability/Sentinel/evidence, and its transport credentials (if any) must come from a
// secret-broker/reference pattern, never be embedded in platform configuration or Ledger events
// (section 62). Declaring this interface now, without a local MCP server fixture behind it, keeps the
// boundary narrow and honest rather than half-implemented.
// ---------------------------------------------------------------------------------------------

export interface McpToolConnector extends ToolConnector {
  readonly mcp_server_id: string;
  readonly mcp_tool_name: string;
}
