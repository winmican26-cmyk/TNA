import assert from 'node:assert/strict';

import test from 'node:test';

import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';

import { resolve, sep } from 'node:path';

import { pathToFileURL } from 'node:url';

import { canonicalizeSpec, computeSpecHash, finalizeAtomSpec, isResourceViolation, isOperationViolation, canonicalizePath, matchesPattern, checkForbiddenDependencies, type AtomSpec } from '../../packages/vad-core/src/index.js';

import { ValidationGate } from '../../packages/validation-gate/src/index.js';

import { DefaultVerifier } from '../../packages/verifier-core/src/index.js';

import { DeterministicMockProducer } from '../../packages/model-adapter/src/index.js';

import {

  EvidenceStore,

  FileEvidenceStore,

  type FinalEvidencePackage,

  ActiveExecutionRegistry,

  Lifecycle,

  RuntimeBudget,

  VadExecution,

  finalizeAcceptance,

  validateHumanDecision,
  type Clock,

} from '../../packages/vad-runtime/src/index.js';



const baseSpec: AtomSpec = {

  version: '1.0',

  atom: {

    id: 'atom-auth-001',

    title: 'Session expiry validation',

  },

  goal: 'Add validation that rejects expired sessions while preserving valid sessions.',

  success_criteria: [

    { id: 'SC-1', description: 'Expired sessions return HTTP 401.', validation: 'deterministic' },

    { id: 'SC-2', description: 'Valid sessions continue to succeed.', validation: 'deterministic' },

  ],

  risk: { level: 'medium' },

  resources: {

    read: ['src/auth/**'],

    write: ['src/auth/session.ts'],

    create: ['tests/auth/session-expiry.test.ts'],

  },

  constraints: {

    forbidden: ['new dependencies', 'database schema changes'],

  },

  limits: {

    max_attempts: 3,

    max_runtime_seconds: 300,

    max_cost_usd: 2,

  },

};



test('atom spec rejects unsupported version', () => {

  const invalid = { ...baseSpec, version: '2.0' } as const;

  assert.throws(() => finalizeAtomSpec(invalid as unknown));

});



test('canonical spec hash ignores insertion order', () => {

  const ordered = canonicalizeSpec(baseSpec);

  const scrambled = canonicalizeSpec({

    ...baseSpec,

    resources: {

      create: [...baseSpec.resources.create].reverse(),

      read: [...baseSpec.resources.read].reverse(),

      write: [...baseSpec.resources.write].reverse(),

    },

  });

  assert.equal(ordered, scrambled);

  assert.equal(computeSpecHash(baseSpec), computeSpecHash({ ...baseSpec, resources: { ...baseSpec.resources, write: [...baseSpec.resources.write].reverse() } }));

});



test('resource manifest detects undeclared file changes', () => {

  const result = isResourceViolation(baseSpec, ['src/auth/session.ts', 'src/other.ts']);

  assert.equal(result, true);

});



test('validation gate accepts deterministic evidence and rejects false self-claims', async () => {

  const gate = new ValidationGate();

  const pass = await gate.run(baseSpec, {

    artifactHash: 'abc',

    diffHash: 'def',

    filesChanged: ['src/auth/session.ts'],

    evidence: [

      { validatorId: 'unit-tests', status: 'PASS', summary: '2 tests passed', exitCode: 0 },

      { validatorId: 'typecheck', status: 'PASS', summary: 'typecheck ok', exitCode: 0 },

    ],

    declaredArtifacts: ['src/auth/session.ts'],

  });

  assert.equal(pass.status, 'PASS');



  const fail = await gate.run(baseSpec, {

    artifactHash: 'xyz',

    diffHash: 'zzz',

    filesChanged: ['src/auth/session.ts', 'src/other.ts'],

    evidence: [

      { validatorId: 'unit-tests', status: 'FAIL', summary: 'tests failed', exitCode: 1 },

    ],

    declaredArtifacts: ['src/auth/session.ts'],

  });

  assert.equal(fail.status, 'FAIL');

});



test('retry context excludes prior producer conversation history', async () => {

  const producer = new DeterministicMockProducer();

  const initial = await producer.produce(baseSpec, { artifacts: ['src/auth/session.ts'], failure: null, priorConversation: ['old output'] });

  const retry = await producer.produce(baseSpec, { artifacts: ['src/auth/session.ts'], failure: 'unit-tests failed', priorConversation: ['old output', 'later output'] });

  assert.equal(initial.context.priorConversation.length, 0);

  assert.equal(retry.context.failure, 'unit-tests failed');

  assert.equal(retry.context.priorConversation.length, 0);

});



test('verifier rejects invented criteria and missing criteria', async () => {

  const verifier = new DefaultVerifier();

  const result = await verifier.verify({

    atom: baseSpec,

    specHash: computeSpecHash(baseSpec),

    validationEvidence: {

      validators: [

        { validatorId: 'unit-tests', status: 'PASS', summary: '2 tests passed', exitCode: 0 },

      ],

      status: 'PASS',

    },

    producedArtifact: {

      artifactHash: 'hash',

      diffHash: 'diff',

      filesChanged: ['src/auth/session.ts'],

      declaredArtifacts: ['src/auth/session.ts'],

    },

  });



  assert.equal(result.verdict, 'ACCEPT');



  const invalidResult = await verifier.verify({

    atom: baseSpec,

    specHash: computeSpecHash(baseSpec),

    validationEvidence: {

      validators: [

        { validatorId: 'unit-tests', status: 'PASS', summary: '2 tests passed', exitCode: 0 },

      ],

      status: 'PASS',

    },

    producedArtifact: {

      artifactHash: 'hash',

      diffHash: 'diff',

      filesChanged: ['src/auth/session.ts'],

      declaredArtifacts: ['src/auth/session.ts'],

      evidence: [

        { validatorId: 'unit-tests', status: 'PASS', summary: '2 tests passed', exitCode: 0 },

      ],

    },

    customCriteria: [{ id: 'SC-99', status: 'MET' }],

  } satisfies Parameters<typeof verifier.verify>[0]);



  assert.equal(invalidResult.verdict, 'INVALID');

});



test('accepted demo atom completes the VAD flow', async () => {

  const producer = new DeterministicMockProducer();

  const gate = new ValidationGate();

  const verifier = new DefaultVerifier();



  const initial = await producer.produce(baseSpec, { artifacts: ['src/auth/session.ts'], failure: null, priorConversation: [] });

  const firstGate = await gate.run(baseSpec, {

    ...initial.artifact,

    evidence: [{ validatorId: 'unit-tests', status: 'PASS', summary: 'demo passes', exitCode: 0 }],

  });

  assert.equal(firstGate.status, 'PASS');



  const verification = await verifier.verify({

    atom: baseSpec,

    specHash: computeSpecHash(baseSpec),

    producedArtifact: {

      ...initial.artifact,

      evidence: firstGate.validators,

    },

    validationEvidence: { status: 'PASS', validators: firstGate.validators },

  });



  assert.equal(verification.verdict, 'ACCEPT');

});



test('lifecycle rejects illegal terminal transitions and records legal history', () => {

  const lifecycle = new Lifecycle(baseSpec);

  assert.throws(() => lifecycle.transition('ACCEPTED', 'premature'));

  lifecycle.transition('READY', 'spec accepted');

  lifecycle.transition('PRODUCING', 'producer started');

  assert.equal(lifecycle.history.length, 2);

  assert.equal(lifecycle.current, 'PRODUCING');

});



test('runtime budget makes attempt four impossible and enforces cost and runtime', () => {

  const budget = new RuntimeBudget(baseSpec);

  budget.assertCanAttempt(1, 0);

  budget.assertCanAttempt(2, 0.5);

  budget.assertCanAttempt(3, 1);

  assert.throws(() => budget.assertCanAttempt(4, 1.5), /attempt limit/i);

  assert.throws(() => budget.assertCanAttempt(2, 2.01), /cost limit/i);

  assert.throws(() => budget.assertCanAttempt(2, 0, baseSpec.limits.max_runtime_seconds + 1), /runtime limit/i);

});



test('strict verifier parser rejects malformed output and unmet acceptance', async () => {

  const verifier = new DefaultVerifier();

  await assert.rejects(() => verifier.parse({ verdict: 'MAYBE' }), /verdict/i);

  await assert.rejects(() => verifier.parse('all good'), /object/i);

  await assert.rejects(() => verifier.parse({ verdict: 'ACCEPT', criteria: [{ criterionId: 'SC-1', status: 'MET', evidence: [] }] }), /criteria/i);

  await assert.rejects(() => verifier.parse({

    verdict: 'ACCEPT',

    criteria: [

      { criterionId: 'SC-1', status: 'MET', evidence: ['ok'] },

      { criterionId: 'SC-2', status: 'NOT_MET', evidence: ['failed'] },

    ],

    scopeViolations: [],

    residualRisks: [],

    reasons: [],

  }), /unmet/i);

});



test('human override requires an auditable decision and preserves the spec hash', () => {

  const specHash = computeSpecHash(baseSpec);

  assert.throws(() => validateHumanDecision({ decision: 'OVERRIDE_ACCEPT', actor: '', timestamp: new Date().toISOString(), rationale: 'x', automatedOutcome: 'REJECT', specHash }), /actor/i);

  assert.throws(() => validateHumanDecision({ decision: 'OVERRIDE_ACCEPT', actor: 'reviewer', timestamp: new Date().toISOString(), rationale: '', automatedOutcome: 'REJECT', specHash }), /rationale/i);

  const decision = validateHumanDecision({ decision: 'OVERRIDE_ACCEPT', actor: 'reviewer', timestamp: new Date().toISOString(), rationale: 'Reviewed deterministic evidence', automatedOutcome: 'REJECT', specHash });

  assert.equal(decision.specHash, specHash);

});



test('acceptance requires persisted evidence and rejects integrity mismatches', async () => {

  const store = new EvidenceStore();

  const packageData = {

    atomId: baseSpec.atom.id,

    specHash: computeSpecHash(baseSpec),

    artifactHash: 'artifact-a',

    finalState: 'ACCEPTED' as const,

  };

  await assert.rejects(() => finalizeAcceptance(store, packageData, { failWrites: true }), /persist/i);

  await assert.rejects(() => finalizeAcceptance(store, { ...packageData, specHash: 'wrong' }, { expectedSpecHash: packageData.specHash }), /spec hash/i);

  const persisted = await finalizeAcceptance(store, packageData);

  assert.equal(persisted.finalState, 'ACCEPTED');

  assert.equal(store.records().length, 1);

});



async function temporaryEvidenceDirectory(t: { after: (fn: () => Promise<void>) => void }): Promise<URL> {

  const root = resolve('test-artifacts');

  await mkdir(root, { recursive: true });

  const directory = await mkdtemp(resolve(root, 'vad-store-'));

  assert.ok(directory.startsWith(`${root}${sep}`));

  t.after(() => rm(directory, { recursive: true, force: true }));

  return pathToFileURL(`${directory}${sep}`);

}



test('file evidence store persists final evidence and prevents conflicting finalization', async (t) => {

  const directory = await temporaryEvidenceDirectory(t);

  const store = new FileEvidenceStore(directory);

  const packageData = {

    atomId: 'atom-remediation',

    specHash: 'spec-a',

    artifactHash: 'artifact-a',

    finalState: 'REJECTED' as const,

  };

  await store.persist(packageData);

  await assert.rejects(() => store.persist({ ...packageData, artifactHash: 'artifact-b' }), /conflict/i);

});



test('file evidence store retries canonical records without changing generated completion time', async (t) => {

  const directory = await temporaryEvidenceDirectory(t);

  const store = new FileEvidenceStore(directory);

  const record = { atomId: 'retry', specHash: 's', artifactHash: 'a', finalState: 'ACCEPTED' as const, details: { b: 2, a: 1 } };

  await store.persist(record);

  const filename = (await readdir(directory))[0]!;

  const original = await readFile(new URL(filename, directory), 'utf8');

  await new FileEvidenceStore(directory).persist({ ...record, details: { a: 1, b: 2 } });

  assert.equal(await readFile(new URL(filename, directory), 'utf8'), original);

  await assert.rejects(() => store.persist({ ...record, completedAt: '2000-01-01T00:00:00.000Z' }), /conflict/i);

});



test('file evidence store concurrent identical writers succeed and conflicting writers have one winner', async (t) => {

  const directory = await temporaryEvidenceDirectory(t);

  const record = { atomId: 'concurrent', specHash: 's', artifactHash: 'a', finalState: 'ACCEPTED' as const };

  await Promise.all(Array.from({ length: 12 }, () => new FileEvidenceStore(directory).persist(record)));

  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => new FileEvidenceStore(directory).persist({ ...record, atomId: 'conflict', artifactHash: `artifact-${i}` })));

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);

  for (const result of results) if (result.status === 'rejected') assert.match(String(result.reason), /conflict/i);

  assert.equal((await readdir(directory)).length, 2);

});



test('file evidence store safely separates path-like atom identifiers', async (t) => {

  const directory = await temporaryEvidenceDirectory(t);

  for (const atomId of ['x/a', 'y/a', '../escape', 'a?b', 'a#b', 'CON']) {

    await new FileEvidenceStore(directory).persist({ atomId, specHash: 's', artifactHash: 'a', finalState: 'REJECTED' });

  }

  const files = await readdir(directory);

  assert.equal(files.length, 6);

  const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(new URL(file, directory), 'utf8')) as { atomId: string }));

  assert.equal(new Set(records.map((record) => record.atomId)).size, 6);

});



test('accepted Level 2 flow persists evidence before entering ACCEPTED', async () => {

  const store = new EvidenceStore();

  const execution = new VadExecution(baseSpec, store);

  execution.ready();

  execution.attempt({ passed: false, artifactHash: 'artifact-failed', costUsd: 0.25 });

  execution.attempt({ passed: true, artifactHash: 'artifact-final', costUsd: 0.25 });

  execution.verify('ACCEPT');

  const evidence = await execution.decide({

    decision: 'MERGE',

    actor: 'reviewer-1',

    timestamp: new Date().toISOString(),

    automatedOutcome: 'ACCEPT',

    specHash: computeSpecHash(baseSpec),

  });

  assert.equal(evidence.finalState, 'ACCEPTED');

  assert.equal(execution.lifecycle.current, 'ACCEPTED');

  assert.deepEqual(execution.events, [

    'ATOM CREATED', 'ATOM READY', 'PRODUCER ATTEMPT 1', 'DETERMINISTIC GATE FAILED',

    'FRESH RETRY CREATED', 'PRODUCER ATTEMPT 2', 'DETERMINISTIC GATE PASSED',

    'VERIFIER ACCEPTED', 'AWAITING HUMAN', 'HUMAN DECISION RECORDED',

    'EVIDENCE PACKAGE PERSISTED', 'EVIDENCE INTEGRITY VERIFIED', 'ATOM ACCEPTED',

  ]);

});



test('rejected and exhausted flows persist evidence and close safely', async () => {

  const rejectedStore = new EvidenceStore();

  const rejected = new VadExecution(baseSpec, rejectedStore);

  rejected.ready();

  rejected.attempt({ passed: true, artifactHash: 'artifact-rejected', costUsd: 0.25 });

  rejected.verify('REJECT');

  await rejected.decide({

    decision: 'REJECT',

    actor: 'reviewer-2',

    timestamp: new Date().toISOString(),

    automatedOutcome: 'REJECT',

    specHash: computeSpecHash(baseSpec),

  });

  assert.equal(rejected.lifecycle.current, 'REJECTED');

  assert.equal(rejectedStore.records()[0]?.finalState, 'REJECTED');



  const escalated = new VadExecution(baseSpec, new EvidenceStore());

  escalated.ready();

  escalated.attempt({ passed: false, artifactHash: 'a1', costUsd: 0.25 });

  escalated.attempt({ passed: false, artifactHash: 'a2', costUsd: 0.25 });

  escalated.attempt({ passed: false, artifactHash: 'a3', costUsd: 0.25 });

  assert.equal(escalated.lifecycle.current, 'ESCALATED');

  assert.ok(escalated.events.includes('ATOM ESCALATED'));

});



test('active execution registry rejects duplicate runs', () => {

  const registry = new ActiveExecutionRegistry();

  registry.acquire(baseSpec.atom.id);

  assert.throws(() => registry.acquire(baseSpec.atom.id), /active run/i);

  registry.release(baseSpec.atom.id);

  registry.acquire(baseSpec.atom.id);

});



// ═══════════════════════════════════════════════════════════════════════════════

// S4: V1 — Trusted Validation and Verifier Contract

// ═══════════════════════════════════════════════════════════════════════════════



test('V1: NOT_RUN mandatory validator fails the gate', async () => {

  const gate = new ValidationGate();

  const result = await gate.run(baseSpec, {

    artifactHash: 'abc',

    diffHash: 'def',

    filesChanged: ['src/auth/session.ts'],

    evidence: [

      { validatorId: 'unit-tests', status: 'NOT_RUN', summary: 'Validator did not execute' },

    ],

    declaredArtifacts: ['src/auth/session.ts'],

  });

  assert.equal(result.status, 'FAIL');

});



test('V1: PASS with nonzero exit code fails the gate', async () => {

  const gate = new ValidationGate();

  const result = await gate.run(baseSpec, {

    artifactHash: 'abc',

    diffHash: 'def',

    filesChanged: ['src/auth/session.ts'],

    evidence: [

      { validatorId: 'unit-tests', status: 'PASS', exitCode: 1, summary: 'Reported pass but exited with error' },

    ],

    declaredArtifacts: ['src/auth/session.ts'],

  });

  assert.equal(result.status, 'FAIL');

});



test('V1: wrong spec hash invalidates verification', async () => {

  const verifier = new DefaultVerifier();

  const result = await verifier.verify({

    atom: baseSpec,

    specHash: 'wrong-hash-value',

    validationEvidence: {

      validators: [

        { validatorId: 'unit-tests', status: 'PASS', summary: 'ok', exitCode: 0 },

      ],

      status: 'PASS',

    },

    producedArtifact: {

      artifactHash: 'hash',

      diffHash: 'diff',

      filesChanged: ['src/auth/session.ts'],

      declaredArtifacts: ['src/auth/session.ts'],

    },

  });

  assert.equal(result.verdict, 'INVALID');

});



test('V1: empty verifier criteria cannot ACCEPT', async () => {

  const verifier = new DefaultVerifier();

  await assert.rejects(() => verifier.parse({

    verdict: 'ACCEPT',

    criteria: [],

    scopeViolations: [],

    residualRisks: [],

    reasons: [],

  }), /criterion|criteria|empty/i);

});



test('V1: verifier ACCEPT requires validation evidence passed', async () => {

  const verifier = new DefaultVerifier();

  const result = await verifier.verify({

    atom: baseSpec,

    specHash: computeSpecHash(baseSpec),

    validationEvidence: {

      validators: [

        { validatorId: 'unit-tests', status: 'FAIL', summary: 'tests failed', exitCode: 1 },

      ],

      status: 'FAIL',

    },

    producedArtifact: {

      artifactHash: 'hash',

      diffHash: 'diff',

      filesChanged: ['src/auth/session.ts'],

      declaredArtifacts: ['src/auth/session.ts'],

    },

  });

  assert.equal(result.verdict, 'REJECT');

});



test('V1: missing required validator evidence blocks acceptance', async () => {

  const verifier = new DefaultVerifier();

  const result = await verifier.verify({

    atom: baseSpec,

    specHash: computeSpecHash(baseSpec),

    validationEvidence: {

      validators: [],

      status: 'PASS',

    },

    producedArtifact: {

      artifactHash: 'hash',

      diffHash: 'diff',

      filesChanged: ['src/auth/session.ts'],

      declaredArtifacts: ['src/auth/session.ts'],

    },

  });

  assert.ok(result.verdict === 'REJECT' || result.verdict === 'INVALID');

});



// ═══════════════════════════════════════════════════════════════════════════════

// S5: V2 — Operation-Aware Resource and Dependency Checks

// ═══════════════════════════════════════════════════════════════════════════════



test('V2: read-only path modified is a violation', () => {

  // src/auth/helpers.ts matches src/auth/** (read) but NOT src/auth/session.ts (write)

  const result = isOperationViolation(baseSpec, 'src/auth/helpers.ts', 'write');

  assert.equal(result, true);

});



test('V2: write path modified is allowed', () => {

  const result = isOperationViolation(baseSpec, 'src/auth/session.ts', 'write');

  assert.equal(result, false);

});



test('V2: src/auth/** does not match src/auth-evil/file.ts', () => {

  const result = matchesPattern('src/auth/**', 'src/auth-evil/file.ts');

  assert.equal(result, false);

});



test('V2: traversal path rejected', () => {

  assert.throws(() => canonicalizePath('src/auth/../../outside.ts'), /traversal/i);

  // Also verify isResourceViolation treats traversal paths as a violation

  const result = isResourceViolation(baseSpec, ['src/auth/../../outside.ts']);

  assert.equal(result, true);

});



test('V2: absolute path escape rejected', () => {

  assert.throws(() => canonicalizePath('/etc/passwd'), /absolute/i);

  // Also verify isResourceViolation treats absolute paths as a violation

  const result = isResourceViolation(baseSpec, ['/etc/passwd']);

  assert.equal(result, true);

});



test('V2: forbidden dependency added is detected', () => {

  // baseSpec.constraints.forbidden includes 'new dependencies'

  const violations = checkForbiddenDependencies(

    baseSpec,

    ['express'],

    ['express', 'sqlite3'],

  );

  assert.ok(violations.includes('sqlite3'));

  assert.equal(violations.length, 1);

});



// ── S6: V3–V5 Operational lifecycle integration ─────────────────────────



test('V3: spec tampered after verification blocks acceptance', async () => {

  const store = new EvidenceStore();

  const spec = { ...baseSpec, atom: { ...baseSpec.atom, id: 'v3-spec-tamper' } };

  const exec = new VadExecution(spec, store);

  exec.ready();

  exec.attempt({ passed: true, artifactHash: 'artifact-a', costUsd: 0.1 });

  exec.verify('ACCEPT');

  // Tamper the spec hash in the decision

  await assert.rejects(

    () => exec.decide({

      decision: 'MERGE', actor: 'reviewer',

      timestamp: new Date().toISOString(), automatedOutcome: 'ACCEPT',

      specHash: 'tampered-hash',

    }),

    /spec hash/i,

  );

  assert.equal(store.records().length, 0, 'ACCEPTED must not be persisted');

});



test('V3: evidence persistence failure blocks acceptance', async () => {

  const store = new EvidenceStore();

  const spec = { ...baseSpec, atom: { ...baseSpec.atom, id: 'v3-persist-fail' } };

  const exec = new VadExecution(spec, store);

  const specHash = computeSpecHash(spec);

  exec.ready();

  exec.attempt({ passed: true, artifactHash: 'artifact-a', costUsd: 0.1 });

  exec.verify('ACCEPT');

  await assert.rejects(

    () => finalizeAcceptance(store, {

      atomId: spec.atom.id, specHash, artifactHash: 'artifact-a', finalState: 'ACCEPTED',

    }, { failWrites: true }),

    /persist/i,

  );

  assert.equal(store.records().length, 0, 'ACCEPTED must not be persisted when writes fail');

});



test('V4: RuntimeBudget rejects NaN, Infinity, and negative values', () => {

  const budget = new RuntimeBudget(baseSpec);

  assert.throws(() => budget.assertCanAttempt(NaN, 0), /invalid/i);

  assert.throws(() => budget.assertCanAttempt(1, NaN), /invalid/i);

  assert.throws(() => budget.assertCanAttempt(1, 0, NaN), /invalid/i);

  assert.throws(() => budget.assertCanAttempt(Infinity, 0), /invalid/i);

  assert.throws(() => budget.assertCanAttempt(1, Infinity), /invalid/i);

  assert.throws(() => budget.assertCanAttempt(1, 0, Infinity), /invalid/i);

  assert.throws(() => budget.assertCanAttempt(1, -1), /invalid/i);

  assert.throws(() => budget.assertCanAttempt(1, 0, -1), /invalid/i);

  assert.throws(() => budget.assertCanAttempt(-1, 0), /invalid/i);

  assert.throws(() => budget.assertCanAttempt(0, 0), /invalid/i);

});



test('V4: runtime owns attempt numbers — caller cannot select or reset them', () => {
  const store = new EvidenceStore();
  const spec = { ...baseSpec, atom: { ...baseSpec.atom, id: 'v4-owned-attempts' } };
  const exec = new VadExecution(spec, store);
  exec.ready();

  // Runtime assigns attempt 1
  const a1 = exec.attempt({ passed: false, artifactHash: 'a', costUsd: 0.1 });
  assert.equal(a1, 1, 'first attempt must be 1');
  assert.equal(exec.currentAttemptCount, 1);

  // Runtime assigns attempt 2
  const a2 = exec.attempt({ passed: false, artifactHash: 'b', costUsd: 0.1 });
  assert.equal(a2, 2, 'second attempt must be 2');
  assert.equal(exec.currentAttemptCount, 2);

  // Runtime assigns attempt 3
  const a3 = exec.attempt({ passed: false, artifactHash: 'c', costUsd: 0.1 });
  assert.equal(a3, 3, 'third attempt must be 3');
  assert.equal(exec.currentAttemptCount, 3);

  // Attempt 4 is impossible — max_attempts = 3, already escalated
  assert.equal(exec.lifecycle.current, 'ESCALATED');
});

test('V4: attempt exhaustion transitions to ESCALATED and blocks further attempts', () => {
  const store = new EvidenceStore();
  const spec = { ...baseSpec, atom: { ...baseSpec.atom, id: 'v4-escalation' }, limits: { ...baseSpec.limits, max_attempts: 2 } };
  const exec = new VadExecution(spec, store);
  exec.ready();

  exec.attempt({ passed: false, artifactHash: 'a', costUsd: 0.1 });
  exec.attempt({ passed: false, artifactHash: 'b', costUsd: 0.1 });
  assert.equal(exec.lifecycle.current, 'ESCALATED');
  assert.ok(exec.events.includes('ATOM ESCALATED'));

  // No more attempts possible — budget rejects before lifecycle check
  assert.throws(
    () => exec.attempt({ passed: false, artifactHash: 'c', costUsd: 0.1 }),
    /attempt limit|illegal lifecycle/i,
  );
});

test('V4: caller cannot reset aggregate cost by starting another attempt', () => {
  const store = new EvidenceStore();
  const spec = { ...baseSpec, atom: { ...baseSpec.atom, id: 'v4-cost' } };
  const exec = new VadExecution(spec, store);
  exec.ready();

  exec.attempt({ passed: false, artifactHash: 'a', costUsd: 1.5 });
  assert.equal(exec.currentAggregateCost, 1.5);

  // Next attempt would push total to 3.0 — exceeds max_cost_usd of 2
  assert.throws(
    () => exec.attempt({ passed: false, artifactHash: 'b', costUsd: 1.5 }),
    /cost limit/i,
  );
});

test('V4: runtime-owned clock derives elapsed time — caller cannot override', () => {
  let clockMs = 1000;
  const clock: Clock = () => clockMs;
  const store = new EvidenceStore();
  // max_runtime_seconds = 10 for this test
  const spec = { ...baseSpec, atom: { ...baseSpec.atom, id: 'v4-clock' }, limits: { ...baseSpec.limits, max_runtime_seconds: 10 } };
  const exec = new VadExecution(spec, store, clock);
  exec.ready();

  // Attempt 1 at t=1s
  exec.attempt({ passed: false, artifactHash: 'a', costUsd: 0.1 });
  assert.ok(exec.currentElapsedSeconds < 1, 'elapsed should be near 0 at start');

  // Advance clock past the 10s limit
  clockMs = 1000 + 11_000; // 11 seconds elapsed

  // Next attempt should be blocked by runtime limit
  assert.throws(
    () => exec.attempt({ passed: false, artifactHash: 'b', costUsd: 0.1 }),
    /runtime limit/i,
  );
});

test('V4: negative and invalid cost values rejected', () => {
  const store = new EvidenceStore();
  const spec = { ...baseSpec, atom: { ...baseSpec.atom, id: 'v4-invalid' } };
  const exec = new VadExecution(spec, store);
  exec.ready();

  assert.throws(() => exec.attempt({ passed: false, artifactHash: 'a', costUsd: -1 }), /invalid cost/i);
  assert.throws(() => exec.attempt({ passed: false, artifactHash: 'a', costUsd: NaN }), /invalid cost/i);
  assert.throws(() => exec.attempt({ passed: false, artifactHash: 'a', costUsd: Infinity }), /invalid cost/i);
});

test('V4: override requires actor, rationale, records verifier outcome and preserves spec hash', () => {
  const specHash = computeSpecHash(baseSpec);
  // Override without actor
  assert.throws(() => validateHumanDecision({
    decision: 'OVERRIDE_ACCEPT', actor: '', timestamp: new Date().toISOString(),
    rationale: 'reviewed', automatedOutcome: 'REJECT', specHash,
  }), /actor/i);

  // Override without rationale
  assert.throws(() => validateHumanDecision({
    decision: 'OVERRIDE_ACCEPT', actor: 'reviewer', timestamp: new Date().toISOString(),
    rationale: '', automatedOutcome: 'REJECT', specHash,
  }), /rationale/i);

  // Valid override records all required fields
  const decision = validateHumanDecision({
    decision: 'OVERRIDE_ACCEPT', actor: 'lead-reviewer', timestamp: '2026-09-10T12:00:00.000Z',
    rationale: 'Deterministic evidence reviewed manually', automatedOutcome: 'REJECT', specHash,
  });
  assert.equal(decision.actor, 'lead-reviewer');
  assert.equal(decision.rationale, 'Deterministic evidence reviewed manually');
  assert.equal(decision.automatedOutcome, 'REJECT');
  assert.equal(decision.specHash, specHash);
  assert.equal(decision.timestamp, '2026-09-10T12:00:00.000Z');

  // Override cannot change spec hash
  assert.equal(decision.specHash, computeSpecHash(baseSpec));
});

test('V5: FileEvidenceStore end-to-end with restart proof', async (t) => {
  const directory = await temporaryEvidenceDirectory(t);
  const store1 = new FileEvidenceStore(directory);
  const record: FinalEvidencePackage = {
    atomId: 'v5-restart-test', specHash: 'spec-hash-1',
    artifactHash: 'artifact-hash-1', finalState: 'ACCEPTED',
  };
  await store1.persist(record);

  // "Restart" — create a new store instance pointing at the same directory
  const store2 = new FileEvidenceStore(directory);
  // Re-persist same record should be idempotent (proves reload)
  await store2.persist(record);

  // Conflicting data should still be rejected after restart
  await assert.rejects(
    () => store2.persist({ ...record, artifactHash: 'different-hash' }),
    /conflict/i,
  );
});

test('V5: rejected and escalated atoms survive FileEvidenceStore restart', async (t) => {
  const directory = await temporaryEvidenceDirectory(t);
  const store = new FileEvidenceStore(directory);

  const rejected: FinalEvidencePackage = {
    atomId: 'v5-rejected', specHash: 's', artifactHash: 'a', finalState: 'REJECTED',
  };
  const escalated: FinalEvidencePackage = {
    atomId: 'v5-escalated', specHash: 's', artifactHash: 'a', finalState: 'ESCALATED',
  };
  await store.persist(rejected);
  await store.persist(escalated);

  // Restart with new store instance
  const store2 = new FileEvidenceStore(directory);
  // Idempotent re-persist proves state survived
  await store2.persist(rejected);
  await store2.persist(escalated);
  // Conflicting changes still blocked
  await assert.rejects(() => store2.persist({ ...rejected, finalState: 'ACCEPTED' }), /conflict/i);
  await assert.rejects(() => store2.persist({ ...escalated, finalState: 'ACCEPTED' }), /conflict/i);
});
