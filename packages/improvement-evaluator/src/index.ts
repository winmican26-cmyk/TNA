import { spawnSync } from 'node:child_process';
import {
  classifyMutation, detectTestManifestTampering, computeCapabilityDelta, authorityWithinCeiling as isAuthorityWithinCeiling,
  computeAuthorityDelta, evaluateBenchmark, evaluatePromotion, hash as hashValue,
  type ImprovementClass, type ImprovementSpec, type CapabilityProfile, type AuthorityCeiling, type BenchmarkResult,
  type RequiredTestManifest, type PromotionDecision, type PromotionStatus,
} from '../../improvement-schema/src/index.js';
import { hashDirectoryTree, diffDirectoryTrees, candidateEnvironment } from '../../improvement-core/src/index.js';
import type { ImprovementStore } from '../../improvement-store/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12). `PromotionEvaluator` — the real orchestration
 * that runs a candidate's actual regression/security tests and benchmarks (real `spawnSync` processes,
 * real filesystem diffing) and feeds REAL, JUST-MEASURED evidence into `evaluatePromotion` (the pure,
 * deterministic decision function in `improvement-schema`). This is the one place `classifyMutation`
 * (and every candidate spec) treats as permanently outside the mutation boundary — see
 * `EVALUATOR_PATH_PREFIX` in `improvement-schema`, which names this exact package path unconditionally.
 * No LLM anywhere in this file decides a promotion outcome (section 49).
 */

export interface BenchmarkSpec {
  readonly benchmarkId: string;
  /** A command that prints a single numeric score to stdout when run in the workspace. */
  readonly command: readonly string[];
  readonly threshold: number;
  readonly parentScore: number;
}

export interface EvaluationInputs {
  readonly tenantId: string;
  readonly generationId: string;
  readonly parentGenerationId: string | null;
  readonly improvementClass: ImprovementClass;
  readonly parentWorkspace: string;
  readonly candidateWorkspace: string;
  readonly spec: ImprovementSpec;
  readonly parentCapabilityProfile: CapabilityProfile;
  readonly candidateCapabilityProfile: CapabilityProfile;
  readonly allowedCapabilityGrowth?: Parameters<typeof computeCapabilityDelta>[3];
  /** `null` means no regression suite is configured for this fixture — treated as PASS by default,
   * documented explicitly in every caller/demo that relies on this rather than silently assumed. */
  readonly regressionTestCommand: readonly string[] | null;
  readonly securityTestCommand: readonly string[] | null;
  readonly benchmarks: readonly BenchmarkSpec[];
  readonly requiredTestManifestBefore: RequiredTestManifest;
  readonly requiredTestManifestAfter: RequiredTestManifest;
  readonly candidateAuthorityProfile: AuthorityCeiling;
  readonly humanApproved: boolean | null;
  readonly independentReviewApproved: boolean | null;
  readonly evaluationProfileHash: string;
  readonly decidedBy: string;
}

export interface EvaluationResult {
  readonly decision: PromotionDecision;
  readonly status: PromotionStatus;
  readonly reason: string;
  readonly benchmarkResults: readonly BenchmarkResult[];
  readonly regressionSuitePassed: boolean;
  readonly securityTestsPassed: boolean;
  readonly evidenceComplete: boolean;
  /** Exposed so callers (e.g. the governor's Ledger-append and Auditor-assessment integrations) can
   * record the exact same booleans this function itself based its decision on, rather than
   * recomputing — or worse, guessing — them a second time. */
  readonly controlPlaneChanged: boolean;
  readonly evaluatorChanged: boolean;
  readonly testTampered: boolean;
  readonly authorityWithinCeiling: boolean;
  readonly hasUnexpectedCapabilityGain: boolean;
}

interface CommandOutcome { readonly ranSuccessfully: boolean; readonly exitCode: number | null; readonly stdout: string }
/** Runs a real, isolated process in `cwd` with a secret-stripped, explicitly-allowlisted environment
 * (section 24-25). `ranSuccessfully:false` means the command itself could not even be spawned/completed
 * (a real infrastructure failure) — distinct from `exitCode !== 0`, which means the command ran and
 * reported a real failure. The caller treats the former as evaluation-infrastructure failure
 * (INDETERMINATE, section 121), never as a candidate PASS. */
function runCommand(command: readonly string[], cwd: string): CommandOutcome {
  if (command.length === 0) return { ranSuccessfully: false, exitCode: null, stdout: '' };
  const [executable, ...args] = command;
  const result = spawnSync(executable!, args, { cwd, encoding: 'utf8', env: candidateEnvironment({}) });
  if (result.error) return { ranSuccessfully: false, exitCode: null, stdout: '' };
  return { ranSuccessfully: true, exitCode: result.status, stdout: result.stdout ?? '' };
}

/**
 * Section 32-51, 78-80: the real end-to-end promotion evaluation for one generation. Every input that
 * COULD be forged (test results, benchmark scores, capability/authority profiles) is instead measured
 * here by actually running the candidate — the caller supplies only workspace paths, commands, and
 * declared profiles for the toy fixture (section 145's documented limitation: capability/authority
 * profiles are configured/declared for v0.1, not derived from deep static analysis of arbitrary code).
 */
export function runPromotionEvaluation(store: ImprovementStore, inputs: EvaluationInputs): EvaluationResult {
  // Section 128: if the accepted parent's real content has changed since this generation's baseline was
  // recorded at creation time, refuse to silently promote against a different baseline — INDETERMINATE,
  // not a guess in either direction, and never a call to evaluatePromotion with a stale premise.
  const generation = store.getGeneration(inputs.tenantId, inputs.generationId);
  const sourceHashBefore = hashDirectoryTree(inputs.parentWorkspace);
  if (sourceHashBefore !== generation.source_hash_before) {
    const staleReason = `Stale parent: the parent workspace's current content hash (${sourceHashBefore}) no longer matches this generation's recorded source_hash_before (${generation.source_hash_before}) — the accepted baseline changed since this generation was created`;
    const decision = store.recordPromotionDecision(inputs.tenantId, {
      generation_id: inputs.generationId, parent_generation_id: inputs.parentGenerationId,
      evaluation_profile_hash: inputs.evaluationProfileHash, spec_hash: inputs.spec.spec_hash, source_hash: sourceHashBefore,
      benchmark_summary_hash: hashValue([]), security_summary_hash: hashValue({}), capability_delta_hash: hashValue({}), authority_delta_hash: null,
      decision: 'INDETERMINATE', decision_reason: staleReason, decided_by: inputs.decidedBy, decided_at: new Date().toISOString(),
    });
    return {
      decision, status: 'INDETERMINATE', reason: staleReason, benchmarkResults: [], regressionSuitePassed: false, securityTestsPassed: false, evidenceComplete: false,
      controlPlaneChanged: false, evaluatorChanged: false, testTampered: false, authorityWithinCeiling: false, hasUnexpectedCapabilityGain: false,
    };
  }
  const sourceHashAfter = hashDirectoryTree(inputs.candidateWorkspace);
  const diffs = diffDirectoryTrees(inputs.parentWorkspace, inputs.candidateWorkspace);
  const changedPaths = diffs.map(d => d.path);
  const mutationDiff = classifyMutation(inputs.generationId, changedPaths, inputs.spec);
  const testTamper = detectTestManifestTampering(inputs.requiredTestManifestBefore, inputs.requiredTestManifestAfter);

  let evidenceComplete = true;
  const regression = inputs.regressionTestCommand ? runCommand(inputs.regressionTestCommand, inputs.candidateWorkspace) : { ranSuccessfully: true, exitCode: 0, stdout: '' };
  if (!regression.ranSuccessfully) evidenceComplete = false;
  const regressionSuitePassed = regression.ranSuccessfully && regression.exitCode === 0;

  const security = inputs.securityTestCommand ? runCommand(inputs.securityTestCommand, inputs.candidateWorkspace) : { ranSuccessfully: true, exitCode: 0, stdout: '' };
  if (!security.ranSuccessfully) evidenceComplete = false;
  const securityTestsPassed = security.ranSuccessfully && security.exitCode === 0;

  const benchmarkResults: BenchmarkResult[] = [];
  for (const benchmark of inputs.benchmarks) {
    const run = runCommand(benchmark.command, inputs.candidateWorkspace);
    if (!run.ranSuccessfully) { evidenceComplete = false; continue; }
    const candidateScore = Number(run.stdout.trim());
    if (Number.isNaN(candidateScore)) { evidenceComplete = false; continue; }
    benchmarkResults.push(evaluateBenchmark(benchmark.benchmarkId, inputs.generationId, benchmark.parentScore, candidateScore, benchmark.threshold, `cmd:${benchmark.command.join(' ')}`));
  }
  const benchmarksAllPass = evidenceComplete && benchmarkResults.length === inputs.benchmarks.length && benchmarkResults.every(r => r.status === 'PASS');

  const capabilityDelta = computeCapabilityDelta(inputs.generationId, inputs.parentCapabilityProfile, inputs.candidateCapabilityProfile, inputs.allowedCapabilityGrowth);
  const authorityContained = isAuthorityWithinCeiling(inputs.candidateAuthorityProfile, inputs.spec.authority_ceiling);
  const authorityDelta = computeAuthorityDelta(inputs.spec.authority_ceiling, inputs.candidateAuthorityProfile);

  const { status, reason } = evaluatePromotion({
    improvementClass: inputs.improvementClass, benchmarksAllPass, regressionSuitePassed, securityTestsPassed,
    capabilityDelta, authorityWithinCeiling: authorityContained, mutationDiff, testTamper,
    humanApproved: inputs.humanApproved, independentReviewApproved: inputs.independentReviewApproved, evidenceComplete,
  });

  const decision = store.recordPromotionDecision(inputs.tenantId, {
    generation_id: inputs.generationId, parent_generation_id: inputs.parentGenerationId,
    evaluation_profile_hash: inputs.evaluationProfileHash, spec_hash: inputs.spec.spec_hash, source_hash: sourceHashAfter,
    benchmark_summary_hash: hashValue(benchmarkResults), security_summary_hash: hashValue({ regressionSuitePassed, securityTestsPassed }),
    capability_delta_hash: capabilityDelta.report_hash, authority_delta_hash: authorityDelta.delta_hash,
    decision: status, decision_reason: reason, decided_by: inputs.decidedBy, decided_at: new Date().toISOString(),
  });

  return {
    decision, status, reason, benchmarkResults, regressionSuitePassed, securityTestsPassed, evidenceComplete,
    controlPlaneChanged: mutationDiff.control_plane_changed, evaluatorChanged: mutationDiff.evaluator_changed,
    testTampered: testTamper.tampered, authorityWithinCeiling: authorityContained, hasUnexpectedCapabilityGain: capabilityDelta.has_unexpected_gain,
  };
}
