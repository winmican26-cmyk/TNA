import { LedgerError, validateEventInput, type LedgerEvent, type LedgerEventInput, type SourceComponent } from '../../ledger-schema/src/index.js';
import { LedgerStore } from '../../ledger-store/src/index.js';
import {
  verifyStream as verifyStreamImpl, verifyAll as verifyAllImpl,
  type StreamVerificationResult, type FullVerificationResult,
} from '../../ledger-integrity/src/index.js';
import {
  getEvent as getEventImpl, getStream as getStreamImpl, getEventsByActor as getEventsByActorImpl,
  getEventsByCorrelation as getEventsByCorrelationImpl, getEventsByType as getEventsByTypeImpl,
  getEventsByTimeRange as getEventsByTimeRangeImpl, getEventsByDecision as getEventsByDecisionImpl,
  getEventsByExecution as getEventsByExecutionImpl, getEventsByAtom as getEventsByAtomImpl, search as searchImpl,
  reconstructGateAction as reconstructGateActionImpl, reconstructVadAtom as reconstructVadAtomImpl,
  exportEvidence as exportEvidenceImpl, verifyExportedBundle as verifyExportedBundleImpl,
  type Page, type GateActionReconstruction, type VadAtomReconstruction, type EvidenceExportBundle, type ExportVerificationResult,
} from '../../ledger-query/src/index.js';

export type { LedgerEvent, LedgerEventInput, StreamVerificationResult, FullVerificationResult, Page, GateActionReconstruction, VadAtomReconstruction, EvidenceExportBundle, ExportVerificationResult };
export { LedgerStore, LedgerError };

export type LedgerRole = 'writer' | 'reader' | 'admin';

/** A service identity bound to the Ledger. Never derived from caller-supplied request fields. */
export interface LedgerPrincipal {
  readonly id: string;
  readonly role: LedgerRole;
  readonly tenantId: string;
  readonly allowedSourceComponents: readonly SourceComponent[];
}

export function writerPrincipal(id: string, tenantId: string, allowedSourceComponents: readonly SourceComponent[]): LedgerPrincipal {
  return { id, role: 'writer', tenantId, allowedSourceComponents };
}
export function readerPrincipal(id: string, tenantId: string): LedgerPrincipal {
  return { id, role: 'reader', tenantId, allowedSourceComponents: [] };
}
export function adminPrincipal(id: string, tenantId: string): LedgerPrincipal {
  return { id, role: 'admin', tenantId, allowedSourceComponents: [] };
}

function assertCanWrite(principal: LedgerPrincipal, input: LedgerEventInput): void {
  if (principal.role !== 'writer') throw new LedgerError('FORBIDDEN', `Principal ${principal.id} does not hold write authority`);
  if (principal.tenantId !== input.tenant_id) throw new LedgerError('FORBIDDEN', `Principal ${principal.id} is not authorized for tenant ${input.tenant_id}`);
  if (!principal.allowedSourceComponents.includes(input.source_component)) {
    throw new LedgerError('FORBIDDEN', `Principal ${principal.id} is not bound to source_component "${input.source_component}"`);
  }
}
function assertCanRead(principal: LedgerPrincipal): void {
  if (principal.role !== 'reader' && principal.role !== 'admin') throw new LedgerError('FORBIDDEN', `Principal ${principal.id} does not hold read authority`);
}
function assertIsAdmin(principal: LedgerPrincipal): void {
  if (principal.role !== 'admin') throw new LedgerError('FORBIDDEN', `Principal ${principal.id} does not hold admin authority`);
}

/**
 * Local, reliably-enforceable cross-event invariants (section 62). Each rule looks for the causal
 * predecessor an event claims to extend; a "successful" event with no such predecessor is an orphan
 * and is rejected rather than silently accepted (section 63).
 */
function assertInvariants(store: LedgerStore, input: LedgerEventInput): void {
  switch (input.event_type) {
    case 'CAPABILITY_REDEEMED': {
      const capabilityId = input.authority_context?.capability_id;
      if (capabilityId && store.findByContextField(input.tenant_id, 'authority_context', 'capability_id', capabilityId, ['CAPABILITY_ISSUED']).length === 0) {
        throw new LedgerError('ORPHAN_EVENT', 'CAPABILITY_REDEEMED has no prior CAPABILITY_ISSUED for this capability_id');
      }
      break;
    }
    case 'EXECUTION_SUCCEEDED':
    case 'EXECUTION_FAILED':
    case 'EXECUTION_TERMINATED':
    case 'EXECUTION_INDETERMINATE': {
      const executionId = input.execution_context?.execution_id;
      if (executionId && store.findByContextField(input.tenant_id, 'execution_context', 'execution_id', executionId, ['EXECUTION_STARTED']).length === 0) {
        throw new LedgerError('ORPHAN_EVENT', `${input.event_type} has no prior EXECUTION_STARTED for this execution_id`);
      }
      break;
    }
    case 'ATOM_ACCEPTED': {
      const atomId = input.spec_context?.atom_id;
      if (atomId) {
        const verified = store.findByContextField(input.tenant_id, 'spec_context', 'atom_id', atomId, ['ATOM_VERIFICATION_ACCEPTED']);
        const decided = store.findByContextField(input.tenant_id, 'spec_context', 'atom_id', atomId, ['ATOM_HUMAN_DECISION']);
        if (verified.length === 0 || decided.length === 0) {
          throw new LedgerError('ORPHAN_EVENT', 'ATOM_ACCEPTED requires a prior ATOM_VERIFICATION_ACCEPTED and ATOM_HUMAN_DECISION for this atom_id');
        }
      }
      break;
    }
    case 'AGENT_REVOKED': {
      const agentId = input.authority_context?.agent_id;
      if (agentId && store.findByContextField(input.tenant_id, 'authority_context', 'agent_id', agentId, ['AGENT_REGISTERED']).length === 0) {
        throw new LedgerError('ORPHAN_EVENT', 'AGENT_REVOKED references an unknown agent_id');
      }
      break;
    }
    default:
      break;
  }
}

/**
 * The Ledger domain facade: the only sanctioned entry point for TNA Gate, VAD, and API callers.
 * Every method requires a LedgerPrincipal and enforces role, tenant, and source-component binding
 * before touching the store. The Ledger records evidence; it does not authorize (Gate) or verify
 * correctness (VAD) — see docs/ledger/ledger-threat-model-v0.1.md (TNA-23).
 */
export class Ledger {
  public constructor(private readonly store: LedgerStore) {}

  public append(principal: LedgerPrincipal, rawInput: unknown): LedgerEvent {
    const input = validateEventInput(rawInput);
    assertCanWrite(principal, input);
    assertInvariants(this.store, input);
    return this.store.append(input);
  }

  public getEvent(principal: LedgerPrincipal, eventId: string): LedgerEvent { assertCanRead(principal); return getEventImpl(this.store, principal.tenantId, eventId); }
  public getStream(principal: LedgerPrincipal, streamId: string, limit?: number, cursor?: string): Page<LedgerEvent> { assertCanRead(principal); return getStreamImpl(this.store, principal.tenantId, streamId, limit, cursor); }
  public getEventsByActor(principal: LedgerPrincipal, actorId: string, limit?: number, cursor?: string): Page<LedgerEvent> { assertCanRead(principal); return getEventsByActorImpl(this.store, principal.tenantId, actorId, limit, cursor); }
  public getEventsByCorrelation(principal: LedgerPrincipal, correlationId: string, limit?: number, cursor?: string): Page<LedgerEvent> { assertCanRead(principal); return getEventsByCorrelationImpl(this.store, principal.tenantId, correlationId, limit, cursor); }
  public getEventsByType(principal: LedgerPrincipal, eventType: string, limit?: number, cursor?: string): Page<LedgerEvent> { assertCanRead(principal); return getEventsByTypeImpl(this.store, principal.tenantId, eventType, limit, cursor); }
  public getEventsByTimeRange(principal: LedgerPrincipal, fromTime: string, toTime: string, limit?: number, cursor?: string): Page<LedgerEvent> { assertCanRead(principal); return getEventsByTimeRangeImpl(this.store, principal.tenantId, fromTime, toTime, limit, cursor); }
  public getEventsByDecision(principal: LedgerPrincipal, decisionId: string): LedgerEvent[] { assertCanRead(principal); return getEventsByDecisionImpl(this.store, principal.tenantId, decisionId); }
  public getEventsByExecution(principal: LedgerPrincipal, executionId: string): LedgerEvent[] { assertCanRead(principal); return getEventsByExecutionImpl(this.store, principal.tenantId, executionId); }
  public getEventsByAtom(principal: LedgerPrincipal, atomId: string): LedgerEvent[] { assertCanRead(principal); return getEventsByAtomImpl(this.store, principal.tenantId, atomId); }
  public search(principal: LedgerPrincipal, filters: { actorId?: string; correlationId?: string; eventType?: string; streamId?: string; fromTime?: string; toTime?: string }, limit?: number, cursor?: string): Page<LedgerEvent> { assertCanRead(principal); return searchImpl(this.store, principal.tenantId, filters, limit, cursor); }

  public verifyStream(principal: LedgerPrincipal, streamId: string): StreamVerificationResult { assertCanRead(principal); return verifyStreamImpl(this.store, principal.tenantId, streamId); }
  public verifyAll(principal: LedgerPrincipal): FullVerificationResult { assertIsAdmin(principal); return verifyAllImpl(this.store, { tenantId: principal.tenantId }); }

  public reconstructGateAction(principal: LedgerPrincipal, correlationId: string): GateActionReconstruction { assertCanRead(principal); return reconstructGateActionImpl(this.store, principal.tenantId, correlationId); }
  public reconstructVadAtom(principal: LedgerPrincipal, correlationId: string): VadAtomReconstruction { assertCanRead(principal); return reconstructVadAtomImpl(this.store, principal.tenantId, correlationId); }

  public exportEvidence(principal: LedgerPrincipal, correlationId: string): EvidenceExportBundle { assertCanRead(principal); return exportEvidenceImpl(this.store, principal.tenantId, correlationId); }
  public verifyExportedBundle(principal: LedgerPrincipal, bundle: EvidenceExportBundle): ExportVerificationResult { assertCanRead(principal); return verifyExportedBundleImpl(bundle); }

  public close(): void { this.store.close(); }
}
