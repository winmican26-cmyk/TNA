import { GENESIS_HASH, type LedgerStore } from '../../ledger-store/src/index.js';
import { computeEventHash, computePayloadHash, type LedgerEvent } from '../../ledger-schema/src/index.js';

export type IntegrityFailureReason =
  | 'SEQUENCE_GAP_OR_DUPLICATE' | 'PREVIOUS_HASH_MISMATCH' | 'PAYLOAD_HASH_MISMATCH'
  | 'EVENT_HASH_MISMATCH' | 'STREAM_HEAD_MISMATCH' | 'STREAM_HEAD_SEQUENCE_MISMATCH' | 'EMPTY_STREAM_WITH_HEAD';

export interface StreamVerificationResult {
  valid: boolean;
  tenantId: string;
  streamId: string;
  eventsChecked: number;
  firstInvalidSequence: number | null;
  reason: IntegrityFailureReason | null;
}

export function recomputeEventHash(event: LedgerEvent): string {
  return computeEventHash({
    version: event.version, tenant_id: event.tenant_id, stream_id: event.stream_id, sequence: event.sequence,
    event_id: event.event_id, event_type: event.event_type, occurred_at: event.occurred_at ?? null,
    actor: event.actor, correlation_id: event.correlation_id,
    causation_id: event.causation_id ?? null, parent_event_id: event.parent_event_id ?? null,
    source_component: event.source_component,
    ...(event.authority_context !== undefined ? { authority_context: event.authority_context } : {}),
    ...(event.spec_context !== undefined ? { spec_context: event.spec_context } : {}),
    ...(event.execution_context !== undefined ? { execution_context: event.execution_context } : {}),
    ...(event.artifact_context !== undefined ? { artifact_context: event.artifact_context } : {}),
    payload_hash: event.payload_hash, previous_event_hash: event.previous_event_hash,
  });
}

/**
 * Recomputes a stream's entire hash chain from stored rows and compares it against what is stored.
 * Detects: sequence gaps/duplicates, broken previous-hash linkage, payload tampering, event-hash
 * tampering, and a stream head inconsistent with its last event. On failure the stream is persisted
 * as INVALID (fail-closed, section 85) unless `persist: false` is passed for a read-only probe.
 */
export function verifyStream(store: LedgerStore, tenantId: string, streamId: string, options: { persist?: boolean } = {}): StreamVerificationResult {
  const persist = options.persist ?? true;
  const events = store.listStream(tenantId, streamId);
  let previousHash = GENESIS_HASH;
  let expectedSequence = 1;
  const fail = (event: LedgerEvent, reason: IntegrityFailureReason): StreamVerificationResult => {
    const result: StreamVerificationResult = { valid: false, tenantId, streamId, eventsChecked: events.length, firstInvalidSequence: event.sequence, reason };
    if (persist) store.markStreamInvalid(tenantId, streamId, `${reason} at sequence ${event.sequence}`);
    return result;
  };
  for (const event of events) {
    if (event.sequence !== expectedSequence) return fail(event, 'SEQUENCE_GAP_OR_DUPLICATE');
    if (event.previous_event_hash !== previousHash) return fail(event, 'PREVIOUS_HASH_MISMATCH');
    if (computePayloadHash(event.payload) !== event.payload_hash) return fail(event, 'PAYLOAD_HASH_MISMATCH');
    if (recomputeEventHash(event) !== event.event_hash) return fail(event, 'EVENT_HASH_MISMATCH');
    previousHash = event.event_hash;
    expectedSequence += 1;
  }
  const head = store.streamHead(tenantId, streamId);
  if (head) {
    if (events.length === 0 && head.latest_sequence !== 0) {
      const result: StreamVerificationResult = { valid: false, tenantId, streamId, eventsChecked: 0, firstInvalidSequence: null, reason: 'EMPTY_STREAM_WITH_HEAD' };
      if (persist) store.markStreamInvalid(tenantId, streamId, 'Stream head references events that do not exist');
      return result;
    }
    if (head.latest_sequence !== events.length) {
      const result: StreamVerificationResult = { valid: false, tenantId, streamId, eventsChecked: events.length, firstInvalidSequence: null, reason: 'STREAM_HEAD_SEQUENCE_MISMATCH' };
      if (persist) store.markStreamInvalid(tenantId, streamId, 'Stream head sequence does not match persisted event count');
      return result;
    }
    if (head.latest_event_hash !== previousHash) {
      const result: StreamVerificationResult = { valid: false, tenantId, streamId, eventsChecked: events.length, firstInvalidSequence: null, reason: 'STREAM_HEAD_MISMATCH' };
      if (persist) store.markStreamInvalid(tenantId, streamId, 'Stream head hash does not match last persisted event');
      return result;
    }
  }
  return { valid: true, tenantId, streamId, eventsChecked: events.length, firstInvalidSequence: null, reason: null };
}

export interface FullVerificationResult {
  streamsChecked: number;
  eventsChecked: number;
  validStreams: number;
  invalidStreams: number;
  firstFailure: StreamVerificationResult | null;
  durationMs: number;
}

/** Full-ledger verification. A local, unoptimized full scan is acceptable at v0.1 scale (section 33). */
export function verifyAll(store: LedgerStore, options: { tenantId?: string; persist?: boolean } = {}): FullVerificationResult {
  const start = Date.now();
  const streams = store.listAllStreams().filter(stream => options.tenantId === undefined || stream.tenant_id === options.tenantId);
  let eventsChecked = 0;
  let validStreams = 0;
  let invalidStreams = 0;
  let firstFailure: StreamVerificationResult | null = null;
  for (const stream of streams) {
    const result = verifyStream(store, stream.tenant_id, stream.stream_id, options.persist === undefined ? {} : { persist: options.persist });
    eventsChecked += result.eventsChecked;
    if (result.valid) validStreams += 1;
    else {
      invalidStreams += 1;
      firstFailure ??= result;
    }
  }
  return { streamsChecked: streams.length, eventsChecked, validStreams, invalidStreams, firstFailure, durationMs: Date.now() - start };
}
