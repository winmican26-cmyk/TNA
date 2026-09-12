/**
 * TNA Deployment Academy v0.1 — question bank loader. Every file is validated against
 * `AcademyQuestion v1` at load time (section 38: "no malformed questions").
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQuestionBank, type AcademyQuestion } from './schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFile(name: string): readonly AcademyQuestion[] {
  const path = resolve(HERE, name);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return validateQuestionBank(raw, name);
}

let cache: Readonly<Record<1 | 2 | 3 | 4, readonly AcademyQuestion[]>> | null = null;

export function loadQuestionBank(): Readonly<Record<1 | 2 | 3 | 4, readonly AcademyQuestion[]>> {
  if (cache) return cache;
  cache = {
    1: loadFile('level-1.json'),
    2: loadFile('level-2.json'),
    3: loadFile('level-3.json'),
    4: loadFile('level-4.json'),
  };
  return cache;
}

export function questionsForLevel(level: 1 | 2 | 3 | 4): readonly AcademyQuestion[] {
  return loadQuestionBank()[level];
}

export function allQuestions(): readonly AcademyQuestion[] {
  const bank = loadQuestionBank();
  return [...bank[1], ...bank[2], ...bank[3], ...bank[4]];
}
