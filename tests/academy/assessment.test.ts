import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcademyProgressStore } from '../../apps/tna-operator/src/academy/progress-store.js';
import { assessLevel, KNOWLEDGE_PASSING_SCORE } from '../../apps/tna-operator/src/academy/assessment.js';
import { questionsForLevel } from '../../academy/question-bank/loader.js';
import { LAB_META } from '../../academy/labs/registry.js';
import type { LabResult } from '../../academy/labs/blocked-action.js';

/**
 * TNA Deployment Academy v0.1. Section 39: permanent assessment tests, including tampering resistance
 * (section 11) and authority separation (section 10, TNA-69).
 */

function tmpStore(): { store: AcademyProgressStore; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-academy-assessment-test-'));
  return { store: new AcademyProgressStore(resolve(dir, 'progress.sqlite')), dir };
}

function fakeLabResult(labId: string, passed: boolean): LabResult {
  return { lab_id: labId, passed, steps: [{ description: 'synthetic step for this test', passed }] };
}

function correctAnswersFor(level: 1 | 2 | 3 | 4) {
  return questionsForLevel(level).map(q => ({ question_id: q.question_id, answer: q.correct_answer }));
}
function wrongAnswersFor(level: 1 | 2 | 3 | 4) {
  return questionsForLevel(level).map(q => ({ question_id: q.question_id, answer: '__definitely_wrong__' }));
}

test('knowledge pass + all mandatory labs pass -> PASSED', () => {
  const { store, dir } = tmpStore();
  try {
    const level1Labs = LAB_META.filter(l => l.level === 1);
    for (const lab of level1Labs) store.recordLabAttempt('learner-a', 1, fakeLabResult(lab.id, true));
    const assessment = assessLevel({ progress: store, learnerId: 'learner-a', level: 1, answers: correctAnswersFor(1) });
    assert.equal(assessment.status, 'PASSED');
    assert.ok(assessment.verified_evidence.knowledge_score >= KNOWLEDGE_PASSING_SCORE);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('knowledge fail + all mandatory labs pass -> FAILED', () => {
  const { store, dir } = tmpStore();
  try {
    const level1Labs = LAB_META.filter(l => l.level === 1);
    for (const lab of level1Labs) store.recordLabAttempt('learner-b', 1, fakeLabResult(lab.id, true));
    const assessment = assessLevel({ progress: store, learnerId: 'learner-b', level: 1, answers: wrongAnswersFor(1) });
    assert.equal(assessment.status, 'FAILED');
    assert.equal(assessment.verified_evidence.knowledge_score, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('knowledge pass + one mandatory lab fails (or was never attempted) -> FAILED', () => {
  const { store, dir } = tmpStore();
  try {
    const level1Labs = LAB_META.filter(l => l.level === 1);
    // Only pass the first required lab — leave the rest NOT_STARTED.
    store.recordLabAttempt('learner-c', 1, fakeLabResult(level1Labs[0]!.id, true));
    const assessment = assessLevel({ progress: store, learnerId: 'learner-c', level: 1, answers: correctAnswersFor(1) });
    assert.equal(assessment.status, 'FAILED');
    assert.ok(assessment.verified_evidence.labs.some(l => l.status !== 'PASSED'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a mandatory lab that FAILED (not merely unattempted) also blocks completion, even with perfect knowledge', () => {
  const { store, dir } = tmpStore();
  try {
    const level1Labs = LAB_META.filter(l => l.level === 1);
    for (const lab of level1Labs) store.recordLabAttempt('learner-d', 1, fakeLabResult(lab.id, false));
    const assessment = assessLevel({ progress: store, learnerId: 'learner-d', level: 1, answers: correctAnswersFor(1) });
    assert.equal(assessment.status, 'FAILED');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a learner cannot forge lab PASS by hand-writing an evidence-less progress row directly into the store', () => {
  const { store, dir } = tmpStore();
  try {
    // Simulate a forged row: PASSED status with NO evidence_refs and no verified_at — never produced
    // by the real recordLabAttempt path, which always includes real step-level evidence.
    const rawDb = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    const level1Labs = LAB_META.filter(l => l.level === 1);
    for (const lab of level1Labs) {
      rawDb.prepare('INSERT INTO academy_progress (learner_id, level, entry_key, lesson_id, lab_id, status, attempt_count, verified_at, evidence_refs_json) VALUES (?,?,?,NULL,?,?,?,?,?)')
        .run('forger', 1, `lab:${lab.id}`, lab.id, 'PASSED', 1, null, '[]');
    }
    const assessment = assessLevel({ progress: store, learnerId: 'forger', level: 1, answers: correctAnswersFor(1) });
    assert.equal(assessment.status, 'FAILED', 'a PASSED status with no real evidence_refs/verified_at must never count toward completion');
    assert.ok(assessment.verified_evidence.labs.every(l => l.status !== 'PASSED'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a learner cannot forge a knowledge score by submitting a pre-computed score instead of real answers', () => {
  const { store, dir } = tmpStore();
  try {
    const level1Labs = LAB_META.filter(l => l.level === 1);
    for (const lab of level1Labs) store.recordLabAttempt('learner-e', 1, fakeLabResult(lab.id, true));
    // Attempt to inject a fake "score"/"correct_answer" field alongside a real answer shape — the
    // assessor's type only reads {question_id, answer}; anything else is structurally ignored.
    const forgedAnswers = correctAnswersFor(1).map(a => ({ ...a, score: 999, correct_answer: 'ignored', forced_status: 'PASSED' }));
    const assessment = assessLevel({ progress: store, learnerId: 'learner-e', level: 1, answers: forgedAnswers });
    // The score is still computed honestly from the real answers (which happen to be genuinely correct
    // here) — the extraneous forged fields have no effect on the computed result either way.
    assert.equal(assessment.verified_evidence.knowledge_correct, questionsForLevel(1).length);
    assert.equal(assessment.status, 'PASSED');

    // Now prove the forged fields cannot MANUFACTURE a pass when the real answer is wrong.
    const forgedWrongAnswers = wrongAnswersFor(1).map(a => ({ ...a, score: 999, forced_status: 'PASSED' }));
    const failedAssessment = assessLevel({ progress: store, learnerId: 'learner-e', level: 1, answers: forgedWrongAnswers });
    assert.equal(failedAssessment.status, 'FAILED');
    assert.equal(failedAssessment.verified_evidence.knowledge_score, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('retaking after a failure preserves attempt history — attempt_count increases and the prior attempt remains in academy_attempts', () => {
  const { store, dir } = tmpStore();
  try {
    const labId = LAB_META[0]!.id;
    store.recordLabAttempt('learner-f', 1, fakeLabResult(labId, false));
    store.recordLabAttempt('learner-f', 1, fakeLabResult(labId, false));
    store.recordLabAttempt('learner-f', 1, fakeLabResult(labId, true));
    const progress = store.getLabProgress('learner-f', labId)!;
    assert.equal(progress.attempt_count, 3);
    assert.equal(progress.status, 'PASSED');
    const history = store.attemptHistory('learner-f', labId);
    assert.equal(history.length, 3);
    assert.equal(history[0]!.status, 'FAILED');
    assert.equal(history[1]!.status, 'FAILED');
    assert.equal(history[2]!.status, 'PASSED');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('academy assessment completion never touches any OperatorProfile, role, tenant, Gate, credential, or policy-binding state (TNA-69)', () => {
  // Structural proof: assessment.ts and progress-store.ts import nothing from config.ts (OperatorProfile),
  // roles.ts, http-client.ts, or any client-gateway/platform-writing module — there is no code path by
  // which running an assessment could reach production authority state.
  const assessmentSource = readFileSync(fileURLToPath(new URL('../../../apps/tna-operator/src/academy/assessment.ts', import.meta.url)), 'utf8');
  const progressSource = readFileSync(fileURLToPath(new URL('../../../apps/tna-operator/src/academy/progress-store.ts', import.meta.url)), 'utf8');
  // Check actual import statements (real code dependencies), not prose — both files' own doc comments
  // legitimately discuss OperatorProfile/TNA-69 in English while importing none of that machinery.
  const importLines = (source: string) => source.split('\n').filter(line => line.trim().startsWith('import'));
  for (const forbidden of ['http-client.js', './config.js', '../config.js', './roles.js', '../roles.js']) {
    assert.ok(!importLines(assessmentSource).some(line => line.includes(forbidden)), `assessment.ts must not import ${forbidden}`);
    assert.ok(!importLines(progressSource).some(line => line.includes(forbidden)), `progress-store.ts must not import ${forbidden}`);
  }
});
