import {
  LedgerError, MAX_QUERY_PAGE_SIZE, DEFAULT_QUERY_PAGE_SIZE, MAX_RECONSTRUCTION_EVENTS, MAX_EXPORT_EVENTS,
  hash, computePayloadHash, type LedgerEvent,
} from '../../ledger-schema/src/index.js';
import { type LedgerStore, type StreamHead } from '../../ledger-store/src/index.js';
import { verifyStream, recomputeEventHash } from '../../ledger-integrity/src/index.js';

export interface Page<T> { items: T[]; nextCursor: string | null }

function encodeCursor(offset: number): string { return Buffer.from(String(offset), 'utf8').toString('base64url'); }
function decodeCursor(cursor?: string): number {
  if (cursor === undefined) return 0;
  const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(decoded) || decoded < 0) throw new LedgerError('INVALID_EVENT', 'Invalid pagination cursor');
  return decoded;
}
function boundedLimit(limit?: number): number {
  const value = limit ?? DEFAULT_QUERY_PAGE_SIZE;
  if (!Number.isInteger(value) || value <= 0) throw new LedgerError('INVALID_EVENT', 'limit must be a positive integer');
  return Math.min(value, MAX_QUERY_PAGE_SIZE);
}

/** Deterministic ordering (section 40): received_at, then stream_id, then sequence, then event_id. */
function page(store: LedgerStore, tenantId: string, filters: Parameters<LedgerStore['query']>[1], limit?: number, cursor?: string): Page<LedgerEvent> {
  const boundedLimitValue = boundedLimit(limit);
  const offset = decodeCursor(cursor);
  const rows = store.query(tenantId, filters, boundedLimitValue + 1, offset);
  const truncated = rows.length > boundedLimitValue;
  const items = truncated ? rows.slice(0, boundedLimitValue) : rows;
  return { items, nextCursor: truncated ? encodeCursor(offset + boundedLimitValue) : null };
}

export function getEvent(store: LedgerStore, tenantId: string, eventId: string): LedgerEvent {
  const event = store.getByEventId(tenantId, eventId);
  if (!event) throw new LedgerError('NOT_FOUND', `No event ${eventId}`);
  return event;
}

/**
 * Bounded, paginated public stream retrieval. An ordinary caller cannot pull an unlimited stream
 * through this path: the page size defaults to DEFAULT_QUERY_PAGE_SIZE, is clamped (not rejected)
 * at MAX_QUERY_PAGE_SIZE, and traversal continues via an opaque cursor.
 *
 * Ordering: `page()` orders by (received_at, stream_id, sequence, event_id). Within a single
 * stream_id, sequence is the last tiebreaker and received_at is non-decreasing with sequence
 * (each append reads the store clock inside the same serialized transaction that assigns the next
 * sequence), so this yields the stream's hash-chain order deterministically.
 *
 * This is NOT the path integrity verification uses — `verifyStream` (ledger-integrity) reads the
 * whole stream through the internal `LedgerStore.listStream` primitive and is unaffected by this
 * public pagination.
 */
export function getStream(store: LedgerStore, tenantId: string, streamId: string, limit?: number, cursor?: string): Page<LedgerEvent> {
  return page(store, tenantId, { streamId }, limit, cursor);
}

export function getEventsByActor(store: LedgerStore, tenantId: string, actorId: string, limit?: number, cursor?: string): Page<LedgerEvent> {
  return page(store, tenantId, { actorId }, limit, cursor);
}
export function getEventsByCorrelation(store: LedgerStore, tenantId: string, correlationId: string, limit?: number, cursor?: string): Page<LedgerEvent> {
  return page(store, tenantId, { correlationId }, limit, cursor);
}
export function getEventsByType(store: LedgerStore, tenantId: string, eventType: string, limit?: number, cursor?: string): Page<LedgerEvent> {
  return page(store, tenantId, { eventType }, limit, cursor);
}
export function getEventsByTimeRange(store: LedgerStore, tenantId: string, fromTime: string, toTime: string, limit?: number, cursor?: string): Page<LedgerEvent> {
  return page(store, tenantId, { fromTime, toTime }, limit, cursor);
}
export function getEventsByDecision(store: LedgerStore, tenantId: string, decisionId: string): LedgerEvent[] {
  return store.findByContextField(tenantId, 'authority_context', 'decision_id', decisionId);
}
export function getEventsByExecution(store: LedgerStore, tenantId: string, executionId: string): LedgerEvent[] {
  return store.findByContextField(tenantId, 'execution_context', 'execution_id', executionId);
}
export function getEventsByAtom(store: LedgerStore, tenantId: string, atomId: string): LedgerEvent[] {
  return store.findByContextField(tenantId, 'spec_context', 'atom_id', atomId);
}

/** Multi-filter search used by the search API (section 37). All clauses are parameterized (section 38). */
export function search(store: LedgerStore, tenantId: string, filters: Parameters<LedgerStore['query']>[1], limit?: number, cursor?: string): Page<LedgerEvent> {
  return page(store, tenantId, filters, limit, cursor);
}

interface EvidenceRef { eventId: string; eventType: string; streamId: string; sequence: number }
function evidenceRef(event: LedgerEvent): EvidenceRef {
  return { eventId: event.event_id, eventType: event.event_type, streamId: event.stream_id, sequence: event.sequence };
}
function correlationEvents(store: LedgerStore, tenantId: string, correlationId: string): { events: LedgerEvent[]; truncated: boolean } {
  const rows = store.query(tenantId, { correlationId }, MAX_RECONSTRUCTION_EVENTS + 1);
  const truncated = rows.length > MAX_RECONSTRUCTION_EVENTS;
  return { events: truncated ? rows.slice(0, MAX_RECONSTRUCTION_EVENTS) : rows, truncated };
}

export interface GateActionReconstruction {
  correlationId: string;
  truncated: boolean;
  who: { actorType: string; actorId: string } | null;
  authorizedUnder: { decisionId: string; policyHash: string } | null;
  what: string | null;
  tool: string | null;
  resource: string | null;
  approval: { actorType: string; actorId: string } | null;
  capability: { capabilityId: string } | null;
  execution: { executionId: string } | null;
  outcome: 'SUCCEEDED' | 'FAILED' | 'TERMINATED' | 'INDETERMINATE' | 'UNKNOWN';
  evidence: EvidenceRef[];
}

/** Reconstructs an authorized Gate action from Ledger evidence alone (section 41). */
export function reconstructGateAction(store: LedgerStore, tenantId: string, correlationId: string): GateActionReconstruction {
  const { events, truncated } = correlationEvents(store, tenantId, correlationId);
  const allowed = events.find(e => e.event_type === 'AUTHORIZATION_ALLOWED');
  const approval = events.find(e => e.event_type === 'APPROVAL_GRANTED');
  const capability = events.find(e => e.event_type === 'CAPABILITY_ISSUED');
  const execution = events.find(e => e.event_type === 'EXECUTION_STARTED');
  const outcomeEvent = [...events].reverse().find(e =>
    ['EXECUTION_SUCCEEDED', 'EXECUTION_FAILED', 'EXECUTION_TERMINATED', 'EXECUTION_INDETERMINATE'].includes(e.event_type));
  const outcome = outcomeEvent
    ? (outcomeEvent.event_type.replace('EXECUTION_', '') as GateActionReconstruction['outcome'])
    : 'UNKNOWN';
  return {
    correlationId, truncated,
    who: allowed ? { actorType: allowed.actor.type, actorId: allowed.actor.id } : null,
    authorizedUnder: allowed?.authority_context?.decision_id && allowed.authority_context.policy_hash
      ? { decisionId: allowed.authority_context.decision_id, policyHash: allowed.authority_context.policy_hash } : null,
    what: allowed?.authority_context?.action ?? null,
    tool: allowed?.authority_context?.tool ?? capability?.authority_context?.tool ?? null,
    resource: allowed?.authority_context?.resource ?? capability?.authority_context?.resource ?? null,
    approval: approval ? { actorType: approval.actor.type, actorId: approval.actor.id } : null,
    capability: capability?.authority_context?.capability_id ? { capabilityId: capability.authority_context.capability_id } : null,
    execution: execution?.execution_context?.execution_id ? { executionId: execution.execution_context.execution_id } : null,
    outcome,
    evidence: events.map(evidenceRef),
  };
}

export interface VadAtomReconstruction {
  correlationId: string;
  truncated: boolean;
  atom: { atomId: string; specHash: string } | null;
  attempts: Array<{ eventType: string; attemptNumber: number | null; sequence: number }>;
  validation: { passed: boolean } | null;
  verification: { verdict: string } | null;
  humanDecision: { decision: string; actorId: string } | null;
  finalState: 'ACCEPTED' | 'REJECTED' | 'ESCALATED' | 'UNKNOWN';
  evidence: EvidenceRef[];
}

/** Reconstructs a VAD atom's lifecycle from Ledger evidence alone (section 42). */
export function reconstructVadAtom(store: LedgerStore, tenantId: string, correlationId: string): VadAtomReconstruction {
  const { events, truncated } = correlationEvents(store, tenantId, correlationId);
  const created = events.find(e => e.event_type === 'ATOM_CREATED');
  const attempts = events
    .filter(e => e.event_type === 'ATOM_ATTEMPT_STARTED' || e.event_type === 'ATOM_ATTEMPT_FAILED')
    .map(e => ({ eventType: e.event_type, attemptNumber: e.spec_context?.attempt_number ?? null, sequence: e.sequence }));
  const validationPassed = events.find(e => e.event_type === 'ATOM_VALIDATION_PASSED');
  const validationFailed = [...events].reverse().find(e => e.event_type === 'ATOM_VALIDATION_FAILED');
  const verification = [...events].reverse().find(e => e.event_type === 'ATOM_VERIFICATION_ACCEPTED' || e.event_type === 'ATOM_VERIFICATION_REJECTED');
  const humanDecision = [...events].reverse().find(e => e.event_type === 'ATOM_HUMAN_DECISION');
  const finalEvent = [...events].reverse().find(e => ['ATOM_ACCEPTED', 'ATOM_REJECTED', 'ATOM_ESCALATED'].includes(e.event_type));
  return {
    correlationId, truncated,
    atom: created?.spec_context?.atom_id && created.spec_context.spec_hash
      ? { atomId: created.spec_context.atom_id, specHash: created.spec_context.spec_hash } : null,
    attempts,
    validation: validationPassed ? { passed: true } : validationFailed ? { passed: false } : null,
    verification: verification?.spec_context?.verifier_verdict ? { verdict: verification.spec_context.verifier_verdict } : null,
    humanDecision: humanDecision?.spec_context?.human_decision ? { decision: humanDecision.spec_context.human_decision, actorId: humanDecision.actor.id } : null,
    finalState: finalEvent ? (finalEvent.event_type.replace('ATOM_', '') as VadAtomReconstruction['finalState']) : 'UNKNOWN',
    evidence: events.map(evidenceRef),
  };
}

export interface EvidenceExportBundle {
  version: '1.0';
  tenantId: string;
  correlationId: string;
  exportedAt: string;
  events: LedgerEvent[];
  streamHeads: StreamHead[];
  verification: Array<{ streamId: string; valid: boolean }>;
  exportHash: string;
}

/** Deterministic, self-contained, portable evidence export for one correlation (sections 66-69). Contains no secrets. */
export function exportEvidence(store: LedgerStore, tenantId: string, correlationId: string, clock: () => number = Date.now): EvidenceExportBundle {
  const rows = store.query(tenantId, { correlationId }, MAX_EXPORT_EVENTS);
  const streamIds = [...new Set(rows.map(event => event.stream_id))].sort();
  const streamHeads = streamIds.map(streamId => store.streamHead(tenantId, streamId)).filter((head): head is StreamHead => head !== null);
  const verification = streamIds.map(streamId => ({ streamId, valid: verifyStream(store, tenantId, streamId, { persist: false }).valid }));
  const exportedAt = new Date(clock()).toISOString();
  const withoutHash = { version: '1.0' as const, tenantId, correlationId, exportedAt, events: rows, streamHeads, verification };
  return { ...withoutHash, exportHash: hash(withoutHash) };
}

export interface ExportVerificationResult { valid: boolean; reason?: string }

/**
 * Verifies a previously exported bundle using only its own contents — no store access required.
 *
 * An export is scoped to one correlation, which is typically a strict subset of a stream (e.g. an
 * AGENT_REGISTERED event outside the exported decision's correlation is legitimately absent). So the
 * first included event of a stream is not required to chain back to GENESIS, and a sequence gap
 * between two included events is not itself a fault — it just means chain continuity cannot be
 * checked across that gap. What IS checked: every event's own hashes recompute correctly, and any
 * two included events that are sequence-adjacent (nothing was excluded between them) must chain.
 */
export function verifyExportedBundle(bundle: EvidenceExportBundle): ExportVerificationResult {
  const { exportHash, ...rest } = bundle;
  if (hash(rest) !== exportHash) return { valid: false, reason: 'EXPORT_HASH_MISMATCH' };
  const lastSeenByStream = new Map<string, LedgerEvent>();
  const ordered = [...bundle.events].sort((a, b) => (a.stream_id === b.stream_id ? a.sequence - b.sequence : a.stream_id < b.stream_id ? -1 : 1));
  for (const event of ordered) {
    const previousIncluded = lastSeenByStream.get(event.stream_id);
    if (previousIncluded && previousIncluded.sequence + 1 === event.sequence && event.previous_event_hash !== previousIncluded.event_hash) {
      return { valid: false, reason: 'CHAIN_BROKEN' };
    }
    if (computePayloadHash(event.payload) !== event.payload_hash) return { valid: false, reason: 'PAYLOAD_HASH_MISMATCH' };
    if (recomputeEventHash(event) !== event.event_hash) return { valid: false, reason: 'EVENT_HASH_MISMATCH' };
    lastSeenByStream.set(event.stream_id, event);
  }
  return { valid: true };
}
