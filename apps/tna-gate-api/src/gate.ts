import { randomUUID } from 'node:crypto';
import { envelopeSchema, hash, type Envelope } from '../../../packages/authority-envelope/src/index.js';
import { issueToken, tokenHash, type Principal } from '../../../packages/agent-identity/src/index.js';
import { evaluate, micros, attemptsFor, type Usage } from '../../../packages/policy-engine/src/index.js';
import { Store } from '../../../packages/evidence-core/src/index.js';
import { approvalSchema, registrationSchema, requestSchema, revokeSchema, type AuthorizationRequest, type Decision } from '../../../packages/shared-schema/src/index.js';
import { ToolInputRegistry, ToolInputError, demoToolInputMetadata } from '../../../packages/tool-inputs/src/index.js';

type Agent = { id: string; name: string; tokenHash: string; revoked: boolean };
type Policy = { envelope: Envelope; hash: string; revision: string };
type DecisionPolicy = { policyHash: string; policyRevision: string };
type Approval = { id: string; agentId: string; policyHash: string; policyRevision: string; requestHash: string; role: string; expiresAt: string; used: boolean };
type StoredRequest = AuthorizationRequest & { input?: Record<string, unknown>; input_hash?: string };
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const newId = (prefix: string) => `${prefix}_${randomUUID()}`;
const emptyUsage = (): Usage => ({ startedAt: null, calls: 0, external: 0, costMicros: 0, attempts: {} });
function requestHash(request: AuthorizationRequest): string {
  const { approvalId: _approvalId, ...bound } = request;
  void _approvalId;
  return hash(bound);
}
export class Gate {
  private readonly inputRegistry = new ToolInputRegistry();
  constructor(public readonly store: Store, private readonly now: () => number = Date.now) { this.inputRegistry.register(demoToolInputMetadata); }
  authenticateAgent(token: string): Principal | null {
    const digest = tokenHash(token);
    const agent = this.store.list<Agent>('agent').find(a => a.tokenHash === digest);
    return agent ? { kind: 'agent', agentId: agent.id } : null;
  }
  private requireAdmin(principal: Principal): void {
    if (principal.kind !== 'admin') throw new HttpError(403, 'Administrator credential required');
  }
  private requireReader(principal: Principal, agentId: string): void {
    if (principal.kind !== 'admin' && (principal.kind !== 'agent' || principal.agentId !== agentId)) throw new HttpError(403, 'Access denied');
  }
  register(principal: Principal, input: unknown): unknown {
    this.requireAdmin(principal);
    const data = registrationSchema.parse(input);
    return this.store.transaction(() => {
      if (this.store.get('agent', data.id)) throw new HttpError(409, 'Agent already registered');
      const token = issueToken();
      this.store.put('agent', data.id, { ...data, tokenHash: tokenHash(token), revoked: false });
      this.audit('agent.registered', { agentId: data.id });
      return { agentId: data.id, token };
    });
  }
  setEnvelope(principal: Principal, input: unknown): unknown {
    this.requireAdmin(principal);
    const envelope = envelopeSchema.parse(input);
    if (Date.parse(envelope.agent.expires_at) <= this.now()) throw new HttpError(400, 'Cannot issue an expired envelope');
    return this.store.transaction(() => {
      const agent = this.store.get<Agent>('agent', envelope.agent.id);
      if (!agent || agent.revoked) throw new HttpError(409, 'Agent missing or revoked');
      const policyHash = hash(envelope);
      const revision = newId('pol');
      this.store.put('policy', agent.id, { envelope, hash: policyHash, revision });
      // Lifetime counters intentionally survive policy replacement.
      this.audit('envelope.issued', { agentId: agent.id, policyHash, revision, envelope });
      return { agentId: agent.id, policyHash, policyVersion: envelope.version };
    });
  }
  getEnvelope(principal: Principal, agentId: string): unknown {
    this.requireReader(principal, agentId);
    const policy = this.store.get<Policy>('policy', agentId);
    if (!policy) throw new HttpError(404, 'Envelope not found');
    return policy;
  }
  isAgentRevoked(agentId: string): boolean { return this.store.get<Agent>('agent', agentId)?.revoked ?? true; }
  isPolicyCurrent(decision: Decision): boolean {
    const policy = this.store.get<Policy>('policy', decision.agentId);
    const issued = this.store.get<DecisionPolicy>('decision.policy', decision.decisionId);
    return !!policy && !!issued && Date.parse(policy.envelope.agent.expires_at) > this.now() && decision.policyHash === policy.hash && issued.policyHash === policy.hash && issued.policyRevision === policy.revision;
  }
  approve(principal: Principal, input: unknown): unknown {
    if (principal.kind !== 'approver') throw new HttpError(403, 'Independent approver credential required');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Schema validation failed');
    const raw = input as Record<string, unknown>;
    const request = this.parseAuthorizationRequest(raw.request);
    const { input: _toolInput, input_hash: _inputHash, ...baseRequest } = request;
    void _toolInput;
    void _inputHash;
    const data = approvalSchema.parse({ ...raw, request: baseRequest });
    return this.store.transaction(() => {
      const policy = this.store.get<Policy>('policy', data.request.agentId);
      const agent = this.store.get<Agent>('agent', data.request.agentId);
      const rule = policy?.envelope.approvals.required_for.find(r => r.action === data.request.action);
      if (!policy || !agent || agent.revoked || !rule || rule.approver_role !== principal.role) throw new HttpError(403, 'Approver role or agent policy is invalid');
      const expiry = Date.parse(data.expiresAt);
      if (expiry <= this.now() || expiry > Date.parse(policy.envelope.agent.expires_at)) throw new HttpError(400, 'Approval expiry must be in the future and within envelope expiry');
      const verdict = evaluate(data.request, policy.envelope, this.context(agent, true));
      if (verdict.decision !== 'ALLOW') throw new HttpError(409, verdict.reason);
      const approval: Approval = { id: newId('apr'), agentId: agent.id, policyHash: policy.hash, policyRevision: policy.revision, requestHash: requestHash(request), role: principal.role, expiresAt: data.expiresAt, used: false };
      this.store.put('approval', approval.id, approval);
      this.audit('approval.issued', { ...approval });
      return { approvalId: approval.id, expiresAt: approval.expiresAt };
    });
  }
  private context(agent: Agent, approvalValid: boolean) {
    return { now: this.now(), revoked: agent.revoked, approvalValid,
      usage: this.store.get<Usage>('usage', agent.id) ?? emptyUsage(),
      knownAgents: new Set(this.store.list<Agent>('agent').filter(a => !a.revoked).map(a => a.id)) };
  }
  authorize(principal: Principal, input: unknown): Decision {
    const request = this.parseAuthorizationRequest(input);
    if (principal.kind !== 'agent' || principal.agentId !== request.agentId) throw new HttpError(403, 'Agent credential must match agentId');
    return this.store.transaction(() => {
      const agent = this.store.get<Agent>('agent', request.agentId);
      if (!agent) throw new HttpError(401, 'Unknown agent');
      const policy = this.store.get<Policy>('policy', agent.id);
      const approval = request.approvalId ? this.store.get<Approval>('approval', request.approvalId) : null;
      const rule = policy?.envelope.approvals.required_for.find(r => r.action === request.action);
      const valid = !!approval && !approval.used && approval.agentId === agent.id && approval.policyHash === policy?.hash && approval.policyRevision === policy?.revision
        && approval.requestHash === requestHash(request) && approval.role === rule?.approver_role && Date.parse(approval.expiresAt) > this.now();
      const context = this.context(agent, valid);
      const verdict = evaluate(request, policy?.envelope ?? null, context);
      const decision = { ...verdict, decisionId: newId('dec'), agentId: agent.id,
        severity: verdict.decision === 'ALLOW' ? 'info' : 'high', policyVersion: policy?.envelope.version ?? null,
        policyHash: policy?.hash ?? null, requiresEvidence: true, timestamp: new Date(context.now).toISOString(),
        request, approvalReference: valid && approval ? approval.id : null };
      if (decision.decision === 'ALLOW') {
        const usage = context.usage;
        usage.startedAt ??= decision.timestamp;
        usage.calls += 1;
        usage.external += request.destination ? 1 : 0;
        usage.costMicros += micros(request.estimatedCostUsd);
        usage.attempts[request.action] = attemptsFor(usage, request.action) + 1;
        this.store.put('usage', agent.id, usage);
        if (valid && approval) this.store.put('approval', approval.id, { ...approval, used: true });
      }
      this.store.put('decision', decision.decisionId, decision);
      if (policy) this.store.put('decision.policy', decision.decisionId, { policyHash: policy.hash, policyRevision: policy.revision } satisfies DecisionPolicy);
      this.store.append({ type: 'authorization.decision', ...decision });
      return decision as Decision;
    });
  }
  revoke(principal: Principal, input: unknown): unknown {
    this.requireAdmin(principal);
    const data = revokeSchema.parse(input);
    return this.store.transaction(() => {
      const agent = this.store.get<Agent>('agent', data.agentId);
      if (!agent) throw new HttpError(404, 'Agent not found');
      this.store.put('agent', agent.id, { ...agent, revoked: true });
      this.audit('agent.revoked', data);
      return { agentId: agent.id, revoked: true };
    });
  }
  decision(principal: Principal, id: string): Decision {
    const decision = this.store.get<Decision>('decision', id);
    if (!decision) throw new HttpError(404, 'Decision not found');
    this.requireReader(principal, decision.agentId);
    return decision;
  }
  activity(principal: Principal, agentId: string): Decision[] {
    this.requireReader(principal, agentId);
    return this.store.list<Decision>('decision').filter(d => d.agentId === agentId).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  private parseAuthorizationRequest(input: unknown): StoredRequest {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return requestSchema.parse(input) as StoredRequest;
    const raw = input as Record<string, unknown>;
    if (raw.tool !== demoToolInputMetadata.tool) return requestSchema.parse(input) as StoredRequest;
    const { input: toolInput, input_hash: suppliedHash, ...baseRequest } = raw;
    const request = requestSchema.parse(baseRequest);
    try {
      const parsed = this.inputRegistry.parseAndHash(demoToolInputMetadata.tool, toolInput);
      if (suppliedHash !== undefined && suppliedHash !== parsed.input_hash) throw new ToolInputError('Input hash mismatch');
      return { ...request, input: parsed.input, input_hash: parsed.input_hash };
    } catch (error) {
      if (error instanceof ToolInputError) throw new HttpError(400, error.message);
      throw error;
    }
  }
  audit(type: string, details: unknown): void { this.store.append({ type, timestamp: new Date(this.now()).toISOString(), details }); }
}
