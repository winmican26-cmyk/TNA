# VAD Engine v0.1 Remediation Pass

This is the required remediation pass for VAD Engine v0.1. It is intentionally scoped to the missing requirements necessary to make v0.1 acceptable and does not advance into v0.2 scope.

## 1. Purpose and decision rule

The purpose of this pass is to close the v0.1 acceptance gaps exposed by the review evidence, not to add speculative v0.2 functionality.

The decision rule is simple:

- v0.1 is not acceptable until all acceptance blockers are addressed and proven
- v0.2 work must not start while any v0.1 blocker remains open
- the process is: SPEC → BUILD → PROOF → REVIEW → REMEDIATE → ACCEPT → TAG

If a requirement is not proven by fresh execution evidence, it is treated as not complete.

### Meta-evidence for the book

This remediation cycle is itself evidence for the framework's central principle: passing code is not the same thing as satisfying the specification. The original VAD implementation passed its available tests and repository checks, yet the architectural review correctly found unimplemented lifecycle, persistence, enforcement, and acceptance requirements. The test suite proved that the implemented behavior worked; it did not prove that the implementation covered the whole specification.

That distinction is not a defect in the process. It is the process working as intended. SPEC defines the obligation, BUILD creates an implementation, PROOF tests observed behavior, and REVIEW compares that behavior against the full specification. REMEDIATE exists because a green build can still be incomplete.

## 2. Scope of this pass

This pass covers only the missing requirements necessary to make the current VAD v0.1 implementation acceptably deterministic, evidence-based, and reviewable.

The following are in scope:

- runtime lifecycle/state transitions for atom execution
- persisted evidence package and acceptance ledger
- deterministic enforcement of limits and retry behavior
- verifier output strictness and rejection of invalid machine-readable results
- hash and artifact integrity enforcement across the full lifecycle
- human decision / override handling, if required for v0.1 acceptance
- dependency/resource contamination enforcement where the design claims it at v0.1

The following are explicitly out of scope for this pass:

- v0.2 architecture design
- multi-agent orchestration or Level 3/4 control flow
- broad autonomous execution planning
- speculative workflow improvements not required to close a documented v0.1 blocker

## 3. Required v0.1 acceptance blockers to close

The remediation pass must close the gaps that were rated PARTIAL, FAIL, or NOT IMPLEMENTED in the v0.1 review. The minimum blocker set is:

1. Runtime lifecycle and state machine
   - Implement a real state model for atom lifecycle with explicit transitions
   - Reject illegal transitions
   - Define FAILED, REJECTED, ACCEPTED, and ESCALATED behavior concretely
   - Ensure state transitions are exercised by tests

2. Persistent evidence package and final acceptance ledger
   - Implement a single evidence package structure that contains the original spec, validation evidence, verifier evidence, artifact metadata, and final lifecycle state
   - Prevent ACCEPTED completion when evidence is missing or not persisted
   - Prevent double-completion or conflicting final evidence

3. Deterministic enforcement of retries and resource limits
   - Enforce max attempts, max runtime, and max cost at runtime
   - Ensure attempt 4 is impossible when max_attempts = 3
   - Fail closed when the lifecycle exceeds the declared bounds

4. Integrity enforcement for spec and artifact hashes
   - Detect spec hash mismatch after evidence generation
   - Detect artifact hash mismatch after verification
   - Reject completion when integrity checks fail

5. Strict verifier output schema
   - Reject unknown verdict strings at runtime
   - Reject free-form or arbitrary prose output
   - Require deterministic machine-readable verification output

6. Human decision and override validation
   - If human override is part of v0.1 acceptance, model actor, timestamp, override rationale, and immutable-spec preservation
   - Reject silent override of the original atom spec
   - Require explicit decision records for any override path

7. Dependency and contamination enforcement
   - Replace structural-only forbidden dependency records with executable enforcement where claimed
   - Ensure declared resource and dependency boundaries are checked against actual workspace state

8. Final acceptance proof path
   - Provide a deterministic accepted flow test from atom creation through producer, gate, verifier, and accepted final state
   - Provide an explicit rejected flow test ensuring fail-closed behavior persists into the final state model

## 4. Remediation test requirements

All remediation work must be accompanied by failing tests first, then implementation, then passing verification.

The remediation pass must add or update tests for the following minimum cases:

1. State transition legality
   - It rejects illegal transitions such as ACCEPTED before VALIDATING
   - It rejects multiple transitions into terminal states

2. Evidence persistence and completion gate
   - It fails when evidence package is absent
   - It fails when evidence package is incomplete
   - It prevents ACCEPTED without a persisted record

3. Retry limit enforcement
   - A run with max_attempts = 3 cannot reach attempt 4
   - Attempt counters are monotonic and deterministic

4. Runtime limit enforcement
   - A run above max_runtime_seconds fails before completion
   - A run above max_cost_usd fails before completion

5. Hash integrity mismatch detection
   - A spec hash mismatch causes REJECTED or FAILED
   - An artifact hash mismatch causes REJECTED or FAILED

6. Strict verifier output validation
   - Unknown verdict values are rejected
   - Non-machine-readable prose verdicts are rejected
   - Missing criterion validation still fails deterministically

7. Human override auditability
   - If override is enabled, override requires actor, timestamp, and rationale
   - Override cannot silently alter the original spec

8. Remediation pass acceptance flow
   - A clean and deterministic accepted atom flow passes end-to-end
   - A clean rejected atom flow fails end-to-end and leaves no false ACCEPTED state

## 5. Proof requirements before acceptance

A v0.1 milestone may not be accepted until the following evidence exists and passes:

- all minimum remediation tests pass
- all previously existing Gate tests still pass
- the entire monorepo verification command passes
- the proof-of-work file records actual test names, command output, pass counts, and the exact acceptance decision
- the review memo explicitly lists which requirements are now PASS, PARTIAL, or NOT IMPLEMENTED
- the acceptance decision is backed by fresh execution results from the current tree, not historical assertions

Minimum proof command:

- `npm run check`

The proof requirement is strict: no acceptance decision is valid without fresh, current run output from the repository state under review.

## 6. Stop conditions

The remediation pass stops immediately under any of the following conditions:

1. any acceptance blocker remains untested
2. any test is added without a failing-first reproduction
3. any fix claims completion without fresh proof output
4. implementation moves beyond v0.1 scope into v0.2 features
5. reviewer evidence does not clearly separate PASS from PARTIAL and NOT IMPLEMENTED
6. the set of changes is not demonstrably necessary for v0.1 acceptance
7. there is any ambiguity about whether the final state is a real accepted state versus an in-memory simulation

When any stop condition is hit, the pass is suspended and the issue is re-scoped to the smallest necessary fix before continuing.

## 7. Acceptance gate

The v0.1 remediation pass is complete only when all of the following are true:

- all critical acceptance blockers are closed by implemented code and tests
- all remediation tests pass
- no Gate baseline tests regress
- the review memo shows the v0.1 milestone is truly acceptable
- the final artifact is tagged only after a clean acceptance decision

## 8. Explicit rule for v0.2

No v0.2 work begins until v0.1 receives a clean acceptance decision.

This remediation pass exists specifically to enforce that rule and to prevent the project from advancing into speculative architecture before a deterministic v0.1 acceptance gate is satisfied.

This is not a v0.2 planning document. It is a disciplined corrective pass that enforces the intended pipeline:

SPEC → BUILD → PROOF → REVIEW → REMEDIATE → ACCEPT → TAG
