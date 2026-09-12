/**
 * TNA Deployment Academy v0.1 — `AcademyAssessment v1`. Section 8: no level passes on knowledge alone —
 * KNOWLEDGE SCORE + MANDATORY VERIFIED LABS = LEVEL COMPLETION. Section 9: lab pass evidence comes only
 * from `AcademyProgressStore` records that were themselves only ever written by actually running a real
 * lab verifier (see `progress-store.ts`'s doc comment) — never from a caller-supplied "labs passed"
 * argument. Section 10: this module writes nothing to any `OperatorProfile`/production authority
 * record — carries TNA-69 forward structurally, not just by policy statement.
 */
import { createHash } from 'node:crypto';
import { questionsForLevel } from '../../../../academy/question-bank/loader.js';
import { LAB_META, type LabId } from '../../../../academy/labs/registry.js';
import { AcademyProgressStore } from './progress-store.js';

/** Documented, deterministic passing threshold — the same for every level (section 8: "exact threshold
 * may be chosen deterministically and documented"). 70% of that level's own question bank. */
export const KNOWLEDGE_PASSING_SCORE = 0.7;

export interface KnowledgeAnswer { readonly question_id: string; readonly answer: string }

export interface LabEvidenceSummary {
  readonly lab_id: LabId;
  readonly status: 'NOT_STARTED' | 'IN_PROGRESS' | 'PASSED' | 'FAILED';
  readonly verified_at: string | null;
  readonly evidence_refs: readonly string[];
}

export interface AcademyAssessment {
  readonly version: '1.0';
  readonly assessment_id: string;
  readonly level: 1 | 2 | 3 | 4;
  readonly learner_id: string;
  readonly knowledge_requirements: { readonly total_questions: number; readonly answered: number; readonly passing_score: number };
  readonly required_labs: readonly LabId[];
  readonly passing_score: number;
  readonly status: 'PASSED' | 'FAILED';
  readonly started_at: string;
  readonly completed_at: string;
  readonly verified_evidence: {
    readonly knowledge_score: number;
    readonly knowledge_correct: number;
    readonly knowledge_total: number;
    readonly labs: readonly LabEvidenceSummary[];
  };
  readonly assessment_hash: string;
}

function normalizeAnswer(value: string): string { return value.trim().toLowerCase(); }

/**
 * Scores a learner's submitted RAW ANSWERS against the question bank's own hidden `correct_answer`
 * values. The caller can never submit a pre-computed score directly — only answers, which this function
 * alone grades. This is the section-11 tamper-resistance boundary for knowledge scoring.
 */
function scoreKnowledge(level: 1 | 2 | 3 | 4, answers: readonly KnowledgeAnswer[]): { correct: number; total: number; score: number } {
  const questions = questionsForLevel(level);
  const byId = new Map(answers.map(a => [a.question_id, a.answer]));
  let correct = 0;
  for (const question of questions) {
    const submitted = byId.get(question.question_id);
    if (submitted === undefined) continue;
    if (normalizeAnswer(submitted) === normalizeAnswer(question.correct_answer)) correct += 1;
  }
  const total = questions.length;
  return { correct, total, score: total === 0 ? 0 : correct / total };
}

/**
 * Reads REQUIRED lab status exclusively from `AcademyProgressStore` — real, runtime-recorded evidence
 * from an actual `runLabById()` invocation. A lab with no recorded evidence_refs is never treated as
 * passed, no matter what status string might otherwise be present (defense in depth against a
 * hand-edited row bypassing `recordLabAttempt`).
 */
function readLabEvidence(progress: AcademyProgressStore, learnerId: string, labId: LabId): LabEvidenceSummary {
  const entry = progress.getLabProgress(learnerId, labId);
  if (!entry) return { lab_id: labId, status: 'NOT_STARTED', verified_at: null, evidence_refs: [] };
  const genuinelyPassed = entry.status === 'PASSED' && entry.verified_at !== null && entry.evidence_refs.length > 0;
  // A raw status of PASSED with no real evidence behind it (e.g. a hand-edited row that bypassed
  // recordLabAttempt) is never trusted — it is reported as FAILED, never silently passed through.
  const trustworthyStatus = entry.status === 'PASSED' && !genuinelyPassed ? 'FAILED' : entry.status;
  return { lab_id: labId, status: trustworthyStatus, verified_at: entry.verified_at, evidence_refs: entry.evidence_refs };
}

export function assessLevel(deps: { progress: AcademyProgressStore; learnerId: string; level: 1 | 2 | 3 | 4; answers: readonly KnowledgeAnswer[] }): AcademyAssessment {
  const { progress, learnerId, level, answers } = deps;
  const knowledge = scoreKnowledge(level, answers);
  const requiredLabs = LAB_META.filter(l => l.level === level).map(l => l.id);
  const labEvidence = requiredLabs.map(id => readLabEvidence(progress, learnerId, id));
  const allLabsPassed = labEvidence.every(l => l.status === 'PASSED');
  const knowledgePassed = knowledge.score >= KNOWLEDGE_PASSING_SCORE;
  const status: 'PASSED' | 'FAILED' = knowledgePassed && allLabsPassed ? 'PASSED' : 'FAILED';

  const startedAt = new Date().toISOString();
  const completedAt = startedAt;
  const withoutHash = {
    version: '1.0' as const, assessment_id: `asmt_${createHash('sha256').update(`${learnerId}:${level}:${completedAt}:${Math.random()}`).digest('hex').slice(0, 16)}`,
    level, learner_id: learnerId,
    knowledge_requirements: { total_questions: knowledge.total, answered: answers.length, passing_score: KNOWLEDGE_PASSING_SCORE },
    required_labs: requiredLabs, passing_score: KNOWLEDGE_PASSING_SCORE, status, started_at: startedAt, completed_at: completedAt,
    verified_evidence: { knowledge_score: knowledge.score, knowledge_correct: knowledge.correct, knowledge_total: knowledge.total, labs: labEvidence },
  };
  const assessment_hash = createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex');
  return { ...withoutHash, assessment_hash };
}
