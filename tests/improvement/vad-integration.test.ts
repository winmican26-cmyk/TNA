import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyCandidateBuild } from '../../packages/improvement-core/src/vad-integration.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section C: real VAD integration for candidate
 * build acceptance — the actual `finalizeAtomSpec`/`ValidationGate`/`DefaultVerifier`/`VadExecution`
 * pipeline, never a re-implemented parallel verifier.
 */

test('a candidate with real passing regression evidence is ACCEPTED by the real VAD pipeline', async () => {
  const result = await verifyCandidateBuild({
    generationId: 'gen_vad_1', objective: 'improve routing accuracy', maxRuntimeSeconds: 60, maxCostUsd: 1,
    regressionEvidence: [{ validatorId: 'candidate-regression-suite', status: 'PASS', summary: 'regression suite passed', exitCode: 0 }],
  });
  assert.equal(result.verifierVerdict, 'ACCEPT');
  assert.equal(result.finalState, 'ACCEPTED');
});

test('a candidate with real FAILING regression evidence never reaches ACCEPTED — the real VAD lifecycle escalates it before the independent verifier is even called', async () => {
  const result = await verifyCandidateBuild({
    generationId: 'gen_vad_2', objective: 'improve routing accuracy but break tests', maxRuntimeSeconds: 60, maxCostUsd: 1,
    regressionEvidence: [{ validatorId: 'candidate-regression-suite', status: 'FAIL', summary: 'regression suite failed', exitCode: 1 }],
  });
  assert.equal(result.verifierVerdict, 'REJECT');
  assert.equal(result.finalState, 'ESCALATED', 'real VAD semantics: a failed deterministic gate escalates the atom without ever reaching the independent verifier — never fabricated as REJECTED');
  assert.notEqual(result.finalState, 'ACCEPTED');
});

test('a candidate with NO regression evidence at all never reaches ACCEPTED — VAD never treats absent evidence as a pass', async () => {
  const result = await verifyCandidateBuild({
    generationId: 'gen_vad_3', objective: 'no evidence provided', maxRuntimeSeconds: 60, maxCostUsd: 1,
    regressionEvidence: [],
  });
  assert.equal(result.verifierVerdict, 'REJECT');
  assert.equal(result.finalState, 'ESCALATED');
});

test('a candidate whose validator reported PASS but with a non-zero exit code is still REJECTED (an inconsistent PASS is treated as a real failure)', async () => {
  const result = await verifyCandidateBuild({
    generationId: 'gen_vad_4', objective: 'inconsistent evidence', maxRuntimeSeconds: 60, maxCostUsd: 1,
    regressionEvidence: [{ validatorId: 'candidate-regression-suite', status: 'PASS', summary: 'claims pass but exit code says otherwise', exitCode: 1 }],
  });
  assert.equal(result.verifierVerdict, 'REJECT');
});

test('spec hash binding: the same objective and generation id always produce the same atom identity/spec hash (deterministic, replayable)', async () => {
  const first = await verifyCandidateBuild({ generationId: 'gen_vad_5', objective: 'deterministic check', maxRuntimeSeconds: 60, maxCostUsd: 1, regressionEvidence: [{ validatorId: 'v', status: 'PASS', summary: 's', exitCode: 0 }] });
  const second = await verifyCandidateBuild({ generationId: 'gen_vad_5', objective: 'deterministic check', maxRuntimeSeconds: 60, maxCostUsd: 1, regressionEvidence: [{ validatorId: 'v', status: 'PASS', summary: 's', exitCode: 0 }] });
  assert.equal(first.atomId, second.atomId);
  assert.equal(first.specHash, second.specHash);
});
