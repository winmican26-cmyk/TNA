/**
 * TNA Deployment Academy v0.1 — `AcademyProgress v1`. The one runtime-owned source of truth for what a
 * learner has actually done. Section 32: a PASSED lab entry always carries real verifier evidence
 * (the actual step results from `runLabById`), never a bare boolean. Section 33: retakes preserve
 * history — every attempt is appended to `academy_attempts` (never overwritten), and
 * `academy_progress` holds the current summary (status, attempt_count, verified_at, evidence_refs).
 * Section 9/10 (assessment tampering): the ONLY code path that can write a PASSED lab status here is
 * `recordLabAttempt`, called exclusively by `apps/tna-operator/src/main.ts`'s `academy lab verify`
 * command immediately after it actually ran `runLabById()` — there is no command that accepts a
 * caller-supplied status, verified_at, or evidence_refs value directly.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { LabResult } from '../../../../academy/labs/blocked-action.js';

export const ACADEMY_PROGRESS_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'PASSED', 'FAILED'] as const;
export type AcademyProgressStatus = typeof ACADEMY_PROGRESS_STATUSES[number];

export interface AcademyProgressEntry {
  readonly learner_id: string;
  readonly level: 1 | 2 | 3 | 4;
  readonly lesson_id: string | null;
  readonly lab_id: string | null;
  readonly status: AcademyProgressStatus;
  readonly attempt_count: number;
  readonly verified_at: string | null;
  readonly evidence_refs: readonly string[];
}

export interface AcademyAttemptRecord {
  readonly attempt_id: string;
  readonly learner_id: string;
  readonly lab_id: string;
  readonly attempted_at: string;
  readonly status: 'PASSED' | 'FAILED';
  readonly evidence_refs: readonly string[];
}

/** `node:sqlite` refuses an expression (e.g. COALESCE) inside a PRIMARY KEY/UNIQUE definition — the
 * distinguishing key for one progress row is therefore computed here, in application code, as a plain
 * stored column, never as a SQL-level expression. */
function entryKeyFor(lessonId: string | null, labId: string | null): string {
  return lessonId !== null ? `lesson:${lessonId}` : labId !== null ? `lab:${labId}` : 'level';
}

export class AcademyProgressStore {
  private readonly db: DatabaseSync;
  public constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000;
      CREATE TABLE IF NOT EXISTS academy_progress (
        learner_id TEXT NOT NULL, level INTEGER NOT NULL, entry_key TEXT NOT NULL,
        lesson_id TEXT, lab_id TEXT, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
        verified_at TEXT, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (learner_id, level, entry_key));
      CREATE TABLE IF NOT EXISTS academy_attempts (
        attempt_id TEXT PRIMARY KEY, learner_id TEXT NOT NULL, lab_id TEXT NOT NULL,
        attempted_at TEXT NOT NULL, status TEXT NOT NULL, evidence_refs_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS academy_attempts_learner_lab ON academy_attempts(learner_id, lab_id, attempted_at);`);
  }

  /** The ONLY write path for lab progress — always called with a REAL `LabResult` just produced by
   * actually invoking `runLabById()`. Never accepts a caller-asserted status. */
  public recordLabAttempt(learnerId: string, level: 1 | 2 | 3 | 4, result: LabResult): AcademyProgressEntry {
    const now = new Date().toISOString();
    const status: 'PASSED' | 'FAILED' = result.passed ? 'PASSED' : 'FAILED';
    const evidenceRefs = result.steps.map(s => `${s.passed ? 'PASS' : 'FAIL'}: ${s.description}`);
    const entryKey = entryKeyFor(null, result.lab_id);
    const attempt: AcademyAttemptRecord = { attempt_id: `att_${randomUUID()}`, learner_id: learnerId, lab_id: result.lab_id, attempted_at: now, status, evidence_refs: evidenceRefs };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO academy_attempts VALUES (?,?,?,?,?,?)').run(attempt.attempt_id, learnerId, result.lab_id, now, status, JSON.stringify(evidenceRefs));
      const existing = this.db.prepare('SELECT attempt_count FROM academy_progress WHERE learner_id=? AND level=? AND entry_key=?').get(learnerId, level, entryKey) as { attempt_count: number } | undefined;
      const nextAttemptCount = (existing?.attempt_count ?? 0) + 1;
      this.db.prepare(`INSERT INTO academy_progress (learner_id, level, entry_key, lesson_id, lab_id, status, attempt_count, verified_at, evidence_refs_json)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
        ON CONFLICT(learner_id, level, entry_key) DO UPDATE SET status=excluded.status, attempt_count=excluded.attempt_count, verified_at=excluded.verified_at, evidence_refs_json=excluded.evidence_refs_json`)
        .run(learnerId, level, entryKey, result.lab_id, status, nextAttemptCount, status === 'PASSED' ? now : null, JSON.stringify(evidenceRefs));
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
    return this.getLabProgress(learnerId, result.lab_id)!;
  }

  public recordLessonViewed(learnerId: string, level: 1 | 2 | 3 | 4, lessonId: string): AcademyProgressEntry {
    const now = new Date().toISOString();
    const entryKey = entryKeyFor(lessonId, null);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT attempt_count FROM academy_progress WHERE learner_id=? AND level=? AND entry_key=?').get(learnerId, level, entryKey) as { attempt_count: number } | undefined;
      const nextAttemptCount = (existing?.attempt_count ?? 0) + 1;
      this.db.prepare(`INSERT INTO academy_progress (learner_id, level, entry_key, lesson_id, lab_id, status, attempt_count, verified_at, evidence_refs_json)
        VALUES (?, ?, ?, ?, NULL, 'IN_PROGRESS', ?, ?, '[]')
        ON CONFLICT(learner_id, level, entry_key) DO UPDATE SET attempt_count=excluded.attempt_count, verified_at=excluded.verified_at`)
        .run(learnerId, level, entryKey, lessonId, nextAttemptCount, now);
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ } throw error; }
    return this.getLessonProgress(learnerId, lessonId)!;
  }

  public getLabProgress(learnerId: string, labId: string): AcademyProgressEntry | null {
    const row = this.db.prepare('SELECT * FROM academy_progress WHERE learner_id=? AND lab_id=?').get(learnerId, labId) as RawRow | undefined;
    return row ? rowToEntry(row) : null;
  }
  public getLessonProgress(learnerId: string, lessonId: string): AcademyProgressEntry | null {
    const row = this.db.prepare('SELECT * FROM academy_progress WHERE learner_id=? AND lesson_id=?').get(learnerId, lessonId) as RawRow | undefined;
    return row ? rowToEntry(row) : null;
  }
  public listForLearner(learnerId: string): readonly AcademyProgressEntry[] {
    return (this.db.prepare('SELECT * FROM academy_progress WHERE learner_id=?').all(learnerId) as unknown as RawRow[]).map(rowToEntry);
  }
  public attemptHistory(learnerId: string, labId: string): readonly AcademyAttemptRecord[] {
    return (this.db.prepare('SELECT * FROM academy_attempts WHERE learner_id=? AND lab_id=? ORDER BY attempted_at').all(learnerId, labId) as unknown as { attempt_id: string; learner_id: string; lab_id: string; attempted_at: string; status: string; evidence_refs_json: string }[])
      .map(r => ({ attempt_id: r.attempt_id, learner_id: r.learner_id, lab_id: r.lab_id, attempted_at: r.attempted_at, status: r.status as 'PASSED' | 'FAILED', evidence_refs: JSON.parse(r.evidence_refs_json) as string[] }));
  }
  public close(): void { this.db.close(); }
}

interface RawRow { learner_id: string; level: number; lesson_id: string | null; lab_id: string | null; status: string; attempt_count: number; verified_at: string | null; evidence_refs_json: string }
function rowToEntry(row: RawRow): AcademyProgressEntry {
  return {
    learner_id: row.learner_id, level: row.level as 1 | 2 | 3 | 4, lesson_id: row.lesson_id, lab_id: row.lab_id,
    status: row.status as AcademyProgressStatus, attempt_count: row.attempt_count, verified_at: row.verified_at,
    evidence_refs: JSON.parse(row.evidence_refs_json) as string[],
  };
}
