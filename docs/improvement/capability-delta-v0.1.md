# TNA Recursive Improvement Governance v0.1 — Capability Delta

Source of truth: `packages/improvement-schema/src/index.ts` (`CapabilityProfile`,
`CapabilityDeltaReport`, `computeCapabilityDelta`).

## Observable capability delta

`CapabilityProfile` fields: `tools`, `operations`, `resources`, `destinations`, `filesystem_writes`,
`network_access`, `credential_access`, `code_execution`, `max_parallelism`, `side_effect_classes`.

`computeCapabilityDelta(generationId, parent, candidate, allowedGrowth?)` is a pure function comparing two
CALLER-supplied profiles — never a candidate self-report. It computes: added tools/operations/resources/
destinations/credential-access/side-effect-classes, plus booleans for filesystem-writes-gained,
network-access-gained, code-execution-gained, and parallelism-increased.

**Conservative-by-default unexpected-gain detection**: any capability gain not explicitly listed in the
optional `allowedGrowth` parameter is flagged as `has_unexpected_gain: true` with a specific reason string
(e.g. `"unauthorized new tool(s): ..."`, `"unauthorized filesystem-write capability gained"`). With no
`allowedGrowth` supplied at all — the default for a `CLASS_0`/`CLASS_1` candidate, which should not be
gaining capability in the first place — ANY gain at all is unexpected. `evaluatePromotion()` REJECTs
unconditionally on `has_unexpected_gain`, before benchmark results are even consulted.

## Authority delta (distinct from capability delta)

`AuthorityCeiling`/`computeAuthorityDelta` (see `authority-ceiling-v0.1.md`) is a SEPARATE computation over
a separate, narrower type — the caller's *granted* operations/resources/tools/budget ceiling. Capability
delta is broader and looser: it also covers `code_execution`, `filesystem_writes`, and `side_effect_classes`
— dimensions that describe what the candidate's build actually appears able to DO, not just what it was
formally granted. A candidate can fail on authority delta, capability delta, both, or neither, independently
— E2E B exercises exactly this: a candidate passes its benchmark but is REJECTed on BOTH an authority-
ceiling violation AND (separately) an unexpected-capability-gain signal.

## Latent / unobservable emergent capability

`computeCapabilityDelta` can only compare what is captured in the two `CapabilityProfile` objects it is
given. In the real governor flow, these profiles are supplied by the trusted operator/orchestration as
declared configuration — they are not derived from deep static or dynamic analysis of the candidate's
actual code. This means:

- A capability genuinely present in the candidate's build but not reflected in either the parent's or the
  candidate's declared `CapabilityProfile` is invisible to this check entirely.
- A capability that only manifests under specific runtime conditions not exercised during evaluation (a
  "latent" or "emergent" capability) is not detected by this mechanism, and is not claimed to be.

**TNA does not prove the absence of every latent emergent capability.** This is a structural limitation of
comparing declared profiles, not a bug to be fixed within this volume's scope — a general solution would
require either exhaustive dynamic analysis of arbitrary candidate code (computationally intractable in
general) or a fundamentally different verification approach outside this volume's charter. What this
volume DOES guarantee is that the capability/authority dimensions that ARE declared are compared
conservatively (unexpected-by-default) and that the comparison itself cannot be skipped, weakened, or
self-reported by the candidate.

## Summary of the boundary

| | Computed by | Compared against | Detects |
|---|---|---|---|
| Capability delta | `computeCapabilityDelta` | Declared parent vs. candidate `CapabilityProfile` | Declared behavioral capability gain outside explicit allowance |
| Authority delta | `computeAuthorityDelta` | Declared before/after `AuthorityCeiling` | Declared granted-authority change (recorded even when a reduction) |
| Latent/emergent capability | *(not computed)* | *(nothing)* | *(nothing — explicitly out of scope, see threat model)* |
