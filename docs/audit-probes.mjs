import { ValidationGate } from '../dist/packages/validation-gate/src/index.js';
import { DefaultVerifier } from '../dist/packages/verifier-core/src/index.js';
import { computeSpecHash, isResourceViolation } from '../dist/packages/vad-core/src/index.js';
import { EvidenceStore, VadExecution, finalizeAcceptance } from '../dist/packages/vad-runtime/src/index.js';

const spec = () => ({ version: '1.0', atom: { id: 'audit-atom', title: 'Audit fixture' }, goal: 'Audit acceptance gates', success_criteria: [{ id: 'SC-1', description: 'A real validator must pass', validation: 'deterministic' }], risk: { level: 'high' }, resources: { read: ['src/auth/**'], write: ['src/safe.ts'], create: [] }, constraints: { forbidden: ['new dependencies'] }, limits: { max_attempts: 3, max_runtime_seconds: 30, max_cost_usd: 2 } });
const artifact = { artifactHash: 'unverified', diffHash: 'unverified', filesChanged: ['src/safe.ts'], declaredArtifacts: ['src/safe.ts'] };
const results = {};
results.notRunGate = (await new ValidationGate().run(spec(), { ...artifact, evidence: [{ validatorId: 'tests', status: 'NOT_RUN', summary: 'No tests executed' }] })).status;
results.nonzeroExitGate = (await new ValidationGate().run(spec(), { ...artifact, evidence: [{ validatorId: 'tests', status: 'PASS', exitCode: 1, summary: 'Contradictory evidence' }] })).status;
results.readOnlyWriteDetected = isResourceViolation(spec(), ['src/auth/readonly.ts']);
results.prefixEscapeDetected = isResourceViolation(spec(), ['src/auth-evil/escape.ts']);
results.traversalDetected = isResourceViolation(spec(), ['src/auth/../../outside.ts']);
results.emptyEvidenceVerdict = (await new DefaultVerifier().verify({ atom: spec(), specHash: 'incorrect', producedArtifact: artifact, validationEvidence: { status: 'PASS', validators: [] } })).verdict;
results.emptyCriteriaParse = (await new DefaultVerifier().parse({ verdict: 'ACCEPT', criteria: [], scopeViolations: [], residualRisks: [], reasons: [] })).verdict;
const repeating = new VadExecution(spec(), new EvidenceStore());
repeating.ready();
for (let i = 0; i < 4; i++) repeating.attempt(1, false, 'claimed-hash', 0, 0);
results.fourAttemptsNumberedOne = repeating.lifecycle.current;
results.incompleteAcceptance = (await finalizeAcceptance(new EvidenceStore(), { atomId: 'bare', specHash: 'claimed', artifactHash: 'claimed', finalState: 'ACCEPTED' })).finalState;
const mutableSpec = spec();
const store = new EvidenceStore();
const execution = new VadExecution(mutableSpec, store);
const originalHash = computeSpecHash(mutableSpec);
execution.ready(); execution.attempt(1, true, 'claimed-hash', 0, 0); execution.verify('ACCEPT');
mutableSpec.goal = 'Changed after verification';
try { await execution.decide({ decision: 'MERGE', actor: 'audit', timestamp: new Date().toISOString(), automatedOutcome: 'ACCEPT', specHash: originalHash }); }
catch (error) { results.specMutationError = error.message; }
results.persistedAfterSpecMutation = store.records().map(r => r.finalState);
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
