import { DatabaseSync } from 'node:sqlite';
import {
  ImprovementError, canonical, newGenerationId, newSystemId, newExpansionRequestId,
  newPromotionDecisionId, newCanaryRunId, newRollbackRecordId, readPageOptions, canTransition,
  type GenerationState, type ImprovementClass, type ImprovementGeneration, type AuthorityCeiling,
  type AuthorityDelta, type AuthorityExpansionRequest, type AuthorityExpansionStatus, type PromotionDecision,
  type RecursionBudget, type RecursionLimits, type CanaryRun, type CanaryStatus, type RollbackRecord,
  type RollbackStatus, type RollbackTrigger, type Page,
} from '../../improvement-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12). Durable SQLite store for the improvement
 * control plane — generations, specs, recursion budgets, authority expansion requests, promotion
 * decisions, canary runs, and rollback records. Follows the same discipline as `packages/client-core`:
 * every race-sensitive record uses a `state_version` compare-and-swap, and every read/write method that
 * takes a `tenantId` never returns another tenant's row (section 93) — there is no "unscoped by id"
 * lookup method anywhere in this class.
 */

export interface ImprovementSystem {
  readonly system_id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly accepted_generation_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly state_version: number;
}

interface SystemRow { system_id: string; tenant_id: string; name: string; accepted_generation_id: string | null; created_by: string; created_at: string; state_version: number }
function rowToSystem(row: SystemRow): ImprovementSystem {
  return { system_id: row.system_id, tenant_id: row.tenant_id, name: row.name, accepted_generation_id: row.accepted_generation_id, created_by: row.created_by, created_at: row.created_at, state_version: row.state_version };
}

interface GenerationRow {
  generation_id: string; tenant_id: string; system_id: string; parent_generation_id: string | null; root_generation_id: string;
  generation_number: number; candidate_version: string; status: string; improvement_class: string; spec_hash: string;
  source_hash_before: string; source_hash_after: string | null; authority_profile_before_json: string;
  authority_profile_after_json: string | null; authority_delta_json: string | null; created_by: string; created_at: string; state_version: number;
}
function rowToGeneration(row: GenerationRow): ImprovementGeneration {
  return {
    generation_id: row.generation_id, tenant_id: row.tenant_id, system_id: row.system_id,
    parent_generation_id: row.parent_generation_id, root_generation_id: row.root_generation_id,
    generation_number: row.generation_number, candidate_version: row.candidate_version, status: row.status as GenerationState,
    improvement_class: row.improvement_class as ImprovementClass, spec_hash: row.spec_hash,
    source_hash_before: row.source_hash_before, source_hash_after: row.source_hash_after,
    authority_profile_before: JSON.parse(row.authority_profile_before_json) as AuthorityCeiling,
    authority_profile_after: row.authority_profile_after_json ? JSON.parse(row.authority_profile_after_json) as AuthorityCeiling : null,
    authority_delta: row.authority_delta_json ? JSON.parse(row.authority_delta_json) as AuthorityDelta : null,
    created_by: row.created_by, created_at: row.created_at, state_version: row.state_version,
  };
}

interface ExpansionRow {
  request_id: string; generation_id: string; tenant_id: string; requested_delta_json: string; reason: string; risk: string;
  requested_by: string; status: string; approved_by: string | null; decision_reason: string | null; created_at: string; decided_at: string | null; state_version: number;
}
function rowToExpansion(row: ExpansionRow): AuthorityExpansionRequest {
  return {
    request_id: row.request_id, generation_id: row.generation_id, tenant_id: row.tenant_id,
    requested_delta: JSON.parse(row.requested_delta_json) as AuthorityDelta, reason: row.reason,
    risk: row.risk as AuthorityExpansionRequest['risk'], requested_by: row.requested_by, status: row.status as AuthorityExpansionStatus,
    approved_by: row.approved_by, decision_reason: row.decision_reason, created_at: row.created_at, decided_at: row.decided_at, state_version: row.state_version,
  };
}

interface BudgetRow {
  system_id: string; tenant_id: string; limits_json: string; generation_count: number; attempt_count: number;
  runtime_used_ms: number; cost_used_usd: number; tool_calls_used: number; mutation_size_used_bytes: number; state_version: number;
}
function rowToBudget(row: BudgetRow): RecursionBudget {
  return {
    system_id: row.system_id, tenant_id: row.tenant_id, limits: JSON.parse(row.limits_json) as RecursionLimits,
    generation_count: row.generation_count, attempt_count: row.attempt_count, runtime_used_ms: row.runtime_used_ms,
    cost_used_usd: row.cost_used_usd, tool_calls_used: row.tool_calls_used, mutation_size_used_bytes: row.mutation_size_used_bytes,
    state_version: row.state_version,
  };
}

interface CanaryRow {
  canary_id: string; generation_id: string; policy_hash: string; status: string; actions_executed: number;
  failures_observed: number; sentinel_terminations: number; cost_incurred_usd: number; started_at: string; ended_at: string | null; state_version: number;
}
function rowToCanary(row: CanaryRow): CanaryRun {
  return {
    canary_id: row.canary_id, generation_id: row.generation_id, policy_hash: row.policy_hash, status: row.status as CanaryStatus,
    actions_executed: row.actions_executed, failures_observed: row.failures_observed, sentinel_terminations: row.sentinel_terminations,
    cost_incurred_usd: row.cost_incurred_usd, started_at: row.started_at, ended_at: row.ended_at, state_version: row.state_version,
  };
}

interface RollbackRow {
  rollback_id: string; generation_id: string; rollback_target_generation_id: string; trigger: string; status: string;
  evidence_ref: string | null; initiated_by: string; initiated_at: string; completed_at: string | null;
}
function rowToRollback(row: RollbackRow): RollbackRecord {
  return {
    rollback_id: row.rollback_id, generation_id: row.generation_id, rollback_target_generation_id: row.rollback_target_generation_id,
    trigger: row.trigger as RollbackTrigger | 'MANUAL', status: row.status as RollbackStatus, evidence_ref: row.evidence_ref,
    initiated_by: row.initiated_by, initiated_at: row.initiated_at, completed_at: row.completed_at,
  };
}

export interface GenerationLineage {
  readonly generation_id: string;
  readonly ancestors: readonly ImprovementGeneration[]; // root-first, nearest-parent-last
  readonly descendants: readonly ImprovementGeneration[]; // any order
}

export class ImprovementStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  public constructor(path: string, options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=8000;
      CREATE TABLE IF NOT EXISTS improvement_systems (
        system_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
        accepted_generation_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, state_version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS improvement_systems_tenant ON improvement_systems(tenant_id);
      CREATE TABLE IF NOT EXISTS improvement_generations (
        generation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, system_id TEXT NOT NULL,
        parent_generation_id TEXT, root_generation_id TEXT NOT NULL, generation_number INTEGER NOT NULL,
        candidate_version TEXT NOT NULL, status TEXT NOT NULL, improvement_class TEXT NOT NULL, spec_hash TEXT NOT NULL,
        source_hash_before TEXT NOT NULL, source_hash_after TEXT, authority_profile_before_json TEXT NOT NULL,
        authority_profile_after_json TEXT, authority_delta_json TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        state_version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS improvement_generations_tenant_system ON improvement_generations(tenant_id, system_id);
      CREATE INDEX IF NOT EXISTS improvement_generations_parent ON improvement_generations(parent_generation_id);
      CREATE TABLE IF NOT EXISTS improvement_specs (
        spec_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, tenant_id TEXT NOT NULL, spec_json TEXT NOT NULL,
        spec_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS improvement_specs_generation ON improvement_specs(generation_id);
      CREATE TABLE IF NOT EXISTS recursion_budgets (
        system_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, limits_json TEXT NOT NULL, generation_count INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL, runtime_used_ms INTEGER NOT NULL, cost_used_usd REAL NOT NULL,
        tool_calls_used INTEGER NOT NULL, mutation_size_used_bytes INTEGER NOT NULL, state_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS authority_expansion_requests (
        request_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, tenant_id TEXT NOT NULL, requested_delta_json TEXT NOT NULL,
        reason TEXT NOT NULL, risk TEXT NOT NULL, requested_by TEXT NOT NULL, status TEXT NOT NULL, approved_by TEXT,
        decision_reason TEXT, created_at TEXT NOT NULL, decided_at TEXT, state_version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS authority_expansion_requests_generation ON authority_expansion_requests(generation_id);
      CREATE TABLE IF NOT EXISTS promotion_decisions (
        decision_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, tenant_id TEXT NOT NULL, parent_generation_id TEXT,
        evaluation_profile_hash TEXT NOT NULL, spec_hash TEXT NOT NULL, source_hash TEXT NOT NULL,
        benchmark_summary_hash TEXT NOT NULL, security_summary_hash TEXT NOT NULL, capability_delta_hash TEXT NOT NULL,
        authority_delta_hash TEXT, decision TEXT NOT NULL, decision_reason TEXT NOT NULL, decided_by TEXT NOT NULL, decided_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS promotion_decisions_generation ON promotion_decisions(generation_id, decided_at);
      CREATE TABLE IF NOT EXISTS canary_runs (
        canary_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, tenant_id TEXT NOT NULL, policy_hash TEXT NOT NULL,
        status TEXT NOT NULL, actions_executed INTEGER NOT NULL, failures_observed INTEGER NOT NULL,
        sentinel_terminations INTEGER NOT NULL, cost_incurred_usd REAL NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        state_version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS canary_runs_generation ON canary_runs(generation_id);
      CREATE TABLE IF NOT EXISTS rollback_records (
        rollback_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, tenant_id TEXT NOT NULL, rollback_target_generation_id TEXT NOT NULL,
        trigger TEXT NOT NULL, status TEXT NOT NULL, evidence_ref TEXT, initiated_by TEXT NOT NULL, initiated_at TEXT NOT NULL, completed_at TEXT);
      CREATE INDEX IF NOT EXISTS rollback_records_generation ON rollback_records(generation_id);
    `);
  }
  public close(): void { this.db.close(); }
  private now(): string { return new Date(this.clock()).toISOString(); }
  private tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* not open */ } throw error; } }

  // -----------------------------------------------------------------------------------------
  // Systems
  // -----------------------------------------------------------------------------------------

  public createSystem(tenantId: string, name: string, createdBy: string): ImprovementSystem {
    const systemId = newSystemId();
    const now = this.now();
    this.db.prepare('INSERT INTO improvement_systems VALUES (?,?,?,?,?,?,?)').run(systemId, tenantId, name, null, createdBy, now, 0);
    return this.getSystem(tenantId, systemId);
  }
  public getSystem(tenantId: string, systemId: string): ImprovementSystem {
    const row = this.db.prepare('SELECT * FROM improvement_systems WHERE tenant_id=? AND system_id=?').get(tenantId, systemId) as unknown as SystemRow | undefined;
    if (!row) throw new ImprovementError('NOT_FOUND', `No system ${systemId} for tenant ${tenantId}`);
    return rowToSystem(row);
  }
  /** `system_id` is always runtime-minted (`newSystemId()`) — a caller-chosen identifier is a `name`,
   * looked up here rather than confused with the internal id. Used by callers (e.g. the governor's
   * `POST /v1/improvements`) that want "find-or-create by my own chosen system name" semantics without
   * accidentally minting a fresh, disconnected system on every call. */
  public findSystemByName(tenantId: string, name: string): ImprovementSystem | null {
    const row = this.db.prepare('SELECT * FROM improvement_systems WHERE tenant_id=? AND name=?').get(tenantId, name) as unknown as SystemRow | undefined;
    return row ? rowToSystem(row) : null;
  }
  private setAcceptedGeneration(tenantId: string, systemId: string, generationId: string): void {
    const changed = this.db.prepare('UPDATE improvement_systems SET accepted_generation_id=?, state_version=state_version+1 WHERE tenant_id=? AND system_id=?')
      .run(generationId, tenantId, systemId);
    if (changed.changes !== 1) throw new ImprovementError('NOT_FOUND', `No system ${systemId} for tenant ${tenantId}`);
  }

  // -----------------------------------------------------------------------------------------
  // Generations — section 5-6, 90-93.
  // -----------------------------------------------------------------------------------------

  /** Section 91: rejects a nonexistent parent, a cross-tenant parent, and a self-parent. Section 92: a
   * generation is a freshly-minted id whose only possible parent already existed before this call, so a
   * true cycle cannot arise through this method alone — `getLineage`'s ancestor walk still carries an
   * explicit cycle guard as defense in depth (tested directly against a hand-crafted pathological row
   * set in `tests/improvement/lineage.test.ts`, since a legitimate insert path cannot produce one). */
  public createGeneration(input: {
    readonly tenantId: string; readonly systemId: string; readonly parentGenerationId: string | null;
    readonly candidateVersion: string; readonly improvementClass: ImprovementClass; readonly specHash: string;
    readonly sourceHashBefore: string; readonly authorityProfileBefore: AuthorityCeiling; readonly createdBy: string;
  }): ImprovementGeneration {
    return this.tx(() => {
      let rootGenerationId: string;
      let generationNumber: number;
      if (input.parentGenerationId === null) {
        rootGenerationId = ''; // filled in after mint, see below
        generationNumber = 0;
      } else {
        const parent = this.getGenerationRow(input.tenantId, input.parentGenerationId);
        if (!parent) throw new ImprovementError('NOT_FOUND', `Parent generation ${input.parentGenerationId} not found for tenant ${input.tenantId}`);
        rootGenerationId = parent.root_generation_id;
        generationNumber = parent.generation_number + 1;
      }
      const generationId = newGenerationId();
      if (input.parentGenerationId === generationId) throw new ImprovementError('INVALID_INPUT', 'A generation cannot be its own parent');
      if (rootGenerationId === '') rootGenerationId = generationId;
      const now = this.now();
      this.db.prepare('INSERT INTO improvement_generations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        generationId, input.tenantId, input.systemId, input.parentGenerationId, rootGenerationId, generationNumber,
        input.candidateVersion, 'PROPOSED', input.improvementClass, input.specHash, input.sourceHashBefore, null,
        JSON.stringify(input.authorityProfileBefore), null, null, input.createdBy, now, 0,
      );
      return this.getGeneration(input.tenantId, generationId);
    });
  }

  private getGenerationRow(tenantId: string, generationId: string): GenerationRow | undefined {
    return this.db.prepare('SELECT * FROM improvement_generations WHERE tenant_id=? AND generation_id=?').get(tenantId, generationId) as unknown as GenerationRow | undefined;
  }
  public getGeneration(tenantId: string, generationId: string): ImprovementGeneration {
    const row = this.getGenerationRow(tenantId, generationId);
    if (!row) throw new ImprovementError('NOT_FOUND', `No generation ${generationId} for tenant ${tenantId}`);
    return rowToGeneration(row);
  }
  public listGenerations(tenantId: string, systemId: string, options: { limit?: number; cursor?: string } = {}): Page<ImprovementGeneration> {
    const limit = readPageOptions(options.limit);
    const offset = options.cursor ? Number(Buffer.from(options.cursor, 'base64url').toString('utf8')) : 0;
    const rows = this.db.prepare('SELECT * FROM improvement_generations WHERE tenant_id=? AND system_id=? ORDER BY created_at, generation_id LIMIT ? OFFSET ?')
      .all(tenantId, systemId, limit + 1, offset) as unknown as GenerationRow[];
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).map(rowToGeneration), ...(hasMore ? { nextCursor: Buffer.from(String(offset + limit)).toString('base64url') } : {}) };
  }

  /** Section 66, 92: reconstructs the full ancestor chain (root-first) and every direct+transitive
   * descendant. The ancestor walk carries an explicit visited-set cycle guard — see the class doc comment
   * above for why a legitimate insert cannot itself create a cycle, and why the guard exists anyway. */
  public getLineage(tenantId: string, generationId: string): GenerationLineage {
    const start = this.getGeneration(tenantId, generationId);
    const ancestors: ImprovementGeneration[] = [];
    const visited = new Set<string>([generationId]);
    let cursor: string | null = start.parent_generation_id;
    while (cursor !== null) {
      if (visited.has(cursor)) throw new ImprovementError('LINEAGE_CYCLE', `Lineage cycle detected while walking ancestors of ${generationId}`);
      visited.add(cursor);
      const row = this.getGenerationRow(tenantId, cursor);
      if (!row) break; // parent id points nowhere resolvable for this tenant — stop, do not throw NOT_FOUND for a lineage read
      const gen = rowToGeneration(row);
      ancestors.unshift(gen);
      cursor = gen.parent_generation_id;
    }
    const descendants: ImprovementGeneration[] = [];
    const frontier = [generationId];
    const descendantVisited = new Set<string>([generationId]);
    while (frontier.length > 0) {
      const current = frontier.pop()!;
      const children = this.db.prepare('SELECT * FROM improvement_generations WHERE tenant_id=? AND parent_generation_id=?').all(tenantId, current) as unknown as GenerationRow[];
      for (const child of children) {
        if (descendantVisited.has(child.generation_id)) throw new ImprovementError('LINEAGE_CYCLE', `Lineage cycle detected while walking descendants of ${generationId}`);
        descendantVisited.add(child.generation_id);
        descendants.push(rowToGeneration(child));
        frontier.push(child.generation_id);
      }
    }
    return { generation_id: generationId, ancestors, descendants };
  }

  /** Section 6: enforces the deterministic state machine (`canTransition`) — an illegal transition is a
   * CONFLICT, never silently coerced. Section 60-61: transitioning a generation to PROMOTED atomically
   * also updates the owning system's `accepted_generation_id` in the same transaction. */
  public transitionGeneration(tenantId: string, generationId: string, expectedVersion: number, to: GenerationState, extra?: { readonly sourceHashAfter?: string; readonly authorityProfileAfter?: AuthorityCeiling; readonly authorityDelta?: AuthorityDelta }): ImprovementGeneration {
    return this.tx(() => {
      const current = this.getGeneration(tenantId, generationId);
      if (current.state_version !== expectedVersion) throw new ImprovementError('CONFLICT', 'Generation state has changed — retry with the current version');
      if (!canTransition(current.status, to)) throw new ImprovementError('CONFLICT', `Illegal transition ${current.status} -> ${to}`);
      const sourceHashAfter = extra?.sourceHashAfter ?? current.source_hash_after;
      const authorityAfter = extra?.authorityProfileAfter ?? current.authority_profile_after;
      const authorityDelta = extra?.authorityDelta ?? current.authority_delta;
      const changed = this.db.prepare(`UPDATE improvement_generations SET status=?, source_hash_after=?, authority_profile_after_json=?, authority_delta_json=?, state_version=state_version+1
        WHERE tenant_id=? AND generation_id=? AND state_version=?`).run(
        to, sourceHashAfter ?? null, authorityAfter ? JSON.stringify(authorityAfter) : null, authorityDelta ? JSON.stringify(authorityDelta) : null,
        tenantId, generationId, expectedVersion,
      );
      if (changed.changes !== 1) throw new ImprovementError('CONFLICT', 'Generation state changed concurrently');
      if (to === 'PROMOTED') this.setAcceptedGeneration(tenantId, current.system_id, generationId);
      return this.getGeneration(tenantId, generationId);
    });
  }

  // -----------------------------------------------------------------------------------------
  // Specs — persisted once, immutable (section 8), keyed by the generation that owns them.
  // -----------------------------------------------------------------------------------------

  public saveSpec(tenantId: string, generationId: string, specId: string, spec: unknown, specHash: string): void {
    const existing = this.db.prepare('SELECT spec_hash FROM improvement_specs WHERE spec_id=?').get(specId) as { spec_hash: string } | undefined;
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ImprovementError('SPEC_IMMUTABLE', `Spec ${specId} already exists with a different hash — specs are immutable once saved`);
      return;
    }
    this.db.prepare('INSERT INTO improvement_specs VALUES (?,?,?,?,?,?)').run(specId, generationId, tenantId, canonical(spec), specHash, this.now());
  }
  public getSpec<T>(tenantId: string, specId: string): T {
    const row = this.db.prepare('SELECT spec_json FROM improvement_specs WHERE tenant_id=? AND spec_id=?').get(tenantId, specId) as { spec_json: string } | undefined;
    if (!row) throw new ImprovementError('NOT_FOUND', `No spec ${specId} for tenant ${tenantId}`);
    return JSON.parse(row.spec_json) as T;
  }

  // -----------------------------------------------------------------------------------------
  // Recursion budget — section 28-31: runtime-owned counters, hard stop.
  // -----------------------------------------------------------------------------------------

  public getOrCreateRecursionBudget(tenantId: string, systemId: string, limits: RecursionLimits): RecursionBudget {
    const existing = this.db.prepare('SELECT * FROM recursion_budgets WHERE tenant_id=? AND system_id=?').get(tenantId, systemId) as unknown as BudgetRow | undefined;
    if (existing) return rowToBudget(existing);
    this.db.prepare('INSERT INTO recursion_budgets VALUES (?,?,?,?,?,?,?,?,?,?)').run(systemId, tenantId, JSON.stringify(limits), 0, 0, 0, 0, 0, 0, 0);
    return this.getRecursionBudget(tenantId, systemId);
  }
  public getRecursionBudget(tenantId: string, systemId: string): RecursionBudget {
    const row = this.db.prepare('SELECT * FROM recursion_budgets WHERE tenant_id=? AND system_id=?').get(tenantId, systemId) as unknown as BudgetRow | undefined;
    if (!row) throw new ImprovementError('NOT_FOUND', `No recursion budget for system ${systemId}`);
    return rowToBudget(row);
  }
  /** Section 29-31: the ONLY write path for budget consumption — always an authoritative runtime-side
   * increment by real, just-measured amounts, never a caller-asserted absolute value. CAS-protected. */
  public consumeRecursionBudget(tenantId: string, systemId: string, expectedVersion: number, deltas: { readonly generations?: number; readonly attempts?: number; readonly runtimeMs?: number; readonly costUsd?: number; readonly toolCalls?: number; readonly mutationBytes?: number }): RecursionBudget {
    const changed = this.db.prepare(`UPDATE recursion_budgets SET
        generation_count=generation_count+?, attempt_count=attempt_count+?, runtime_used_ms=runtime_used_ms+?,
        cost_used_usd=cost_used_usd+?, tool_calls_used=tool_calls_used+?, mutation_size_used_bytes=mutation_size_used_bytes+?,
        state_version=state_version+1
        WHERE tenant_id=? AND system_id=? AND state_version=?`).run(
      deltas.generations ?? 0, deltas.attempts ?? 0, deltas.runtimeMs ?? 0, deltas.costUsd ?? 0, deltas.toolCalls ?? 0, deltas.mutationBytes ?? 0,
      tenantId, systemId, expectedVersion,
    );
    if (changed.changes !== 1) throw new ImprovementError('CONFLICT', 'Recursion budget changed concurrently');
    return this.getRecursionBudget(tenantId, systemId);
  }

  // -----------------------------------------------------------------------------------------
  // Authority expansion requests — section 14, 52: never effective from self-assertion alone.
  // -----------------------------------------------------------------------------------------

  public createAuthorityExpansionRequest(input: { readonly tenantId: string; readonly generationId: string; readonly requestedDelta: AuthorityDelta; readonly reason: string; readonly risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; readonly requestedBy: string }): AuthorityExpansionRequest {
    const requestId = newExpansionRequestId();
    const now = this.now();
    this.db.prepare('INSERT INTO authority_expansion_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      requestId, input.generationId, input.tenantId, JSON.stringify(input.requestedDelta), input.reason, input.risk,
      input.requestedBy, 'PENDING', null, null, now, null, 0,
    );
    return this.getAuthorityExpansionRequest(input.tenantId, requestId);
  }
  public getAuthorityExpansionRequest(tenantId: string, requestId: string): AuthorityExpansionRequest {
    const row = this.db.prepare('SELECT * FROM authority_expansion_requests WHERE tenant_id=? AND request_id=?').get(tenantId, requestId) as unknown as ExpansionRow | undefined;
    if (!row) throw new ImprovementError('NOT_FOUND', `No authority expansion request ${requestId} for tenant ${tenantId}`);
    return rowToExpansion(row);
  }
  /** Section 14, 52-54: the ONLY way a `PENDING` request becomes `APPROVED`/`REJECTED` — always requires
   * an external `approvedBy` actor distinct from candidate self-assertion; the caller (governor
   * orchestration) is responsible for enforcing separation of duties (section 54) before calling this. */
  public decideAuthorityExpansionRequest(tenantId: string, requestId: string, expectedVersion: number, decision: 'APPROVED' | 'REJECTED', approvedBy: string, decisionReason: string): AuthorityExpansionRequest {
    const changed = this.db.prepare(`UPDATE authority_expansion_requests SET status=?, approved_by=?, decision_reason=?, decided_at=?, state_version=state_version+1
      WHERE tenant_id=? AND request_id=? AND state_version=? AND status='PENDING'`).run(
      decision, approvedBy, decisionReason, this.now(), tenantId, requestId, expectedVersion,
    );
    if (changed.changes !== 1) throw new ImprovementError('CONFLICT', 'Authority expansion request already decided or changed concurrently');
    return this.getAuthorityExpansionRequest(tenantId, requestId);
  }

  // -----------------------------------------------------------------------------------------
  // Promotion decisions — append-only (section 67, 74): never overwritten, never deleted.
  // -----------------------------------------------------------------------------------------

  public recordPromotionDecision(tenantId: string, decision: Omit<PromotionDecision, 'decision_id'>): PromotionDecision {
    const decisionId = newPromotionDecisionId();
    this.db.prepare('INSERT INTO promotion_decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      decisionId, decision.generation_id, tenantId, decision.parent_generation_id, decision.evaluation_profile_hash,
      decision.spec_hash, decision.source_hash, decision.benchmark_summary_hash, decision.security_summary_hash,
      decision.capability_delta_hash, decision.authority_delta_hash, decision.decision, decision.decision_reason,
      decision.decided_by, decision.decided_at,
    );
    return { ...decision, decision_id: decisionId };
  }
  public listPromotionDecisions(tenantId: string, generationId: string): readonly PromotionDecision[] {
    const rows = this.db.prepare('SELECT * FROM promotion_decisions WHERE tenant_id=? AND generation_id=? ORDER BY decided_at').all(tenantId, generationId) as unknown as (Omit<PromotionDecision, 'authority_delta_hash'> & { authority_delta_hash: string | null })[];
    return rows.map(r => ({ ...r, authority_delta_hash: r.authority_delta_hash }));
  }

  // -----------------------------------------------------------------------------------------
  // Canary runs — section 55-59.
  // -----------------------------------------------------------------------------------------

  public startCanaryRun(tenantId: string, generationId: string, policyHash: string): CanaryRun {
    const canaryId = newCanaryRunId();
    this.db.prepare('INSERT INTO canary_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(canaryId, generationId, tenantId, policyHash, 'RUNNING', 0, 0, 0, 0, this.now(), null, 0);
    return this.getCanaryRun(tenantId, canaryId);
  }
  public getCanaryRun(tenantId: string, canaryId: string): CanaryRun {
    const row = this.db.prepare('SELECT * FROM canary_runs WHERE tenant_id=? AND canary_id=?').get(tenantId, canaryId) as unknown as CanaryRow | undefined;
    if (!row) throw new ImprovementError('NOT_FOUND', `No canary run ${canaryId} for tenant ${tenantId}`);
    return rowToCanary(row);
  }
  public recordCanaryObservation(tenantId: string, canaryId: string, expectedVersion: number, delta: { readonly actions?: number; readonly failures?: number; readonly sentinelTerminations?: number; readonly costUsd?: number }): CanaryRun {
    const changed = this.db.prepare(`UPDATE canary_runs SET actions_executed=actions_executed+?, failures_observed=failures_observed+?,
        sentinel_terminations=sentinel_terminations+?, cost_incurred_usd=cost_incurred_usd+?, state_version=state_version+1
        WHERE tenant_id=? AND canary_id=? AND state_version=? AND status='RUNNING'`).run(
      delta.actions ?? 0, delta.failures ?? 0, delta.sentinelTerminations ?? 0, delta.costUsd ?? 0, tenantId, canaryId, expectedVersion,
    );
    if (changed.changes !== 1) throw new ImprovementError('CONFLICT', 'Canary run already ended or changed concurrently');
    return this.getCanaryRun(tenantId, canaryId);
  }
  /** Section 129: a late, weaker observation must never overwrite a stronger terminal state — enforced
   * here by only allowing this transition while `status='RUNNING'`; once FAILED/PASSED/INDETERMINATE is
   * written, a further call is a CONFLICT, not a silent overwrite. */
  public endCanaryRun(tenantId: string, canaryId: string, expectedVersion: number, status: Exclude<CanaryStatus, 'RUNNING'>): CanaryRun {
    const changed = this.db.prepare(`UPDATE canary_runs SET status=?, ended_at=?, state_version=state_version+1
      WHERE tenant_id=? AND canary_id=? AND state_version=? AND status='RUNNING'`).run(status, this.now(), tenantId, canaryId, expectedVersion);
    if (changed.changes !== 1) throw new ImprovementError('CONFLICT', 'Canary run already ended or changed concurrently');
    return this.getCanaryRun(tenantId, canaryId);
  }

  // -----------------------------------------------------------------------------------------
  // Rollback records — section 62-65, 67: never deleted, uncertainty is INDETERMINATE not a guess.
  // -----------------------------------------------------------------------------------------

  public initiateRollback(tenantId: string, generationId: string, rollbackTargetGenerationId: string, trigger: RollbackTrigger | 'MANUAL', initiatedBy: string): RollbackRecord {
    // Section 93: both the generation being rolled back AND its target must genuinely belong to
    // `tenantId` — `getGeneration` throws NOT_FOUND (never a cross-tenant row) for either otherwise.
    this.getGeneration(tenantId, generationId);
    this.getGeneration(tenantId, rollbackTargetGenerationId);
    const rollbackId = newRollbackRecordId();
    this.db.prepare('INSERT INTO rollback_records VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      rollbackId, generationId, tenantId, rollbackTargetGenerationId, trigger, 'INDETERMINATE', null, initiatedBy, this.now(), null,
    );
    return this.getRollback(tenantId, rollbackId);
  }
  public getRollback(tenantId: string, rollbackId: string): RollbackRecord {
    const row = this.db.prepare('SELECT * FROM rollback_records WHERE tenant_id=? AND rollback_id=?').get(tenantId, rollbackId) as unknown as RollbackRow | undefined;
    if (!row) throw new ImprovementError('NOT_FOUND', `No rollback record ${rollbackId} for tenant ${tenantId}`);
    return rowToRollback(row);
  }
  public completeRollback(tenantId: string, rollbackId: string, status: Exclude<RollbackStatus, never>, evidenceRef: string | null): RollbackRecord {
    const changed = this.db.prepare(`UPDATE rollback_records SET status=?, evidence_ref=?, completed_at=?
      WHERE tenant_id=? AND rollback_id=? AND status='INDETERMINATE'`).run(status, evidenceRef, this.now(), tenantId, rollbackId);
    if (changed.changes !== 1) throw new ImprovementError('CONFLICT', 'Rollback record already completed or not found');
    return this.getRollback(tenantId, rollbackId);
  }
  public listRollbacks(tenantId: string, generationId: string): readonly RollbackRecord[] {
    return (this.db.prepare('SELECT * FROM rollback_records WHERE tenant_id=? AND generation_id=? ORDER BY initiated_at').all(tenantId, generationId) as unknown as RollbackRow[]).map(rowToRollback);
  }
}

