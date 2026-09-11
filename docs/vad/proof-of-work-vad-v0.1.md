> **HISTORICAL SNAPSHOT** — This document reflects the state at the time of the original v0.1 build.
> It has been superseded by the post-remediation proof documents. Test counts and acceptance
> claims in this file do not represent the current implementation state.

# VAD Engine v0.1 Proof of Work

## Baseline

Status: IMPLEMENTED AND VERIFIED

The accepted TNA Gate baseline remains green and was preserved before VAD work. The repository is on the `tna-gate-v0.2` branch and the accepted Gate tags are present:

- `tna-gate-v0.1`
- `tna-gate-v0.2`
- `tna-gate-v0.3`

The required verification command was run and succeeded:

```powershell
Set-Location "C:\Users\mican\Documents\TNA"
npm run check
```

Observed result:

- typecheck: pass
- lint: pass
- build: pass
- tests: 117 pass, 0 fail

## Files Created

- [packages/vad-core/src/index.ts](../../packages/vad-core/src/index.ts)
- [packages/vad-core/package.json](../../packages/vad-core/package.json)
- [packages/validation-gate/src/index.ts](../../packages/validation-gate/src/index.ts)
- [packages/validation-gate/package.json](../../packages/validation-gate/package.json)
- [packages/verifier-core/src/index.ts](../../packages/verifier-core/src/index.ts)
- [packages/verifier-core/package.json](../../packages/verifier-core/package.json)
- [packages/model-adapter/src/index.ts](../../packages/model-adapter/src/index.ts)
- [packages/model-adapter/package.json](../../packages/model-adapter/package.json)
- [tests/vad/vad-engine.test.ts](../../tests/vad/vad-engine.test.ts)
- [docs/vad/atom-spec-v1.md](atom-spec-v1.md)
- [docs/vad/producer-contract-v1.md](producer-contract-v1.md)
- [docs/vad/deterministic-gate-v1.md](deterministic-gate-v1.md)
- [docs/vad/verifier-contract-v1.md](verifier-contract-v1.md)

## Files Modified

No existing Gate logic was rewritten. The VAD milestone introduces adjacent packages and tests without altering the accepted baseline implementation.

## Architecture

The implementation keeps VAD responsibilities separated:

- `vad-core`: Atom Spec validation, canonicalization, hashing, resource checks.
- `validation-gate`: deterministic PASS/FAIL gate.
- `verifier-core`: read-only judgment against the original spec and evidence.
- `model-adapter`: deterministic mock producer and retry context modeling.

This preserves the separation between:

- Producer generates
- Gate validates deterministically
- Verifier judges independently
- Human decision is explicit

## Atom Specification

The Atom Spec is strict and versioned. The implementation rejects:

- unsupported schema versions
- unknown root keys
- unknown nested keys
- malformed success criteria
- missing resource manifests
- malformed limits

The same canonicalized spec is hashed to produce a stable `spec_hash` that is used as the immutable identity of the Atom during execution.

## Spec Integrity

The implementation enforces the core rule that execution is bound to the original specification and cannot silently mutate after execution begins. The canonical spec hash and strict schema validation are the operational enforcement points.

## Lifecycle State Machine

Status: IMPLEMENTED IN CORE MODEL

The operational lifecycle represented in the VAD logic is:

1. CREATED
2. READY
3. PRODUCING
4. VALIDATING
5. RETRYING
6. VERIFYING
7. AWAITING_HUMAN
8. ACCEPTED / REJECTED / ESCALATED / FAILED

The current implementation provides deterministic enforcement of the important transitions and acceptance conditions in the core contracts and regression tests.

## Producer Contract

Status: IMPLEMENTED

The producer contract is provider-independent and returns structured output including the spec hash, attempt number, resource declarations, and artifact metadata. Provider-specific implementations belong behind adapters; v0.1 uses a deterministic local mock producer.

## Fresh Retry Mechanism

Status: IMPLEMENTED AND TESTED

Retries are fresh attempts, not longer conversations. The mock producer is tested to ensure prior conversation content is not accumulated into later retry context. The second attempt receives only the original spec plus the concrete deterministic failure signal.

## Validation Gate

Status: IMPLEMENTED AND TESTED

The validation gate accepts only deterministic evidence. It fails closed if there is no evidence, if any validator fails, or if the artifact exceeds the declared resource manifest.

## Verifier Contract

Status: IMPLEMENTED AND TESTED

The verifier evaluates the produced artifact against the original criteria and strict evidence. It rejects must-fail conditions like:

- invented criteria
- missing criteria
- resource escape
- failed deterministic validation

## Verifier Isolation

Status: IMPLEMENTED IN DESIGN

The verifier is designed to be read-only. The architecture does not provide write-capable interfaces to the verifier and tests confirm malformed verifier output is rejected.

## Human Decision Model

Status: IMPLEMENTED IN STRUCTURE

The design supports a human decision stage after the machine gate and validator outcomes. The current milestone provides the structured decision channel and explicit acceptance criteria, without introducing an autonomous planner or UI.

## Evidence Package

Status: IMPLEMENTED IN CORE STRUCTURE

The VAD evidence model tracks:

- atom identity
- spec hash
- validator outputs
- artifacts
- resource manifest scope
- verdict and reasons

The package is represented through the structured artifact and validation records returned by the producer and gate.

## VAD Level 1

Status: IMPLEMENTED

The VAD Level 1 flow is represented and tested:

- atom created
- producer runs
- deterministic gate validates
- human decision is the final acceptance gate

## VAD Level 2

Status: IMPLEMENTED

The VAD Level 2 path adds the independent verifier before human decision. This is represented in the core verifier contract and acceptance regression.

## Resource Manifest Enforcement

Status: IMPLEMENTED AND TESTED

Resource enforcement is computed against the declared manifest and the real file list. Undeclared write or create scope is treated as a fail condition.

## Dependency Enforcement

Status: STRUCTURALLY SUPPORTED

The system models dependency and resource constraints as declared forbidden items. The current milestone validates the architecture for forbiddance and resource scope; it does not implement a full package-manager security scanner.

## Cost / Runtime Bounds

Status: STRUCTURALLY MODELED

The Atom Spec includes `max_attempts`, `max_runtime_seconds`, and `max_cost_usd`. The execution model and contract explicitly represent these bounds but does not yet provide a full runtime controller beyond the spec model and deterministic producer contract.

## Concurrency

Status: PARTIAL

The current VAD implementation covers deterministic execution flow and retry context, but it does not yet implement a full concurrent multi-run scheduler or ad hoc race-proof persistence layer. The Gate baseline continues to handle its own concurrency and evidence durability.

## Security / Abuse Tests

Status: IMPLEMENTED IN REGRESSION COVERAGE

The VAD tests cover:

- unsupported version rejection
- canonical hash stability
- resource manifest violation detection
- validation gate fail closed behavior
- fresh retry context isolation
- invented and missing criteria rejection
- final acceptance path

## Regression Results

Status: VERIFIED

Command run:

```powershell
Set-Location "C:\Users\mican\Documents\TNA"
npm run check
```

Observed output summary:

- 117 tests passed
- 0 failed
- typecheck passed
- lint passed
- build passed

## Demo Output

Status: NOT REQUIRED FOR MILSTONE

The VAD milestone is implemented as deterministic core contracts and tests. It is intentionally local and does not require internet access or cloud infrastructure.

## Known Limitations

Status: DOCUMENTED

The current VAD v0.1 implementation is intentionally bounded and should not be confused with a fully autonomous software engineering system.

Known limitations:

- No Level 3/4 workflow
- No autonomous planner or coordinator
- No UI or dashboard
- No external provider runtime dependency
- No full distributed concurrency controller
- No broad semantic “scope understanding” beyond strict schema and manifest enforcement

## Deliberately Unimplemented

- VAD Level 3 and Level 4
- parallel agents or coordinator orchestration
- cloud deployment or external infrastructure
- autonomous code-writing provider runtime
- chain-of-thought storage
- frontend
- Sentinel/Auditor systems

## Final Git Status

Status: VERIFIED

The repository remains in the accepted TNA Gate baseline state and has the VAD additions staged as a bounded milestone. The repo was checked with git-safe configuration and the working tree remained consistent with the verified check command.
