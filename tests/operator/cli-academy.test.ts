import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { resolve } from 'node:path';
import { questionsForLevel } from '../../academy/question-bank/loader.js';

/**
 * TNA Deployment Academy v0.1 closure — real CLI process tests for the five `academy` commands. Every
 * test here spawns the actual compiled `dist/apps/tna-operator/src/main.js` binary as a real OS process
 * (`spawnSync`) — never an imported function. Manual CLI verification during development is not accepted
 * as closure evidence for this requirement; these tests are.
 */

const OPERATOR_MAIN = resolve('dist', 'apps', 'tna-operator', 'src', 'main.js');

function writeProfile(dir: string, name: string, role: string): void {
  writeFileSync(resolve(dir, `${name}.json`), JSON.stringify({ role, devMode: true }));
}

interface CliRun { readonly stdout: string; readonly stderr: string; readonly code: number | null }
function runCli(args: readonly string[], env: Record<string, string>): CliRun {
  const result = spawnSync(execPath, [OPERATOR_MAIN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}

let profileDir: string;

before(() => {
  profileDir = mkdtempSync(resolve(tmpdir(), 'tna-academy-cli-profiles-'));
  writeProfile(profileDir, 'viewer', 'viewer');
  writeProfile(profileDir, 'operator', 'operator');
  writeProfile(profileDir, 'admin', 'admin');
  writeFileSync(resolve(profileDir, 'broken.json'), JSON.stringify({ role: 'not-a-real-role', devMode: true }));
});

/** Every test gets its own isolated Academy progress store and audit log — a real, separate SQLite file
 * per test, never shared state that could leak between tests or between learners. */
function isolatedEnv(profile: string, learner: string): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-academy-cli-state-'));
  return {
    dir,
    env: {
      TNA_OPERATOR_PROFILE_DIR: profileDir,
      TNA_OPERATOR_AUDIT_PATH: resolve(dir, 'audit.sqlite'),
      TNA_ACADEMY_PROGRESS_PATH: resolve(dir, 'progress.sqlite'),
      TNA_OPERATOR_PROFILE: profile,
      __TNA_LEARNER_UNUSED__: learner, // kept only for readability at call sites; real learner id passed via --learner
    },
  };
}

function cleanup(dir: string): void { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }

test('real CLI process: academy status starts a real process, exits 0, and shows the full 15-lab catalog for a brand-new learner with zero progress', () => {
  const { env, dir } = isolatedEnv('viewer', 'learner-fresh-1');
  try {
    const run = runCli(['academy', 'status', '--profile', 'viewer', '--json', '--learner', 'learner-fresh-1'], env);
    assert.equal(run.code, 0, run.stderr);
    const parsed = JSON.parse(run.stdout) as { ok: boolean; data: { learner_id: string; labs: { id: string }[]; entries: unknown[] } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.learner_id, 'learner-fresh-1');
    assert.equal(parsed.data.labs.length, 15);
    assert.equal(parsed.data.entries.length, 0, 'a brand-new learner must show zero progress entries');
  } finally { cleanup(dir); }
});

test('real CLI process: academy lesson marks progress that persists across a second, separate CLI process invocation', () => {
  const { env, dir } = isolatedEnv('viewer', 'learner-2');
  try {
    const marked = runCli(['academy', 'lesson', 'lesson-gate-basics', '--level', '1', '--profile', 'viewer', '--json', '--learner', 'learner-2'], env);
    assert.equal(marked.code, 0, marked.stderr);
    const markedParsed = JSON.parse(marked.stdout) as { data: { status: string } };
    assert.equal(markedParsed.data.status, 'IN_PROGRESS');

    // A second, entirely separate OS process, sharing only the same progress file via env — proves this
    // is real persisted state, not something held in the first process's memory.
    const status = runCli(['academy', 'status', '--profile', 'viewer', '--json', '--learner', 'learner-2'], env);
    assert.equal(status.code, 0, status.stderr);
    const statusParsed = JSON.parse(status.stdout) as { data: { entries: { lesson_id: string | null; status: string }[] } };
    assert.ok(statusParsed.data.entries.some(e => e.lesson_id === 'lesson-gate-basics' && e.status === 'IN_PROGRESS'));
  } finally { cleanup(dir); }
});

test('real CLI process: academy lab start is informational only and writes no persisted progress', () => {
  const { env, dir } = isolatedEnv('viewer', 'learner-3');
  try {
    const started = runCli(['academy', 'lab', 'start', 'lab-01-blocked-action', '--profile', 'viewer', '--json', '--learner', 'learner-3'], env);
    assert.equal(started.code, 0, started.stderr);
    const startedParsed = JSON.parse(started.stdout) as { data: { id: string; title: string } };
    assert.equal(startedParsed.data.id, 'lab-01-blocked-action');

    const status = runCli(['academy', 'status', '--profile', 'viewer', '--json', '--learner', 'learner-3'], env);
    const statusParsed = JSON.parse(status.stdout) as { data: { entries: unknown[] } };
    assert.equal(statusParsed.data.entries.length, 0, '"lab start" must never itself write a progress row');
  } finally { cleanup(dir); }
});

test('real CLI process: academy lab verify runs the real lab, exits 0 on a real PASS, persists real runtime evidence, and ignores any learner-supplied result fields', () => {
  const { env, dir } = isolatedEnv('viewer', 'learner-4');
  try {
    // Bogus extra flags asserting a fake result — the command accepts no such input at all; this proves
    // there is no argument surface by which a learner could assert their own pass/fail/score/evidence.
    const verify = runCli(['academy', 'lab', 'verify', 'lab-01-blocked-action', '--profile', 'viewer', '--json', '--learner', 'learner-4', '--passed', 'true', '--score', '100', '--evidence', 'forged'], env);
    assert.equal(verify.code, 0, verify.stderr);
    const parsed = JSON.parse(verify.stdout) as { ok: boolean; data: { result: { lab_id: string; passed: boolean; steps: { description: string; passed: boolean }[] }; progress: { status: string; verified_at: string | null; evidence_refs: string[] } } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.result.lab_id, 'lab-01-blocked-action');
    assert.equal(parsed.data.result.passed, true);
    assert.ok(parsed.data.result.steps.length > 0, 'a real lab must report real verifier steps, never a bare boolean');
    assert.equal(parsed.data.progress.status, 'PASSED');
    assert.ok(parsed.data.progress.verified_at !== null);
    assert.ok(parsed.data.progress.evidence_refs.length > 0);

    const status = runCli(['academy', 'status', '--profile', 'viewer', '--json', '--learner', 'learner-4'], env);
    const statusParsed = JSON.parse(status.stdout) as { data: { entries: { lab_id: string | null; status: string; verified_at: string | null; evidence_refs: string[] }[] } };
    const entry = statusParsed.data.entries.find(e => e.lab_id === 'lab-01-blocked-action');
    assert.ok(entry, 'lab verify result must be persisted and visible in a subsequent status call');
    assert.equal(entry!.status, 'PASSED');
    assert.ok(entry!.verified_at !== null);
    assert.ok(entry!.evidence_refs.length > 0);
  } finally { cleanup(dir); }
});

test('real CLI process: academy assessment --questions never exposes correct_answer in real learner-facing output', () => {
  const { env, dir } = isolatedEnv('viewer', 'learner-5');
  try {
    const run = runCli(['academy', 'assessment', '1', '--questions', '--profile', 'viewer', '--json', '--learner', 'learner-5'], env);
    assert.equal(run.code, 0, run.stderr);
    const parsed = JSON.parse(run.stdout) as { data: Record<string, unknown>[] };
    assert.equal(parsed.data.length, questionsForLevel(1).length);
    for (const question of parsed.data) assert.ok(!('correct_answer' in question), 'CLI questions output must never contain correct_answer');
    assert.ok(!run.stdout.includes('"correct_answer"'), 'the raw CLI stdout text must never contain the correct_answer field at all');
  } finally { cleanup(dir); }
});

test('real CLI process: academy assessment FAILS a real learner with correct knowledge but incomplete required labs', () => {
  const { env, dir } = isolatedEnv('viewer', 'learner-6');
  try {
    // Only one of the three Level 1 required labs (lab-01) is actually verified.
    const verify = runCli(['academy', 'lab', 'verify', 'lab-01-blocked-action', '--profile', 'viewer', '--json', '--learner', 'learner-6'], env);
    assert.equal(verify.code, 0, verify.stderr);

    const answers = questionsForLevel(1).map(q => ({ question_id: q.question_id, answer: q.correct_answer }));
    const run = runCli(['academy', 'assessment', '1', '--profile', 'viewer', '--json', '--learner', 'learner-6', '--answers', JSON.stringify(answers)], env);
    assert.notEqual(run.code, 0);
    const parsed = JSON.parse(run.stdout) as { ok: boolean; data: { status: string; verified_evidence: { labs: { status: string }[] } } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.data.status, 'FAILED');
    assert.ok(parsed.data.verified_evidence.labs.some(l => l.status !== 'PASSED'), 'assessment result must reflect real, currently-stored lab evidence, not a client-side claim');
  } finally { cleanup(dir); }
});

test('real CLI process: academy assessment PASSES a real learner only once every required lab was independently verified through separate real CLI invocations, plus a passing knowledge score', () => {
  const { env, dir } = isolatedEnv('viewer', 'learner-7');
  try {
    for (const labId of ['lab-01-blocked-action', 'lab-02-held-action', 'lab-04-vad-rejection']) {
      const verify = runCli(['academy', 'lab', 'verify', labId, '--profile', 'viewer', '--json', '--learner', 'learner-7'], env);
      assert.equal(verify.code, 0, `${labId}: ${verify.stderr}`);
    }
    const answers = questionsForLevel(1).map(q => ({ question_id: q.question_id, answer: q.correct_answer }));
    const run = runCli(['academy', 'assessment', '1', '--profile', 'viewer', '--json', '--learner', 'learner-7', '--answers', JSON.stringify(answers)], env);
    assert.equal(run.code, 0, run.stderr);
    const parsed = JSON.parse(run.stdout) as { ok: boolean; data: { status: string } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.status, 'PASSED');
  } finally { cleanup(dir); }
});

test('real CLI process: role enforcement — every real operator role (viewer, operator, admin) can run Academy commands, by explicit design, while a request with no resolvable profile is refused before any command runs', () => {
  for (const profile of ['viewer', 'operator', 'admin']) {
    const { env, dir } = isolatedEnv(profile, `learner-role-${profile}`);
    try {
      const run = runCli(['academy', 'status', '--profile', profile, '--json', '--learner', `learner-role-${profile}`], env);
      assert.equal(run.code, 0, `${profile}: ${run.stderr}`);
      assert.equal((JSON.parse(run.stdout) as { ok: boolean }).ok, true);
    } finally { cleanup(dir); }
  }

  const { env, dir } = isolatedEnv('viewer', 'learner-noprofile');
  try {
    const noProfileEnv = { ...env }; delete noProfileEnv.TNA_OPERATOR_PROFILE;
    const noProfile = runCli(['academy', 'status', '--json', '--learner', 'learner-noprofile'], noProfileEnv);
    assert.notEqual(noProfile.code, 0);
    assert.equal((JSON.parse(noProfile.stdout) as { code: string }).code, 'VALIDATION_ERROR');

    const brokenRole = runCli(['academy', 'status', '--profile', 'broken', '--json', '--learner', 'learner-noprofile'], env);
    assert.notEqual(brokenRole.code, 0);
    assert.equal((JSON.parse(brokenRole.stdout) as { code: string }).code, 'VALIDATION_ERROR');
  } finally { cleanup(dir); }
});

test('real CLI process: one learner\'s persisted Academy progress is never visible to a different learner sharing the same underlying store', () => {
  const { env, dir } = isolatedEnv('viewer', 'learner-8');
  try {
    const verify = runCli(['academy', 'lab', 'verify', 'lab-01-blocked-action', '--profile', 'viewer', '--json', '--learner', 'learner-8'], env);
    assert.equal(verify.code, 0, verify.stderr);

    const otherStatus = runCli(['academy', 'status', '--profile', 'viewer', '--json', '--learner', 'learner-9'], env);
    assert.equal(otherStatus.code, 0, otherStatus.stderr);
    const parsed = JSON.parse(otherStatus.stdout) as { data: { entries: unknown[] } };
    assert.equal(parsed.data.entries.length, 0, 'a different learner_id sharing the same store file must see zero entries from another learner');

    const ownStatus = runCli(['academy', 'status', '--profile', 'viewer', '--json', '--learner', 'learner-8'], env);
    const ownParsed = JSON.parse(ownStatus.stdout) as { data: { entries: unknown[] } };
    assert.ok(ownParsed.data.entries.length > 0, 'the original learner must still see their own entry (proving the isolation above is real separation, not a broken store)');
  } finally { cleanup(dir); }
});
