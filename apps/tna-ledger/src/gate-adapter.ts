import type { LedgerEventInput } from '../../../packages/ledger-schema/src/index.js';

/**
 * Maps existing TNA Gate evidence into Ledger event inputs. Does not touch Gate's authorization
 * decisions or storage — it only translates evidence Gate already produced (section 45).
 *
 * Stream partitioning: one stream per agent (`agent:<agentId>`), so a single agent's full history
 * chains together. correlation_id is the decision_id, which threads one authorized action through
 * authorization -> capability -> execution.
 */
export class GateLedgerAdapter {
  public constructor(private readonly tenantId: string) {}

  private streamOf(agentId: string): string { return `agent:${agentId}`; }

  public agentRegistered(agentId: string): LedgerEventInput {
    return {
      version: '1.0', event_id: `agent.${agentId}.AGENT_REGISTERED`, event_type: 'AGENT_REGISTERED',
      tenant_id: this.tenantId, stream_id: this.streamOf(agentId), correlation_id: `agent:${agentId}`,
      actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate',
      authority_context: { agent_id: agentId },
    };
  }

  public authorizationAllowed(p: { agentId: string; decisionId: string; policyHash: string; action: string; tool?: string; resource?: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `${p.decisionId}.AUTHORIZATION_ALLOWED`, event_type: 'AUTHORIZATION_ALLOWED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.agentId), correlation_id: p.decisionId,
      actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate',
      authority_context: {
        agent_id: p.agentId, decision_id: p.decisionId, policy_hash: p.policyHash, action: p.action,
        ...(p.tool !== undefined ? { tool: p.tool } : {}), ...(p.resource !== undefined ? { resource: p.resource } : {}),
      },
    };
  }

  public capabilityIssued(p: { agentId: string; decisionId: string; capabilityId: string; expiresAt: string; tool?: string; resource?: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `${p.decisionId}.CAPABILITY_ISSUED.${p.capabilityId}`, event_type: 'CAPABILITY_ISSUED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.agentId), correlation_id: p.decisionId,
      causation_id: `${p.decisionId}.AUTHORIZATION_ALLOWED`,
      actor: { type: 'SYSTEM', id: 'execution-broker' }, source_component: 'execution-broker',
      authority_context: {
        agent_id: p.agentId, decision_id: p.decisionId, capability_id: p.capabilityId, authority_expiry: p.expiresAt,
        ...(p.tool !== undefined ? { tool: p.tool } : {}), ...(p.resource !== undefined ? { resource: p.resource } : {}),
      },
    };
  }

  public capabilityRedeemed(p: { agentId: string; decisionId: string; capabilityId: string; executionId: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `${p.decisionId}.CAPABILITY_REDEEMED.${p.capabilityId}`, event_type: 'CAPABILITY_REDEEMED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.agentId), correlation_id: p.decisionId,
      causation_id: `${p.decisionId}.CAPABILITY_ISSUED.${p.capabilityId}`,
      actor: { type: 'AGENT', id: p.agentId }, source_component: 'execution-broker',
      authority_context: { agent_id: p.agentId, decision_id: p.decisionId, capability_id: p.capabilityId },
      execution_context: { execution_id: p.executionId },
    };
  }

  public executionStarted(p: { agentId: string; decisionId: string; executionId: string; tool: string; resource: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `${p.decisionId}.EXECUTION_STARTED.${p.executionId}`, event_type: 'EXECUTION_STARTED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.agentId), correlation_id: p.decisionId,
      causation_id: `${p.decisionId}.CAPABILITY_REDEEMED.${p.executionId}`,
      actor: { type: 'SYSTEM', id: 'execution-broker' }, source_component: 'execution-broker',
      execution_context: { execution_id: p.executionId, tool: p.tool, resource: p.resource },
    };
  }

  public executionSucceeded(p: { agentId: string; decisionId: string; executionId: string; resultHash: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `${p.decisionId}.EXECUTION_SUCCEEDED.${p.executionId}`, event_type: 'EXECUTION_SUCCEEDED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.agentId), correlation_id: p.decisionId,
      causation_id: `${p.decisionId}.EXECUTION_STARTED.${p.executionId}`,
      actor: { type: 'SYSTEM', id: 'execution-broker' }, source_component: 'execution-broker',
      execution_context: { execution_id: p.executionId, result_hash: p.resultHash },
    };
  }

  public executionFailed(p: { agentId: string; decisionId: string; executionId: string; terminationReason: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `${p.decisionId}.EXECUTION_FAILED.${p.executionId}`, event_type: 'EXECUTION_FAILED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.agentId), correlation_id: p.decisionId,
      causation_id: `${p.decisionId}.EXECUTION_STARTED.${p.executionId}`,
      actor: { type: 'SYSTEM', id: 'execution-broker' }, source_component: 'execution-broker',
      execution_context: { execution_id: p.executionId, termination_reason: p.terminationReason },
    };
  }

  public agentRevoked(p: { agentId: string; reason: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `agent.${p.agentId}.AGENT_REVOKED.${Date.now()}`, event_type: 'AGENT_REVOKED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.agentId), correlation_id: `agent:${p.agentId}`,
      actor: { type: 'ADMIN', id: 'ledger-admin' }, source_component: 'tna-gate',
      authority_context: { agent_id: p.agentId },
      payload: { reason: p.reason },
    };
  }
}
