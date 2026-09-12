import assert from 'node:assert/strict';
import test from 'node:test';
import { loadQuestionBank, allQuestions, questionsForLevel } from '../../academy/question-bank/loader.js';
import { validateQuestionBank, AcademyQuestionValidationError, toLearnerFacing } from '../../academy/question-bank/schema.js';

/**
 * TNA Deployment Academy v0.1. Section 38: permanent tests for the question bank — minimum counts,
 * unique ids, valid schema, valid answer references, principle coverage, no malformed questions.
 */

test('Level 1 has at least 25 questions', () => { assert.ok(questionsForLevel(1).length >= 25, `expected >= 25, got ${questionsForLevel(1).length}`); });
test('Level 2 has at least 30 questions', () => { assert.ok(questionsForLevel(2).length >= 30, `expected >= 30, got ${questionsForLevel(2).length}`); });
test('Level 3 has at least 30 questions', () => { assert.ok(questionsForLevel(3).length >= 30, `expected >= 30, got ${questionsForLevel(3).length}`); });
test('Level 4 has at least 35 questions', () => { assert.ok(questionsForLevel(4).length >= 35, `expected >= 35, got ${questionsForLevel(4).length}`); });
test('total question bank has at least 120 questions', () => { assert.ok(allQuestions().length >= 120, `expected >= 120, got ${allQuestions().length}`); });

test('every question_id across the entire bank is globally unique', () => {
  const all = allQuestions();
  const seen = new Set<string>();
  for (const q of all) {
    assert.ok(!seen.has(q.question_id), `duplicate question_id: ${q.question_id}`);
    seen.add(q.question_id);
  }
  assert.equal(seen.size, all.length);
});

test('every question declares the level matching the file it was loaded from', () => {
  const bank = loadQuestionBank();
  for (const level of [1, 2, 3, 4] as const) {
    for (const question of bank[level]) assert.equal(question.level, level, `${question.question_id} declares level ${question.level} but was loaded from level-${level}.json`);
  }
});

test('every multiple_choice question\'s correct_answer is exactly one of its own listed options', () => {
  for (const question of allQuestions()) {
    if (question.answer_type !== 'multiple_choice') continue;
    assert.ok(question.options && question.options.includes(question.correct_answer), `${question.question_id}: correct_answer is not among its own options`);
  }
});

test('every true_false question\'s correct_answer is exactly "true" or "false"', () => {
  for (const question of allQuestions()) {
    if (question.answer_type !== 'true_false') continue;
    assert.ok(question.correct_answer === 'true' || question.correct_answer === 'false', `${question.question_id}: invalid true_false answer`);
  }
});

test('every question declares at least one non-empty principle/theme tag', () => {
  for (const question of allQuestions()) assert.ok(question.principles.length > 0, `${question.question_id} has no principle tags`);
});

test('every question has a non-empty explanation distinct from the question text itself', () => {
  for (const question of allQuestions()) {
    assert.ok(question.explanation.length > 10, `${question.question_id}: explanation too short`);
    assert.notEqual(question.explanation, question.question);
  }
});

test('the bank meaningfully covers TNA-58 through TNA-71 (the Volume 10/11 principle range)', () => {
  const all = allQuestions();
  for (let n = 58; n <= 71; n += 1) {
    const tag = `TNA-${n}`;
    const covered = all.some(q => q.principles.includes(tag));
    assert.ok(covered, `${tag} has no covering question`);
  }
});

test('the bank meaningfully covers every accepted-volume theme (Authority, Verification, Evidence, Runtime Control, Assurance)', () => {
  const all = allQuestions();
  for (const theme of ['Authority (Gate)', 'Verification (VAD)', 'Evidence (Ledger)', 'Runtime Control (Sentinel)', 'Assurance (Auditor)']) {
    assert.ok(all.some(q => q.principles.includes(theme)), `theme "${theme}" has no covering question`);
  }
});

test('a malformed question bank file is rejected outright, never silently accepted', () => {
  assert.throws(() => validateQuestionBank([{ question_id: 'BAD-1' }], 'test-context'), AcademyQuestionValidationError);
  assert.throws(() => validateQuestionBank('not an array', 'test-context'), AcademyQuestionValidationError);
  assert.throws(() => validateQuestionBank([{ question_id: 'DUP', level: 1, objective: 'x', question: 'x', answer_type: 'true_false', correct_answer: 'true', explanation: 'x', principles: ['x'], difficulty: 'easy' }, { question_id: 'DUP', level: 1, objective: 'x', question: 'x', answer_type: 'true_false', correct_answer: 'false', explanation: 'x', principles: ['x'], difficulty: 'easy' }], 'dup-context'), AcademyQuestionValidationError);
});

test('a multiple_choice question whose correct_answer is not one of its options is rejected', () => {
  assert.throws(() => validateQuestionBank([{
    question_id: 'BAD-MC', level: 1, objective: 'x', question: 'x', answer_type: 'multiple_choice',
    options: ['A', 'B'], correct_answer: 'C', explanation: 'x', principles: ['x'], difficulty: 'easy',
  }], 'bad-mc-context'), AcademyQuestionValidationError);
});

// Section 3: correct_answer must never be exposed through ordinary learner-facing output before submission.
test('toLearnerFacing strips correct_answer from every question, for every question in the real bank', () => {
  for (const question of allQuestions()) {
    const learnerView = toLearnerFacing(question);
    assert.ok(!('correct_answer' in learnerView), `${question.question_id}: correct_answer leaked into the learner-facing view`);
  }
});

test('the question bank favors scenario reasoning over bare trivia: a meaningful share of questions include a scenario field', () => {
  const all = allQuestions();
  const withScenario = all.filter(q => typeof q.scenario === 'string' && q.scenario.length > 0);
  assert.ok(withScenario.length >= 15, `expected at least 15 scenario-based questions, got ${withScenario.length}`);
});
