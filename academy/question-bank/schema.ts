/**
 * TNA Deployment Academy v0.1 — `AcademyQuestion v1` schema and validator.
 *
 * Section 3: `correct_answer` must never be exposed through ordinary learner-facing command output
 * before submission. `toLearnerFacing` provides that projection for a future assessment layer;
 * no Academy assessment module exists yet.
 */

export const ANSWER_TYPES = ['multiple_choice', 'true_false', 'short_answer'] as const;
export type AnswerType = typeof ANSWER_TYPES[number];

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = typeof DIFFICULTIES[number];

export interface AcademyQuestion {
  readonly question_id: string;
  readonly level: 1 | 2 | 3 | 4;
  readonly objective: string;
  readonly scenario?: string;
  readonly question: string;
  readonly answer_type: AnswerType;
  readonly options?: readonly string[];
  readonly correct_answer: string;
  readonly explanation: string;
  readonly principles: readonly string[];
  readonly difficulty: Difficulty;
}

/** The learner-facing view of a question — `correct_answer` is never included (section 3). */
export type LearnerFacingQuestion = Omit<AcademyQuestion, 'correct_answer'>;
export function toLearnerFacing(question: AcademyQuestion): LearnerFacingQuestion {
  const { correct_answer: _correctAnswer, ...rest } = question;
  void _correctAnswer;
  return rest;
}

export class AcademyQuestionValidationError extends Error {
  public constructor(message: string) { super(message); this.name = 'AcademyQuestionValidationError'; }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validates one question object against the `AcademyQuestion v1` schema. Throws on the first defect
 * found; used by the loader (every question bank file is validated at load time, never trusted blindly)
 * and directly by `tests/academy/question-bank.test.ts`. */
export function validateQuestion(raw: unknown, context: string): AcademyQuestion {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AcademyQuestionValidationError(`${context}: question must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.question_id)) throw new AcademyQuestionValidationError(`${context}: question_id is required`);
  const id = obj.question_id;
  if (obj.level !== 1 && obj.level !== 2 && obj.level !== 3 && obj.level !== 4) throw new AcademyQuestionValidationError(`${id}: level must be 1|2|3|4`);
  if (!isNonEmptyString(obj.objective)) throw new AcademyQuestionValidationError(`${id}: objective is required`);
  if (obj.scenario !== undefined && typeof obj.scenario !== 'string') throw new AcademyQuestionValidationError(`${id}: scenario must be a string when present`);
  if (!isNonEmptyString(obj.question)) throw new AcademyQuestionValidationError(`${id}: question is required`);
  if (typeof obj.answer_type !== 'string' || !(ANSWER_TYPES as readonly string[]).includes(obj.answer_type)) throw new AcademyQuestionValidationError(`${id}: answer_type must be one of ${ANSWER_TYPES.join(', ')}`);
  if (obj.answer_type === 'multiple_choice') {
    if (!Array.isArray(obj.options) || obj.options.length < 2 || !obj.options.every(isNonEmptyString)) {
      throw new AcademyQuestionValidationError(`${id}: multiple_choice questions require >= 2 non-empty options`);
    }
    if (!isNonEmptyString(obj.correct_answer) || !(obj.options as string[]).includes(obj.correct_answer)) {
      throw new AcademyQuestionValidationError(`${id}: correct_answer must be exactly one of the listed options`);
    }
  } else if (obj.answer_type === 'true_false') {
    if (obj.correct_answer !== 'true' && obj.correct_answer !== 'false') throw new AcademyQuestionValidationError(`${id}: true_false correct_answer must be "true" or "false"`);
  } else {
    if (!isNonEmptyString(obj.correct_answer)) throw new AcademyQuestionValidationError(`${id}: short_answer correct_answer is required`);
  }
  if (!isNonEmptyString(obj.explanation)) throw new AcademyQuestionValidationError(`${id}: explanation is required`);
  if (!Array.isArray(obj.principles) || obj.principles.length === 0 || !obj.principles.every(p => typeof p === 'string' && p.length > 0)) {
    throw new AcademyQuestionValidationError(`${id}: principles must be a non-empty array of strings`);
  }
  if (typeof obj.difficulty !== 'string' || !(DIFFICULTIES as readonly string[]).includes(obj.difficulty)) throw new AcademyQuestionValidationError(`${id}: difficulty must be one of ${DIFFICULTIES.join(', ')}`);
  return obj as unknown as AcademyQuestion;
}

export function validateQuestionBank(raw: unknown, context: string): readonly AcademyQuestion[] {
  if (!Array.isArray(raw)) throw new AcademyQuestionValidationError(`${context}: question bank file must be a JSON array`);
  const questions = raw.map((entry, index) => validateQuestion(entry, `${context}[${index}]`));
  const ids = new Set<string>();
  for (const question of questions) {
    if (ids.has(question.question_id)) throw new AcademyQuestionValidationError(`${context}: duplicate question_id ${question.question_id}`);
    ids.add(question.question_id);
  }
  return questions;
}
