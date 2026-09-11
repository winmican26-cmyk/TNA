import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  PlatformError, assertCanSubmit, canonical, computeInputHash, hash, isAllowedTransition,
  newCorrelationId, newPlatformActionId, validatePlatformActionRequestInput,
  type Page, type PlatformActionIdentity, type PlatformActionRequestInput, type PlatformActionState,
} from '../../platform-schema/src/index.js';
import { newOutboxRecord, outboxLedgerEventId, OutboxDispatcher, type OutboxPort, type OutboxRecord } from '../../platform-outbox/src/index.js';
import type { LedgerEventInput, LedgerEventType } from '../../ledger-schema/src/index.js';
import type { PlatformPrincipal } from '../../platform-schema/src/index.js';
import { BrokerError, type ExecutionBroker } from '../../execution-broker/src/index.js';
import type { Principal as GateAgentPrincipal } from '../../agent-identity/src/index.js';
import type { SentinelPrincipal, SentinelSession, SentinelSessionInput, SentinelObservation, SentinelDecision } from '../../sentinel-runtime/src/index.js';
import type { Operation as SentinelOperation, SentinelObservationInput } from '../../sentinel-schema/src/index.js';

/** Minimal stable copy of a Gate decision.  The platform owns this persisted
 * binding; it never accepts it from an action request. */
export interface GateDecisionEvidence {
  readonly decision_id: string;
  readonly decision: 'ALLOW' | 'BLOCK' | 'HOLD';
  readonly reason: string;
  readonly policy_hash: string | null;
  readonly policy_version: string | null;
  readonly approval_reference: string | null;
  readonly decided_at: string;
}

export interface ExecutionEvidence { readonly execution_id: string; readonly result_hash: string }
export interface VerificationEvidence { readonly vad_atom_id: string; readonly vad_final_state: string }

export interface PlatformAction extends PlatformActionIdentity {
  readonly tenant_id: string;
  readonly request: PlatformActionRequestInput;
  readonly state: PlatformActionState;
  readonly state_version: number;
  readonly updated_at: string;
  readonly gate_decision: GateDecisionEvidence | null;
  readonly capability_id: string | null;
  readonly sentinel_session_id: string | null;
  readonly execution_id: string | null;
  readonly result_hash: string | null;
  readonly vad_atom_id: string | null;
  readonly vad_final_state: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
}
export interface PlatformRun {
  readonly execution_id: string; readonly tenant_id: string; readonly platform_action_id: string;
  readonly status: 'CLAIMED' | 'FINISHED' | 'INDETERMINATE'; readonly claimed_at: string; readonly finished_at: string | null;
}
interface ActionRow {
  tenant_id: string; platform_action_id: string; request_id: string; request_json: string; canonical_request: string;
  correlation_id: string; created_at: string; created_by: string; input_hash: string; state: PlatformActionState;
  state_version: number; updated_at: string; gate_decision_json: string | null;
  capability_id: string | null; sentinel_session_id: string | null; execution_id: string | null; result_hash: string | null;
  vad_atom_id: string | null; vad_final_state: string | null; error_code: string | null; error_message: string | null;
  last_outbox_id: string | null;
}
interface RunRow { execution_id: string; tenant_id: string; platform_action_id: string; status: PlatformRun['status']; claimed_at: string; finished_at: string | null }
interface OutboxRow {
  outbox_id: string; tenant_id: string; platform_action_id: string; event_type: string; payload_json: string;
  created_at: string; attempt_count: number; next_attempt_at: string; status: OutboxRecord['status'];
  ledger_event_id: string | null; last_error: string | null;
  claim_owner: string | null; claim_token: string | null; claim_expires_at: string | null;
}
const rowToAction = (row: ActionRow): PlatformAction => ({
  tenant_id: row.tenant_id, platform_action_id: row.platform_action_id, correlation_id: row.correlation_id,
  created_at: row.created_at, created_by: row.created_by, input_hash: row.input_hash,
  request: JSON.parse(row.request_json) as PlatformActionRequestInput, state: row.state, state_version: row.state_version,
  updated_at: row.updated_at, gate_decision: row.gate_decision_json ? JSON.parse(row.gate_decision_json) as GateDecisionEvidence : null,
  capability_id: row.capability_id, sentinel_session_id: row.sentinel_session_id, execution_id: row.execution_id,
  result_hash: row.result_hash, vad_atom_id: row.vad_atom_id, vad_final_state: row.vad_final_state,
  error_code: row.error_code, error_message: row.error_message,
});
const rowToRun = (row: RunRow): PlatformRun => ({ ...row });
const rowToOutbox = (row: OutboxRow): OutboxRecord => ({
  outbox_id: row.outbox_id, tenant_id: row.tenant_id, platform_action_id: row.platform_action_id, event_type: row.event_type,
  payload: JSON.parse(row.payload_json) as Record<string, unknown>, created_at: row.created_at, attempt_count: row.attempt_count,
  next_attempt_at: row.next_attempt_at, status: row.status, ledger_event_id: row.ledger_event_id, last_error: row.last_error,
  claim_owner: row.claim_owner, claim_token: row.claim_token, claim_expires_at: row.claim_expires_at,
});

/** Durable platform control-plane store. All writes use SQLite IMMEDIATE transactions; a state transition
 * and its evidence obligation are one local transaction, never a best-effort second write. */
export class PlatformStore implements OutboxPort {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  public constructor(path: string, options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now; this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=8000;
      CREATE TABLE IF NOT EXISTS platform_actions (
        tenant_id TEXT NOT NULL, platform_action_id TEXT NOT NULL, request_id TEXT NOT NULL, request_json TEXT NOT NULL, canonical_request TEXT NOT NULL,
        correlation_id TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, input_hash TEXT NOT NULL,
        state TEXT NOT NULL, state_version INTEGER NOT NULL, updated_at TEXT NOT NULL, gate_decision_json TEXT,
        capability_id TEXT, sentinel_session_id TEXT, execution_id TEXT, result_hash TEXT,
        vad_atom_id TEXT, vad_final_state TEXT, error_code TEXT, error_message TEXT, last_outbox_id TEXT,
        PRIMARY KEY(tenant_id, platform_action_id), UNIQUE(tenant_id, request_id));
      CREATE INDEX IF NOT EXISTS platform_actions_list ON platform_actions(tenant_id, created_at, platform_action_id);
      CREATE TABLE IF NOT EXISTS platform_runs (execution_id TEXT NOT NULL, tenant_id TEXT NOT NULL, platform_action_id TEXT NOT NULL, status TEXT NOT NULL, claimed_at TEXT NOT NULL, finished_at TEXT, PRIMARY KEY(tenant_id, execution_id), UNIQUE(tenant_id, platform_action_id));
      CREATE TABLE IF NOT EXISTS platform_outbox (
        outbox_id TEXT NOT NULL, tenant_id TEXT NOT NULL, platform_action_id TEXT NOT NULL, event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL, attempt_count INTEGER NOT NULL, next_attempt_at TEXT NOT NULL,
        status TEXT NOT NULL, ledger_event_id TEXT NOT NULL, last_error TEXT,
        claim_owner TEXT, claim_token TEXT, claim_expires_at TEXT,
        PRIMARY KEY(tenant_id, outbox_id));
      CREATE INDEX IF NOT EXISTS platform_outbox_pending ON platform_outbox(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS platform_outbox_lease ON platform_outbox(status, claim_expires_at);`);
    // CREATE TABLE IF NOT EXISTS does not add columns to a pre-existing store file — each column added
    // after the table's first shipped version gets its own defensive ALTER TABLE, same discipline the
    // Auditor v0.1 trust-closure pass established (auditor-engine's setManifest migration).
    for (const column of ['gate_decision_json', 'capability_id', 'sentinel_session_id', 'execution_id', 'result_hash', 'vad_atom_id', 'vad_final_state', 'error_code', 'error_message', 'last_outbox_id']) {
      try { this.db.exec(`ALTER TABLE platform_actions ADD COLUMN ${column} TEXT`); } catch { /* existing store already has the column */ }
    }
    for (const column of ['claim_owner', 'claim_token', 'claim_expires_at']) {
      try { this.db.exec(`ALTER TABLE platform_outbox ADD COLUMN ${column} TEXT`); } catch { /* existing store already has the column */ }
    }
    this.recoverInterruptedWork();
  }
  public close(): void { this.db.close(); }
  private now(): string { return new Date(this.clock()).toISOString(); }
  private tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* transaction was never opened or already rolled back */ } throw error; } }
  public createOrReturn(raw: unknown, createdBy: string): PlatformAction {
    const request = validatePlatformActionRequestInput(raw); const requestCanonical = canonical(request); const now = this.now();
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM platform_actions WHERE tenant_id=? AND request_id=?').get(request.tenant_id, request.request_id) as ActionRow | undefined;
      if (existing) { if (existing.canonical_request !== requestCanonical) throw new PlatformError('CONFLICT', `request_id ${request.request_id} already exists with different canonical request`); return rowToAction(existing); }
      const identity = { platform_action_id: newPlatformActionId(), correlation_id: newCorrelationId(), created_at: now, created_by: createdBy, input_hash: computeInputHash(request) };
      this.db.prepare('INSERT INTO platform_actions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        request.tenant_id, identity.platform_action_id, request.request_id, JSON.stringify(request), requestCanonical,
        identity.correlation_id, now, createdBy, identity.input_hash, 'RECEIVED', 0, now, null,
        null, null, null, null, null, null, null, null, null,
      );
      this.enqueue(request.tenant_id, identity.platform_action_id, 'PLATFORM_ACTION_RECEIVED', { platform_action_id: identity.platform_action_id, correlation_id: identity.correlation_id, request_id: request.request_id, state: 'RECEIVED' }, now);
      return {
        tenant_id: request.tenant_id, request, state: 'RECEIVED', state_version: 0, updated_at: now, gate_decision: null,
        capability_id: null, sentinel_session_id: null, execution_id: null, result_hash: null,
        vad_atom_id: null, vad_final_state: null, error_code: null, error_message: null, ...identity,
      };
    });
  }
  public get(tenantId: string, actionId: string): PlatformAction { const row = this.db.prepare('SELECT * FROM platform_actions WHERE tenant_id=? AND platform_action_id=?').get(tenantId, actionId) as ActionRow | undefined; if (!row) throw new PlatformError('NOT_FOUND', `No platform action ${actionId}`); return rowToAction(row); }
  public list(tenantId: string, options: { limit?: number; cursor?: string } = {}): Page<PlatformAction> { const limit = Math.min(Math.max(options.limit ?? 50, 1), 200); const offset = options.cursor ? Number(Buffer.from(options.cursor, 'base64url').toString('utf8')) : 0; if (!Number.isInteger(offset) || offset < 0) throw new PlatformError('INVALID_INPUT', 'Invalid action cursor'); const rows = this.db.prepare('SELECT * FROM platform_actions WHERE tenant_id=? ORDER BY created_at, platform_action_id LIMIT ? OFFSET ?').all(tenantId, limit + 1, offset) as unknown as ActionRow[]; const hasMore = rows.length > limit; return { items: rows.slice(0, limit).map(rowToAction), ...(hasMore ? { nextCursor: Buffer.from(String(offset + limit)).toString('base64url') } : {}) }; }
  public transition(tenantId: string, actionId: string, expectedVersion: number, target: PlatformActionState, eventType = 'PLATFORM_ACTION_STATE_CHANGED', emit = true): PlatformAction {
    return this.tx(() => { const current = this.get(tenantId, actionId); if (current.state_version !== expectedVersion) throw new PlatformError('CONFLICT', 'Platform action state version changed'); if (!isAllowedTransition(current.state, target)) throw new PlatformError('INVALID_TRANSITION', `${current.state} -> ${target} is not allowed`); const now = this.now(); const changed = this.db.prepare('UPDATE platform_actions SET state=?, state_version=state_version+1, updated_at=? WHERE tenant_id=? AND platform_action_id=? AND state_version=?').run(target, now, tenantId, actionId, expectedVersion); if (changed.changes !== 1) throw new PlatformError('CONFLICT', 'Platform action state version changed'); if (emit) this.enqueue(tenantId, actionId, eventType, { platform_action_id: actionId, correlation_id: current.correlation_id, from_state: current.state, to_state: target, state_version: expectedVersion + 1 }, now); return this.get(tenantId, actionId); });
  }
  /** AUTHORIZED -> CAPABILITY_ISSUED. No independent Ledger record — the causally relevant fact (which
   * capability backed this action's execution) is carried in the PLATFORM_EXECUTION_STARTED payload
   * `claimExecution` emits next, per section 32's "use only if it adds value" instruction. */
  public recordCapability(tenantId: string, actionId: string, expectedVersion: number, capabilityId: string): PlatformAction {
    return this.tx(() => {
      const current = this.get(tenantId, actionId);
      if (current.state !== 'AUTHORIZED' || current.state_version !== expectedVersion) throw new PlatformError('CONFLICT', 'Action is not awaiting capability issuance');
      const now = this.now();
      const changed = this.db.prepare("UPDATE platform_actions SET state='CAPABILITY_ISSUED', state_version=state_version+1, updated_at=?, capability_id=? WHERE tenant_id=? AND platform_action_id=? AND state='AUTHORIZED' AND state_version=?").run(now, capabilityId, tenantId, actionId, expectedVersion);
      if (changed.changes !== 1) throw new PlatformError('CONFLICT', 'Platform action state version changed');
      return this.get(tenantId, actionId);
    });
  }
  /** CAPABILITY_ISSUED -> MONITORING. Same no-independent-event rationale as `recordCapability`. */
  public recordSentinelSession(tenantId: string, actionId: string, expectedVersion: number, sentinelSessionId: string): PlatformAction {
    return this.tx(() => {
      const current = this.get(tenantId, actionId);
      if (current.state !== 'CAPABILITY_ISSUED' || current.state_version !== expectedVersion) throw new PlatformError('CONFLICT', 'Action is not awaiting a Sentinel session');
      const now = this.now();
      const changed = this.db.prepare("UPDATE platform_actions SET state='MONITORING', state_version=state_version+1, updated_at=?, sentinel_session_id=? WHERE tenant_id=? AND platform_action_id=? AND state='CAPABILITY_ISSUED' AND state_version=?").run(now, sentinelSessionId, tenantId, actionId, expectedVersion);
      if (changed.changes !== 1) throw new PlatformError('CONFLICT', 'Platform action state version changed');
      return this.get(tenantId, actionId);
    });
  }
  /** Records the connector's real execution outcome and moves the action to its next state in one
   * transaction — `VERIFYING` when verification is required, `COMPLETED` otherwise (TNA-47: external
   * success and assurance success are different facts, so an execution result is recorded even when
   * the action is not yet fully COMPLETED). */
  public recordExecutionResult(tenantId: string, actionId: string, expectedVersion: number, evidence: ExecutionEvidence, target: 'VERIFYING' | 'COMPLETED', eventType: string): PlatformAction {
    return this.tx(() => {
      const current = this.get(tenantId, actionId);
      if (current.state !== 'EXECUTING' || current.state_version !== expectedVersion) throw new PlatformError('CONFLICT', 'Action is not executing');
      if (!isAllowedTransition('EXECUTING', target)) throw new PlatformError('INVALID_TRANSITION', `EXECUTING -> ${target} is not allowed`);
      const now = this.now();
      const changed = this.db.prepare('UPDATE platform_actions SET state=?, state_version=state_version+1, updated_at=?, execution_id=?, result_hash=? WHERE tenant_id=? AND platform_action_id=? AND state=? AND state_version=?').run(target, now, evidence.execution_id, evidence.result_hash, tenantId, actionId, 'EXECUTING', expectedVersion);
      if (changed.changes !== 1) throw new PlatformError('CONFLICT', 'Platform action state version changed');
      this.enqueue(tenantId, actionId, eventType, { platform_action_id: actionId, correlation_id: current.correlation_id, from_state: 'EXECUTING', to_state: target, state_version: expectedVersion + 1, execution: evidence }, now);
      return this.get(tenantId, actionId);
    });
  }
  /** Records the VAD verdict alongside the VERIFYING -> COMPLETED|FAILED transition. */
  public recordVerificationResult(tenantId: string, actionId: string, expectedVersion: number, evidence: VerificationEvidence, target: 'COMPLETED' | 'FAILED' | 'INDETERMINATE', errorCode: string | null): PlatformAction {
    return this.tx(() => {
      const current = this.get(tenantId, actionId);
      if (current.state !== 'VERIFYING' || current.state_version !== expectedVersion) throw new PlatformError('CONFLICT', 'Action is not awaiting verification');
      const now = this.now();
      const changed = this.db.prepare('UPDATE platform_actions SET state=?, state_version=state_version+1, updated_at=?, vad_atom_id=?, vad_final_state=?, error_code=? WHERE tenant_id=? AND platform_action_id=? AND state=? AND state_version=?').run(target, now, evidence.vad_atom_id, evidence.vad_final_state, errorCode, tenantId, actionId, 'VERIFYING', expectedVersion);
      if (changed.changes !== 1) throw new PlatformError('CONFLICT', 'Platform action state version changed');
      this.enqueue(tenantId, actionId, 'PLATFORM_VERIFICATION_COMPLETED', { platform_action_id: actionId, correlation_id: current.correlation_id, from_state: 'VERIFYING', to_state: target, state_version: expectedVersion + 1, verification: evidence }, now);
      return this.get(tenantId, actionId);
    });
  }
  /** Terminal transition (FAILED/TERMINATED/INDETERMINATE) from any non-terminal state, recording why. */
  public recordFailure(tenantId: string, actionId: string, expectedVersion: number, from: PlatformActionState, target: 'FAILED' | 'TERMINATED' | 'INDETERMINATE', errorCode: string, errorMessage: string): PlatformAction {
    return this.tx(() => {
      const current = this.get(tenantId, actionId);
      if (current.state !== from || current.state_version !== expectedVersion) throw new PlatformError('CONFLICT', 'Platform action state version changed');
      if (!isAllowedTransition(from, target)) throw new PlatformError('INVALID_TRANSITION', `${from} -> ${target} is not allowed`);
      const now = this.now();
      const changed = this.db.prepare('UPDATE platform_actions SET state=?, state_version=state_version+1, updated_at=?, error_code=?, error_message=? WHERE tenant_id=? AND platform_action_id=? AND state=? AND state_version=?').run(target, now, errorCode, errorMessage, tenantId, actionId, from, expectedVersion);
      if (changed.changes !== 1) throw new PlatformError('CONFLICT', 'Platform action state version changed');
      const eventType = target === 'FAILED' ? 'PLATFORM_ACTION_FAILED' : target === 'TERMINATED' ? 'PLATFORM_ACTION_TERMINATED' : 'PLATFORM_ACTION_INDETERMINATE';
      this.enqueue(tenantId, actionId, eventType, { platform_action_id: actionId, correlation_id: current.correlation_id, from_state: from, to_state: target, state_version: expectedVersion + 1, error_code: errorCode, error_message: errorMessage }, now);
      return this.get(tenantId, actionId);
    });
  }
  /** Auditor discoverability (section 42, 79): every Ledger event for this action's evidence stream
   * currently DEAD_LETTER means genuine execution/verification facts exist that Ledger never durably
   * received — the action's real outcome is preserved, but its assurance is degraded (section 41). */
  public evidenceStatus(tenantId: string, actionId: string): 'OK' | 'DEGRADED' {
    const row = this.db.prepare("SELECT 1 FROM platform_outbox WHERE tenant_id=? AND platform_action_id=? AND status='DEAD_LETTER' LIMIT 1").get(tenantId, actionId);
    return row ? 'DEGRADED' : 'OK';
  }
  /** Atomically binds the exact Gate result to the action, state transition, and Ledger obligation. */
  public recordGateDecision(tenantId: string, actionId: string, expectedVersion: number, decision: GateDecisionEvidence): PlatformAction {
    return this.tx(() => {
      const current = this.get(tenantId, actionId);
      if (current.state !== 'AUTHORIZING' || current.state_version !== expectedVersion) throw new PlatformError('CONFLICT', 'Action is not awaiting Gate authorization');
      const target: PlatformActionState = decision.decision === 'ALLOW' ? 'AUTHORIZED' : decision.decision === 'BLOCK' ? 'BLOCKED' : 'HELD';
      const now = this.now();
      const changed = this.db.prepare('UPDATE platform_actions SET state=?, state_version=state_version+1, updated_at=?, gate_decision_json=? WHERE tenant_id=? AND platform_action_id=? AND state=? AND state_version=?').run(target, now, JSON.stringify(decision), tenantId, actionId, 'AUTHORIZING', expectedVersion);
      if (changed.changes !== 1) throw new PlatformError('CONFLICT', 'Platform action state version changed');
      const eventType = target === 'AUTHORIZED' ? 'PLATFORM_ACTION_AUTHORIZED' : target === 'BLOCKED' ? 'PLATFORM_ACTION_BLOCKED' : 'PLATFORM_ACTION_HELD';
      this.enqueue(tenantId, actionId, eventType, { platform_action_id: actionId, correlation_id: current.correlation_id, from_state: current.state, to_state: target, state_version: expectedVersion + 1, gate_decision: decision }, now);
      return this.get(tenantId, actionId);
    });
  }
  /** One durable action-level execution claim. A second worker gets CONFLICT before any connector call.
   * Runs are internal claim bookkeeping, not an independently auditable lifecycle: the associated
   * action transition to EXECUTING and its PLATFORM_EXECUTION_CLAIMED outbox record are committed
   * in this same transaction and remain the durable evidence boundary. */
  public claimExecution(tenantId: string, actionId: string, expectedVersion: number, executionId = `exec_${randomUUID()}`): PlatformRun {
    return this.tx(() => { const action = this.get(tenantId, actionId); if (action.state !== 'MONITORING' || action.state_version !== expectedVersion) throw new PlatformError('CONFLICT', 'Action is not claimable for execution'); const now = this.now(); const state = this.db.prepare("UPDATE platform_actions SET state='EXECUTING', state_version=state_version+1, updated_at=? WHERE tenant_id=? AND platform_action_id=? AND state='MONITORING' AND state_version=?").run(now, tenantId, actionId, expectedVersion); if (state.changes !== 1) throw new PlatformError('CONFLICT', 'Action execution claim lost'); try { this.db.prepare("INSERT INTO platform_runs VALUES (?,?,?,?,?,NULL)").run(executionId, tenantId, actionId, 'CLAIMED', now); } catch { throw new PlatformError('CONFLICT', 'Action already has an execution claim'); } this.enqueue(tenantId, actionId, 'PLATFORM_EXECUTION_CLAIMED', { platform_action_id: actionId, correlation_id: action.correlation_id, execution_id: executionId, state: 'EXECUTING', decision_id: action.gate_decision?.decision_id ?? null, capability_id: action.capability_id, sentinel_session_id: action.sentinel_session_id }, now); return { execution_id: executionId, tenant_id: tenantId, platform_action_id: actionId, status: 'CLAIMED', claimed_at: now, finished_at: null }; });
  }
  public finishRun(tenantId: string, executionId: string, status: 'FINISHED' | 'INDETERMINATE' = 'FINISHED'): PlatformRun { return this.tx(() => { const now = this.now(); const changed = this.db.prepare("UPDATE platform_runs SET status=?, finished_at=? WHERE tenant_id=? AND execution_id=? AND status='CLAIMED'").run(status, now, tenantId, executionId); if (changed.changes !== 1) throw new PlatformError('CONFLICT', 'Execution run is not claimable for completion'); const row = this.db.prepare('SELECT * FROM platform_runs WHERE tenant_id=? AND execution_id=?').get(tenantId, executionId) as unknown as RunRow; return rowToRun(row); }); }
  /**
   * Distributed-evidence closure, Finding 2: causation is captured **here**, once, at the instant the
   * evidence obligation is created — never reconstructed later from whatever the action currently
   * contains. `causation_event_id` chains this record to the immediately-preceding record this same
   * action enqueued (via `platform_actions.last_outbox_id`, read and advanced inside this same
   * transaction), which is itself an immutable, deterministic Ledger event id
   * (`outboxLedgerEventId`) regardless of whether that prior record has been *delivered* yet. Once
   * written, a record's `payload` (including this field) is never updated by any other method in this
   * class — later lifecycle progress creates *new* outbox records, it never rewrites an old one.
   */
  private enqueue(tenantId: string, actionId: string, eventType: string, payload: Record<string, unknown>, now: string): void {
    const outboxId = `ob_${randomUUID()}`;
    const priorRow = this.db.prepare('SELECT last_outbox_id FROM platform_actions WHERE tenant_id=? AND platform_action_id=?').get(tenantId, actionId) as { last_outbox_id: string | null } | undefined;
    const causationEventId = priorRow?.last_outbox_id ? outboxLedgerEventId(priorRow.last_outbox_id) : null;
    const fullPayload: Record<string, unknown> = causationEventId ? { ...payload, causation_event_id: causationEventId } : payload;
    const record = newOutboxRecord({ outboxId, tenantId, platformActionId: actionId, eventType, payload: fullPayload, now });
    this.db.prepare('INSERT INTO platform_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      record.outbox_id, record.tenant_id, record.platform_action_id, record.event_type, JSON.stringify(record.payload),
      record.created_at, record.attempt_count, record.next_attempt_at, record.status, record.ledger_event_id, record.last_error,
      record.claim_owner, record.claim_token, record.claim_expires_at,
    );
    this.db.prepare('UPDATE platform_actions SET last_outbox_id=? WHERE tenant_id=? AND platform_action_id=?').run(outboxId, tenantId, actionId);
  }
  /** Recovers two crash windows without pretending a distributed transaction exists. EXECUTING is
   * uncertain external work, thus INDETERMINATE. DELIVERING whose lease has genuinely expired is
   * safely requeued because its event_id is deterministic and Ledger append is idempotent — but a
   * DELIVERING record whose lease is still live is left strictly alone: it may be owned by a
   * different, still-running process sharing this same database file (distributed-evidence closure,
   * section 1), and this store must never assume its own restart means it is the only writer. */
  private recoverInterruptedWork(): void { this.tx(() => { const now = this.now(); const actions = this.db.prepare("SELECT * FROM platform_actions WHERE state='EXECUTING'").all() as unknown as ActionRow[]; for (const row of actions) { this.db.prepare("UPDATE platform_actions SET state='INDETERMINATE', state_version=state_version+1, updated_at=? WHERE tenant_id=? AND platform_action_id=? AND state='EXECUTING'").run(now, row.tenant_id, row.platform_action_id); this.db.prepare("UPDATE platform_runs SET status='INDETERMINATE', finished_at=? WHERE tenant_id=? AND platform_action_id=? AND status='CLAIMED'").run(now, row.tenant_id, row.platform_action_id); this.enqueue(row.tenant_id, row.platform_action_id, 'PLATFORM_EXECUTION_INDETERMINATE_RECOVERY', { platform_action_id: row.platform_action_id, correlation_id: row.correlation_id, prior_state: 'EXECUTING', state: 'INDETERMINATE' }, now); }
    this.db.prepare("UPDATE platform_outbox SET status='FAILED', next_attempt_at=?, last_error='Recovered after interrupted or expired delivery claim' WHERE status='DELIVERING' AND (claim_expires_at IS NULL OR claim_expires_at<=?)").run(now, now); }); }
  /** Distributed-evidence closure, Finding 1. Atomically claims one eligible record — `PENDING`;
   * `FAILED` past its backoff; or `DELIVERING` whose lease has expired — stamping a fresh
   * `claim_owner`/`claim_token`/`claim_expires_at`. The final `UPDATE` is guarded by the exact
   * `status` *and* `claim_token` just read: only a caller whose read reflects the row's still-current,
   * unchanged state can win. A second, independently live process (a genuinely separate
   * `PlatformStore`/`DatabaseSync` connection to the same file, not merely a second in-process call)
   * racing the same row will read the same pre-claim snapshot but lose the conditional UPDATE, so it
   * never independently believes it owns the delivery obligation — the guarantee lives in SQLite's own
   * transactional CAS, not an in-process mutex. */
  public claimNext(now: string, ownerId: string, leaseMs: number): OutboxRecord | null {
    return this.tx(() => {
      const row = this.db.prepare(
        // Ordered by SQLite's own implicit rowid, not (created_at, outbox_id) — two records enqueued
        // within the same millisecond (routine under a mocked or fast-ticking clock) would otherwise
        // tie-break on a random UUID string and dispatch out of true creation order. rowid is
        // monotonically assigned in insertion order for an ordinary (non-WITHOUT-ROWID) table, so this
        // guarantees FIFO delivery — which the causal chain itself does not depend on (causation_id is
        // fixed at enqueue time regardless), but a reviewer reading Ledger's own per-stream `sequence`
        // should still see events in the order they causally happened, not an incidental UUID order.
        "SELECT * FROM platform_outbox WHERE status='PENDING' OR (status='FAILED' AND next_attempt_at<=?) OR (status='DELIVERING' AND claim_expires_at IS NOT NULL AND claim_expires_at<=?) ORDER BY rowid LIMIT 1",
      ).get(now, now) as OutboxRow | undefined;
      if (!row) return null;
      const claimToken = randomUUID();
      const claimExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      const changed = this.db.prepare(
        'UPDATE platform_outbox SET status=?, claim_owner=?, claim_token=?, claim_expires_at=?, attempt_count=attempt_count+1 WHERE tenant_id=? AND outbox_id=? AND status=? AND claim_token IS ?',
      ).run('DELIVERING', ownerId, claimToken, claimExpiresAt, row.tenant_id, row.outbox_id, row.status, row.claim_token);
      if (changed.changes !== 1) return null;
      return rowToOutbox({ ...row, status: 'DELIVERING', claim_owner: ownerId, claim_token: claimToken, claim_expires_at: claimExpiresAt, attempt_count: row.attempt_count + 1 });
    });
  }
  /** All three `mark*` calls are fenced on `claim_token`: a token mismatch means this caller's lease
   * has since been reclaimed by a different owner, so the write is a silent no-op — the row's true
   * state is whatever its current, authoritative owner leaves it as, never overwritten by a
   * superseded claimant reporting a late outcome (section 4's crash-after-append scenario relies on
   * this: process A never gets to call this at all, which is exactly the point). */
  public markDelivered(outboxId: string, tenantId: string, claimToken: string, ledgerEventId: string): void {
    if (ledgerEventId !== outboxLedgerEventId(outboxId)) throw new PlatformError('CONFLICT', 'Non-deterministic ledger event id');
    this.db.prepare("UPDATE platform_outbox SET status='DELIVERED', ledger_event_id=?, last_error=NULL, claim_expires_at=NULL WHERE tenant_id=? AND outbox_id=? AND status='DELIVERING' AND claim_token=?").run(ledgerEventId, tenantId, outboxId, claimToken);
  }
  public markRetry(outboxId: string, tenantId: string, claimToken: string, error: string, nextAttemptAtIso: string): void {
    this.db.prepare("UPDATE platform_outbox SET status='FAILED', last_error=?, next_attempt_at=?, claim_expires_at=NULL WHERE tenant_id=? AND outbox_id=? AND status='DELIVERING' AND claim_token=?").run(error, nextAttemptAtIso, tenantId, outboxId, claimToken);
  }
  public markDeadLetter(outboxId: string, tenantId: string, claimToken: string, error: string): void {
    this.db.prepare("UPDATE platform_outbox SET status='DEAD_LETTER', last_error=?, claim_expires_at=NULL WHERE tenant_id=? AND outbox_id=? AND status='DELIVERING' AND claim_token=?").run(error, tenantId, outboxId, claimToken);
  }
  // Ordered by rowid, not created_at alone — records enqueued within the same millisecond (routine
  // under a mocked or fast-ticking clock) must still list in true creation/causal order, matching
  // claimNext's own ordering fix (see its comment) and required for reconstructPlatformAction's
  // causal_chain to reflect an actually-consistent, walkable chain.
  public listOutbox(tenantId: string, actionId?: string): readonly OutboxRecord[] { const rows = actionId ? this.db.prepare('SELECT * FROM platform_outbox WHERE tenant_id=? AND platform_action_id=? ORDER BY rowid').all(tenantId, actionId) : this.db.prepare('SELECT * FROM platform_outbox WHERE tenant_id=? ORDER BY rowid').all(tenantId); return (rows as unknown as OutboxRow[]).map(rowToOutbox); }
}

/** Narrow anti-corruption boundary around the real Gate. The platform supplies the only agent
 * principal it is willing to represent and never lets a caller submit an authorization outcome. */
export interface GatePort {
  authorize(principal: { readonly kind: 'agent'; readonly agentId: string }, request: {
    readonly agentId: string; readonly action: string; readonly tool: string; readonly resource: string;
    readonly estimatedCostUsd: number; readonly destination?: string;
  }): GateDecisionLike;
}
export interface GateDecisionLike {
  readonly decisionId: string; readonly decision: 'ALLOW' | 'BLOCK' | 'HOLD'; readonly reason: string;
  readonly policyHash: string | null; readonly policyVersion: string | null; readonly approvalReference: string | null; readonly timestamp: string;
}

/** Performs precisely the pre-execution authorization leg. Capability, Sentinel, and connector
 * execution are deliberately outside this atom: ALLOW leaves the durable action AUTHORIZED. */
export class PlatformGateOrchestrator {
  public constructor(private readonly store: PlatformStore, private readonly gate: GatePort) {}
  public authorize(principal: PlatformPrincipal, actionId: string): PlatformAction {
    if (principal.role !== 'platform-agent' || !principal.agentId) throw new PlatformError('FORBIDDEN', 'Only a tenant-bound platform agent may request Gate authorization');
    const action = this.store.get(principal.tenantId, actionId);
    if (action.request.agent_id !== principal.agentId) throw new PlatformError('FORBIDDEN', 'Platform agent is not bound to this action');
    const authorizing = action.state === 'RECEIVED'
      ? this.store.transition(action.tenant_id, action.platform_action_id, action.state_version, 'AUTHORIZING')
      : action;
    if (authorizing.state !== 'AUTHORIZING') throw new PlatformError('CONFLICT', 'Action is not awaiting Gate authorization');
    const destination = typeof authorizing.request.metadata?.destination === 'string' ? authorizing.request.metadata.destination : undefined;
    const decision = this.gate.authorize({ kind: 'agent', agentId: principal.agentId }, {
      agentId: authorizing.request.agent_id, action: authorizing.request.action, tool: authorizing.request.tool,
      resource: authorizing.request.resource, estimatedCostUsd: authorizing.request.requested_cost_limits?.max_cost_usd ?? 0,
      ...(destination ? { destination } : {}),
    });
    const evidence: GateDecisionEvidence = {
      decision_id: decision.decisionId, decision: decision.decision, reason: decision.reason,
      policy_hash: decision.policyHash, policy_version: decision.policyVersion,
      approval_reference: decision.approvalReference, decided_at: decision.timestamp,
    };
    return this.store.recordGateDecision(authorizing.tenant_id, authorizing.platform_action_id, authorizing.state_version, evidence);
  }
}

export interface PlatformLedgerPort { append(input: LedgerEventInput): { readonly event_id: string } | Promise<{ readonly event_id: string }> }

/** Reads a decision id only from what this specific record's own payload captured at enqueue time
 * (either a flat `decision_id`, or nested under `gate_decision.decision_id` as `recordGateDecision`'s
 * own enqueue call shapes it) — never from current action state. See `toLedgerEvent`. */
function capturedDecisionIdFromPayload(payload: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof payload.decision_id === 'string') return payload.decision_id;
  const gateDecision = payload.gate_decision;
  if (gateDecision && typeof gateDecision === 'object' && 'decision_id' in gateDecision && typeof (gateDecision as { decision_id: unknown }).decision_id === 'string') {
    return (gateDecision as { decision_id: string }).decision_id;
  }
  return undefined;
}
function capturedPolicyHashFromPayload(payload: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof payload.policy_hash === 'string') return payload.policy_hash;
  const gateDecision = payload.gate_decision;
  if (gateDecision && typeof gateDecision === 'object' && 'policy_hash' in gateDecision && typeof (gateDecision as { policy_hash: unknown }).policy_hash === 'string') {
    return (gateDecision as { policy_hash: string }).policy_hash;
  }
  return undefined;
}

/** Pure outbox-to-Ledger translation. IDs are derived exclusively from the outbox record; the
 * action correlation ID survives every event and Gate decision ID is the causal link. */
export class PlatformLedgerDispatcher {
  public constructor(private readonly store: PlatformStore, private readonly ledger: PlatformLedgerPort, options: { maxAttempts?: number; clock?: () => number; ownerId?: string; leaseMs?: number } = {}) {
    this.dispatcher = new OutboxDispatcher(store, async record => this.ledger.append(this.toLedgerEvent(record)), options);
  }
  private readonly dispatcher: OutboxDispatcher;
  public dispatchOnce() { return this.dispatcher.dispatchOnce(); }
  /**
   * Distributed-evidence closure, Finding 2. Causation is read **only** from `record.payload` — the
   * exact snapshot captured at `enqueue()` time (`PlatformStore.enqueue`) — never re-derived from the
   * action's *current* state. `action` (re-fetched here) supplies only fields that are immutable for
   * the lifetime of the action (`request.*`, `correlation_id`, `input_hash`, `tenant_id`) — none of
   * which can drift between when a record was enqueued and when it is eventually dispatched, unlike
   * `gate_decision`/`capability_id`/`sentinel_session_id`/etc., which the old implementation read live
   * and which a later lifecycle event (e.g. a HELD action's later resume producing a *second*, ALLOW
   * decision) could otherwise retroactively attach to an unrelated, already-historical record.
   */
  public toLedgerEvent(record: OutboxRecord): LedgerEventInput {
    const action = this.store.get(record.tenant_id, record.platform_action_id);
    const eventType = this.eventType(record) as LedgerEventType;
    const capturedDecisionId = capturedDecisionIdFromPayload(record.payload);
    const capturedPolicyHash = capturedPolicyHashFromPayload(record.payload);
    const causationEventId = typeof record.payload.causation_event_id === 'string' ? record.payload.causation_event_id : undefined;
    const authority = {
      agent_id: action.request.agent_id, action: action.request.action, tool: action.request.tool,
      resource: action.request.resource, operation: action.request.operation,
      ...(capturedDecisionId ? { decision_id: capturedDecisionId } : {}),
      ...(capturedPolicyHash ? { policy_hash: capturedPolicyHash } : {}),
    };
    return {
      version: '1.0', event_id: outboxLedgerEventId(record.outbox_id), event_type: eventType,
      tenant_id: action.tenant_id, stream_id: `platform:${action.platform_action_id}`,
      correlation_id: action.correlation_id, ...(causationEventId ? { causation_id: causationEventId } : {}),
      actor: { type: 'AGENT', id: action.request.agent_id }, source_component: 'platform',
      authority_context: authority,
      payload: { ...record.payload, input_hash: action.input_hash },
    };
  }
  private eventType(record: OutboxRecord): LedgerEventType {
    const direct: Record<string, LedgerEventType> = {
      PLATFORM_ACTION_RECEIVED: 'PLATFORM_ACTION_RECEIVED', PLATFORM_ACTION_AUTHORIZED: 'PLATFORM_ACTION_AUTHORIZED',
      PLATFORM_ACTION_BLOCKED: 'PLATFORM_ACTION_BLOCKED', PLATFORM_ACTION_HELD: 'PLATFORM_ACTION_HELD',
      PLATFORM_EXECUTION_CLAIMED: 'PLATFORM_EXECUTION_STARTED', PLATFORM_EXECUTION_INDETERMINATE_RECOVERY: 'PLATFORM_ACTION_INDETERMINATE',
      // Emitted directly (not via the generic PLATFORM_ACTION_STATE_CHANGED bucket) by
      // recordExecutionResult/recordVerificationResult/recordFailure — the outbox event_type these
      // methods enqueue with is already the literal target Ledger event type, so it passes straight
      // through here rather than needing to_state inference.
      PLATFORM_EXECUTION_COMPLETED: 'PLATFORM_EXECUTION_COMPLETED', PLATFORM_VERIFICATION_STARTED: 'PLATFORM_VERIFICATION_STARTED',
      PLATFORM_VERIFICATION_COMPLETED: 'PLATFORM_VERIFICATION_COMPLETED', PLATFORM_ACTION_COMPLETED: 'PLATFORM_ACTION_COMPLETED',
      PLATFORM_ACTION_FAILED: 'PLATFORM_ACTION_FAILED', PLATFORM_ACTION_TERMINATED: 'PLATFORM_ACTION_TERMINATED',
      PLATFORM_ACTION_INDETERMINATE: 'PLATFORM_ACTION_INDETERMINATE',
    };
    const mapped = direct[record.event_type];
    if (mapped) return mapped;
    if (record.event_type === 'PLATFORM_ACTION_STATE_CHANGED') {
      const target = record.payload.to_state;
      if (target === 'AUTHORIZED') return 'PLATFORM_ACTION_AUTHORIZED';
      if (target === 'BLOCKED') return 'PLATFORM_ACTION_BLOCKED';
      if (target === 'HELD') return 'PLATFORM_ACTION_HELD';
      if (target === 'AUTHORIZING') return 'PLATFORM_ACTION_RECEIVED';
      if (target === 'COMPLETED') return 'PLATFORM_ACTION_COMPLETED';
      if (target === 'INDETERMINATE') return 'PLATFORM_ACTION_INDETERMINATE';
    }
    throw new PlatformError('EVIDENCE_DEGRADED', `No Ledger mapping for outbox event ${record.event_type}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Capability, Sentinel, and connector execution (sections 18-26, 32). Gate's own `ExecutionBroker`
// and `SentinelRuntime` are real, already-accepted packages — used directly here, never
// reimplemented — but both are constructed by the composition root (apps/tna-platform), which is
// also where the connector-adapted `ToolRegistry` and containment/revalidator wiring live. This
// class only sequences the calls and enforces the platform's own state machine around them.
// ---------------------------------------------------------------------------------------------

/** Narrow anti-corruption boundary around VAD — VAD itself has no principal/durability model of its
 * own (section 2 of the API survey), so the composition root owns the actual atom-spec/producer/
 * validation-gate/verifier/human-decision sequence and exposes only the resulting verdict here. */
export interface VadPort {
  verify(input: VadVerifyInput): Promise<VadVerdict>;
}
export interface VadVerifyInput {
  readonly platform_action_id: string; readonly correlation_id: string; readonly tenant_id: string;
  readonly goal: string; readonly resource: string; readonly result_hash: string;
  readonly max_runtime_seconds: number; readonly max_cost_usd: number;
}
export interface VadVerdict { readonly atom_id: string; readonly final_state: 'ACCEPTED' | 'REJECTED' | 'ESCALATED' | 'FAILED' }

const SENTINEL_OPERATIONS: ReadonlySet<string> = new Set(['read', 'write', 'create', 'delete']);
/** Sentinel's `allowed_operations` is a controlled vocabulary distinct from the platform's own free-
 * form `operation` field (section 6 is intentionally more permissive at the API boundary than any one
 * downstream consumer). An operation outside Sentinel's vocabulary is simply not added to the
 * session's allow-list rather than rejecting the whole request — the session then authorizes no
 * resource-operation observations at all for this action, which is fail-closed, not fail-open. */
function sentinelOperations(operation: string): readonly SentinelOperation[] {
  return SENTINEL_OPERATIONS.has(operation) ? [operation as SentinelOperation] : [];
}
/** Mirrors `ExecutionBroker`'s own private `operation()` rule exactly (execution-broker/src/index.ts):
 * capability/redeem binding always uses 'write' for `production.deploy` and 'read' for every other
 * action, regardless of the platform's own `operation` field. This is Gate's broker's own internal
 * capability-binding convention, not a platform policy — documented here because it is not exported. */
function brokerOperation(action: string): 'read' | 'write' { return action === 'production.deploy' ? 'write' : 'read'; }
/** Sentinel's `expected_resource`/observation `resource` pattern must start with an alphanumeric
 * character (`safeResourcePattern`, sentinel-schema); Gate's own file-scoped resources are required
 * to start with `/` (`validFile`, authority-envelope). The two subsystems' resource-identifier
 * conventions are simply incompatible at the leading character — this is the platform's own
 * normalization boundary, applied consistently everywhere a resource crosses into Sentinel, never
 * altering what Gate/the connector/Ledger see. */
function toSentinelResource(resource: string): string { return resource.replace(/^\/+/, '') || resource; }

export interface ExecutionOutcome { readonly action: PlatformAction; readonly executed: boolean }

/** The narrow slice of `SentinelRuntime`'s real, accepted API this orchestrator actually calls —
 * declared as an interface (mirroring `GatePort`/`VadPort`) so tests can substitute a deterministic
 * fake for the TERMINATE/HOLD branches without needing a Sentinel policy engineered to fire on
 * demand. A real `SentinelRuntime` instance satisfies this structurally; no adapter is needed at the
 * composition root. */
export interface SentinelPort {
  createSession(principal: SentinelPrincipal, input: SentinelSessionInput): SentinelSession;
  getSession(principal: SentinelPrincipal, sessionId: string): SentinelSession;
  submitObservation(principal: SentinelPrincipal, sessionId: string, input: SentinelObservationInput): Promise<{ observation: SentinelObservation; decision: SentinelDecision | null }>;
  completeSession(principal: SentinelPrincipal, sessionId: string): SentinelSession;
}

/**
 * Runs the full post-authorization leg for one `AUTHORIZED` action: capability issuance, Sentinel
 * session creation, the mandatory pre-action check (section 23), broker-mediated connector execution
 * (section 22, 24), and — when required — VAD verification (sections 27-30). Every step's durable
 * fact is committed before the next side effect is attempted, so a crash at any point leaves the
 * action in a state `recoverInterruptedWork()` can honestly resolve on restart (section 99).
 */
export class PlatformExecutionOrchestrator {
  public constructor(
    private readonly store: PlatformStore,
    private readonly broker: ExecutionBroker,
    private readonly sentinel: SentinelPort,
    private readonly sentinelController: SentinelPrincipal,
    private readonly sentinelObserver: SentinelPrincipal,
    private readonly vad?: VadPort,
  ) {}

  public async run(principal: PlatformPrincipal, actionId: string): Promise<ExecutionOutcome> {
    if (principal.role !== 'platform-agent' || !principal.agentId) throw new PlatformError('FORBIDDEN', 'Only a tenant-bound platform agent may drive execution');
    let action = this.store.get(principal.tenantId, actionId);
    if (action.request.agent_id !== principal.agentId) throw new PlatformError('FORBIDDEN', 'Platform agent is not bound to this action');
    if (action.state !== 'AUTHORIZED') throw new PlatformError('CONFLICT', `Action is not AUTHORIZED (state: ${action.state})`);
    const gate = action.gate_decision;
    if (!gate || gate.decision !== 'ALLOW') throw new PlatformError('CONFLICT', 'Action has no ALLOW decision to execute against');
    const gatePrincipal: GateAgentPrincipal = { kind: 'agent', agentId: principal.agentId };

    // 1. Capability issuance (AUTHORIZED -> CAPABILITY_ISSUED).
    let capability: { token: string; payload: { capability_id: string } };
    try { capability = this.broker.issue(gatePrincipal, gate.decision_id); }
    catch (error) { throw this.failAt(action.tenant_id, actionId, action.state_version, 'AUTHORIZED', 'FAILED', 'CAPABILITY_FAILURE', error); }
    action = this.store.recordCapability(action.tenant_id, actionId, action.state_version, capability.payload.capability_id);

    // 2. Sentinel session creation (CAPABILITY_ISSUED -> MONITORING). A session-creation failure means
    //    the action requiring monitoring has none — this must never silently fall back to unmonitored
    //    execution (section 21): fail closed to INDETERMINATE, never proceed to redeem.
    let session;
    try { session = this.createSession(action); }
    catch (error) { throw this.failAt(action.tenant_id, actionId, action.state_version, 'CAPABILITY_ISSUED', 'INDETERMINATE', 'SENTINEL_UNAVAILABLE', error); }
    action = this.store.recordSentinelSession(action.tenant_id, actionId, action.state_version, session.sentinel_session_id);

    // 3. Durable execution claim (MONITORING -> EXECUTING). One winner even under concurrent callers.
    const run = this.store.claimExecution(action.tenant_id, actionId, action.state_version);
    action = this.store.get(action.tenant_id, actionId);
    const finishRunQuietly = (status: 'FINISHED' | 'INDETERMINATE'): void => { try { this.store.finishRun(action.tenant_id, run.execution_id, status); } catch { /* already finished by a concurrent path — not this call's concern */ } };

    // 4. Mandatory pre-action Sentinel check (section 23) — TOOL_CALL_REQUESTED must be evaluated
    //    before the connector is ever invoked. A TERMINATE or HOLD decision here means the connector
    //    is never called at all: `executed: false` below is the platform's own confirmation of that.
    const preCheck = await this.sentinel.submitObservation(this.sentinelObserver, session.sentinel_session_id, {
      version: '1.0', observation_id: `obs_pre_${randomUUID()}`, tenant_id: action.tenant_id,
      sentinel_session_id: session.sentinel_session_id, timestamp: new Date().toISOString(),
      source: 'EXECUTION_BROKER', observation_type: 'TOOL_CALL_REQUESTED',
      payload: { tool: action.request.tool, resource: toSentinelResource(action.request.resource) },
    });
    if (preCheck.decision?.decision === 'TERMINATE') {
      const confirmed = this.sentinel.getSession(this.sentinelController, session.sentinel_session_id).status === 'TERMINATED';
      const finalAction = this.store.recordFailure(action.tenant_id, actionId, action.state_version, 'EXECUTING', confirmed ? 'TERMINATED' : 'INDETERMINATE', 'SENTINEL_TERMINATED', preCheck.decision.violations.map(v => v.rule_type).join(', ') || 'Sentinel terminated the session before execution');
      finishRunQuietly(confirmed ? 'FINISHED' : 'INDETERMINATE');
      return { action: finalAction, executed: false };
    }
    if (preCheck.decision?.decision === 'HOLD') {
      const finalAction = this.store.recordFailure(action.tenant_id, actionId, action.state_version, 'EXECUTING', 'INDETERMINATE', 'SENTINEL_HOLD', 'Sentinel held the session before execution; connector was never invoked');
      return { action: finalAction, executed: false };
    }

    // 5. Input-binding re-verification (section 19): the stored request is what execution binds to —
    //    if it were ever found to differ from the hash bound at RECEIVED time, execution must not
    //    proceed. Unreachable through the public API (the stored request is immutable once written),
    //    proven directly by a white-box test that corrupts the row and asserts this fires.
    if (computeInputHash(action.request) !== action.input_hash) {
      const finalAction = this.store.recordFailure(action.tenant_id, actionId, action.state_version, 'EXECUTING', 'TERMINATED', 'EXECUTION_FAILED', 'Input binding drift detected between authorization and execution — connector never invoked');
      return { action: finalAction, executed: false };
    }

    // 6. Broker-mediated connector execution (section 22, 24) — never a direct handler call.
    let redeemed;
    try {
      redeemed = await this.broker.redeem(gatePrincipal, {
        token: capability.token, tool: action.request.tool, resource: action.request.resource,
        operation: brokerOperation(action.request.action), input: action.request.input, input_hash: hash(action.request.input),
      });
    } catch (error) {
      const indeterminate = error instanceof BrokerError && /Evidence persistence failed after successful handler execution/.test(error.message);
      const finalAction = this.store.recordFailure(action.tenant_id, actionId, action.state_version, 'EXECUTING', indeterminate ? 'INDETERMINATE' : 'FAILED', indeterminate ? 'EVIDENCE_DEGRADED' : 'EXECUTION_FAILED', error instanceof Error ? error.message : 'Connector execution failed');
      finishRunQuietly(indeterminate ? 'INDETERMINATE' : 'FINISHED');
      return { action: finalAction, executed: false };
    }
    await this.sentinel.submitObservation(this.sentinelObserver, session.sentinel_session_id, {
      version: '1.0', observation_id: `obs_post_${randomUUID()}`, tenant_id: action.tenant_id,
      sentinel_session_id: session.sentinel_session_id, timestamp: new Date().toISOString(),
      source: 'EXECUTION_BROKER', observation_type: 'EXECUTION_COMPLETED', payload: { tool: action.request.tool, resource: toSentinelResource(action.request.resource) },
    }).catch(() => undefined);
    try { this.sentinel.completeSession(this.sentinelController, session.sentinel_session_id); } catch { /* best-effort — the real side effect already succeeded (TNA-47) */ }

    const evidence: ExecutionEvidence = { execution_id: redeemed.executionId, result_hash: redeemed.result.hash };
    if (!action.request.requires_verification) {
      const finalAction = this.store.recordExecutionResult(action.tenant_id, actionId, action.state_version, evidence, 'COMPLETED', 'PLATFORM_ACTION_COMPLETED');
      this.store.finishRun(action.tenant_id, run.execution_id, 'FINISHED');
      return { action: finalAction, executed: true };
    }
    action = this.store.recordExecutionResult(action.tenant_id, actionId, action.state_version, evidence, 'VERIFYING', 'PLATFORM_VERIFICATION_STARTED');
    this.store.finishRun(action.tenant_id, run.execution_id, 'FINISHED');

    // 7. Optional VAD verification (sections 27-30). No VadPort configured but verification required
    //    is itself INDETERMINATE, never a silent skip (section 27 only permits skipping when the
    //    request itself declared requires_verification: false).
    if (!this.vad) {
      const finalAction = this.store.recordVerificationResult(action.tenant_id, actionId, action.state_version, { vad_atom_id: 'none', vad_final_state: 'UNAVAILABLE' }, 'INDETERMINATE', 'COMPONENT_UNAVAILABLE');
      return { action: finalAction, executed: true };
    }
    const verdict = await this.vad.verify({
      platform_action_id: actionId, correlation_id: action.correlation_id, tenant_id: action.tenant_id,
      goal: `${action.request.action} via ${action.request.tool}`, resource: action.request.resource, result_hash: evidence.result_hash,
      max_runtime_seconds: action.request.requested_runtime_limits?.max_runtime_seconds ?? 60,
      max_cost_usd: action.request.requested_cost_limits?.max_cost_usd ?? 1,
    });
    const verificationEvidence: VerificationEvidence = { vad_atom_id: verdict.atom_id, vad_final_state: verdict.final_state };
    if (verdict.final_state === 'ACCEPTED') {
      const finalAction = this.store.recordVerificationResult(action.tenant_id, actionId, action.state_version, verificationEvidence, 'COMPLETED', null);
      return { action: finalAction, executed: true };
    }
    if (verdict.final_state === 'REJECTED') {
      const finalAction = this.store.recordVerificationResult(action.tenant_id, actionId, action.state_version, verificationEvidence, 'FAILED', 'VERIFICATION_REJECTED');
      return { action: finalAction, executed: true };
    }
    const finalAction = this.store.recordVerificationResult(action.tenant_id, actionId, action.state_version, verificationEvidence, 'INDETERMINATE', 'VERIFICATION_ESCALATED');
    return { action: finalAction, executed: true };
  }

  private createSession(action: PlatformAction): SentinelSession {
    const gate = action.gate_decision!;
    const runtimeSeconds = action.request.requested_runtime_limits?.max_runtime_seconds ?? 60;
    const costUsd = action.request.requested_cost_limits?.max_cost_usd ?? 1;
    const policyHash = gate.policy_hash ?? hash(action.request);
    return this.sentinel.createSession(this.sentinelController, {
      version: '1.0', tenant_id: action.tenant_id, agent_id: action.request.agent_id, execution_id: action.platform_action_id,
      decision_id: gate.decision_id, ...(action.capability_id !== null ? { capability_id: action.capability_id } : {}), correlation_id: action.correlation_id,
      authority_snapshot_hash: policyHash, policy_snapshot_hash: policyHash,
      expected_action: action.request.action, expected_tool: action.request.tool, expected_resource: toSentinelResource(action.request.resource),
      allowed_destinations: [], allowed_operations: sentinelOperations(action.request.operation),
      authority_expiry: new Date(Date.parse(gate.decided_at) + runtimeSeconds * 1000).toISOString(),
      runtime_limits: { max_runtime_seconds: runtimeSeconds }, cost_limits: { max_cost_usd: costUsd },
    });
  }

  private failAt(tenantId: string, actionId: string, expectedVersion: number, from: PlatformActionState, target: 'FAILED' | 'INDETERMINATE', code: string, error: unknown): PlatformError {
    this.store.recordFailure(tenantId, actionId, expectedVersion, from, target, code, error instanceof Error ? error.message : String(error));
    return error instanceof PlatformError ? error : new PlatformError('CAPABILITY_FAILURE', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Section 45: "create + orchestrate through a bounded request." A single call drives an action from
 * RECEIVED all the way to a terminal or HELD state within one bounded synchronous request — the
 * facade both the HTTP API's `POST /v1/platform/actions` and the demo script drive, so the
 * create-authorize-execute sequencing lives in exactly one place. Idempotent re-submission of a
 * `request_id` whose action has already progressed past RECEIVED simply returns its current state
 * rather than re-running any side effect.
 */
export class PlatformFacade {
  public constructor(private readonly store: PlatformStore, private readonly gateOrchestrator: PlatformGateOrchestrator, private readonly executionOrchestrator: PlatformExecutionOrchestrator) {}
  public async submitAndRun(principal: PlatformPrincipal, raw: unknown, createdBy: string): Promise<PlatformAction> {
    assertCanSubmit(principal);
    const created = this.store.createOrReturn(raw, createdBy);
    if (created.state !== 'RECEIVED') return created;
    const authorized = this.gateOrchestrator.authorize(principal, created.platform_action_id);
    if (authorized.state !== 'AUTHORIZED') return authorized;
    const outcome = await this.executionOrchestrator.run(principal, authorized.platform_action_id);
    return outcome.action;
  }
}

/** Operator control actions (sections 47-48): approve/resume a HELD action, or terminate one already
 * in flight. An agent principal cannot call either — enforced by `platform-schema`'s own role guards. */
export class PlatformControlOrchestrator {
  public constructor(private readonly store: PlatformStore) {}
  public resume(principal: PlatformPrincipal, actionId: string): PlatformAction {
    if (principal.role !== 'platform-operator' && principal.role !== 'platform-admin') throw new PlatformError('FORBIDDEN', `Role ${principal.role} may not resume a held action`);
    const action = this.store.get(principal.tenantId, actionId);
    if (action.state !== 'HELD') throw new PlatformError('INVALID_TRANSITION', `Action is not HELD (state: ${action.state})`);
    return this.store.transition(action.tenant_id, actionId, action.state_version, 'AUTHORIZING');
  }
  public terminate(principal: PlatformPrincipal, actionId: string, reason: string): PlatformAction {
    if (principal.role !== 'platform-operator' && principal.role !== 'platform-admin') throw new PlatformError('FORBIDDEN', `Role ${principal.role} may not terminate a platform action`);
    const action = this.store.get(principal.tenantId, actionId);
    if (action.state === 'HELD') return this.store.transition(action.tenant_id, actionId, action.state_version, 'TERMINATED', 'PLATFORM_ACTION_TERMINATED');
    if (!['MONITORING', 'EXECUTING'].includes(action.state)) throw new PlatformError('INVALID_TRANSITION', `Action cannot be terminated from state ${action.state}`);
    return this.store.recordFailure(action.tenant_id, actionId, action.state_version, action.state, 'TERMINATED', 'SENTINEL_TERMINATED', reason);
  }
}

// ---------------------------------------------------------------------------------------------
// Reconstruction (section 64-66, 148). The defining engineering standard of this milestone: can an
// independent reviewer trace CONTROL -> REQUIRED EVIDENCE -> ACTUAL EVIDENCE -> EVALUATION -> RESULT
// for one governed action, without trusting the system being reviewed to grade itself? This function
// answers that for one platform action, from durable state alone.
// ---------------------------------------------------------------------------------------------

/** One record's causal position (distributed-evidence closure, Finding 2, section 11): `event_id` is
 * this record's own deterministic Ledger identity (known even before delivery); `caused_by` is the
 * event_id of whatever this record's own enqueue-time snapshot named as its cause — never recomputed
 * from current state. Domain ids are only present where that record actually captured them. */
export interface CausalChainStep {
  readonly event_id: string;
  readonly event_type: string;
  readonly caused_by: string | null;
  readonly decision_id?: string;
  readonly capability_id?: string;
  readonly sentinel_session_id?: string;
  readonly execution_id?: string;
  readonly vad_atom_id?: string;
}

function extractCausalFacts(payload: Readonly<Record<string, unknown>>): Omit<CausalChainStep, 'event_id' | 'event_type' | 'caused_by'> {
  const facts: { decision_id?: string; capability_id?: string; sentinel_session_id?: string; execution_id?: string; vad_atom_id?: string } = {};
  const decisionId = capturedDecisionIdFromPayload(payload);
  if (decisionId) facts.decision_id = decisionId;
  if (typeof payload.capability_id === 'string') facts.capability_id = payload.capability_id;
  if (typeof payload.sentinel_session_id === 'string') facts.sentinel_session_id = payload.sentinel_session_id;
  if (typeof payload.execution_id === 'string') facts.execution_id = payload.execution_id;
  else {
    const exec = payload.execution;
    if (exec && typeof exec === 'object' && typeof (exec as { execution_id?: unknown }).execution_id === 'string') facts.execution_id = (exec as { execution_id: string }).execution_id;
  }
  const verification = payload.verification;
  if (verification && typeof verification === 'object' && typeof (verification as { vad_atom_id?: unknown }).vad_atom_id === 'string') facts.vad_atom_id = (verification as { vad_atom_id: string }).vad_atom_id;
  return facts;
}

export interface PlatformActionReconstruction {
  readonly platform_action_id: string;
  readonly correlation_id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly request: { readonly tool: string; readonly action: string; readonly operation: string; readonly resource: string; readonly input_hash: string; readonly requires_verification: boolean };
  readonly gate: { readonly decision: 'ALLOW' | 'BLOCK' | 'HOLD'; readonly decision_id: string; readonly reason: string } | null;
  readonly capability_id: string | null;
  readonly sentinel_session_id: string | null;
  readonly execution: { readonly execution_id: string; readonly result_hash: string } | null;
  readonly verification: { readonly vad_atom_id: string; readonly vad_final_state: string } | null;
  readonly evidence: { readonly status: 'OK' | 'DEGRADED'; readonly outbox_records: number; readonly delivered: number; readonly dead_lettered: number };
  readonly final_status: PlatformActionState;
  readonly error: { readonly code: string; readonly message: string } | null;
  /** Causal linkage, not merely chronological ordering (section 11) — each step names exactly what
   * it was enqueued knowing as its cause, so an independent reviewer can trace e.g. "execution caused
   * by Sentinel session, caused by capability, caused by Gate decision" without trusting the system
   * being reviewed to grade itself, and without the chain being able to silently rewrite itself as the
   * action's current state later changes. */
  readonly causal_chain: readonly CausalChainStep[];
}

export function reconstructPlatformAction(store: PlatformStore, tenantId: string, actionId: string): PlatformActionReconstruction {
  const action = store.get(tenantId, actionId);
  const outbox = store.listOutbox(tenantId, actionId);
  return {
    platform_action_id: action.platform_action_id, correlation_id: action.correlation_id, tenant_id: action.tenant_id,
    agent_id: action.request.agent_id,
    request: { tool: action.request.tool, action: action.request.action, operation: action.request.operation, resource: action.request.resource, input_hash: action.input_hash, requires_verification: action.request.requires_verification },
    gate: action.gate_decision ? { decision: action.gate_decision.decision, decision_id: action.gate_decision.decision_id, reason: action.gate_decision.reason } : null,
    capability_id: action.capability_id, sentinel_session_id: action.sentinel_session_id,
    execution: action.execution_id && action.result_hash ? { execution_id: action.execution_id, result_hash: action.result_hash } : null,
    verification: action.vad_atom_id && action.vad_final_state ? { vad_atom_id: action.vad_atom_id, vad_final_state: action.vad_final_state } : null,
    evidence: {
      status: store.evidenceStatus(tenantId, actionId), outbox_records: outbox.length,
      delivered: outbox.filter(o => o.status === 'DELIVERED').length, dead_lettered: outbox.filter(o => o.status === 'DEAD_LETTER').length,
    },
    final_status: action.state,
    error: action.error_code && action.error_message ? { code: action.error_code, message: action.error_message } : null,
    causal_chain: outbox.map(record => ({
      event_id: outboxLedgerEventId(record.outbox_id), event_type: record.event_type,
      caused_by: typeof record.payload.causation_event_id === 'string' ? record.payload.causation_event_id : null,
      ...extractCausalFacts(record.payload),
    })),
  };
}
