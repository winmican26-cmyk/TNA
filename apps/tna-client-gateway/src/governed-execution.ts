/**
 * TNA Client Integration & MCP Gateway v0.1 — Packaged-Execution Closure.
 *
 * The real production composition root for the client gateway's governed execution path (TNA-64 —
 * "The Packaged Path Is the Real Path", see `docs/client-integration/client-integration-principles-v0.1.md`):
 *
 *   Client Gateway -> Client Action Handler -> PlatformFacade -> Platform Action -> Gate ->
 *     Capability -> Sentinel -> Execution Broker -> MCP Connector -> MCP Server -> Ledger
 *
 * Every component here is the same accepted class `apps/tna-platform/src/main.ts` already wires for the
 * standalone platform app (Gate, ExecutionBroker, SentinelRuntime, PlatformStore orchestrators, Ledger,
 * PlatformLedgerDispatcher) — nothing here reimplements their logic; this file only sequences
 * construction and keeps it in sync with live tenant state.
 *
 * The one real difference from `tna-platform`'s single-tenant composition: `tna-platform` binds one
 * fixed demo agent/envelope at startup because it serves one deployment-bound tenant. The client
 * gateway serves many client tenants whose enabled-tool set changes at runtime (tool enable/disable,
 * schema drift, offboarding) — so `syncGovernedTenant` derives that tenant's Gate agent/envelope and
 * connector/tool registrations from *live* `ClientStore` state immediately before every governed
 * submission, never built once at startup and left to go stale. `PlatformExecutionOrchestrator` binds a
 * fixed Sentinel principal at construction (tenant-scoped by Sentinel's own authorization model), so one
 * `PlatformFacade` is built per tenant, lazily, and cached — never one shared instance impersonating
 * every tenant.
 */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Gate } from '../../tna-gate-api/src/gate.js';
import { Store } from '../../../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../../../packages/capability-core/src/index.js';
import { ExecutionBroker, ToolRegistry } from '../../../packages/execution-broker/src/index.js';
import { LedgerStore, Ledger } from '../../../packages/ledger-core/src/index.js';
import { platformWriter } from '../../tna-ledger/src/writers.js';
import {
  SentinelRuntime, adminPrincipal as sentinelAdminPrincipal,
  controllerPrincipal as sentinelControllerPrincipal, observerPrincipal as sentinelObserverPrincipal,
} from '../../../packages/sentinel-runtime/src/index.js';
import {
  PlatformStore, PlatformGateOrchestrator, PlatformExecutionOrchestrator, PlatformFacade, PlatformLedgerDispatcher,
} from '../../../packages/platform-core/src/index.js';
import { ConnectorRegistry } from '../../../packages/platform-connectors/src/index.js';
import type { DispatchSummary } from '../../../packages/platform-outbox/src/index.js';
import type { Envelope } from '../../../packages/authority-envelope/src/index.js';
import type { GovernedToolDefinition } from '../../../packages/mcp-schema/src/index.js';
import { toolPlatformId, type ClientStore } from '../../../packages/client-core/src/index.js';
import { GateActionAdapter } from '../../tna-platform/src/gate-adapter.js';
import { buildToolRegistry, registerMcpConnectors } from './connectors.js';

const GATE_ADMIN = { kind: 'admin' as const, role: 'administrator' as const };
function nowIso(offsetMs = 0): string { return new Date(Date.now() + offsetMs).toISOString(); }

/**
 * Builds a real Gate envelope from a tenant's *currently enabled* governed tools — never a fixed or
 * hand-maintained allow list. `tools.allow`, `action_bindings`, and `resources.files.{read,write}` are
 * derived directly from each tool's own policy binding (`allowed_operations`, `resource_patterns`,
 * bound at `enableTool` time — see `tool-policy-binding-v0.1.md`). A tool that is not currently enabled
 * is simply absent from the envelope, so Gate blocks any attempt to use it on its own authority
 * ("Action is outside the stated objective") — there is no separate allow/deny list to keep in sync
 * with `ClientStore`'s own governed-tool state.
 */
export function buildTenantGateEnvelope(agentId: string, tenantId: string, enabledTools: readonly GovernedToolDefinition[]): Envelope {
  const filesRead: string[] = [];
  const filesWrite: string[] = [];
  const allowedTools: string[] = [];
  const actionBindings: Envelope['action_bindings'] = [];
  for (const tool of enabledTools) {
    const platformId = toolPlatformId(tool.tool_id);
    const operation: 'read' | 'write' = tool.allowed_operations.includes('write') ? 'write' : 'read';
    (operation === 'write' ? filesWrite : filesRead).push(...tool.resource_patterns);
    allowedTools.push(platformId);
    actionBindings.push({
      action: `${platformId}.execute`, outcome: `invoke ${platformId}`, tool: platformId,
      resource_kind: 'files', operation, destination_required: false,
    });
  }
  return {
    version: '1.0',
    agent: { id: agentId, name: agentId, role: 'client-service-identity', owner: tenantId, environment: 'client-integration', expires_at: nowIso(3_600_000) },
    objective: {
      task_id: `client-gateway-${tenantId}`, goal: 'Execute governed MCP tool calls on behalf of a TNA client tenant',
      allowed_outcomes: allowedTools.map(tool => `invoke ${tool}`), forbidden_outcomes: [],
    },
    resources: { repositories: { read: [], write: [] }, files: { read: filesRead, write: filesWrite }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
    tools: { allow: allowedTools, deny: [] },
    network: { allow: [], deny: ['*'] },
    secrets: { allow: [], deny: ['*'] },
    agents: { communicate_with: [], communication_mode: 'authenticated' as const, shared_memory: false as const, deny_unknown_agents: true as const },
    limits: { max_runtime_seconds: 600, max_tool_calls: 1000, max_external_requests: 0, max_cost_usd: 1000, max_retries_per_action: 20 },
    approvals: { required_for: [] },
    risk: { level: 'low' as const, blast_radius: 'tenant-scoped', rollback_required: false },
    evidence: { capture: ['agent_identity', 'policy_hash', 'tool_calls', 'timestamps'] as const, retention_days: 365 },
    violation_policy: {
      unknown_tool: 'block' as const, undeclared_resource: 'block' as const, unauthorized_agent_contact: 'terminate' as const,
      network_violation: 'terminate' as const, secret_violation: 'terminate_and_rotate' as const,
      cost_limit_exceeded: 'pause_and_escalate' as const, runtime_limit_exceeded: 'terminate' as const,
    },
    action_bindings: actionBindings,
  };
}

export interface GovernedIntegration {
  /** Lazily builds (and caches) the one `PlatformFacade` for a given tenant. A tenant's Sentinel
   * principal is fixed at this facade's construction, so one instance never serves two tenants. */
  readonly platformFacadeFor: (tenantId: string) => PlatformFacade;
  /** Re-derives Gate's agent registration/envelope and the connector/tool registries for one tenant
   * from live `ClientStore` state. Must be called before every governed submission — never assume a
   * prior sync is still current (tools may have been enabled, disabled, or drifted since). */
  readonly syncGovernedTenant: (tenantId: string, agentId: string) => void;
  readonly dispatchOnce: () => Promise<DispatchSummary>;
  readonly close: () => void;
}

/**
 * Constructs the real governed-execution composition described at the top of this file. Every store is
 * a real accepted SQLite-backed class opened against a file under `dataDir` — nothing in-memory, nothing
 * faked. Throws if any mandatory dependency fails to construct; the caller (`main.ts`) must treat that
 * as a fatal startup error, never a silent degrade to a weaker mode (TNA-64).
 */
export function buildGovernedIntegration(store: ClientStore, dataDir: string): GovernedIntegration {
  const gateStore = new Store(resolve(dataDir, 'tna-client-gateway-gate.sqlite'));
  const gate = new Gate(gateStore);
  const connectors = new ConnectorRegistry();
  const toolRegistry = new ToolRegistry();
  const broker = new ExecutionBroker(gateStore, new CapabilityCodec(randomBytes(32)), toolRegistry, {
    isAgentRevoked: agentId => gate.isAgentRevoked(agentId),
    isPolicyCurrent: decision => gate.isPolicyCurrent(decision),
    isDecisionCurrent: decision => gate.isPolicyCurrent(decision),
  });

  const sentinel = new SentinelRuntime(resolve(dataDir, 'tna-client-gateway-sentinel.sqlite'));
  const sentinelPolicyTenants = new Set<string>();
  function ensureSentinelPolicy(tenantId: string): void {
    if (sentinelPolicyTenants.has(tenantId)) return;
    try { sentinel.getActivePolicy(sentinelAdminPrincipal(`client-gateway-sentinel-admin-${tenantId}`, tenantId)); }
    catch { sentinel.installDefaultPolicy(sentinelAdminPrincipal(`client-gateway-sentinel-admin-${tenantId}`, tenantId)); }
    sentinelPolicyTenants.add(tenantId);
  }

  const ledgerStore = new LedgerStore(resolve(dataDir, 'tna-client-gateway-ledger.sqlite'));
  const ledger = new Ledger(ledgerStore);

  const platform = new PlatformStore(resolve(dataDir, 'tna-client-gateway-platform.sqlite'));
  const gateOrchestrator = new PlatformGateOrchestrator(platform, new GateActionAdapter(gate));
  const dispatcher = new PlatformLedgerDispatcher(platform, {
    append: input => ledger.append(platformWriter(input.tenant_id), input),
  });

  const facades = new Map<string, PlatformFacade>();
  function platformFacadeFor(tenantId: string): PlatformFacade {
    let facade = facades.get(tenantId);
    if (facade) return facade;
    ensureSentinelPolicy(tenantId);
    const executionOrchestrator = new PlatformExecutionOrchestrator(
      platform, broker, sentinel,
      sentinelControllerPrincipal(`client-gateway-sentinel-controller-${tenantId}`, tenantId),
      sentinelObserverPrincipal(`client-gateway-execution-broker-${tenantId}`, tenantId, ['EXECUTION_BROKER']),
    );
    facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);
    facades.set(tenantId, facade);
    return facade;
  }

  const registeredAgents = new Set<string>();
  function syncGovernedTenant(tenantId: string, agentId: string): void {
    if (!registeredAgents.has(agentId)) {
      try { gate.register(GATE_ADMIN, { id: agentId, name: agentId }); } catch { /* already registered */ }
      registeredAgents.add(agentId);
    }
    registerMcpConnectors(connectors, store, tenantId);
    buildToolRegistry(connectors, tenantId, toolRegistry);
    const enabledTools = store.listTools(tenantId).filter(tool => tool.enabled);
    gate.setEnvelope(GATE_ADMIN, buildTenantGateEnvelope(agentId, tenantId, enabledTools));
  }

  return {
    platformFacadeFor,
    syncGovernedTenant,
    dispatchOnce: () => dispatcher.dispatchOnce(),
    close: () => { gateStore.close(); sentinel.close(); ledgerStore.close(); platform.close(); },
  };
}
