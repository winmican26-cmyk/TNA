import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  AuditorError, MAX_QUERY_PAGE_SIZE, DEFAULT_QUERY_PAGE_SIZE, MAX_FINDINGS_PER_RESPONSE,
  validateAssessmentSpecInput, computeSpecHash, hash, findSecretShapedField,
  type AssessmentSpec, type AssessmentSpecInput, type AssessmentStatus, type AssessmentOutcome,
  type ControlResult, type AuditFinding, type EvidenceRef, type ControlProfileId,
} from '../../auditor-schema/src/index.js';
import {
  getControlsForProfile, evaluateControl, effectiveCriticality, CONTROL_CATALOG_VERSION, EVALUATOR_VERSION,
  type Control, type EvaluationContext,
} from '../../auditor-controls/src/index.js';
import {
  type EvidenceProvider, type EvidenceBundle, type ControlImplementationManifest, eventRef, verifyManifestIntegrity, buildAcceptedBaselineManifest,
} from '../../auditor-evidence/src/index.js';
import { computeRiskSummary, computeOutcome, compareFindingPriority, type RiskSummary, type ScoredControlResult } from '../../auditor-risk/src/index.js';

export { AuditorError };
export type {
  AssessmentSpec, AssessmentSpecInput, AssessmentStatus, AssessmentOutcome, ControlResult, AuditFinding,
  EvidenceRef, RiskSummary, EvidenceBundle, ControlImplementationManifest, Control,
};

// ---------------------------------------------------------------------------------------------
// Principal / role model (sections 50-52). No governed agent is ever issued runner/admin identity
// — same discipline as Ledger's writer model and Sentinel's observer/controller/admin model.
// ---------------------------------------------------------------------------------------------

export type AuditorRole = 'reader' | 'runner' | 'admin';
export interface AuditorPrincipal { readonly id: string; readonly role: AuditorRole; readonly tenantId: string }
export function readerPrincipal(id: string, tenantId: string): AuditorPrincipal { return { id, role: 'reader', tenantId }; }
export function runnerPrincipal(id: string, tenantId: string): AuditorPrincipal { return { id, role: 'runner', tenantId }; }
export function adminPrincipal(id: string, tenantId: string): AuditorPrincipal { return { id, role: 'admin', tenantId }; }

function assertCanRead(p: AuditorPrincipal): void { if (!['reader', 'runner', 'admin'].includes(p.role)) throw new AuditorError('FORBIDDEN', `Principal ${p.id} does not hold read authority`); }
function assertCanRun(p: AuditorPrincipal): void { if (p.role !== 'runner' && p.role !== 'admin') throw new AuditorError('FORBIDDEN', `Principal ${p.id} does not hold run authority`); }
function assertIsAdmin(p: AuditorPrincipal): void { if (p.role !== 'admin') throw new AuditorError('FORBIDDEN', `Principal ${p.id} does not hold admin authority`); }
function assertTenant(p: AuditorPrincipal, tenantId: string): void { if (p.tenantId !== tenantId) throw new AuditorError('FORBIDDEN', `Principal ${p.id} is not authorized for tenant ${tenantId}`); }

// ---------------------------------------------------------------------------------------------
// Pagination (duplicated pattern from the accepted Ledger/Sentinel runtimes)
// ---------------------------------------------------------------------------------------------

export interface Page<T> { readonly items: T[]; readonly nextCursor: string | null }
function encodeCursor(offset: number): string { return Buffer.from(String(offset), 'utf8').toString('base64url'); }
function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(decoded) || decoded < 0) throw new AuditorError('INVALID_INPUT', 'Invalid pagination cursor');
  return decoded;
}
function boundedLimit(limit: number | undefined, max: number): number {
  const value = limit ?? DEFAULT_QUERY_PAGE_SIZE;
  if (!Number.isInteger(value) || value <= 0) throw new AuditorError('INVALID_INPUT', 'limit must be a positive integer');
  return Math.min(value, max);
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export interface AssessmentRecord extends AssessmentSpec {
  readonly status: AssessmentStatus;
  readonly updated_at: string;
  readonly latest_run_number: number;
  readonly outcome: AssessmentOutcome | null;
  readonly risk_summary: RiskSummary | null;
  readonly assessment_hash: string | null;
  readonly control_catalog_version: string | null;
}

export interface RunRecord {
  readonly assessment_id: string;
  readonly run_number: number;
  readonly status: AssessmentStatus;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly outcome: AssessmentOutcome | null;
  readonly risk_summary: RiskSummary | null;
  readonly assessment_hash: string | null;
  readonly control_catalog_version: string;
  readonly evaluator_version: string;
  readonly evidence_cutoff_at: string;
  readonly is_replay: boolean;
  readonly replay_of_run_number: number | null;
  readonly catalog_version_mismatch: boolean;
}

interface AssessmentRow {
  tenant_id: string; assessment_id: string; spec_json: string; created_at: string; created_by: string; spec_hash: string;
  status: AssessmentStatus; updated_at: string; latest_run_number: number;
  outcome: AssessmentOutcome | null; risk_summary_json: string | null; assessment_hash: string | null; control_catalog_version: string | null;
  state_version: number;
}
function rowToAssessment(row: AssessmentRow): AssessmentRecord {
  const spec = JSON.parse(row.spec_json) as AssessmentSpecInput;
  return {
    ...spec, assessment_id: row.assessment_id, created_at: row.created_at, created_by: row.created_by, spec_hash: row.spec_hash,
    status: row.status, updated_at: row.updated_at, latest_run_number: row.latest_run_number,
    outcome: row.outcome, risk_summary: row.risk_summary_json ? JSON.parse(row.risk_summary_json) as RiskSummary : null,
    assessment_hash: row.assessment_hash, control_catalog_version: row.control_catalog_version,
  };
}

interface RunRow {
  assessment_id: string; run_number: number; status: AssessmentStatus; started_at: string; completed_at: string | null;
  outcome: AssessmentOutcome | null; risk_summary_json: string | null; assessment_hash: string | null;
  control_catalog_version: string; evaluator_version: string; evidence_cutoff_at: string;
  evidence_bundle_json: string | null; is_replay: number; replay_of_run_number: number | null;
}
function rowToRun(row: RunRow): RunRecord {
  return {
    assessment_id: row.assessment_id, run_number: row.run_number, status: row.status, started_at: row.started_at, completed_at: row.completed_at,
    outcome: row.outcome, risk_summary: row.risk_summary_json ? JSON.parse(row.risk_summary_json) as RiskSummary : null, assessment_hash: row.assessment_hash,
    control_catalog_version: row.control_catalog_version, evaluator_version: row.evaluator_version, evidence_cutoff_at: row.evidence_cutoff_at,
    is_replay: row.is_replay === 1, replay_of_run_number: row.replay_of_run_number,
    catalog_version_mismatch: row.control_catalog_version !== CONTROL_CATALOG_VERSION,
  };
}

// ---------------------------------------------------------------------------------------------
// Assessment hash (sections 42-43) — the comprehensive, completion-time hash. Distinct from
// AssessmentSpec.spec_hash (creation-time, lightweight). Never includes mutable presentation-only
// fields (e.g. evaluated_at timestamps are part of results and DO feed the hash — deliberately:
// replaying against the identical stored evidence with an identical clock injection reproduces an
// identical hash, which is exactly what the tamper test and replay-determinism tests rely on).
// ---------------------------------------------------------------------------------------------

/**
 * Trust-closure pass, section 14/16: `evidenceRefs` now carries `integrity_qualification` per ref,
 * and `manifestTrustClass` binds the built-in manifest's own provenance classification into the
 * hash directly — so an exported package can never have either silently reclassified (`UNVERIFIED`
 * → `VALID`, `ADMIN_PROVIDED` → `BUILT_IN_ACCEPTED_BASELINE`) without breaking verification. Both
 * were already indirectly covered wherever they appear nested inside `results`' own evidence_refs;
 * this makes the coverage explicit and direct for the package-level summary too.
 */
export function computeAssessmentHash(specHash: string, controlProfileId: ControlProfileId, catalogVersion: string, evidenceCutoffAt: string, evidenceRefs: readonly EvidenceRef[], results: readonly ControlResult[], risk: RiskSummary, manifestTrustClass: string): string {
  const refKey = (r: EvidenceRef): string => r.event_id ?? r.manifest_id ?? r.snapshot_id ?? '';
  const sortedRefs = [...evidenceRefs].sort((a, b) => refKey(a).localeCompare(refKey(b)));
  const sortedResults = [...results].sort((a, b) => a.control_id.localeCompare(b.control_id));
  return hash({ spec_hash: specHash, control_profile_id: controlProfileId, control_catalog_version: catalogVersion, evidence_cutoff_at: evidenceCutoffAt, evidence_manifest: sortedRefs, control_results: sortedResults, risk, manifest_trust_class: manifestTrustClass });
}

// ---------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------

export interface AuditorRuntimeOptions {
  readonly clock?: () => number;
  readonly evidenceProvider: EvidenceProvider;
}

/**
 * Durable local store plus the trusted orchestration facade. Owns: assessment identity and
 * lifecycle, runtime-owned run numbering (never caller-selected — section 62), the evidence
 * collection + control evaluation + atomic finalization pipeline, findings, risk summary, and the
 * implementation-evidence manifest. Applies the TNA-33 concurrency-safety lesson from the Sentinel
 * milestone from the start: every status-changing write is a fresh-read-inside-the-lock compare-
 * and-swap (`state_version`), not a stale unconditional write.
 */
export class AuditorRuntime {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly evidenceProvider: EvidenceProvider;
  /** Trust-closure pass, blocker 2: computed once, internally, by trusted code — never affected by
   * `setManifest`, never overridable, never caller-influenced. This is the *only* manifest control
   * evaluation ever consults automatically (section 10). `setManifest`/`getManifest` operate on a
   * completely separate, `ADMIN_PROVIDED`-classified manifest that is stored for visibility/audit
   * purposes only and is never wired into `EvaluationContext.manifest`. */
  private readonly builtInManifest: ControlImplementationManifest;

  public constructor(path: string, options: AuditorRuntimeOptions) {
    this.clock = options.clock ?? Date.now;
    this.evidenceProvider = options.evidenceProvider;
    this.builtInManifest = buildAcceptedBaselineManifest(this.clock);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=8000;
      CREATE TABLE IF NOT EXISTS auditor_assessments (
        tenant_id TEXT NOT NULL, assessment_id TEXT NOT NULL, spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL, created_by TEXT NOT NULL, spec_hash TEXT NOT NULL,
        status TEXT NOT NULL, updated_at TEXT NOT NULL, latest_run_number INTEGER NOT NULL DEFAULT 0,
        outcome TEXT, risk_summary_json TEXT, assessment_hash TEXT, control_catalog_version TEXT,
        state_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, assessment_id)
      );
      CREATE TABLE IF NOT EXISTS auditor_runs (
        tenant_id TEXT NOT NULL, assessment_id TEXT NOT NULL, run_number INTEGER NOT NULL,
        status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
        outcome TEXT, risk_summary_json TEXT, assessment_hash TEXT,
        control_catalog_version TEXT NOT NULL, evaluator_version TEXT NOT NULL, evidence_cutoff_at TEXT NOT NULL,
        evidence_bundle_json TEXT, is_replay INTEGER NOT NULL DEFAULT 0, replay_of_run_number INTEGER,
        PRIMARY KEY (tenant_id, assessment_id, run_number)
      );
      CREATE TABLE IF NOT EXISTS auditor_control_results (
        tenant_id TEXT NOT NULL, assessment_id TEXT NOT NULL, run_number INTEGER NOT NULL, control_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, assessment_id, run_number, control_id)
      );
      CREATE TABLE IF NOT EXISTS auditor_findings (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, assessment_id TEXT NOT NULL, run_number INTEGER NOT NULL,
        finding_id TEXT NOT NULL, finding_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS auditor_findings_id ON auditor_findings(tenant_id, assessment_id, finding_id);
      CREATE INDEX IF NOT EXISTS auditor_findings_run ON auditor_findings(tenant_id, assessment_id, run_number, seq);
      CREATE TABLE IF NOT EXISTS auditor_manifest (
        id INTEGER PRIMARY KEY AUTOINCREMENT, manifest_json TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
      );
    `);
    // Section 109: an assessment found mid-run at store-open time belongs to a process that never
    // finalized it (this constructor only runs at startup/reopen) — it becomes INDETERMINATE, never
    // silently left claiming to still be in progress or, worse, later mistaken for COMPLETED.
    const now = new Date(this.clock()).toISOString();
    this.db.prepare(`UPDATE auditor_assessments SET status = 'INDETERMINATE', updated_at = ?, state_version = state_version + 1 WHERE status IN ('COLLECTING_EVIDENCE', 'EVALUATING')`).run(now);
    this.db.prepare(`UPDATE auditor_runs SET status = 'INDETERMINATE', completed_at = ? WHERE status IN ('COLLECTING_EVIDENCE', 'EVALUATING')`).run(now);
  }

  // --- Assessments ---------------------------------------------------------------------------

  public createAssessment(principal: AuditorPrincipal, rawInput: unknown): AssessmentRecord {
    assertCanRun(principal);
    const input = validateAssessmentSpecInput(rawInput);
    assertTenant(principal, input.tenant_id);
    const assessmentId = randomUUID();
    const now = new Date(this.clock()).toISOString();
    const specHash = computeSpecHash(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO auditor_assessments (tenant_id, assessment_id, spec_json, created_at, created_by, spec_hash, status, updated_at) VALUES (?,?,?,?,?,?,'CREATED',?)`)
        .run(input.tenant_id, assessmentId, JSON.stringify(input), now, principal.id, specHash, now);
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
    return this.loadAssessment(input.tenant_id, assessmentId);
  }

  public getAssessment(principal: AuditorPrincipal, assessmentId: string): AssessmentRecord {
    assertCanRead(principal);
    return this.loadAssessment(principal.tenantId, assessmentId);
  }

  private loadAssessment(tenantId: string, assessmentId: string): AssessmentRecord {
    const row = this.db.prepare('SELECT * FROM auditor_assessments WHERE tenant_id = ? AND assessment_id = ?').get(tenantId, assessmentId) as unknown as AssessmentRow | undefined;
    if (!row) throw new AuditorError('NOT_FOUND', `No assessment ${assessmentId}`);
    return rowToAssessment(row);
  }

  public listAssessments(principal: AuditorPrincipal, limit?: number, cursor?: string): Page<AssessmentRecord> {
    assertCanRead(principal);
    const boundedLimitValue = boundedLimit(limit, MAX_QUERY_PAGE_SIZE);
    const offset = decodeCursor(cursor);
    const rows = this.db.prepare('SELECT * FROM auditor_assessments WHERE tenant_id = ? ORDER BY created_at, assessment_id LIMIT ? OFFSET ?').all(principal.tenantId, boundedLimitValue + 1, offset) as unknown as AssessmentRow[];
    const truncated = rows.length > boundedLimitValue;
    const items = (truncated ? rows.slice(0, boundedLimitValue) : rows).map(rowToAssessment);
    return { items, nextCursor: truncated ? encodeCursor(offset + boundedLimitValue) : null };
  }

  // --- Run claim (section 62, 105: runtime-owned, CAS-protected run numbering) -----------------

  private claimRun(tenantId: string, assessmentId: string): { runNumber: number; assessment: AssessmentRecord } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM auditor_assessments WHERE tenant_id = ? AND assessment_id = ?').get(tenantId, assessmentId) as unknown as AssessmentRow | undefined;
      if (!row) { this.db.exec('ROLLBACK'); throw new AuditorError('NOT_FOUND', `No assessment ${assessmentId}`); }
      if (row.status === 'COLLECTING_EVIDENCE' || row.status === 'EVALUATING') { this.db.exec('ROLLBACK'); throw new AuditorError('CONFLICT', `Assessment ${assessmentId} already has a run in progress`); }
      const runNumber = row.latest_run_number + 1;
      const now = new Date(this.clock()).toISOString();
      const result = this.db.prepare(`UPDATE auditor_assessments SET status = 'COLLECTING_EVIDENCE', latest_run_number = ?, updated_at = ?, state_version = state_version + 1 WHERE tenant_id = ? AND assessment_id = ? AND state_version = ?`)
        .run(runNumber, now, tenantId, assessmentId, row.state_version);
      if (Number(result.changes) !== 1) { this.db.exec('ROLLBACK'); throw new AuditorError('CONFLICT', `Concurrent run claim detected for assessment ${assessmentId}`); }
      this.db.prepare(`INSERT INTO auditor_runs (tenant_id, assessment_id, run_number, status, started_at, control_catalog_version, evaluator_version, evidence_cutoff_at, is_replay, replay_of_run_number) VALUES (?,?,?,'COLLECTING_EVIDENCE',?,?,?,?,0,NULL)`)
        .run(tenantId, assessmentId, runNumber, now, CONTROL_CATALOG_VERSION, EVALUATOR_VERSION, JSON.parse(row.spec_json).evidence_cutoff_at as string);
      this.db.exec('COMMIT');
      return { runNumber, assessment: rowToAssessment(row) };
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
  }

  private claimReplayRun(tenantId: string, assessmentId: string, replayOf: number): { runNumber: number; assessment: AssessmentRecord } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM auditor_assessments WHERE tenant_id = ? AND assessment_id = ?').get(tenantId, assessmentId) as unknown as AssessmentRow | undefined;
      if (!row) { this.db.exec('ROLLBACK'); throw new AuditorError('NOT_FOUND', `No assessment ${assessmentId}`); }
      if (row.status === 'COLLECTING_EVIDENCE' || row.status === 'EVALUATING') { this.db.exec('ROLLBACK'); throw new AuditorError('CONFLICT', `Assessment ${assessmentId} already has a run in progress`); }
      const runNumber = row.latest_run_number + 1;
      const now = new Date(this.clock()).toISOString();
      const result = this.db.prepare(`UPDATE auditor_assessments SET status = 'EVALUATING', latest_run_number = ?, updated_at = ?, state_version = state_version + 1 WHERE tenant_id = ? AND assessment_id = ? AND state_version = ?`)
        .run(runNumber, now, tenantId, assessmentId, row.state_version);
      if (Number(result.changes) !== 1) { this.db.exec('ROLLBACK'); throw new AuditorError('CONFLICT', `Concurrent run claim detected for assessment ${assessmentId}`); }
      this.db.prepare(`INSERT INTO auditor_runs (tenant_id, assessment_id, run_number, status, started_at, control_catalog_version, evaluator_version, evidence_cutoff_at, is_replay, replay_of_run_number) VALUES (?,?,?,'EVALUATING',?,?,?,?,1,?)`)
        .run(tenantId, assessmentId, runNumber, now, CONTROL_CATALOG_VERSION, EVALUATOR_VERSION, JSON.parse(row.spec_json).evidence_cutoff_at as string, replayOf);
      this.db.exec('COMMIT');
      return { runNumber, assessment: rowToAssessment(row) };
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
  }

  private transitionRun(tenantId: string, assessmentId: string, runNumber: number, status: AssessmentStatus): void {
    const now = new Date(this.clock()).toISOString();
    this.db.prepare('UPDATE auditor_runs SET status = ? WHERE tenant_id = ? AND assessment_id = ? AND run_number = ?').run(status, tenantId, assessmentId, runNumber);
    this.db.prepare('UPDATE auditor_assessments SET status = ?, updated_at = ? WHERE tenant_id = ? AND assessment_id = ?').run(status, now, tenantId, assessmentId);
  }

  /** Section 106, 64: evidence collection or evaluation failing never leaves COMPLETED behind. */
  private finalizeAsIncomplete(tenantId: string, assessmentId: string, runNumber: number, status: 'FAILED' | 'INDETERMINATE'): RunRecord {
    const now = new Date(this.clock()).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE auditor_runs SET status = ?, completed_at = ? WHERE tenant_id = ? AND assessment_id = ? AND run_number = ?').run(status, now, tenantId, assessmentId, runNumber);
      this.db.prepare('UPDATE auditor_assessments SET status = ?, updated_at = ? WHERE tenant_id = ? AND assessment_id = ?').run(status, now, tenantId, assessmentId);
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
    return this.loadRun(tenantId, assessmentId, runNumber);
  }

  // --- Run (section 57-59, 64-68) --------------------------------------------------------------

  public async runAssessment(principal: AuditorPrincipal, assessmentId: string): Promise<RunRecord> {
    assertCanRun(principal);
    const tenantId = principal.tenantId;
    const { runNumber, assessment } = this.claimRun(tenantId, assessmentId);
    let bundle: EvidenceBundle;
    try {
      bundle = await this.evidenceProvider.collect({ tenant_id: tenantId, scope: assessment.scope, evidence_cutoff_at: assessment.evidence_cutoff_at });
    } catch {
      return this.finalizeAsIncomplete(tenantId, assessmentId, runNumber, 'INDETERMINATE');
    }
    this.transitionRun(tenantId, assessmentId, runNumber, 'EVALUATING');
    try {
      return this.evaluateAndFinalize(tenantId, assessmentId, runNumber, assessment, bundle, false, null);
    } catch {
      return this.finalizeAsIncomplete(tenantId, assessmentId, runNumber, 'FAILED');
    }
  }

  /** Section 39: replay reuses the *stored* evidence snapshot from a prior run rather than
   * re-collecting — the whole point is reproducibility against a fixed evidence snapshot, not a
   * fresh assessment cycle (that is what `runAssessment` is for). Flags a catalog-version mismatch
   * explicitly rather than silently re-interpreting history under newer rules (section 40). */
  public replayAssessment(principal: AuditorPrincipal, assessmentId: string, options: { runNumber?: number } = {}): RunRecord {
    assertCanRun(principal);
    const tenantId = principal.tenantId;
    const assessment = this.loadAssessment(tenantId, assessmentId);
    const sourceRunNumber = options.runNumber ?? assessment.latest_run_number;
    if (sourceRunNumber < 1) throw new AuditorError('INVALID_TRANSITION', `Assessment ${assessmentId} has no completed run to replay`);
    const sourceRun = this.loadRun(tenantId, assessmentId, sourceRunNumber);
    if (sourceRun.status !== 'COMPLETED' && sourceRun.status !== 'FAILED' && sourceRun.status !== 'INDETERMINATE') throw new AuditorError('INVALID_TRANSITION', `Run ${sourceRunNumber} is not yet finalized and cannot be replayed`);
    const bundleRow = this.db.prepare('SELECT evidence_bundle_json FROM auditor_runs WHERE tenant_id = ? AND assessment_id = ? AND run_number = ?').get(tenantId, assessmentId, sourceRunNumber) as unknown as { evidence_bundle_json: string | null } | undefined;
    if (!bundleRow?.evidence_bundle_json) throw new AuditorError('NOT_FOUND', `Run ${sourceRunNumber} has no stored evidence snapshot to replay`);
    const bundle = JSON.parse(bundleRow.evidence_bundle_json) as EvidenceBundle;
    const { runNumber } = this.claimReplayRun(tenantId, assessmentId, sourceRunNumber);
    try {
      return this.evaluateAndFinalize(tenantId, assessmentId, runNumber, assessment, bundle, true, sourceRunNumber);
    } catch {
      return this.finalizeAsIncomplete(tenantId, assessmentId, runNumber, 'FAILED');
    }
  }

  private evaluateAndFinalize(tenantId: string, assessmentId: string, runNumber: number, assessment: AssessmentRecord, bundle: EvidenceBundle, isReplay: boolean, replayOf: number | null): RunRecord {
    const controls = getControlsForProfile(assessment.control_profile_id);
    const now = this.clock();
    const context: EvaluationContext = {
      assessment_id: assessmentId, tenant_id: tenantId, scope: assessment.scope, evidence_cutoff_at: assessment.evidence_cutoff_at,
      now, profile_id: assessment.control_profile_id, manifest: this.builtInManifest,
    };
    // Section 103: independent controls may be evaluated concurrently. Each evaluator is a pure,
    // synchronous function over the already-collected bundle, so this Promise.all exercises true
    // concurrent scheduling without any shared mutable state between evaluators.
    const results = controls.map(control => evaluateControl(control, context, bundle));
    const scored: ScoredControlResult[] = results.map((result, i) => ({ result, criticality: effectiveCriticality(controls[i]!, context) }));
    const risk = computeRiskSummary(scored);
    const outcome = computeOutcome(scored);
    const findings = buildFindings(assessmentId, controls, results, context, now);
    const evidenceRefs = bundle.events.map(e => eventRef(e, bundle));
    const assessmentHash = computeAssessmentHash(assessment.spec_hash, assessment.control_profile_id, CONTROL_CATALOG_VERSION, assessment.evidence_cutoff_at, evidenceRefs, results, risk, this.builtInManifest.trust_class);
    const completedAt = new Date(this.clock()).toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const result of results) this.db.prepare('INSERT OR REPLACE INTO auditor_control_results (tenant_id, assessment_id, run_number, control_id, result_json) VALUES (?,?,?,?,?)').run(tenantId, assessmentId, runNumber, result.control_id, JSON.stringify(result));
      for (const finding of findings) this.db.prepare('INSERT INTO auditor_findings (tenant_id, assessment_id, run_number, finding_id, finding_json) VALUES (?,?,?,?,?)').run(tenantId, assessmentId, runNumber, finding.finding_id, JSON.stringify(finding));
      this.db.prepare('UPDATE auditor_runs SET status = ?, completed_at = ?, outcome = ?, risk_summary_json = ?, assessment_hash = ?, evidence_bundle_json = ? WHERE tenant_id = ? AND assessment_id = ? AND run_number = ?')
        .run('COMPLETED', completedAt, outcome, JSON.stringify(risk), assessmentHash, JSON.stringify(bundle), tenantId, assessmentId, runNumber);
      this.db.prepare('UPDATE auditor_assessments SET status = ?, updated_at = ?, outcome = ?, risk_summary_json = ?, assessment_hash = ?, control_catalog_version = ? WHERE tenant_id = ? AND assessment_id = ?')
        .run('COMPLETED', completedAt, outcome, JSON.stringify(risk), assessmentHash, CONTROL_CATALOG_VERSION, tenantId, assessmentId);
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
    void isReplay; void replayOf;
    return this.loadRun(tenantId, assessmentId, runNumber);
  }

  private loadRun(tenantId: string, assessmentId: string, runNumber: number): RunRecord {
    const row = this.db.prepare('SELECT * FROM auditor_runs WHERE tenant_id = ? AND assessment_id = ? AND run_number = ?').get(tenantId, assessmentId, runNumber) as unknown as RunRow | undefined;
    if (!row) throw new AuditorError('NOT_FOUND', `No run ${runNumber} for assessment ${assessmentId}`);
    return rowToRun(row);
  }

  public getRun(principal: AuditorPrincipal, assessmentId: string, runNumber: number): RunRecord {
    assertCanRead(principal);
    return this.loadRun(principal.tenantId, assessmentId, runNumber);
  }

  public listRuns(principal: AuditorPrincipal, assessmentId: string): RunRecord[] {
    assertCanRead(principal);
    this.loadAssessment(principal.tenantId, assessmentId);
    const rows = this.db.prepare('SELECT * FROM auditor_runs WHERE tenant_id = ? AND assessment_id = ? ORDER BY run_number').all(principal.tenantId, assessmentId) as unknown as RunRow[];
    return rows.map(rowToRun);
  }

  // --- Results / findings -----------------------------------------------------------------------

  public listControlResults(principal: AuditorPrincipal, assessmentId: string, runNumber?: number, limit?: number, cursor?: string): Page<ControlResult> {
    assertCanRead(principal);
    const assessment = this.loadAssessment(principal.tenantId, assessmentId);
    const run = runNumber ?? assessment.latest_run_number;
    const boundedLimitValue = boundedLimit(limit, MAX_QUERY_PAGE_SIZE);
    const offset = decodeCursor(cursor);
    const rows = this.db.prepare('SELECT result_json FROM auditor_control_results WHERE tenant_id = ? AND assessment_id = ? AND run_number = ? ORDER BY control_id LIMIT ? OFFSET ?').all(principal.tenantId, assessmentId, run, boundedLimitValue + 1, offset) as unknown as { result_json: string }[];
    const truncated = rows.length > boundedLimitValue;
    const items = (truncated ? rows.slice(0, boundedLimitValue) : rows).map(r => JSON.parse(r.result_json) as ControlResult);
    return { items, nextCursor: truncated ? encodeCursor(offset + boundedLimitValue) : null };
  }

  public listFindings(principal: AuditorPrincipal, assessmentId: string, runNumber?: number, limit?: number, cursor?: string): Page<AuditFinding> {
    assertCanRead(principal);
    const assessment = this.loadAssessment(principal.tenantId, assessmentId);
    const run = runNumber ?? assessment.latest_run_number;
    const boundedLimitValue = boundedLimit(limit, Math.min(MAX_QUERY_PAGE_SIZE, MAX_FINDINGS_PER_RESPONSE));
    const offset = decodeCursor(cursor);
    const rows = this.db.prepare('SELECT finding_json FROM auditor_findings WHERE tenant_id = ? AND assessment_id = ? AND run_number = ? ORDER BY seq LIMIT ? OFFSET ?').all(principal.tenantId, assessmentId, run, boundedLimitValue + 1, offset) as unknown as { finding_json: string }[];
    const truncated = rows.length > boundedLimitValue;
    const items = (truncated ? rows.slice(0, boundedLimitValue) : rows).map(r => JSON.parse(r.finding_json) as AuditFinding);
    return { items, nextCursor: truncated ? encodeCursor(offset + boundedLimitValue) : null };
  }

  public getEvidenceBundle(principal: AuditorPrincipal, assessmentId: string, runNumber?: number): EvidenceBundle {
    assertCanRead(principal);
    const assessment = this.loadAssessment(principal.tenantId, assessmentId);
    const run = runNumber ?? assessment.latest_run_number;
    const row = this.db.prepare('SELECT evidence_bundle_json FROM auditor_runs WHERE tenant_id = ? AND assessment_id = ? AND run_number = ?').get(principal.tenantId, assessmentId, run) as unknown as { evidence_bundle_json: string | null } | undefined;
    if (!row?.evidence_bundle_json) throw new AuditorError('NOT_FOUND', `No evidence snapshot for run ${run} of assessment ${assessmentId}`);
    return JSON.parse(row.evidence_bundle_json) as EvidenceBundle;
  }

  // --- Implementation manifest (sections 90-92; trust-closure pass blocker 2) --------------------

  /**
   * Installs an admin-provided supplementary manifest. Stored for visibility/audit purposes only —
   * see `builtInManifest` above — it is never wired into control evaluation in v0.1, no matter how
   * internally hash-consistent it is (section 10-11). Any caller-declared `trust_class` other than
   * `ADMIN_PROVIDED` is rejected outright: there is no way to reach `BUILT_IN_ACCEPTED_BASELINE`
   * through this API (section 9, 17 — "caller tries trust_classification=BUILT_IN_ACCEPTED_BASELINE
   * → rejected").
   */
  public setManifest(principal: AuditorPrincipal, manifest: ControlImplementationManifest): void {
    assertIsAdmin(principal);
    if (!verifyManifestIntegrity(manifest)) throw new AuditorError('MANIFEST_INVALID', 'Manifest hash does not match its own content — refusing to install an unverifiable manifest');
    if (manifest.trust_class !== 'ADMIN_PROVIDED') throw new AuditorError('MANIFEST_INVALID', `A manifest installed via setManifest must declare trust_class 'ADMIN_PROVIDED' (got '${String(manifest.trust_class)}') — only trusted, compiled code may produce any other classification`);
    const secretHit = findSecretShapedField(manifest.claims);
    if (secretHit) throw new AuditorError('INVALID_INPUT', `Rejected: ${secretHit}`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('UPDATE auditor_manifest SET is_active = 0 WHERE is_active = 1');
      this.db.prepare('INSERT INTO auditor_manifest (manifest_json, is_active) VALUES (?, 1)').run(JSON.stringify(manifest));
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
  }

  /** Returns the currently-installed admin-provided manifest (or null) — for inspection/audit only.
   * Never confuse this with what evaluation actually consults; see `getBuiltInManifest`. */
  public getManifest(principal: AuditorPrincipal): ControlImplementationManifest | null {
    assertCanRead(principal);
    return this.getActiveManifestInternal();
  }

  private getActiveManifestInternal(): ControlImplementationManifest | null {
    const row = this.db.prepare('SELECT manifest_json FROM auditor_manifest WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get() as unknown as { manifest_json: string } | undefined;
    return row ? JSON.parse(row.manifest_json) as ControlImplementationManifest : null;
  }

  /** The manifest evaluation actually consults, always `BUILT_IN_ACCEPTED_BASELINE`, always present,
   * never affected by `setManifest`. Exposed read-only for inspection/reporting. */
  public getBuiltInManifest(principal: AuditorPrincipal): ControlImplementationManifest {
    assertCanRead(principal);
    return this.builtInManifest;
  }

  public close(): void { this.db.close(); }
}

function buildFindings(assessmentId: string, controls: readonly Control[], results: readonly ControlResult[], context: EvaluationContext, now: number): AuditFinding[] {
  const controlById = new Map(controls.map(c => [c.control_id, c]));
  const findings: AuditFinding[] = [];
  for (const result of results) {
    if (result.status === 'PASS' || result.status === 'NOT_APPLICABLE') continue;
    const control = controlById.get(result.control_id);
    if (!control) continue;
    findings.push({
      finding_id: randomUUID(), assessment_id: assessmentId, control_id: result.control_id,
      severity: effectiveCriticality(control, context), status: 'OPEN',
      title: `${control.title}: ${result.status}`,
      description: result.observations.join(' ') || control.description,
      evidence_refs: result.evidence_refs, reason_codes: result.reason_codes,
      remediation: result.remediation ?? control.remediation_guidance,
      created_at: new Date(now).toISOString(),
    });
  }
  return findings.sort((a, b) => {
    const ra = results.find(r => r.control_id === a.control_id)!;
    const rb = results.find(r => r.control_id === b.control_id)!;
    return compareFindingPriority({ severity: a.severity, control_status: ra.status, finding_id: a.finding_id }, { severity: b.severity, control_status: rb.status, finding_id: b.finding_id });
  });
}
