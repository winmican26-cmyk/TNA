import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { execPath } from 'node:process';
import { resolve } from 'node:path';
import { hash } from '../../authority-envelope/src/index.js';
import { type CapabilityInput, type CapabilityPayload, CapabilityCodec } from '../../capability-core/src/index.js';
import { type Store } from '../../evidence-core/src/index.js';
import { type Principal } from '../../agent-identity/src/index.js';
import { type IsolatedExecutionRequest, type IsolatedExecutionResult, type IsolationRunner } from '../../isolation-runner/src/index.js';
import { type AuthorizationRequest, type Decision } from '../../shared-schema/src/index.js';
import { ToolInputRegistry, demoToolInputMetadata, type ParsedToolInput } from '../../tool-inputs/src/index.js';

export class BrokerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'BrokerError'; }
}

export type ToolHandlerContext = { executionId: string; agentId: string; decisionId: string; resource: string; operation: string; destination: string | null; input: Record<string, unknown> };
export type ToolHandler = (context: ToolHandlerContext) => unknown | Promise<unknown>;
export type IsolatedToolAdapterContext = ToolHandlerContext & { inputHash: string };
export type IsolatedToolAdapter = { runnerType: string; runnerVersion: string; createRequest(context: IsolatedToolAdapterContext): IsolatedExecutionRequest };
export type ToolDefinition = { name: string; action: string; resourceType: string; allowedOperations: readonly string[]; networkRequired: boolean; credentialsRequired: readonly string[]; handler?: ToolHandler; isolated?: IsolatedToolAdapter };
export type ToolMetadata = Omit<ToolDefinition, 'handler' | 'isolated'> & { isolated?: Pick<IsolatedToolAdapter, 'runnerType' | 'runnerVersion'> };
const brokerToolAccess = Symbol('brokerToolAccess');
const toolMetadata = ({ name, action, resourceType, allowedOperations, networkRequired, credentialsRequired, isolated }: ToolDefinition): ToolMetadata => ({ name, action, resourceType, allowedOperations, networkRequired, credentialsRequired, ...(isolated ? { isolated: { runnerType: isolated.runnerType, runnerVersion: isolated.runnerVersion } } : {}) });

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void { if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`); this.tools.set(tool.name, tool); }
  get(name: string): ToolMetadata | null { const tool = this.tools.get(name); return tool ? toolMetadata(tool) : null; }
  list(): ToolMetadata[] { return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name)).map(toolMetadata); }
  async invoke(name: string, context: ToolHandlerContext): Promise<never> { void context; throw new BrokerError(403, `Handlers are broker-only: ${name}`); }
  [brokerToolAccess](name: string): ToolDefinition | null { return this.tools.get(name) ?? null; }
}

export type SecretLease = { readonly name: string; readonly value: string; release?(): void };
export interface SecretBroker { lease(names: readonly string[], context: { agentId: string; executionId: string }): SecretLease[] | Promise<SecretLease[]>; }
export type BrokerOptions = { now?: () => number; secretBroker?: SecretBroker; isolationRunner?: IsolationRunner; isAgentRevoked?: (agentId: string) => boolean; isPolicyCurrent?: (decision: Decision) => boolean; isDecisionCurrent?: (decision: Decision) => boolean; isToolCompatible?: (decision: Decision, tool: ToolDefinition) => boolean };
type CapabilityRecord = { capability: CapabilityPayload; token: string; consumed: boolean };
type DecisionPolicy = { policyHash: string; policyRevision: string };
export type ExecutionState = 'REQUESTED' | 'AUTHORIZED' | 'CAPABILITY_ISSUED' | 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'TERMINATED' | 'BLOCKED';
export type IsolationEvidence = { runner_type: string; runner_version: string; workspace_id: string; network: { requested: boolean; mode: string; enforcement: string }; runtime_limit_ms: number; exit_code: number | null; termination_reason?: string; stdout_bytes: number; stdout_sha256: string; stderr_bytes: number; stderr_sha256: string; input_hash: string };
export type ExecutionSummary = { execution_id: string; timestamp: string; agent_id: string; decision_id: string; capability_id: string; state: ExecutionState; reason: string; result_hash?: string; input_hash?: string; isolation?: IsolationEvidence };
export type RedeemInput = { token: string; tool: string; resource: string; operation: string; destination?: string; input: unknown; input_hash: string };
export type ExecutionResult = { executionId: string; state: 'SUCCEEDED'; result: { hash: string } };
const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code === 127; });
const iso = (now: number): string => new Date(now).toISOString();

export class ExecutionBroker {
  private readonly now: () => number;
  private readonly inputRegistry = new ToolInputRegistry();
  constructor(private readonly store: Store, private readonly codec: CapabilityCodec, private readonly registry: ToolRegistry, private readonly options: BrokerOptions = {}) { this.now = options.now ?? Date.now; this.inputRegistry.register(demoToolInputMetadata); }
  issue(principal: Principal, decisionId: string): { token: string; payload: CapabilityPayload } {
    const decision = this.store.get<Decision>('decision', decisionId);
    if (!decision) throw new BrokerError(404, 'Decision not found');
    this.requireOwner(principal, decision.agentId);
    const block = (reason: string): never => { this.store.append({ type: 'execution.transition', ...this.transition({ execution_id: randomUUID(), capability_id: 'none', agent_id: decision.agentId, decision_id: decision.decisionId }, 'BLOCKED', reason) }); throw new BrokerError(403, reason); };
    const tool = this.registry[brokerToolAccess](decision.request.tool);
    if (decision.decision !== 'ALLOW') block(`Decision is ${decision.decision}`);
    if (this.options.isAgentRevoked?.(decision.agentId)) block('Agent is revoked');
    if (this.options.isDecisionCurrent && !this.options.isDecisionCurrent(decision)) block('Decision is stale');
    if (this.options.isPolicyCurrent && !this.options.isPolicyCurrent(decision)) block('Policy is stale');
    if (!tool) block('Tool is unregistered or incompatible');
    const registeredTool = tool as ToolDefinition;
    if (!this.compatible(decision, registeredTool)) block('Tool is unregistered or incompatible');
    const parsedInput = this.parseDecisionInput(decision, registeredTool, block);
    return this.store.transaction(() => {
      if (this.store.list<CapabilityRecord>('execution.capability').some(record => record.capability.decision_id === decisionId)) throw new BrokerError(409, 'Capability already issued for decision');
      const executionId = randomUUID();
      const policy = this.store.get<DecisionPolicy>('decision.policy', decision.decisionId);
      const input: CapabilityInput = { capability_id: randomUUID(), execution_id: executionId, agent_id: decision.agentId, decision_id: decision.decisionId, action: decision.request.action, tool: decision.request.tool, resource: decision.request.resource, operation: this.operation(decision.request), destination: decision.request.destination ?? null, policy_hash: decision.policyHash ?? 'none', policy_issuance_id: decision.policyHash ?? 'none', input_hash: parsedInput?.input_hash ?? hash(null) };
      input.policy_issuance_id = policy?.policyRevision ?? input.policy_issuance_id;
      const issued = this.codec.issue(input);
      this.appendTransition(issued.payload, 'REQUESTED', 'Execution requested');
      this.appendTransition(issued.payload, 'AUTHORIZED', 'ALLOW decision verified');
      this.store.put('execution.capability', issued.payload.capability_id, { capability: issued.payload, token: issued.token, consumed: false } satisfies CapabilityRecord);
      this.appendTransition(issued.payload, 'CAPABILITY_ISSUED', 'Capability issued');
      return issued;
    });
  }
  async redeem(principal: Principal, input: RedeemInput): Promise<ExecutionResult> {
    this.validateInput(input);
    const payload = this.verify(input.token);
    this.requireOwner(principal, payload.agent_id);
    const tool = this.registry[brokerToolAccess](input.tool);
    if (!tool || !this.binds(payload, input, tool)) throw new BrokerError(403, 'Capability binding mismatch');
    const parsedInput = this.parseRedeemInput(input, tool, payload.input_hash);
    const decision = this.store.get<Decision>('decision', payload.decision_id);
    if (!decision) throw new BrokerError(404, 'Decision not found');
    if (this.options.isAgentRevoked?.(payload.agent_id)) return this.block(payload, 'Agent is revoked');
    if (this.options.isDecisionCurrent && !this.options.isDecisionCurrent(decision)) return this.block(payload, 'Decision is stale');
    if (this.options.isPolicyCurrent && !this.options.isPolicyCurrent(decision)) return this.block(payload, 'Policy is stale');
    if (tool.credentialsRequired.length > 0 && !this.options.secretBroker) return this.block(payload, 'Required secret broker is unavailable');
    if (tool.isolated && !this.options.isolationRunner) throw new BrokerError(503, 'Isolation runner unavailable');
    this.store.transaction(() => {
      const record = this.store.get<CapabilityRecord>('execution.capability', payload.capability_id);
      if (!record || record.consumed) throw new BrokerError(409, 'Capability already consumed or unknown');
      this.store.put('execution.capability', payload.capability_id, { ...record, consumed: true });
      this.appendTransition(payload, 'STARTED', 'Capability consumed; handler invocation authorized');
      this.store.put('execution', payload.execution_id, this.summary(payload, 'STARTED', 'Capability consumed; handler invocation authorized'));
    });
    let leases: SecretLease[] = [];
    try {
      if (tool.credentialsRequired.length > 0) leases = await this.options.secretBroker!.lease(tool.credentialsRequired, { agentId: payload.agent_id, executionId: payload.execution_id });
      const context = { executionId: payload.execution_id, agentId: payload.agent_id, decisionId: payload.decision_id, resource: payload.resource, operation: payload.operation, destination: payload.destination, input: parsedInput?.input ?? {} };
      if (tool.isolated) {
        const request = tool.isolated.createRequest({ ...context, inputHash: input.input_hash });
        await mkdir(resolve(request.workspace), { recursive: true });
        const isolated = await this.options.isolationRunner!.run(request);
        const evidence = this.isolationEvidence(tool.isolated, request, isolated, input.input_hash);
        const resultHash = hash({ state: isolated.state, reason: isolated.reason, exit_code: isolated.exit_code, stdout: isolated.stdout.sha256, stderr: isolated.stderr.sha256 });
        if (isolated.state === 'SUCCEEDED') { this.finish(payload, 'SUCCEEDED', 'Isolated child completed', resultHash, evidence); return { executionId: payload.execution_id, state: 'SUCCEEDED', result: { hash: resultHash } }; }
        this.finish(payload, isolated.state, `Isolated child ${isolated.reason}`, resultHash, evidence);
        throw new BrokerError(500, isolated.state === 'TERMINATED' ? 'Isolated execution terminated' : 'Isolated execution failed');
      }
      if (!tool.handler) throw new BrokerError(503, 'Tool handler unavailable');
      const result = await tool.handler(context);
      const resultHash = hash(result);
      this.finish(payload, 'SUCCEEDED', 'Handler completed', resultHash);
      return { executionId: payload.execution_id, state: 'SUCCEEDED', result: { hash: resultHash } };
    } catch (error) {
      if (error instanceof BrokerError && (error.message === 'Isolated execution failed' || error.message === 'Isolated execution terminated')) throw error;
      const resultHash = this.handlerResultHash(error);
      try { this.finish(payload, 'FAILED', 'Protected handler failed', resultHash); } catch { throw new BrokerError(503, 'Execution outcome is indeterminate; capability remains consumed'); }
      throw new BrokerError(500, 'Handler failed');
    } finally { for (const lease of leases) lease.release?.(); }
  }
  execution(principal: Principal, executionId: string): ExecutionSummary { const execution = this.store.get<ExecutionSummary>('execution', executionId); if (!execution) throw new BrokerError(404, 'Execution not found'); this.requireOwner(principal, execution.agent_id); return execution; }
  executions(principal: Principal, agentId: string): ExecutionSummary[] { this.requireReader(principal, agentId); return this.store.list<ExecutionSummary>('execution').filter(item => item.agent_id === agentId); }
  private compatible(decision: Decision, tool: ToolDefinition): boolean { return tool.action === decision.request.action && tool.allowedOperations.includes(this.operation(decision.request)) && Boolean(decision.request.destination) === tool.networkRequired && (!this.options.isToolCompatible || this.options.isToolCompatible(decision, tool)); }
  private binds(payload: CapabilityPayload, input: RedeemInput, tool: ToolDefinition): boolean { return payload.tool === tool.name && payload.tool === input.tool && payload.resource === input.resource && payload.operation === input.operation && payload.destination === (input.destination ?? null) && payload.action === tool.action && tool.allowedOperations.includes(payload.operation); }
  private operation(request: AuthorizationRequest): string { return request.action === 'production.deploy' ? 'write' : 'read'; }
  private verify(token: string): CapabilityPayload { try { return this.codec.verify(token); } catch { throw new BrokerError(401, 'Invalid capability'); } }
  private validateInput(input: RedeemInput): void { if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['token', 'tool', 'resource', 'operation', 'destination', 'input', 'input_hash'].includes(key)) || !validText(input.token) || !validText(input.tool) || !validText(input.resource) || !validText(input.operation) || !/^[a-f0-9]{64}$/.test(input.input_hash) || (input.destination !== undefined && !validText(input.destination)) || !('input' in input)) throw new BrokerError(400, 'Invalid redeem input'); }
  private parseDecisionInput(decision: Decision, tool: ToolDefinition, block: (reason: string) => never): ParsedToolInput | null {
    const metadata = this.inputRegistry.get(tool.name);
    if (!metadata) return null;
    const request = decision.request as AuthorizationRequest & { input?: unknown; input_hash?: string };
    if (!('input' in request) || !('input_hash' in request)) block('Validated tool input is required');
    try { const parsed = this.inputRegistry.parseAndHash(tool.name, request.input); if (parsed.input_hash !== request.input_hash || parsed.input.release !== decision.request.resource) block('Decision input hash or resource mismatch'); return parsed; }
    catch { block('Decision tool input is invalid'); }
  }
  private parseRedeemInput(input: RedeemInput, tool: ToolDefinition, expectedHash: string): ParsedToolInput | null {
    const metadata = this.inputRegistry.get(tool.name);
    if (!metadata) return null;
    try { const parsed = this.inputRegistry.parseAndHash(tool.name, input.input); if (parsed.input_hash !== input.input_hash || parsed.input_hash !== expectedHash || parsed.input.release !== input.resource) throw new Error(); return parsed; }
    catch { throw new BrokerError(403, 'Tool input binding mismatch'); }
  }
  private requireOwner(principal: Principal, agentId: string): void { if (principal.kind !== 'admin' && (principal.kind !== 'agent' || principal.agentId !== agentId)) throw new BrokerError(403, 'Access denied'); }
  private requireReader(principal: Principal, agentId: string): void { this.requireOwner(principal, agentId); }
  private appendTransition(payload: Pick<CapabilityPayload, 'execution_id' | 'capability_id' | 'agent_id' | 'decision_id'>, state: ExecutionState, reason: string): void { this.store.append({ type: 'execution.transition', ...this.transition(payload, state, reason) }); }
  private transition(payload: Pick<CapabilityPayload, 'execution_id' | 'capability_id' | 'agent_id' | 'decision_id'>, state: ExecutionState, reason: string, isolation?: IsolationEvidence): Record<string, unknown> { return { execution_id: payload.execution_id, timestamp: iso(this.now()), agent_id: payload.agent_id, decision_id: payload.decision_id, capability_id: payload.capability_id, state, reason, ...(isolation ? { isolation } : {}) }; }
  private summary(payload: CapabilityPayload, state: ExecutionState, reason: string, resultHash?: string, isolation?: IsolationEvidence): ExecutionSummary { return { ...this.transition(payload, state, reason, isolation), ...(resultHash ? { result_hash: resultHash } : {}), input_hash: payload.input_hash, ...(isolation ? { isolation } : {}) } as ExecutionSummary; }
  private finish(payload: CapabilityPayload, state: 'SUCCEEDED' | 'FAILED' | 'TERMINATED', reason: string, resultHash?: string, isolation?: IsolationEvidence): void { this.store.transaction(() => { this.store.append({ type: 'execution.transition', ...this.transition(payload, state, reason, isolation) }); this.store.put('execution', payload.execution_id, this.summary(payload, state, reason, resultHash, isolation)); }); }
  private isolationEvidence(adapter: IsolatedToolAdapter, request: IsolatedExecutionRequest, result: IsolatedExecutionResult, inputHash: string): IsolationEvidence { return { runner_type: adapter.runnerType, runner_version: adapter.runnerVersion, workspace_id: resolve(request.workspace).split(/[\\/]/).pop() ?? 'unknown', network: result.network, runtime_limit_ms: request.runtime_limit_ms, exit_code: result.exit_code, ...(result.state === 'TERMINATED' ? { termination_reason: result.reason } : {}), stdout_bytes: result.stdout.bytes, stdout_sha256: result.stdout.sha256, stderr_bytes: result.stderr.bytes, stderr_sha256: result.stderr.sha256, input_hash: inputHash }; }
  private handlerResultHash(error: unknown): string | undefined {
    if (error === null || typeof error !== 'object') return undefined;
    const candidate = 'resultHash' in error ? error.resultHash : 'result_hash' in error ? error.result_hash : undefined;
    return typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate) ? candidate : undefined;
  }
  private block(payload: CapabilityPayload, reason: string): never { this.appendTransition(payload, 'BLOCKED', reason); throw new BrokerError(403, reason); }
}

export function createDemoRegistry(artifactDirectory: string): ToolRegistry {
  const registry = new ToolRegistry();
  const root = resolve(artifactDirectory);
  registry.register({ name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure', allowedOperations: ['write'], networkRequired: false, credentialsRequired: [], isolated: { runnerType: 'child-process', runnerVersion: '1', createRequest: context => { const workspace = resolve(root, context.executionId); const script = "const fs=require('node:fs');const path=require('node:path');const artifact={execution_id:process.env.TNA_EXECUTION_ID,resource:process.env.TNA_RELEASE,environment:process.env.TNA_ENVIRONMENT,action:'production.deploy',operation:'write',network:false};fs.writeFileSync(path.join(process.cwd(), process.env.TNA_EXECUTION_ID+'.json'), JSON.stringify(artifact)+'\\n',{flag:'wx'});process.stdout.write(JSON.stringify({status:'deployed'}));"; return { execution_id: context.executionId, agent_id: context.agentId, tool: 'demo.deploy.execute', operation: context.operation, command: execPath, args: ['-e', script], workspace, cwd: '.', env: { TNA_RELEASE: String(context.input.release), TNA_ENVIRONMENT: String(context.input.environment) }, runtime_limit_ms: demoToolInputMetadata.runtimeLimitMs, stdout_limit_bytes: demoToolInputMetadata.outputLimitBytes, stderr_limit_bytes: demoToolInputMetadata.outputLimitBytes, output_limit_bytes: demoToolInputMetadata.outputLimitBytes, no_network: { requested: true, mode: 'preflight-only' } }; } } });
  return registry;
}