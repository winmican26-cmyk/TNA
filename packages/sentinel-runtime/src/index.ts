import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  SentinelError, MAX_SESSION_QUERY_PAGE_SIZE, DEFAULT_SESSION_QUERY_PAGE_SIZE, MAX_VIOLATIONS_PER_RESPONSE, MAX_DECISIONS_PER_RESPONSE,
  validateSessionInput, validateObservationInput, SOURCE_ALLOWED_OBSERVATION_TYPES, SEVERITY_SCORE, AUTHORITY_STATUSES,
  type SentinelSession, type SentinelSessionInput, type SentinelObservation, type ObservationSource,
  type SessionStatus, type AuthorityStatus, type AuthorityStatusKind, type RevokedScope, type SentinelDecisionType,
} from '../../sentinel-schema/src/index.js';
import { validatePolicyInput, finalizePolicy, defaultDemoPolicyInput, type SentinelPolicy } from '../../sentinel-policy/src/index.js';
import {
  evaluateSession, isTerminalStatus, nextStatusForDecision,
  type SentinelDecision, type Violation, type ViolationRuleType, type ContainmentStatus, type TransitionResult,
} from '../../sentinel-engine/src/index.js';

export { SentinelError };
export type { SentinelSession, SentinelSessionInput, SentinelObservation, SentinelPolicy, SentinelDecision, Violation, ContainmentStatus, AuthorityStatus, TransitionResult };

// ---------------------------------------------------------------------------------------------
// Principal / role model (sections 79-82). A governed agent is never issued observer/controller/
// admin identity — only trusted platform components hold those, exactly like Ledger's writer model.
// ---------------------------------------------------------------------------------------------

export type SentinelRole = 'observer' | 'reader' | 'controller' | 'admin';
export interface SentinelPrincipal { readonly id: string; readonly role: SentinelRole; readonly tenantId: string; readonly allowedSources: readonly ObservationSource[] }
export function observerPrincipal(id: string, tenantId: string, allowedSources: readonly ObservationSource[]): SentinelPrincipal { return { id, role: 'observer', tenantId, allowedSources }; }
export function readerPrincipal(id: string, tenantId: string): SentinelPrincipal { return { id, role: 'reader', tenantId, allowedSources: [] }; }
export function controllerPrincipal(id: string, tenantId: string): SentinelPrincipal { return { id, role: 'controller', tenantId, allowedSources: [] }; }
export function adminPrincipal(id: string, tenantId: string): SentinelPrincipal { return { id, role: 'admin', tenantId, allowedSources: [] }; }

function assertCanObserve(principal: SentinelPrincipal, type: string): void {
  if (principal.role !== 'observer') throw new SentinelError('FORBIDDEN', `Principal ${principal.id} does not hold observation authority`);
  if (!principal.allowedSources.some(source => SOURCE_ALLOWED_OBSERVATION_TYPES[source].includes(type as never))) {
    throw new SentinelError('FORBIDDEN', `Principal ${principal.id} is not bound to submit observation type "${type}"`);
  }
}
function assertCanRead(principal: SentinelPrincipal): void { if (!['reader', 'controller', 'admin'].includes(principal.role)) throw new SentinelError('FORBIDDEN', `Principal ${principal.id} does not hold read authority`); }
function assertCanControl(principal: SentinelPrincipal): void { if (principal.role !== 'controller' && principal.role !== 'admin') throw new SentinelError('FORBIDDEN', `Principal ${principal.id} does not hold containment-control authority`); }
function assertIsAdmin(principal: SentinelPrincipal): void { if (principal.role !== 'admin') throw new SentinelError('FORBIDDEN', `Principal ${principal.id} does not hold admin authority`); }
function assertTenant(principal: SentinelPrincipal, tenantId: string): void { if (principal.tenantId !== tenantId) throw new SentinelError('FORBIDDEN', `Principal ${principal.id} is not authorized for tenant ${tenantId}`); }

// ---------------------------------------------------------------------------------------------
// Containment interface (sections 44-56). Sentinel never gets arbitrary shell access — only this
// narrow, two-method contract, resolved fully within one runtime call so containment uncertainty is
// never left silently unresolved (section 55, TNA-30/31).
// ---------------------------------------------------------------------------------------------

export interface ContainmentReason { readonly rule_type?: ViolationRuleType; readonly message: string; readonly decision_id?: string }
export interface ContainmentController {
  hold(sessionId: string, reason: ContainmentReason): void | Promise<void>;
  terminate(sessionId: string, reason: ContainmentReason): void | Promise<void>;
}

/** Deterministic in-memory containment adapter for tests and the demo (section 45). */
export class FakeContainmentController implements ContainmentController {
  public readonly holdCalls: Array<{ sessionId: string; reason: ContainmentReason; at: string }> = [];
  public readonly terminateCalls: Array<{ sessionId: string; reason: ContainmentReason; at: string }> = [];
  private readonly failingSessions = new Set<string>();
  public constructor(private readonly clock: () => number = Date.now) {}
  /** Test/demo hook (section 108): make the next terminate() for this session throw, simulating an
   * unconfirmable containment outcome. */
  public simulateTerminationFailure(sessionId: string): void { this.failingSessions.add(sessionId); }
  public hold(sessionId: string, reason: ContainmentReason): void { this.holdCalls.push({ sessionId, reason, at: new Date(this.clock()).toISOString() }); }
  public terminate(sessionId: string, reason: ContainmentReason): void {
    this.terminateCalls.push({ sessionId, reason, at: new Date(this.clock()).toISOString() });
    if (this.failingSessions.has(sessionId)) { this.failingSessions.delete(sessionId); throw new Error('Simulated containment failure: outcome could not be confirmed'); }
  }
}

// ---------------------------------------------------------------------------------------------
// Authority revalidation (sections 59-61). Ledger is evidence, never live authority — this
// abstraction is how Sentinel consults whatever current-state authority source it is wired to.
// ---------------------------------------------------------------------------------------------

export interface AuthorityRevalidator { validate(session: SentinelSession): AuthorityStatus | Promise<AuthorityStatus>; }
/** Deterministic in-memory revalidator for tests and the demo: returns a pre-programmed status per session. */
export class FakeAuthorityRevalidator implements AuthorityRevalidator {
  private readonly statuses = new Map<string, AuthorityStatus>();
  public set(sessionId: string, status: AuthorityStatus): void { this.statuses.set(sessionId, status); }
  public validate(session: SentinelSession): AuthorityStatus { return this.statuses.get(session.sentinel_session_id) ?? { status: 'VALID' }; }
}

// ---------------------------------------------------------------------------------------------
// Emergency stop (sections 50-52). Persisted, tenant/agent/session scoped, admin-only.
// ---------------------------------------------------------------------------------------------

export type StopScopeType = 'tenant' | 'agent' | 'session';
export interface EmergencyStop { tenant_id: string; scope_type: StopScopeType; scope_value: string; active: boolean; reason: string; activated_by: string; activated_at: string; released_by: string | null; released_at: string | null }

export interface Page<T> { items: T[]; nextCursor: string | null }
function encodeCursor(offset: number): string { return Buffer.from(String(offset), 'utf8').toString('base64url'); }
function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(decoded) || decoded < 0) throw new SentinelError('INVALID_INPUT', 'Invalid pagination cursor');
  return decoded;
}
function boundedLimit(limit: number | undefined, max: number): number {
  const value = limit ?? DEFAULT_SESSION_QUERY_PAGE_SIZE;
  if (!Number.isInteger(value) || value <= 0) throw new SentinelError('INVALID_INPUT', 'limit must be a positive integer');
  return Math.min(value, max);
}

interface SessionRow {
  tenant_id: string; sentinel_session_id: string; input_json: string; started_at: string; updated_at: string; status: SessionStatus;
  observation_sequence: number; tool_call_count: number; network_request_count: number; process_spawn_count: number; session_cost: number; last_heartbeat_at: string | null;
  state_version: number;
}
function rowToSession(row: SessionRow): SentinelSession {
  const input = JSON.parse(row.input_json) as SentinelSessionInput;
  return {
    ...input, sentinel_session_id: row.sentinel_session_id, started_at: row.started_at, updated_at: row.updated_at, status: row.status,
    observation_sequence: row.observation_sequence, tool_call_count: row.tool_call_count, network_request_count: row.network_request_count,
    process_spawn_count: row.process_spawn_count, session_cost: row.session_cost, last_heartbeat_at: row.last_heartbeat_at,
  };
}

// ---------------------------------------------------------------------------------------------
// Concurrency-safe status reconciliation (concurrency closure pass, see
// docs/sentinel/sentinel-v0.1-concurrency-closure.md). The core invariant: a decision computed
// against a stale snapshot must never overwrite a stronger containment outcome already committed
// for the same session. `nextStatusForDecision` (sentinel-engine) already encodes the two rules that
// matter here — TERMINATE always wins regardless of current status, and HELD is sticky against
// anything but TERMINATE — so reconciliation only needs to ensure that rule runs against the
// session's *fresh, lock-protected* durable status, never a snapshot read earlier in the call.
// ---------------------------------------------------------------------------------------------

/** Relative severity for labeling a transition APPLIED vs ESCALATED (audit/evidence only — it does
 * not gate whether a transition is allowed; `nextStatusForDecision` + the two short-circuits below
 * already do that). */
const STATUS_TIER: Readonly<Record<SessionStatus, number>> = {
  CREATED: 0, MONITORING: 0, WARNED: 1, HELD: 2, TERMINATING: 3, TERMINATED: 4, COMPLETED: 4, INDETERMINATE: 4,
};

/**
 * Given the session's *fresh* durable status and a computed decision type, determines the status to
 * persist and why. Two cases short-circuit to a guaranteed no-op before `nextStatusForDecision` is
 * even consulted, because no decision — however severe — may act on a session that is already past
 * the point this evaluation can affect:
 *   - already terminal (TERMINATED/COMPLETED/INDETERMINATE): nothing can ever leave a terminal status.
 *   - already TERMINATING: another evaluation's containment call for this exact termination is either
 *     still in flight or has already resolved; a second evaluation must never re-claim it (that would
 *     both risk a duplicate destructive containment call and risk resolving over the first claim's
 *     own eventual TERMINATED/INDETERMINATE write).
 * Otherwise, the fresh status is fed through the existing, already-correct `nextStatusForDecision`
 * (TERMINATE always escalates; HELD is sticky against anything but TERMINATE).
 */
function reconcileDecisionTarget(freshStatus: SessionStatus, decisionType: SentinelDecisionType): { target: SessionStatus; kind: TransitionResult } {
  if (isTerminalStatus(freshStatus) || freshStatus === 'TERMINATING') return { target: freshStatus, kind: 'NO_OP_ALREADY_STRONGER' };
  const target = nextStatusForDecision(freshStatus, decisionType);
  if (target === freshStatus) return { target, kind: 'APPLIED' };
  return { target, kind: STATUS_TIER[target] > STATUS_TIER[freshStatus] ? 'ESCALATED' : 'APPLIED' };
}

interface ClaimResult { readonly kind: TransitionResult; readonly claimedStatus: SessionStatus; readonly priorFreshStatus: SessionStatus }

/**
 * Durable local store plus the trusted orchestration facade (section 6, 53). Owns: session identity
 * and lifecycle, runtime-owned sequencing/counters/clock, the observation processing pipeline
 * (section 54), containment invocation, emergency stop state, and Sentinel's own behavioral policy
 * (distinct from — and unaware of — any tenant's Gate authorization envelope).
 */
export class SentinelRuntime {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly containment: ContainmentController;
  private readonly revalidator: AuthorityRevalidator | undefined;

  public constructor(path: string, options: { clock?: () => number; containment?: ContainmentController; revalidator?: AuthorityRevalidator } = {}) {
    this.clock = options.clock ?? Date.now;
    this.containment = options.containment ?? new FakeContainmentController(this.clock);
    this.revalidator = options.revalidator;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=8000;
      CREATE TABLE IF NOT EXISTS sentinel_sessions (
        tenant_id TEXT NOT NULL, sentinel_session_id TEXT NOT NULL, agent_id TEXT NOT NULL, input_json TEXT NOT NULL,
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL,
        observation_sequence INTEGER NOT NULL DEFAULT 0, tool_call_count INTEGER NOT NULL DEFAULT 0,
        network_request_count INTEGER NOT NULL DEFAULT 0, process_spawn_count INTEGER NOT NULL DEFAULT 0,
        session_cost REAL NOT NULL DEFAULT 0, last_heartbeat_at TEXT,
        state_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, sentinel_session_id)
      );
      CREATE INDEX IF NOT EXISTS sentinel_sessions_agent ON sentinel_sessions(tenant_id, agent_id);
      CREATE TABLE IF NOT EXISTS sentinel_observations (
        tenant_id TEXT NOT NULL, sentinel_session_id TEXT NOT NULL, sequence INTEGER NOT NULL, observation_id TEXT NOT NULL,
        input_json TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, sentinel_session_id, sequence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS sentinel_observations_id ON sentinel_observations(tenant_id, sentinel_session_id, observation_id);
      CREATE TABLE IF NOT EXISTS sentinel_decisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, sentinel_session_id TEXT NOT NULL,
        decision_id TEXT NOT NULL, decision_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sentinel_decisions_session ON sentinel_decisions(tenant_id, sentinel_session_id, seq);
      CREATE TABLE IF NOT EXISTS sentinel_violations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, sentinel_session_id TEXT NOT NULL,
        violation_id TEXT NOT NULL, violation_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sentinel_violations_session ON sentinel_violations(tenant_id, sentinel_session_id, seq);
      CREATE TABLE IF NOT EXISTS sentinel_stops (
        tenant_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_value TEXT NOT NULL, active INTEGER NOT NULL,
        reason TEXT NOT NULL, activated_by TEXT NOT NULL, activated_at TEXT NOT NULL, released_by TEXT, released_at TEXT,
        PRIMARY KEY (tenant_id, scope_type, scope_value)
      );
      CREATE TABLE IF NOT EXISTS sentinel_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, policy_json TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
      );
    `);
    // Defensive migration for a pre-existing v0.1 database created before the concurrency closure
    // pass added state_version (CREATE TABLE IF NOT EXISTS does not add columns to an existing table).
    const columns = this.db.prepare('PRAGMA table_info(sentinel_sessions)').all() as unknown as { name: string }[];
    if (!columns.some(c => c.name === 'state_version')) {
      this.db.exec('ALTER TABLE sentinel_sessions ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0');
    }
  }

  // --- Sessions ------------------------------------------------------------------------------

  public createSession(principal: SentinelPrincipal, rawInput: unknown): SentinelSession {
    assertCanControl(principal);
    const input = validateSessionInput(rawInput);
    assertTenant(principal, input.tenant_id);
    const now = new Date(this.clock()).toISOString();
    const sessionId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO sentinel_sessions (tenant_id, sentinel_session_id, agent_id, input_json, started_at, updated_at, status) VALUES (?,?,?,?,?,?,'MONITORING')`)
        .run(input.tenant_id, sessionId, input.agent_id, JSON.stringify(input), now, now);
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
    return this.loadSession(input.tenant_id, sessionId);
  }

  public getSession(principal: SentinelPrincipal, sessionId: string): SentinelSession {
    assertCanRead(principal);
    return this.loadSession(principal.tenantId, sessionId);
  }

  private loadSession(tenantId: string, sessionId: string): SentinelSession {
    const row = this.db.prepare('SELECT * FROM sentinel_sessions WHERE tenant_id = ? AND sentinel_session_id = ?').get(tenantId, sessionId) as unknown as SessionRow | undefined;
    if (!row) throw new SentinelError('NOT_FOUND', `No session ${sessionId}`);
    return rowToSession(row);
  }

  private saveSession(session: SentinelSession): void {
    this.db.prepare(`UPDATE sentinel_sessions SET input_json = ?, updated_at = ?, status = ?, observation_sequence = ?, tool_call_count = ?, network_request_count = ?, process_spawn_count = ?, session_cost = ?, last_heartbeat_at = ? WHERE tenant_id = ? AND sentinel_session_id = ?`)
      .run(JSON.stringify(stripRuntimeFields(session)), session.updated_at, session.status, session.observation_sequence, session.tool_call_count, session.network_request_count, session.process_spawn_count, session.session_cost, session.last_heartbeat_at, session.tenant_id, session.sentinel_session_id);
  }

  // --- Observations (section 9-14, 54) --------------------------------------------------------

  public async submitObservation(principal: SentinelPrincipal, sessionId: string, rawInput: unknown): Promise<{ observation: SentinelObservation; decision: SentinelDecision | null }> {
    const input = validateObservationInput(rawInput);
    assertCanObserve(principal, input.observation_type);
    assertTenant(principal, input.tenant_id);
    if (input.sentinel_session_id !== sessionId) throw new SentinelError('INVALID_INPUT', 'sentinel_session_id in the body must match the URL');

    this.db.exec('BEGIN IMMEDIATE');
    let observation: SentinelObservation;
    try {
      const session = this.loadSessionForUpdate(input.tenant_id, sessionId);
      if (isTerminalStatus(session.status)) throw new SentinelError('SESSION_TERMINAL', `Session ${sessionId} is in a terminal state (${session.status})`);

      const existing = this.db.prepare('SELECT * FROM sentinel_observations WHERE tenant_id = ? AND sentinel_session_id = ? AND observation_id = ?').get(input.tenant_id, sessionId, input.observation_id) as unknown as { input_json: string; sequence: number; received_at: string } | undefined;
      if (existing) {
        const existingInput = JSON.parse(existing.input_json) as SentinelObservationInputStored;
        if (JSON.stringify(existingInput) !== JSON.stringify(input)) throw new SentinelError('OBSERVATION_CONFLICT', `observation_id ${input.observation_id} already exists with different content`);
        this.db.exec('COMMIT');
        return { observation: { ...input, sequence: existing.sequence, received_at: existing.received_at }, decision: null };
      }

      const sequence = session.observation_sequence + 1;
      const receivedAt = new Date(this.clock()).toISOString();
      this.db.prepare('INSERT INTO sentinel_observations (tenant_id, sentinel_session_id, sequence, observation_id, input_json, received_at) VALUES (?,?,?,?,?,?)')
        .run(input.tenant_id, sessionId, sequence, input.observation_id, JSON.stringify(input), receivedAt);
      observation = { ...input, sequence, received_at: receivedAt };

      const updatedCounters = applyCounters(session, observation);
      updatedCounters.observation_sequence = sequence;
      updatedCounters.updated_at = receivedAt;
      this.saveSession(updatedCounters);
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }

    // Authority revalidation and containment are inherently async; the transactional write above
    // already committed, so this runs the (possibly async) evaluation phase afterward — see section
    // 54's documented boundary: containment cannot be rolled back with the SQLite write it follows.
    const decision = await this.runEvaluation(principal.tenantId, sessionId, observation);
    return { observation, decision };
  }

  private loadSessionForUpdate(tenantId: string, sessionId: string): SentinelSession { return this.loadSession(tenantId, sessionId); }

  // --- Evaluation (section 65-66) ---------------------------------------------------------------

  /** Manual/periodic recheck (section 65): authority, policy, clock, heartbeat, budget, active-stop
   * checks with no specific triggering observation. */
  public async evaluateSession(principal: SentinelPrincipal, sessionId: string): Promise<SentinelDecision> {
    assertCanRead(principal);
    const decision = await this.runEvaluation(principal.tenantId, sessionId, undefined);
    if (!decision) throw new SentinelError('SESSION_TERMINAL', `Session ${sessionId} is in a terminal state and cannot be evaluated further`);
    return decision;
  }

  private async runEvaluation(tenantId: string, sessionId: string, observation: SentinelObservation | undefined): Promise<SentinelDecision | null> {
    const session = this.loadSession(tenantId, sessionId);
    if (isTerminalStatus(session.status)) return null;
    const policy = this.requireActivePolicy(tenantId);
    // A trusted source's own *_RECHECK observation is authoritative for this cycle (sections 10-12);
    // only fall back to the live revalidator when no such observation triggered this evaluation.
    const authorityStatus = observation && RECHECK_OBSERVATION_TYPES.has(observation.observation_type)
      ? authorityStatusFromObservation(observation)
      : this.revalidator ? await this.revalidator.validate(session) : undefined;
    const emergencyStopActive = this.isStopped(tenantId, session.agent_id, sessionId);
    const now = this.clock();
    const outcome = evaluateSession({ session, policy, now, ...(observation !== undefined ? { observation } : {}), ...(authorityStatus !== undefined ? { authorityStatus } : {}), emergencyStopActive });
    return this.applyOutcome(session, outcome);
  }

  private requireActivePolicy(tenantId: string): SentinelPolicy {
    const row = this.db.prepare('SELECT policy_json FROM sentinel_policies WHERE tenant_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1').get(tenantId) as unknown as { policy_json: string } | undefined;
    if (!row) throw new SentinelError('NOT_FOUND', `No active Sentinel policy for tenant ${tenantId}`);
    return JSON.parse(row.policy_json) as SentinelPolicy;
  }

  /**
   * Atomically reconciles a computed decision's target status against the session's *fresh* durable
   * status and, if the transition is real (not a no-op), claims it with a CAS write — all inside one
   * exclusive transaction, so the read-decide-write sequence is fully serialized against every other
   * caller of this method (and of `resolveClaim`/`resume`/`completeSession` below), across processes
   * sharing the same SQLite file (WAL + `BEGIN IMMEDIATE` + `busy_timeout`), not merely within one
   * JS event loop. This is the fix for the concurrency-closure finding: the session's status is never
   * again written from a stale in-memory snapshot.
   */
  private reconcileAndClaim(tenantId: string, sessionId: string, decisionType: SentinelDecisionType): ClaimResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status, state_version FROM sentinel_sessions WHERE tenant_id = ? AND sentinel_session_id = ?').get(tenantId, sessionId) as unknown as { status: SessionStatus; state_version: number } | undefined;
      if (!row) { this.db.exec('ROLLBACK'); throw new SentinelError('NOT_FOUND', `No session ${sessionId}`); }
      const { target, kind } = reconcileDecisionTarget(row.status, decisionType);
      if (target === row.status) { this.db.exec('COMMIT'); return { kind, claimedStatus: row.status, priorFreshStatus: row.status }; }
      const now = new Date(this.clock()).toISOString();
      const result = this.db.prepare('UPDATE sentinel_sessions SET status = ?, state_version = state_version + 1, updated_at = ? WHERE tenant_id = ? AND sentinel_session_id = ? AND state_version = ?')
        .run(target, now, tenantId, sessionId, row.state_version);
      // Unreachable under this method's own exclusive lock (no other writer can have moved
      // state_version between the SELECT and this UPDATE); kept as a defensive, honestly-reported
      // failure rather than a silently swallowed one (never fabricate an applied transition).
      if (Number(result.changes) !== 1) { this.db.exec('ROLLBACK'); throw new SentinelError('INVALID_TRANSITION', `Concurrent modification detected for session ${sessionId}`); }
      this.db.exec('COMMIT');
      return { kind, claimedStatus: target, priorFreshStatus: row.status };
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
  }

  /** Resolves a claimed TERMINATING status to its confirmed outcome. Re-reads fresh state first: if
   * this session is no longer TERMINATING (already resolved — by this same call's own earlier claim,
   * there being only one legal path in), the resolution is a no-op rather than an overwrite. */
  private resolveClaim(tenantId: string, sessionId: string, target: 'TERMINATED' | 'INDETERMINATE'): SessionStatus {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status, state_version FROM sentinel_sessions WHERE tenant_id = ? AND sentinel_session_id = ?').get(tenantId, sessionId) as unknown as { status: SessionStatus; state_version: number } | undefined;
      if (!row) { this.db.exec('ROLLBACK'); throw new SentinelError('NOT_FOUND', `No session ${sessionId}`); }
      if (row.status !== 'TERMINATING') { this.db.exec('COMMIT'); return row.status; }
      const now = new Date(this.clock()).toISOString();
      this.db.prepare('UPDATE sentinel_sessions SET status = ?, state_version = state_version + 1, updated_at = ? WHERE tenant_id = ? AND sentinel_session_id = ? AND state_version = ?')
        .run(target, now, tenantId, sessionId, row.state_version);
      this.db.exec('COMMIT');
      return target;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
  }

  private persistDecisionAndViolations(tenantId: string, sessionId: string, decision: SentinelDecision, violations: readonly Violation[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO sentinel_decisions (tenant_id, sentinel_session_id, decision_id, decision_json) VALUES (?,?,?,?)').run(tenantId, sessionId, decision.decision_id, JSON.stringify(decision));
      for (const violation of violations) this.db.prepare('INSERT INTO sentinel_violations (tenant_id, sentinel_session_id, violation_id, violation_json) VALUES (?,?,?,?)').run(tenantId, sessionId, violation.violation_id, JSON.stringify(violation));
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
  }

  /**
   * Persists a decision/violations, transitions the session, and resolves containment — never
   * reporting a stop as confirmed unless the containment call itself did not throw (sections 55-56).
   *
   * The `session` parameter is deliberately not trusted for the status transition: it may be stale by
   * the time this runs (evaluation itself can take time, and containment calls are async). The target
   * status is instead derived fresh, atomically, via `reconcileAndClaim` — see that method and
   * `docs/sentinel/sentinel-v0.1-concurrency-closure.md` for the invariant this restores: a weaker,
   * stale decision can never overwrite a stronger containment outcome already committed or in flight
   * for the same session, and containment is never invoked for a decision the fresh state has already
   * been superseded by (NO_OP_ALREADY_STRONGER skips the real hold()/terminate() call entirely).
   */
  private async applyOutcome(session: SentinelSession, outcome: { decision: SentinelDecision; violations: readonly Violation[]; nextStatus: SessionStatus }): Promise<SentinelDecision> {
    const tenantId = session.tenant_id;
    const sessionId = session.sentinel_session_id;
    const decisionType = outcome.decision.decision;

    const claim = this.reconcileAndClaim(tenantId, sessionId, decisionType);
    let decision: SentinelDecision = { ...outcome.decision, transition_result: claim.kind };

    if (claim.kind === 'NO_OP_ALREADY_STRONGER') {
      decision = { ...decision, containment_status: 'NOT_REQUIRED' };
      this.persistDecisionAndViolations(tenantId, sessionId, decision, outcome.violations);
      return decision;
    }

    const reason: ContainmentReason = { message: decision.violations[0]?.message ?? 'Sentinel decision', decision_id: decision.decision_id, ...(decision.violations[0] ? { rule_type: decision.violations[0].rule_type } : {}) };

    if (claim.claimedStatus === 'HELD' && claim.priorFreshStatus !== 'HELD') {
      // Newly entering HELD under this evaluation's own claim — invoke containment exactly once.
      try { await this.containment.hold(sessionId, reason); decision = { ...decision, containment_status: 'CONTAINMENT_CONFIRMED' }; }
      catch { decision = { ...decision, containment_status: 'CONTAINMENT_UNCONFIRMED' }; }
    } else if (claim.claimedStatus === 'TERMINATING') {
      // reconcileDecisionTarget's TERMINATING short-circuit guarantees only the evaluation that wins
      // this exact claim ever reaches here for this termination — never a duplicate real call.
      try {
        await this.containment.terminate(sessionId, reason);
        decision = { ...decision, containment_status: 'CONTAINMENT_CONFIRMED' };
        this.resolveClaim(tenantId, sessionId, 'TERMINATED');
      } catch {
        decision = { ...decision, containment_status: 'CONTAINMENT_UNCONFIRMED' };
        this.resolveClaim(tenantId, sessionId, 'INDETERMINATE');
      }
    } else {
      // Ordinary bookkeeping transition (e.g. MONITORING -> WARNED -> MONITORING, or an already-HELD
      // session receiving another HOLD-resolving violation) — no containment action required.
      decision = { ...decision, containment_status: 'NOT_REQUIRED' };
    }

    this.persistDecisionAndViolations(tenantId, sessionId, decision, outcome.violations);
    return decision;
  }

  // --- Explicit containment / lifecycle (sections 44-51) --------------------------------------

  /**
   * A stale leading read is deliberately not trusted for the terminal-state check any more (it used
   * to return early on `session.status === 'HELD'`/terminal from the object loaded here, which could
   * itself already be stale by the time it was read). `applyOutcome` now re-derives the true target
   * from a fresh, lock-protected read regardless of what this snapshot says, and the final
   * `loadSession` below always reflects reality — a concurrently-terminated session correctly comes
   * back TERMINATED even if this method's own manual HOLD lost the race.
   */
  public async hold(principal: SentinelPrincipal, sessionId: string, message: string): Promise<SentinelSession> {
    assertCanControl(principal);
    const session = this.loadSession(principal.tenantId, sessionId);
    const { decision, violations } = manualDecision(session, 'HOLD', message, this.clock());
    await this.applyOutcome(session, { decision, violations, nextStatus: 'HELD' });
    return this.loadSession(principal.tenantId, sessionId);
  }

  public async terminate(principal: SentinelPrincipal, sessionId: string, message: string): Promise<SentinelSession> {
    assertCanControl(principal);
    const session = this.loadSession(principal.tenantId, sessionId);
    const { decision, violations } = manualDecision(session, 'TERMINATE', message, this.clock());
    // Idempotent (section 47): applyOutcome's NO_OP_ALREADY_STRONGER path covers an already-terminal
    // session without a special case here — no duplicate containment call, decision still recorded.
    await this.applyOutcome(session, { decision, violations, nextStatus: 'TERMINATING' });
    return this.loadSession(principal.tenantId, sessionId);
  }

  /**
   * Section 49: only a trusted controller/admin may resume a HELD session — never the agent itself.
   * Concurrency closure: whether the session is truly resumable is decided from a fresh read taken
   * *inside* the same exclusive transaction as the write, not from `loadSession`'s earlier snapshot —
   * so a session that has since moved to TERMINATING/TERMINATED/INDETERMINATE (a race against a
   * concurrent containment escalation) correctly fails to resume instead of silently succeeding on
   * stale information.
   */
  public resume(principal: SentinelPrincipal, sessionId: string, input: { rationale: string; policySnapshotHash?: string; authorityExpiry?: string }): SentinelSession {
    assertCanControl(principal);
    const tenantId = principal.tenantId;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM sentinel_sessions WHERE tenant_id = ? AND sentinel_session_id = ?').get(tenantId, sessionId) as unknown as SessionRow | undefined;
      if (!row) { this.db.exec('ROLLBACK'); throw new SentinelError('NOT_FOUND', `No session ${sessionId}`); }
      if (row.status !== 'HELD') { this.db.exec('ROLLBACK'); throw new SentinelError('INVALID_TRANSITION', `Only a HELD session may be resumed (current status: ${row.status})`); }
      const fresh = rowToSession(row);
      const now = new Date(this.clock()).toISOString();
      const rebound: SentinelSession = {
        ...fresh, status: 'MONITORING', updated_at: now,
        ...(input.policySnapshotHash !== undefined ? { policy_snapshot_hash: input.policySnapshotHash } : {}),
        ...(input.authorityExpiry !== undefined ? { authority_expiry: input.authorityExpiry } : {}),
      };
      const result = this.db.prepare(`UPDATE sentinel_sessions SET input_json = ?, updated_at = ?, status = 'MONITORING', state_version = state_version + 1 WHERE tenant_id = ? AND sentinel_session_id = ? AND state_version = ?`)
        .run(JSON.stringify(stripRuntimeFields(rebound)), now, tenantId, sessionId, row.state_version);
      if (Number(result.changes) !== 1) { this.db.exec('ROLLBACK'); throw new SentinelError('INVALID_TRANSITION', `Concurrent modification detected for session ${sessionId}`); }
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
    return this.loadSession(tenantId, sessionId);
  }

  /** Concurrency closure: same fresh-read-inside-the-lock discipline as `resume()` — a session that
   * has concurrently moved off MONITORING/WARNED (e.g. into HELD or TERMINATING) correctly fails to
   * complete instead of overwriting that outcome with COMPLETED. */
  public completeSession(principal: SentinelPrincipal, sessionId: string): SentinelSession {
    assertCanControl(principal);
    const tenantId = principal.tenantId;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status, state_version FROM sentinel_sessions WHERE tenant_id = ? AND sentinel_session_id = ?').get(tenantId, sessionId) as unknown as { status: SessionStatus; state_version: number } | undefined;
      if (!row) { this.db.exec('ROLLBACK'); throw new SentinelError('NOT_FOUND', `No session ${sessionId}`); }
      if (row.status !== 'MONITORING' && row.status !== 'WARNED') { this.db.exec('ROLLBACK'); throw new SentinelError('INVALID_TRANSITION', `Only a monitoring session may complete (current status: ${row.status})`); }
      const now = new Date(this.clock()).toISOString();
      const result = this.db.prepare(`UPDATE sentinel_sessions SET status = 'COMPLETED', state_version = state_version + 1, updated_at = ? WHERE tenant_id = ? AND sentinel_session_id = ? AND state_version = ?`)
        .run(now, tenantId, sessionId, row.state_version);
      if (Number(result.changes) !== 1) { this.db.exec('ROLLBACK'); throw new SentinelError('INVALID_TRANSITION', `Concurrent modification detected for session ${sessionId}`); }
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
    return this.loadSession(tenantId, sessionId);
  }

  // --- Emergency stop (sections 50-52) ---------------------------------------------------------

  public activateStop(principal: SentinelPrincipal, scopeType: StopScopeType, scopeValue: string, reason: string): EmergencyStop {
    assertIsAdmin(principal);
    const now = new Date(this.clock()).toISOString();
    this.db.prepare(`INSERT INTO sentinel_stops (tenant_id, scope_type, scope_value, active, reason, activated_by, activated_at, released_by, released_at) VALUES (?,?,?,1,?,?,?,NULL,NULL)
      ON CONFLICT(tenant_id, scope_type, scope_value) DO UPDATE SET active = 1, reason = excluded.reason, activated_by = excluded.activated_by, activated_at = excluded.activated_at, released_by = NULL, released_at = NULL`)
      .run(principal.tenantId, scopeType, scopeValue, reason, principal.id, now);
    return this.loadStop(principal.tenantId, scopeType, scopeValue);
  }
  public releaseStop(principal: SentinelPrincipal, scopeType: StopScopeType, scopeValue: string): EmergencyStop {
    assertIsAdmin(principal);
    const now = new Date(this.clock()).toISOString();
    this.db.prepare('UPDATE sentinel_stops SET active = 0, released_by = ?, released_at = ? WHERE tenant_id = ? AND scope_type = ? AND scope_value = ?').run(principal.id, now, principal.tenantId, scopeType, scopeValue);
    return this.loadStop(principal.tenantId, scopeType, scopeValue);
  }
  public listStops(principal: SentinelPrincipal): EmergencyStop[] {
    assertCanRead(principal);
    return (this.db.prepare('SELECT * FROM sentinel_stops WHERE tenant_id = ? ORDER BY activated_at').all(principal.tenantId) as unknown as StopRow[]).map(rowToStop);
  }
  private loadStop(tenantId: string, scopeType: StopScopeType, scopeValue: string): EmergencyStop {
    const row = this.db.prepare('SELECT * FROM sentinel_stops WHERE tenant_id = ? AND scope_type = ? AND scope_value = ?').get(tenantId, scopeType, scopeValue) as unknown as StopRow | undefined;
    if (!row) throw new SentinelError('NOT_FOUND', 'No such emergency stop scope');
    return rowToStop(row);
  }
  private isStopped(tenantId: string, agentId: string, sessionId: string): boolean {
    const rows = this.db.prepare('SELECT scope_type, scope_value FROM sentinel_stops WHERE tenant_id = ? AND active = 1').all(tenantId) as unknown as { scope_type: StopScopeType; scope_value: string }[];
    return rows.some(row => (row.scope_type === 'tenant') || (row.scope_type === 'agent' && row.scope_value === agentId) || (row.scope_type === 'session' && row.scope_value === sessionId));
  }

  // --- Policy (sections 15-17, 71-73) -----------------------------------------------------------

  public setPolicy(principal: SentinelPrincipal, rawInput: unknown): SentinelPolicy {
    assertIsAdmin(principal);
    const input = validatePolicyInput(rawInput);
    assertTenant(principal, input.tenant_id);
    const policy = finalizePolicy(input, this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE sentinel_policies SET is_active = 0 WHERE tenant_id = ? AND is_active = 1').run(input.tenant_id);
      this.db.prepare('INSERT INTO sentinel_policies (tenant_id, policy_json, is_active) VALUES (?,?,1)').run(input.tenant_id, JSON.stringify(policy));
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
    return policy;
  }
  public getActivePolicy(principal: SentinelPrincipal): SentinelPolicy { assertCanRead(principal); return this.requireActivePolicy(principal.tenantId); }
  /** Installs the safe v0.1 demo/default policy for a tenant (section 73) — convenience for demos and tests. */
  public installDefaultPolicy(principal: SentinelPrincipal): SentinelPolicy { return this.setPolicy(principal, defaultDemoPolicyInput(principal.tenantId)); }

  // --- Queries (sections 84-85) ------------------------------------------------------------------

  public listViolations(principal: SentinelPrincipal, sessionId: string, limit?: number, cursor?: string): Page<Violation> {
    assertCanRead(principal);
    this.loadSession(principal.tenantId, sessionId); // 404s / tenant-isolates before paging
    const boundedLimitValue = boundedLimit(limit, Math.min(MAX_SESSION_QUERY_PAGE_SIZE, MAX_VIOLATIONS_PER_RESPONSE));
    const offset = decodeCursor(cursor);
    const rows = this.db.prepare('SELECT violation_json FROM sentinel_violations WHERE tenant_id = ? AND sentinel_session_id = ? ORDER BY seq LIMIT ? OFFSET ?').all(principal.tenantId, sessionId, boundedLimitValue + 1, offset) as unknown as { violation_json: string }[];
    const truncated = rows.length > boundedLimitValue;
    const items = (truncated ? rows.slice(0, boundedLimitValue) : rows).map(row => JSON.parse(row.violation_json) as Violation);
    return { items, nextCursor: truncated ? encodeCursor(offset + boundedLimitValue) : null };
  }
  public listDecisions(principal: SentinelPrincipal, sessionId: string, limit?: number, cursor?: string): Page<SentinelDecision> {
    assertCanRead(principal);
    this.loadSession(principal.tenantId, sessionId);
    const boundedLimitValue = boundedLimit(limit, Math.min(MAX_SESSION_QUERY_PAGE_SIZE, MAX_DECISIONS_PER_RESPONSE));
    const offset = decodeCursor(cursor);
    const rows = this.db.prepare('SELECT decision_json FROM sentinel_decisions WHERE tenant_id = ? AND sentinel_session_id = ? ORDER BY seq LIMIT ? OFFSET ?').all(principal.tenantId, sessionId, boundedLimitValue + 1, offset) as unknown as { decision_json: string }[];
    const truncated = rows.length > boundedLimitValue;
    const items = (truncated ? rows.slice(0, boundedLimitValue) : rows).map(row => JSON.parse(row.decision_json) as SentinelDecision);
    return { items, nextCursor: truncated ? encodeCursor(offset + boundedLimitValue) : null };
  }

  public close(): void { this.db.close(); }
}

interface StopRow { tenant_id: string; scope_type: StopScopeType; scope_value: string; active: number; reason: string; activated_by: string; activated_at: string; released_by: string | null; released_at: string | null }
function rowToStop(row: StopRow): EmergencyStop { return { tenant_id: row.tenant_id, scope_type: row.scope_type, scope_value: row.scope_value, active: row.active === 1, reason: row.reason, activated_by: row.activated_by, activated_at: row.activated_at, released_by: row.released_by, released_at: row.released_at }; }

type SentinelObservationInputStored = Omit<SentinelObservation, 'sequence' | 'received_at'>;
function stripRuntimeFields(session: SentinelSession): SentinelSessionInput {
  const { sentinel_session_id: _id, started_at: _s, updated_at: _u, status: _st, observation_sequence: _seq, tool_call_count: _tc, network_request_count: _nrc, process_spawn_count: _psc, session_cost: _sc, last_heartbeat_at: _lh, ...input } = session;
  void _id; void _s; void _u; void _st; void _seq; void _tc; void _nrc; void _psc; void _sc; void _lh;
  return input;
}
function applyCounters(session: SentinelSession, observation: SentinelObservation): SentinelSession {
  const next: SentinelSession = { ...session };
  if (observation.observation_type === 'TOOL_CALL_REQUESTED') next.tool_call_count += 1;
  if (observation.observation_type === 'NETWORK_REQUEST') next.network_request_count += 1;
  if (observation.observation_type === 'PROCESS_STARTED') next.process_spawn_count += 1;
  if (observation.observation_type === 'EXECUTION_HEARTBEAT') next.last_heartbeat_at = observation.received_at;
  if (observation.observation_type === 'COST_REPORTED') {
    const raw = observation.payload?.cost_usd;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) next.session_cost = round6(next.session_cost + raw);
    // NaN/Infinity/negative increments are silently dropped from the aggregate (section 32) — the
    // caller submitted a structurally valid observation (schema validation already ran), but a
    // non-finite or negative cost increment is never trusted into the runtime-owned aggregate.
  }
  return next;
}
function round6(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }

const RECHECK_OBSERVATION_TYPES = new Set(['AUTHORITY_RECHECK', 'POLICY_RECHECK', 'REVOCATION_RECHECK']);
const AUTHORITY_STATUS_KIND_SET = new Set<string>(AUTHORITY_STATUSES);
/** Derives an AuthorityStatus from a trusted source's own recheck observation (sections 10-12, 19-21).
 * An observation with no recognizable `result` field cannot assert a status and fails safe to UNKNOWN. */
function authorityStatusFromObservation(observation: SentinelObservation): AuthorityStatus {
  const payload = observation.payload ?? {};
  const resultRaw = payload.result;
  const status: AuthorityStatusKind = typeof resultRaw === 'string' && AUTHORITY_STATUS_KIND_SET.has(resultRaw) ? resultRaw as AuthorityStatusKind : 'UNKNOWN';
  const scopeRaw = payload.scope;
  const revokedScope: RevokedScope | undefined = scopeRaw === 'approval' ? 'approval' : scopeRaw === 'agent' ? 'agent' : undefined;
  const currentPolicyHash = typeof payload.current_policy_hash === 'string' ? payload.current_policy_hash : undefined;
  return { status, ...(revokedScope !== undefined ? { revokedScope } : {}), ...(currentPolicyHash !== undefined ? { currentPolicyHash } : {}) };
}
/** Builds the decision record for an explicit controller-initiated hold/terminate (sections 44, 48) —
 * distinct from a rule-triggered decision: `triggered_rules` stays empty, but the operator's stated
 * reason is preserved as a single MANUAL_CONTROL violation so the evidence trail never loses it. */
function manualDecision(session: SentinelSession, decision: 'HOLD' | 'TERMINATE', message: string, now: number): { decision: SentinelDecision; violations: Violation[] } {
  const violationId = randomUUID();
  const violation: Violation = {
    violation_id: violationId, rule_id: 'manual-control', rule_type: 'MANUAL_CONTROL', severity: decision === 'TERMINATE' ? 'HIGH' : 'MEDIUM',
    observed_at: new Date(now).toISOString(), observation_id: null, sentinel_session_id: session.sentinel_session_id,
    message_code: 'SENTINEL_MANUAL_CONTROL', message, evidence: {}, prevention_status: 'DETECTED_AFTER_EFFECT',
  };
  const decisionRecord: SentinelDecision = {
    decision_id: randomUUID(), sentinel_session_id: session.sentinel_session_id, timestamp: new Date(now).toISOString(), decision,
    triggered_rules: [], violations: [violation], risk_score: SEVERITY_SCORE[violation.severity], policy_hash: session.policy_snapshot_hash,
    authority_snapshot_hash: session.authority_snapshot_hash, containment_status: 'CONTAINMENT_REQUESTED',
    // Overwritten by applyOutcome's fresh reconciliation before persistence, same as evaluateSession's decisions.
    transition_result: 'APPLIED',
  };
  return { decision: decisionRecord, violations: [violation] };
}
