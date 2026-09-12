# TNA Recursive Improvement Governance v0.1 — Architecture Overview

This document describes the architecture as actually implemented in `packages/improvement-schema`,
`packages/improvement-store`, `packages/improvement-core`, `packages/improvement-evaluator`, and
`apps/tna-improvement-governor`. It does not describe anything not implemented; where a capability is
partial or absent, this document says so explicitly rather than implying otherwise.

## The pipeline

```
 accepted generation (System.accepted_generation_id)
        │
        ▼
   ImprovementProposal (untrusted candidate/agent input — never itself an authority object)
        │  validateImprovementProposal()
        ▼
   ImprovementSpec (trusted orchestration builds this; immutable once created — see
        │           improvement-spec-v0.1.md)
        │  buildImprovementSpec()
        ▼
   classification (CLASS_0_CONFIG .. CLASS_5_AUTHORITY_OR_EVALUATOR — see
        │          improvement-classification-v0.1.md)
        ▼
   Gate authorization (real, unmodified apps/tna-gate-api — every consequential operation is a real
        │              AuthorizationRequest against a real envelope; ALLOW/BLOCK/HOLD)
        ▼
   isolated mutation workspace (real filesystem copy under improvement/.workspaces/<generation_id>,
        │                       path-safety-checked — see mutation-boundary-v0.1.md)
        ▼
   candidate build (candidateFiles written into the isolated workspace only; the parent workspace is
        │           never mutated)
        ▼
   VAD verification (real apps/tna-platform-style VadExecution/ValidationGate/DefaultVerifier —
        │            see evaluator-independence-v0.1.md)
        ▼
   PromotionEvaluator (real runPromotionEvaluation: real spawned regression/security/benchmark
        │              processes, real classifyMutation/detectTestManifestTampering/
        │              computeCapabilityDelta/computeAuthorityDelta — see promotion-policy-v0.1.md)
        ▼
   Sentinel session (real SentinelRuntime session backs canary execution — see canary-policy-v0.1.md)
        ▼
   canary
        │
        ├──▶ PROMOTED (system's accepted_generation_id atomically updated)
        │        │
        │        └──▶ ROLLED_BACK (rollback-v0.1.md)
        │
        ├──▶ REJECTED (terminal, history retained)
        │
        └──▶ INDETERMINATE (uncertain evidence — never silently resolved either direction)
        ▼
   Ledger (every state transition and evaluation signal appended as a real, hash-chained event under
        │  the additive `improvement-governance` source component — see lineage-v0.1.md)
        ▼
   Auditor-equivalent assessment (packages/improvement-core/src/auditor-integration.ts — reads only
                                   real recorded Ledger evidence; INSUFFICIENT_EVIDENCE where evidence
                                   is missing, never a synthetic PASS)
```

## What each stage actually is

- **Accepted generation**: `ImprovementSystem.accepted_generation_id` in `ImprovementStore` — the one
  generation currently treated as the system's live baseline. Updated atomically only as part of a
  `PROMOTED` transition.
- **Proposal**: `ImprovementProposal` (`packages/improvement-schema`) — shape-validated untrusted input.
  `validateImprovementProposal()` never produces authority; it only proves the input is well-formed.
- **Spec**: `ImprovementSpec`, built only by trusted orchestration (`buildImprovementSpec()`), hashed and
  immutable once created. See `improvement-spec-v0.1.md`.
- **Classification**: `ImprovementClass` (`CLASS_0_CONFIG`..`CLASS_5_AUTHORITY_OR_EVALUATOR`) with a fixed
  `CLASS_POLICY` table determining automated-promotion eligibility and approval requirements. See
  `improvement-classification-v0.1.md`.
- **Gate**: the real, unmodified `apps/tna-gate-api` `Gate` class — every improvement operation
  (`authorize_generation`, `build`, `start_canary`, `promote`, `rollback`, `authority_expansion`,
  `invoke_candidate_tool`) is authorized through a real `AuthorizationRequest` against a real envelope
  registered for the governor agent identity.
- **Mutation workspace**: `packages/improvement-core`'s `createIsolatedWorkspace`/`assertInsideWorkspace` —
  a real, path-safety-checked filesystem copy of the parent, never the parent itself.
- **VAD**: `packages/improvement-core/src/vad-integration.ts`'s `verifyCandidateBuild()`, mirroring the
  accepted `apps/tna-platform/src/vad-adapter.ts` pattern exactly — real atom spec, real
  `DeterministicMockProducer`, real `ValidationGate`, real `DefaultVerifier`, real lifecycle.
- **Evaluator**: `packages/improvement-evaluator`'s `runPromotionEvaluation()` — the real orchestration
  that spawns real regression/security/benchmark commands and computes real mutation-diff/test-tamper/
  capability-delta/authority-delta signals, then calls the pure `evaluatePromotion()` decision function.
- **Sentinel**: `packages/improvement-core/src/sentinel-integration.ts` — a real `SentinelRuntime` session
  backs every canary run; observation types are drawn only from Sentinel's own closed, accepted vocabulary.
- **Capability/authority delta**: `computeCapabilityDelta`/`computeAuthorityDelta` (pure functions over
  caller-supplied parent/candidate profiles — never a candidate self-report).
- **Promotion evaluator (decision)**: `evaluatePromotion()` — deterministic, precedence-ordered, no LLM
  anywhere in the decision path.
- **Canary**: a real `CanaryRun` record plus a real Sentinel session; promotion/rollback decisions are made
  from this real record, never asserted.
- **Promotion / rejection / rollback**: `ImprovementStore.transitionGeneration()` enforces the generation
  state machine (`improvement-generation-model-v0.1.md`); rollback additionally requires a real, verified
  target (`rollback-v0.1.md`).
- **Ledger**: every lifecycle event is appended via the trusted `improvementWriter()` identity, additive to
  the accepted `packages/ledger-schema` event-type vocabulary — mirrors the Volume 6/7/8 precedent exactly.
- **Auditor-equivalent assessment**: `packages/improvement-core/src/auditor-integration.ts` — a Volume
  -12-owned narrow assessment reading only real recorded Ledger evidence, since the accepted
  `packages/auditor-controls` catalog is hardcoded/non-pluggable and this volume does not modify it.

## What this pipeline does not do

This overview intentionally does not claim: independent verification of MCP server behavior or model
weight provenance beyond declared spec fields; a real HTTP route for reporting Sentinel canary-health
observations (canary health is recorded at the store level directly in this v0.1); general reward-hacking
detection (only one implemented benchmark-gaming class is detected — see the threat model); or any
guarantee about latent/unobservable emergent capability beyond what `computeCapabilityDelta` can observe
from the caller-supplied capability profiles. See `docs/improvement/recursive-improvement-threat-model-
v0.1.md` for the complete, itemized threat model and `proof-of-work-recursive-improvement-v0.1.md` for the
complete list of honest scope limitations.
