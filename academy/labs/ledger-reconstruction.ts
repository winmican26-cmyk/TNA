/**
 * TNA Deployment Academy v0.1 — Lab 05 (Level 4): Ledger Reconstruction.
 *
 * Objective: given only a `platform_action_id`, reconstruct the full causal chain — request, authority
 * (Gate decision), capability, Sentinel session, execution, verification, evidence — using only the
 * real, accepted `reconstructPlatformAction` function, and confirm every stage is genuinely populated,
 * not merely present as a null placeholder.
 * Prerequisites: `lab-01-blocked-action`, `lab-02-held-action`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../../packages/capability-core/src/index.js';
import { ExecutionBroker, ToolRegistry } from '../../packages/execution-broker/src/index.js';
import { agentPrincipal } from '../../packages/platform-schema/src/index.js';
import { PlatformStore, PlatformGateOrchestrator, PlatformExecutionOrchestrator, PlatformFacade, reconstructPlatformAction } from '../../packages/platform-core/src/index.js';
import { ConnectorRegistry, DEMO_ECHO_CONNECTOR } from '../../packages/platform-connectors/src/index.js';
import { GateActionAdapter } from '../../apps/tna-platform/src/gate-adapter.js';
import { SentinelRuntime, adminPrincipal as sentinelAdmin, controllerPrincipal as sentinelController, observerPrincipal as sentinelObserver } from '../../packages/sentinel-runtime/src/index.js';
import type { LabResult, LabStep } from './blocked-action.js';

const ADMIN = { kind: 'admin' as const, role: 'administrator' as const };
const TENANT = 'tenant_demo';
const AGENT_ID = 'academy-lab-5-agent';

export async function runLab(): Promise<LabResult> {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-academy-lab-reconstruct-'));
  const steps: LabStep[] = [];
  try {
    const gateStore = new Store(resolve(dir, 'gate.sqlite'));
    const gate = new Gate(gateStore);
    gate.register(ADMIN, { id: AGENT_ID, name: 'Academy Lab 5 Agent' });
    gate.setEnvelope(ADMIN, {
      version: '1.0',
      agent: { id: AGENT_ID, name: 'Academy Lab 5 Agent', role: 'lab', owner: 'academy', environment: 'lab', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      objective: { task_id: 'lab-5-reconstruction', goal: 'Echo a message', allowed_outcomes: ['echo'], forbidden_outcomes: [] },
      resources: { repositories: { read: [], write: [] }, files: { read: ['/academy-lab-5'], write: [] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
      tools: { allow: ['demo.echo'], deny: [] },
      network: { allow: [], deny: ['*'] }, secrets: { allow: [], deny: ['*'] },
      agents: { communicate_with: [], communication_mode: 'authenticated', shared_memory: false, deny_unknown_agents: true },
      limits: { max_runtime_seconds: 600, max_tool_calls: 10, max_external_requests: 0, max_cost_usd: 1, max_retries_per_action: 3 },
      approvals: { required_for: [] }, risk: { level: 'low', blast_radius: 'none', rollback_required: false },
      evidence: { capture: ['agent_identity', 'policy_hash', 'tool_calls', 'timestamps'], retention_days: 30 },
      violation_policy: { unknown_tool: 'block', undeclared_resource: 'block', unauthorized_agent_contact: 'terminate', network_violation: 'terminate', secret_violation: 'terminate_and_rotate', cost_limit_exceeded: 'pause_and_escalate', runtime_limit_exceeded: 'terminate' },
      action_bindings: [{ action: 'demo.echo.execute', outcome: 'echo', tool: 'demo.echo', resource_kind: 'files', operation: 'read', destination_required: false }],
    });

    const connectors = new ConnectorRegistry();
    connectors.register(DEMO_ECHO_CONNECTOR);
    const toolRegistry = new ToolRegistry();
    for (const connector of connectors.list(DEMO_ECHO_CONNECTOR.tenant_id!)) {
      toolRegistry.register({
        name: connector.tool, action: connector.action, resourceType: 'platform-connector',
        allowedOperations: ['read'], networkRequired: connector.network_required, credentialsRequired: [],
        handler: async context => (await connector.execute({
          platform_action_id: context.decisionId, execution_id: context.executionId, agent_id: context.agentId,
          decision_id: context.decisionId, tenant_id: TENANT, operation: context.operation, resource: context.resource,
          destination: context.destination, input: context.input,
        })).output,
      });
    }
    const broker = new ExecutionBroker(gateStore, new CapabilityCodec(randomBytes(32)), toolRegistry, {
      isAgentRevoked: id => gate.isAgentRevoked(id), isPolicyCurrent: d => gate.isPolicyCurrent(d), isDecisionCurrent: d => gate.isPolicyCurrent(d),
    });
    const sentinel = new SentinelRuntime(resolve(dir, 'sentinel.sqlite'));
    sentinel.installDefaultPolicy(sentinelAdmin('academy-sentinel-admin', TENANT));
    const platform = new PlatformStore(resolve(dir, 'platform.sqlite'));
    const gateOrchestrator = new PlatformGateOrchestrator(platform, new GateActionAdapter(gate));
    const executionOrchestrator = new PlatformExecutionOrchestrator(platform, broker, sentinel,
      sentinelController('academy-sentinel-controller', TENANT), sentinelObserver('academy-execution-broker', TENANT, ['EXECUTION_BROKER']));
    const facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);

    const action = await facade.submitAndRun(agentPrincipal('academy-lab-5-cred', TENANT, AGENT_ID), {
      version: '1.0', request_id: 'lab5-request', tenant_id: TENANT, agent_id: AGENT_ID,
      action: 'demo.echo.execute', tool: 'demo.echo', operation: 'read', resource: '/academy-lab-5',
      input: { message: 'reconstruct me' }, requires_verification: false,
    }, 'academy-lab');
    steps.push({ description: 'A real governed action reached COMPLETED', passed: action.state === 'COMPLETED' });

    // The learner's exercise: given ONLY the platform_action_id, reconstruct the causal chain.
    const reconstruction = reconstructPlatformAction(platform, TENANT, action.platform_action_id);
    steps.push({ description: 'REQUEST stage present (tool, action, agent_id)', passed: reconstruction.request?.tool === 'demo.echo' });
    steps.push({ description: 'AUTHORITY stage present (a real Gate decision, ALLOW)', passed: reconstruction.gate?.decision === 'ALLOW' });
    steps.push({ description: 'CAPABILITY stage present (a real issued capability id)', passed: typeof reconstruction.capability_id === 'string' && reconstruction.capability_id.length > 0 });
    steps.push({ description: 'SENTINEL stage present (a real session id)', passed: typeof reconstruction.sentinel_session_id === 'string' && reconstruction.sentinel_session_id.length > 0 });
    steps.push({ description: 'EXECUTION/EVIDENCE stage present (a real result hash)', passed: typeof reconstruction.execution?.result_hash === 'string' && reconstruction.execution.result_hash.length > 0 });
    steps.push({ description: 'The reconstruction\'s final_status matches the actual terminal state', passed: reconstruction.final_status === 'COMPLETED' });
    steps.push({ description: 'Every stage shares the SAME correlation id — the causal chain is genuinely one chain, not coincidentally-adjacent records', passed: reconstruction.correlation_id === action.correlation_id });

    platform.close(); sentinel.close(); gateStore.close();
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return { lab_id: 'lab-05-ledger-reconstruction', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}
