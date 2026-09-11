/**
 * VAD Engine v0.1 — Unified entrypoint.
 *
 * Re-exports the key types and classes from the VAD subsystem packages
 * so consumers can import from a single module.
 */

// vad-core: Atom Spec model, canonicalization, hashing, resource checks
export {
  type AtomSpec,
  type RiskLevel,
  type SuccessCriterion,
  type SuccessValidationMode,
  computeSpecHash,
  canonicalizeSpec,
  finalizeAtomSpec,
  isResourceViolation,
  isOperationViolation,
  canonicalizePath,
  matchesPattern,
  checkForbiddenDependencies,
} from '../../../packages/vad-core/src/index.js';

// vad-runtime: Lifecycle, execution orchestration, evidence persistence
export {
  type LifecycleState,
  type TransitionRecord,
  type HumanDecision,
  type FinalEvidencePackage,
  type AttemptResult,
  type Clock,
  type PersistenceOptions,
  type ExecutionVerdict,
  VadExecution,
  Lifecycle,
  RuntimeBudget,
  EvidenceStore,
  FileEvidenceStore,
  ActiveExecutionRegistry,
  validateHumanDecision,
  finalizeAcceptance,
} from '../../../packages/vad-runtime/src/index.js';

// validation-gate: Deterministic PASS/FAIL gate
export {
  type ValidationRecord,
  type GateArtifacts,
  type GateResult,
  ValidationGate,
} from '../../../packages/validation-gate/src/index.js';

// verifier-core: Independent read-only verifier
export {
  type VerifierVerdict,
  type CriterionResult,
  type VerifierResult,
  type VerificationInput,
  DefaultVerifier,
} from '../../../packages/verifier-core/src/index.js';

// model-adapter: Provider-independent producer abstraction
export {
  type ProducerContext,
  type ProducedArtifact,
  type ProducerResult,
  DeterministicMockProducer,
} from '../../../packages/model-adapter/src/index.js';
