import { Gate } from '../../tna-gate-api/src/gate.js';
import type { GateDecisionLike, GatePort } from '../../../packages/platform-core/src/index.js';

/**
 * Real orchestration adapter over the accepted TNA Gate (section 14) — `PlatformActionRequest ->
 * GateActionAdapter -> Authority Envelope / Decision`. Uses only Gate's own public `authorize()`
 * method; no Gate behavior is modified or reimplemented, and nothing here can bypass Gate by calling
 * the execution broker directly (that only happens after this adapter returns ALLOW, via
 * `apps/tna-platform`'s separately-wired `ExecutionBroker`).
 */
export class GateActionAdapter implements GatePort {
  public constructor(private readonly gate: Gate) {}
  public authorize(principal: { readonly kind: 'agent'; readonly agentId: string }, request: {
    readonly agentId: string; readonly action: string; readonly tool: string; readonly resource: string;
    readonly estimatedCostUsd: number; readonly destination?: string;
  }): GateDecisionLike {
    const decision = this.gate.authorize(principal, request);
    return {
      decisionId: decision.decisionId, decision: decision.decision, reason: decision.reason,
      policyHash: decision.policyHash, policyVersion: decision.policyVersion,
      approvalReference: decision.approvalReference, timestamp: decision.timestamp,
    };
  }
}
