import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hash } from '../../authority-envelope/src/index.js';
import { type CapabilityInput, type CapabilityPayload, CapabilityCodec } from '../../capability-core/src/index.js';
import { type Store } from '../../evidence-core/src/index.js';
import { type Principal } from '../../agent-identity/src/index.js';
import { type AuthorizationRequest, type Decision } from '../../shared-schema/src/index.js';

export class BrokerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'BrokerError'; }
}

export type ToolHandlerContext = { executionId: string; agentId: string; decisionId: string; resource: string; operation: string; destination: string | null };
export type ToolHandler = (context: ToolHandlerContext) => unknown | Promise<unknown>;
export type ToolDefinition = { name: string; action: string; resourceType: string; allowedOperations: readonly string[]; networkRequired: boolean; credentialsRequired: readonly string[]; handler: ToolHandler };
export type ToolMetadata = Omit<ToolDefinition, 'handler'>;
const brokerToolAccess = Symbol('brokerToolAccess');
const toolMetadata = ({ name, action, resourceType, allowedOperations, networkRequired, credentialsRequired }: ToolDefinition): ToolMetadata => ({ name, action, resourceType, allowedOperations, networkRequired, credentialsRequired });

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
type BrokerOptions = { now?: () => number; secretBroker?: SecretBroker; isAgentRevoked?: (agentId: string) => boolean; isPolicyCurrent?: (decision: Decision) => boolean; isDecisionCurrent?: (decision: Decision) => boolean; isToolCompatible?: (decision: Decision, tool: ToolDefinition) => boolean };
type CapabilityRecord = { capability: CapabilityPayload; token: string; consumed: boolean };
type DecisionPolicy = { policyHash: string; policyRevision: string };
export type ExecutionState = 'REQUESTED' | 'AUTHORIZED' | 'CAPABILITY_ISSUED' | 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
export type ExecutionSummary = { execution_id: string; timestamp: string; agent_id: string; decision_id: string; capability_id: string; state: ExecutionState; reason: string; result_hash?: string };
export type RedeemInput = { token: string; tool: string; resource: string; operation: string; destination?: string };
export type ExecutionResult = { executionId: string; state: 'SUCCEEDED'; result: { hash: string } };
const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code === 127; });
const iso = (now: number): string => new Date(now).toISOString();

export class ExecutionBroker {
  private readonly now: () => number;
  constructor(private readonly store: Store, private readonly codec: CapabilityCodec, private readonly registry: ToolRegistry, private readonly options: BrokerOptions = {}) { this.now = options.now ?? Date.now; }
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
    if (!tool || !this.compatible(decision, tool)) block('Tool is unregistered or incompatible');
    return this.store.transaction(() => {
      if (this.store.list<CapabilityRecord>('execution.capability').some(record => record.capability.decision_id === decisionId)) throw new BrokerError(409, 'Capability already issued for decision');
      const executionId = randomUUID();
      const policy = this.store.get<DecisionPolicy>('decision.policy', decision.decisionId);
      const input: CapabilityInput = { capability_id: randomUUID(), execution_id: executionId, agent_id: decision.agentId, decision_id: decision.decisionId, action: decision.request.action, tool: decision.request.tool, resource: decision.request.resource, operation: this.operation(decision.request), destination: decision.request.destination ?? null, policy_hash: decision.policyHash ?? 'none', policy_issuance_id: decision.policyHash ?? 'none' };
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
    const decision = this.store.get<Decision>('decision', payload.decision_id);
    if (!decision) throw new BrokerError(404, 'Decision not found');
    if (this.options.isAgentRevoked?.(payload.agent_id)) return this.block(payload, 'Agent is revoked');
    if (this.options.isDecisionCurrent && !this.options.isDecisionCurrent(decision)) return this.block(payload, 'Decision is stale');
    if (this.options.isPolicyCurrent && !this.options.isPolicyCurrent(decision)) return this.block(payload, 'Policy is stale');
    if (tool.credentialsRequired.length > 0 && !this.options.secretBroker) return this.block(payload, 'Required secret broker is unavailable');
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
      const result = await tool.handler({ executionId: payload.execution_id, agentId: payload.agent_id, decisionId: payload.decision_id, resource: payload.resource, operation: payload.operation, destination: payload.destination });
      const resultHash = hash(result);
      this.finish(payload, 'SUCCEEDED', 'Handler completed', resultHash);
      return { executionId: payload.execution_id, state: 'SUCCEEDED', result: { hash: resultHash } };
    } catch (error) {
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
  private validateInput(input: RedeemInput): void { if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['token', 'tool', 'resource', 'operation', 'destination'].includes(key)) || !validText(input.token) || !validText(input.tool) || !validText(input.resource) || !validText(input.operation) || (input.destination !== undefined && !validText(input.destination))) throw new BrokerError(400, 'Invalid redeem input'); }
  private requireOwner(principal: Principal, agentId: string): void { if (principal.kind !== 'admin' && (principal.kind !== 'agent' || principal.agentId !== agentId)) throw new BrokerError(403, 'Access denied'); }
  private requireReader(principal: Principal, agentId: string): void { this.requireOwner(principal, agentId); }
  private appendTransition(payload: Pick<CapabilityPayload, 'execution_id' | 'capability_id' | 'agent_id' | 'decision_id'>, state: ExecutionState, reason: string): void { this.store.append({ type: 'execution.transition', ...this.transition(payload, state, reason) }); }
  private transition(payload: Pick<CapabilityPayload, 'execution_id' | 'capability_id' | 'agent_id' | 'decision_id'>, state: ExecutionState, reason: string): Record<string, unknown> { return { execution_id: payload.execution_id, timestamp: iso(this.now()), agent_id: payload.agent_id, decision_id: payload.decision_id, capability_id: payload.capability_id, state, reason }; }
  private summary(payload: CapabilityPayload, state: ExecutionState, reason: string, resultHash?: string): ExecutionSummary { return { ...this.transition(payload, state, reason), ...(resultHash ? { result_hash: resultHash } : {}) } as ExecutionSummary; }
  private finish(payload: CapabilityPayload, state: 'SUCCEEDED' | 'FAILED', reason: string, resultHash?: string): void { this.store.transaction(() => { this.appendTransition(payload, state, reason); this.store.put('execution', payload.execution_id, this.summary(payload, state, reason, resultHash)); }); }
  private handlerResultHash(error: unknown): string | undefined {
    if (error === null || typeof error !== 'object') return undefined;
    const candidate = 'resultHash' in error ? error.resultHash : 'result_hash' in error ? error.result_hash : undefined;
    return typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate) ? candidate : undefined;
  }
  private block(payload: CapabilityPayload, reason: string): never { this.appendTransition(payload, 'BLOCKED', reason); throw new BrokerError(403, reason); }
}

export function createDemoRegistry(artifactDirectory: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({ name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure', allowedOperations: ['write'], networkRequired: false, credentialsRequired: [], handler: async context => { const directory = resolve(artifactDirectory); await mkdir(directory, { recursive: true }); const artifact = { execution_id: context.executionId, resource: context.resource, action: 'production.deploy', operation: context.operation, network: false }; const path = resolve(directory, `${context.executionId}.json`); await writeFile(path, `${JSON.stringify(artifact)}\n`, { encoding: 'utf8', flag: 'wx' }); return { artifact: path, ...artifact }; } });
  return registry;
}