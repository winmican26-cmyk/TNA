import { DatabaseSync } from 'node:sqlite';
import {
  LedgerError, canonical, computeEventHash, computePayloadHash,
  type LedgerEvent, type LedgerEventInput, type EventHashCore,
} from '../../ledger-schema/src/index.js';

export const GENESIS_HASH = 'GENESIS';

export interface StreamHead {
  tenant_id: string; stream_id: string; latest_sequence: number; latest_event_hash: string;
  updated_at: string; integrity_status: 'VALID' | 'INVALID';
}

interface RawEventRow {
  tenant_id: string; stream_id: string; sequence: number; event_id: string; event_type: string; version: string;
  actor_type: string; actor_id: string; correlation_id: string; causation_id: string | null; parent_event_id: string | null;
  source_component: string; occurred_at: string | null; received_at: string; persisted_at: string;
  authority_context: string | null; spec_context: string | null; execution_context: string | null; artifact_context: string | null;
  classification: string | null; retention: string | null; payload: string | null;
  payload_hash: string; previous_event_hash: string; event_hash: string;
}

function hashCoreOf(row: Pick<RawEventRow,
  'version' | 'tenant_id' | 'stream_id' | 'sequence' | 'event_id' | 'event_type' | 'occurred_at' | 'actor_type' | 'actor_id'
  | 'correlation_id' | 'causation_id' | 'parent_event_id' | 'source_component' | 'authority_context' | 'spec_context'
  | 'execution_context' | 'artifact_context' | 'payload_hash' | 'previous_event_hash'>): EventHashCore {
  return {
    version: row.version, tenant_id: row.tenant_id, stream_id: row.stream_id, sequence: row.sequence,
    event_id: row.event_id, event_type: row.event_type, occurred_at: row.occurred_at,
    actor: { type: row.actor_type as never, id: row.actor_id },
    correlation_id: row.correlation_id, causation_id: row.causation_id, parent_event_id: row.parent_event_id,
    source_component: row.source_component,
    ...(row.authority_context !== null ? { authority_context: JSON.parse(row.authority_context) as unknown } : {}),
    ...(row.spec_context !== null ? { spec_context: JSON.parse(row.spec_context) as unknown } : {}),
    ...(row.execution_context !== null ? { execution_context: JSON.parse(row.execution_context) as unknown } : {}),
    ...(row.artifact_context !== null ? { artifact_context: JSON.parse(row.artifact_context) as unknown } : {}),
    payload_hash: row.payload_hash, previous_event_hash: row.previous_event_hash,
  };
}

function toLedgerEvent(row: RawEventRow): LedgerEvent {
  const event: Record<string, unknown> = {
    version: row.version, event_id: row.event_id, event_type: row.event_type,
    tenant_id: row.tenant_id, stream_id: row.stream_id, actor: { type: row.actor_type, id: row.actor_id },
    correlation_id: row.correlation_id, source_component: row.source_component,
    sequence: row.sequence, received_at: row.received_at, persisted_at: row.persisted_at,
    payload_hash: row.payload_hash, previous_event_hash: row.previous_event_hash, event_hash: row.event_hash,
  };
  if (row.causation_id !== null) event.causation_id = row.causation_id;
  if (row.parent_event_id !== null) event.parent_event_id = row.parent_event_id;
  if (row.occurred_at !== null) event.occurred_at = row.occurred_at;
  if (row.authority_context !== null) event.authority_context = JSON.parse(row.authority_context);
  if (row.spec_context !== null) event.spec_context = JSON.parse(row.spec_context);
  if (row.execution_context !== null) event.execution_context = JSON.parse(row.execution_context);
  if (row.artifact_context !== null) event.artifact_context = JSON.parse(row.artifact_context);
  if (row.classification !== null) event.classification = row.classification;
  if (row.retention !== null) event.retention = JSON.parse(row.retention);
  if (row.payload !== null) event.payload = JSON.parse(row.payload);
  return event as unknown as LedgerEvent;
}

/**
 * Durable, append-only evidence engine. Owns sequencing, hash chaining, and stream-head state.
 * Does not know about writer identity or cross-event invariants — that is ledger-core's job.
 */
export class LedgerStore {
  private readonly db: DatabaseSync;

  public constructor(path: string, private readonly clock: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=8000;
      CREATE TABLE IF NOT EXISTS ledger_streams (
        tenant_id TEXT NOT NULL, stream_id TEXT NOT NULL, latest_sequence INTEGER NOT NULL DEFAULT 0,
        latest_event_hash TEXT NOT NULL DEFAULT '${GENESIS_HASH}', updated_at TEXT NOT NULL,
        integrity_status TEXT NOT NULL DEFAULT 'VALID',
        PRIMARY KEY(tenant_id, stream_id)
      );
      CREATE TABLE IF NOT EXISTS ledger_events (
        tenant_id TEXT NOT NULL, stream_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL,
        event_type TEXT NOT NULL, version TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL, causation_id TEXT, parent_event_id TEXT, source_component TEXT NOT NULL,
        occurred_at TEXT, received_at TEXT NOT NULL, persisted_at TEXT NOT NULL,
        authority_context TEXT, spec_context TEXT, execution_context TEXT, artifact_context TEXT,
        classification TEXT, retention TEXT, payload TEXT,
        payload_hash TEXT NOT NULL, previous_event_hash TEXT NOT NULL, event_hash TEXT NOT NULL,
        PRIMARY KEY (tenant_id, stream_id, sequence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_event_id ON ledger_events(tenant_id, event_id);
      CREATE INDEX IF NOT EXISTS ledger_events_actor ON ledger_events(tenant_id, actor_id);
      CREATE INDEX IF NOT EXISTS ledger_events_correlation ON ledger_events(tenant_id, correlation_id);
      CREATE INDEX IF NOT EXISTS ledger_events_type ON ledger_events(tenant_id, event_type);
      CREATE INDEX IF NOT EXISTS ledger_events_received ON ledger_events(tenant_id, received_at);
      CREATE TABLE IF NOT EXISTS ledger_integrity_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, stream_id TEXT, status TEXT NOT NULL,
        detail TEXT NOT NULL, checked_at TEXT NOT NULL
      );
    `);
    this.verifyStreamHeadsOnStartup();
  }

  /** Cheap startup check (section 34): recompute each stream's head hash. Full-body scans are verifyStream/verifyAll. */
  private verifyStreamHeadsOnStartup(): void {
    const streams = this.db.prepare('SELECT tenant_id, stream_id, latest_sequence, latest_event_hash FROM ledger_streams')
      .all() as { tenant_id: string; stream_id: string; latest_sequence: number; latest_event_hash: string }[];
    for (const stream of streams) {
      if (stream.latest_sequence === 0) continue;
      const row = this.db.prepare('SELECT * FROM ledger_events WHERE tenant_id = ? AND stream_id = ? AND sequence = ?')
        .get(stream.tenant_id, stream.stream_id, stream.latest_sequence) as unknown as RawEventRow | undefined;
      const recomputed = row ? computeEventHash(hashCoreOf(row)) : null;
      if (!row || recomputed !== stream.latest_event_hash) {
        this.markStreamInvalid(stream.tenant_id, stream.stream_id, 'Startup verification: stream head does not match last persisted event');
      }
    }
  }

  /** Persistently marks a stream INVALID (fail-closed): further appends are blocked until an administrative process repairs it. */
  public markStreamInvalid(tenantId: string, streamId: string, detail: string): void {
    this.db.prepare("UPDATE ledger_streams SET integrity_status = 'INVALID' WHERE tenant_id = ? AND stream_id = ?").run(tenantId, streamId);
    this.db.prepare('INSERT INTO ledger_integrity_checks(tenant_id, stream_id, status, detail, checked_at) VALUES (?,?,?,?,?)')
      .run(tenantId, streamId, 'INVALID', detail, new Date(this.clock()).toISOString());
  }

  public streamHead(tenantId: string, streamId: string): StreamHead | null {
    const row = this.db.prepare('SELECT * FROM ledger_streams WHERE tenant_id = ? AND stream_id = ?').get(tenantId, streamId) as unknown as StreamHead | undefined;
    return row ?? null;
  }

  public getByEventId(tenantId: string, eventId: string): LedgerEvent | null {
    const row = this.db.prepare('SELECT * FROM ledger_events WHERE tenant_id = ? AND event_id = ?').get(tenantId, eventId) as unknown as RawEventRow | undefined;
    return row ? toLedgerEvent(row) : null;
  }

  public getBySequence(tenantId: string, streamId: string, sequence: number): LedgerEvent | null {
    const row = this.db.prepare('SELECT * FROM ledger_events WHERE tenant_id = ? AND stream_id = ? AND sequence = ?').get(tenantId, streamId, sequence) as unknown as RawEventRow | undefined;
    return row ? toLedgerEvent(row) : null;
  }

  public listStream(tenantId: string, streamId: string): LedgerEvent[] {
    return (this.db.prepare('SELECT * FROM ledger_events WHERE tenant_id = ? AND stream_id = ? ORDER BY sequence').all(tenantId, streamId) as unknown as RawEventRow[]).map(toLedgerEvent);
  }

  public listAllStreams(): StreamHead[] {
    return this.db.prepare('SELECT * FROM ledger_streams').all() as unknown as StreamHead[];
  }

  public integrityChecks(tenantId: string): { status: string; detail: string; checked_at: string; stream_id: string | null }[] {
    return this.db.prepare('SELECT status, detail, checked_at, stream_id FROM ledger_integrity_checks WHERE tenant_id = ? ORDER BY id DESC')
      .all(tenantId) as { status: string; detail: string; checked_at: string; stream_id: string | null }[];
  }

  /** Parameterized filter query used by ledger-query. Every clause binds a value — never string concatenation. */
  public query(tenantId: string, filters: {
    actorId?: string; correlationId?: string; eventType?: string; streamId?: string;
    fromTime?: string; toTime?: string;
  }, limit: number, offset = 0): LedgerEvent[] {
    const clauses = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (filters.actorId !== undefined) { clauses.push('actor_id = ?'); params.push(filters.actorId); }
    if (filters.correlationId !== undefined) { clauses.push('correlation_id = ?'); params.push(filters.correlationId); }
    if (filters.eventType !== undefined) { clauses.push('event_type = ?'); params.push(filters.eventType); }
    if (filters.streamId !== undefined) { clauses.push('stream_id = ?'); params.push(filters.streamId); }
    if (filters.fromTime !== undefined) { clauses.push('received_at >= ?'); params.push(filters.fromTime); }
    if (filters.toTime !== undefined) { clauses.push('received_at <= ?'); params.push(filters.toTime); }
    const sql = `SELECT * FROM ledger_events WHERE ${clauses.join(' AND ')} ORDER BY received_at, stream_id, sequence, event_id LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return (this.db.prepare(sql).all(...(params as never[])) as unknown as RawEventRow[]).map(toLedgerEvent);
  }

  /** Finds matches for a context field value within a tenant, for invariant checks and reference-style queries. Full-scan; local-scale only (no context-field index in v0.1). */
  public findByContextField(tenantId: string, contextColumn: 'authority_context' | 'spec_context' | 'execution_context', field: string, value: string, eventTypes?: string[]): LedgerEvent[] {
    const sql = eventTypes && eventTypes.length > 0
      ? `SELECT * FROM ledger_events WHERE tenant_id = ? AND event_type IN (${eventTypes.map(() => '?').join(',')}) AND ${contextColumn} IS NOT NULL ORDER BY received_at`
      : `SELECT * FROM ledger_events WHERE tenant_id = ? AND ${contextColumn} IS NOT NULL ORDER BY received_at`;
    const rows = (eventTypes && eventTypes.length > 0
      ? this.db.prepare(sql).all(tenantId, ...eventTypes)
      : this.db.prepare(sql).all(tenantId)) as unknown as RawEventRow[];
    return rows.filter(row => {
      const context = JSON.parse(row[contextColumn] as string) as Record<string, unknown>;
      return context[field] === value;
    }).map(toLedgerEvent);
  }

  /**
   * Transactionally appends one event to a stream: validates the head, assigns the next sequence,
   * binds the previous hash, computes the event hash, inserts the row, and updates the stream head.
   * Any failure rolls the whole operation back — no partial append (section 29).
   *
   * Idempotency (section 31 / 7): the same event_id with identical canonical content is a no-op that
   * returns the existing row; the same event_id with different content is EVENT_CONFLICT.
   */
  public append(input: LedgerEventInput): LedgerEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM ledger_events WHERE tenant_id = ? AND event_id = ?').get(input.tenant_id, input.event_id) as unknown as RawEventRow | undefined;
      if (existing) {
        const existingEvent = toLedgerEvent(existing);
        if (!sameCanonicalContent(existingEvent, input)) {
          throw new LedgerError('EVENT_CONFLICT', `event_id ${input.event_id} already exists with different content`);
        }
        this.db.exec('COMMIT');
        return existingEvent;
      }

      const head = this.db.prepare('SELECT * FROM ledger_streams WHERE tenant_id = ? AND stream_id = ?').get(input.tenant_id, input.stream_id) as unknown as StreamHead | undefined;
      if (head && head.integrity_status === 'INVALID') {
        throw new LedgerError('INTEGRITY_FAILURE', `Stream ${input.stream_id} has failed integrity verification; writes are blocked (fail-closed)`);
      }
      const previousSequence = head?.latest_sequence ?? 0;
      const previousHash = head?.latest_event_hash ?? GENESIS_HASH;
      const sequence = previousSequence + 1;

      const now = new Date(this.clock()).toISOString();
      const payloadHash = computePayloadHash(input.payload);
      const eventHash = computeEventHash({
        version: input.version, tenant_id: input.tenant_id, stream_id: input.stream_id, sequence,
        event_id: input.event_id, event_type: input.event_type, occurred_at: input.occurred_at ?? null,
        actor: input.actor, correlation_id: input.correlation_id,
        causation_id: input.causation_id ?? null, parent_event_id: input.parent_event_id ?? null,
        source_component: input.source_component,
        ...(input.authority_context !== undefined ? { authority_context: input.authority_context } : {}),
        ...(input.spec_context !== undefined ? { spec_context: input.spec_context } : {}),
        ...(input.execution_context !== undefined ? { execution_context: input.execution_context } : {}),
        ...(input.artifact_context !== undefined ? { artifact_context: input.artifact_context } : {}),
        payload_hash: payloadHash, previous_event_hash: previousHash,
      });

      this.db.prepare(`INSERT INTO ledger_events (
        tenant_id, stream_id, sequence, event_id, event_type, version, actor_type, actor_id, correlation_id,
        causation_id, parent_event_id, source_component, occurred_at, received_at, persisted_at,
        authority_context, spec_context, execution_context, artifact_context, classification, retention, payload,
        payload_hash, previous_event_hash, event_hash
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.tenant_id, input.stream_id, sequence, input.event_id, input.event_type, input.version,
        input.actor.type, input.actor.id, input.correlation_id, input.causation_id ?? null, input.parent_event_id ?? null,
        input.source_component, input.occurred_at ?? null, now, now,
        input.authority_context !== undefined ? JSON.stringify(input.authority_context) : null,
        input.spec_context !== undefined ? JSON.stringify(input.spec_context) : null,
        input.execution_context !== undefined ? JSON.stringify(input.execution_context) : null,
        input.artifact_context !== undefined ? JSON.stringify(input.artifact_context) : null,
        input.classification ?? null,
        input.retention !== undefined ? JSON.stringify(input.retention) : null,
        input.payload !== undefined ? JSON.stringify(input.payload) : null,
        payloadHash, previousHash, eventHash,
      );

      this.db.prepare(`INSERT INTO ledger_streams(tenant_id, stream_id, latest_sequence, latest_event_hash, updated_at, integrity_status)
        VALUES (?,?,?,?,?,'VALID')
        ON CONFLICT(tenant_id, stream_id) DO UPDATE SET latest_sequence = excluded.latest_sequence, latest_event_hash = excluded.latest_event_hash, updated_at = excluded.updated_at`)
        .run(input.tenant_id, input.stream_id, sequence, eventHash, now);

      this.db.exec('COMMIT');
      return { ...input, sequence, received_at: now, persisted_at: now, payload_hash: payloadHash, previous_event_hash: previousHash, event_hash: eventHash };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing was open */ }
      throw error;
    }
  }

  public close(): void { this.db.close(); }
}

const STORE_ASSIGNED_FIELDS = ['sequence', 'received_at', 'persisted_at', 'payload_hash', 'previous_event_hash', 'event_hash'];
function sameCanonicalContent(existing: LedgerEvent, input: LedgerEventInput): boolean {
  const strip = (event: Record<string, unknown>): Record<string, unknown> => {
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(event)) if (!STORE_ASSIGNED_FIELDS.includes(key)) rest[key] = event[key];
    return rest;
  };
  return canonical(strip(existing as unknown as Record<string, unknown>)) === canonical(strip(input as unknown as Record<string, unknown>));
}
