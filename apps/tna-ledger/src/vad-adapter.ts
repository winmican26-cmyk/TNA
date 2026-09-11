import type { LedgerEventInput } from '../../../packages/ledger-schema/src/index.js';

/**
 * Maps existing VAD Engine evidence into Ledger event inputs (section 46). VadExecution does not
 * expose lifecycle hooks, so this adapter is driven explicitly by the caller after each step rather
 * than by introspecting VadExecution's private state — it does not alter VAD's acceptance logic.
 *
 * Stream partitioning: one stream per atom (`atom:<atomId>`). correlation_id equals stream_id: a
 * VAD atom's entire history is one workflow.
 */
export class VadLedgerAdapter {
  public constructor(private readonly tenantId: string) {}

  private streamOf(atomId: string): string { return `atom:${atomId}`; }

  public atomCreated(p: { atomId: string; specHash: string; riskLevel: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `atom:${p.atomId}.ATOM_CREATED`, event_type: 'ATOM_CREATED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.atomId), correlation_id: this.streamOf(p.atomId),
      actor: { type: 'SYSTEM', id: 'vad-engine' }, source_component: 'vad-engine',
      spec_context: { atom_id: p.atomId, spec_hash: p.specHash, risk_level: p.riskLevel },
    };
  }

  public attemptStarted(p: { atomId: string; specHash: string; attemptNumber: number }): LedgerEventInput {
    return {
      version: '1.0', event_id: `atom:${p.atomId}.ATOM_ATTEMPT_STARTED.${p.attemptNumber}`, event_type: 'ATOM_ATTEMPT_STARTED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.atomId), correlation_id: this.streamOf(p.atomId),
      causation_id: `atom:${p.atomId}.ATOM_CREATED`,
      actor: { type: 'PRODUCER', id: 'vad-producer' }, source_component: 'vad-engine',
      spec_context: { atom_id: p.atomId, spec_hash: p.specHash, attempt_number: p.attemptNumber },
    };
  }

  public attemptFailed(p: { atomId: string; specHash: string; attemptNumber: number; artifactHash: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `atom:${p.atomId}.ATOM_ATTEMPT_FAILED.${p.attemptNumber}`, event_type: 'ATOM_ATTEMPT_FAILED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.atomId), correlation_id: this.streamOf(p.atomId),
      causation_id: `atom:${p.atomId}.ATOM_ATTEMPT_STARTED.${p.attemptNumber}`,
      actor: { type: 'SYSTEM', id: 'vad-engine' }, source_component: 'vad-engine',
      spec_context: { atom_id: p.atomId, spec_hash: p.specHash, attempt_number: p.attemptNumber },
      artifact_context: { artifact_hash: p.artifactHash },
    };
  }

  public validationPassed(p: { atomId: string; specHash: string; attemptNumber: number; artifactHash: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `atom:${p.atomId}.ATOM_VALIDATION_PASSED.${p.attemptNumber}`, event_type: 'ATOM_VALIDATION_PASSED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.atomId), correlation_id: this.streamOf(p.atomId),
      causation_id: `atom:${p.atomId}.ATOM_ATTEMPT_STARTED.${p.attemptNumber}`,
      actor: { type: 'SYSTEM', id: 'vad-engine' }, source_component: 'vad-engine',
      spec_context: { atom_id: p.atomId, spec_hash: p.specHash, attempt_number: p.attemptNumber },
      artifact_context: { artifact_hash: p.artifactHash },
    };
  }

  public verificationAccepted(p: { atomId: string; specHash: string; verifierId: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `atom:${p.atomId}.ATOM_VERIFICATION_ACCEPTED`, event_type: 'ATOM_VERIFICATION_ACCEPTED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.atomId), correlation_id: this.streamOf(p.atomId),
      actor: { type: 'VERIFIER', id: p.verifierId }, source_component: 'vad-engine',
      spec_context: { atom_id: p.atomId, spec_hash: p.specHash, verifier_id: p.verifierId, verifier_verdict: 'ACCEPT' },
    };
  }

  public verificationRejected(p: { atomId: string; specHash: string; verifierId: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `atom:${p.atomId}.ATOM_VERIFICATION_REJECTED`, event_type: 'ATOM_VERIFICATION_REJECTED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.atomId), correlation_id: this.streamOf(p.atomId),
      actor: { type: 'VERIFIER', id: p.verifierId }, source_component: 'vad-engine',
      spec_context: { atom_id: p.atomId, spec_hash: p.specHash, verifier_id: p.verifierId, verifier_verdict: 'REJECT' },
    };
  }

  public humanDecision(p: { atomId: string; specHash: string; actorId: string; decision: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `atom:${p.atomId}.ATOM_HUMAN_DECISION`, event_type: 'ATOM_HUMAN_DECISION',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.atomId), correlation_id: this.streamOf(p.atomId),
      causation_id: `atom:${p.atomId}.ATOM_VERIFICATION_ACCEPTED`,
      actor: { type: 'HUMAN', id: p.actorId }, source_component: 'human-decision-service',
      spec_context: { atom_id: p.atomId, spec_hash: p.specHash, human_decision: p.decision },
    };
  }

  public atomAccepted(p: { atomId: string; specHash: string; artifactHash: string; verifierVerdict: string; humanDecision: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `atom:${p.atomId}.ATOM_ACCEPTED`, event_type: 'ATOM_ACCEPTED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.atomId), correlation_id: this.streamOf(p.atomId),
      causation_id: `atom:${p.atomId}.ATOM_HUMAN_DECISION`,
      actor: { type: 'SYSTEM', id: 'vad-engine' }, source_component: 'vad-engine',
      spec_context: { atom_id: p.atomId, spec_hash: p.specHash, verifier_verdict: p.verifierVerdict, human_decision: p.humanDecision },
      artifact_context: { artifact_hash: p.artifactHash },
    };
  }

  public atomRejected(p: { atomId: string; specHash: string; verifierVerdict: string; humanDecision: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `atom:${p.atomId}.ATOM_REJECTED`, event_type: 'ATOM_REJECTED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.atomId), correlation_id: this.streamOf(p.atomId),
      causation_id: `atom:${p.atomId}.ATOM_HUMAN_DECISION`,
      actor: { type: 'SYSTEM', id: 'vad-engine' }, source_component: 'vad-engine',
      spec_context: { atom_id: p.atomId, spec_hash: p.specHash, verifier_verdict: p.verifierVerdict, human_decision: p.humanDecision },
    };
  }

  public atomEscalated(p: { atomId: string; specHash: string; reason: string }): LedgerEventInput {
    return {
      version: '1.0', event_id: `atom:${p.atomId}.ATOM_ESCALATED`, event_type: 'ATOM_ESCALATED',
      tenant_id: this.tenantId, stream_id: this.streamOf(p.atomId), correlation_id: this.streamOf(p.atomId),
      actor: { type: 'SYSTEM', id: 'vad-engine' }, source_component: 'vad-engine',
      spec_context: { atom_id: p.atomId, spec_hash: p.specHash },
      payload: { reason: p.reason },
    };
  }
}
