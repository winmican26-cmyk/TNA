# TNA Recursive Improvement Governance v0.1 — Evaluator Independence

This is one of Volume 12's central guarantees, and it deserves its own document: **the code path that
mutates a candidate and the code path that authoritatively judges that candidate are structurally
separate, and the candidate has no way to collapse that separation.**

## The two scopes

- **Candidate mutation scope**: whatever `ImprovementSpec.allowed_mutation_paths` declares, realized as
  real file writes inside the candidate's real, isolated workspace (`createIsolatedWorkspace` — see
  `mutation-boundary-v0.1.md`). This scope is per-generation, caller-declared, and bounded.
- **Authoritative evaluation control**: `packages/improvement-evaluator/` — the package containing
  `runPromotionEvaluation()`, the real orchestration that spawns regression/security/benchmark commands
  and computes every mutation-diff/test-tamper/capability-delta/authority-delta signal that
  `evaluatePromotion()` (the pure decision function) consumes. This scope is fixed, global, and never
  per-generation.

## How the separation is enforced

`EVALUATOR_PATH_PREFIX = 'packages/improvement-evaluator/'` (`packages/improvement-schema/src/index.ts`)
is checked by `classifyMutation()` **unconditionally** — independent of what any spec's own
`allowed_mutation_paths` claims, independent of improvement class, independent of any approval level:

```ts
const evaluatorChanged = changedPaths.some(p => p.startsWith(EVALUATOR_PATH_PREFIX));
```

`evaluatePromotion()` then checks `mutationDiff.evaluator_changed` **before** every other signal except
incomplete evidence and test-manifest tampering:

```
evidenceComplete? → testTamper.tampered? → evaluator_changed? → control_plane_changed (class<4)? →
regression → security → authority → capability → benchmarks → class policy (independent review,
human approval) → PROMOTE
```

There is no class — including `CLASS_5_AUTHORITY_OR_EVALUATOR`, whose very name references the evaluator —
that can promote a generation which touched `packages/improvement-evaluator/`. Class 5 exists to require
BOTH human approval and independent review for a spec that *declares intent* to touch authority or the
evaluator, but declaring that intent and actually being ALLOWED to touch the evaluator remain two different
things: the unconditional `evaluator_changed` REJECT applies regardless of class, regardless of approval
state. There is no code path in this volume where a human or independent reviewer's approval causes a
generation that mutated the evaluator to be promoted.

## Why this needs to be true structurally, not just tested

If the evaluator's own path could be listed as "allowed" by a low-class spec, a candidate could
progressively weaken the very check meant to catch it — the classic "the fox is guarding the henhouse"
failure mode for any self-improving system. This is why `classifyMutation()` computes both
`control_plane_changed` (general control-plane detection, overridable at Class 4+ with approval) and
`evaluator_changed` (never overridable, at any class) as two separate signals: the evaluator boundary is
strictly stronger than the general control-plane boundary.

## Proof: the evaluator-tampering E2E result

`tests/improvement/e2e-a-to-j.test.ts`, **E2E C**: a real candidate generation is proposed with
`allowedMutationPaths: ['router.mjs', 'packages/improvement-evaluator/']` (i.e. the spec ITSELF explicitly
tries to declare the evaluator path as allowed), then built with a real file write to
`packages/improvement-evaluator/src/index.ts` (`export const tampered = true; // candidate attempts to
weaken its own judge`) inside its isolated workspace. The real `/evaluate` HTTP call against the real
packaged governor returns:

```
status: REJECT
reason: "Candidate mutated the promotion evaluator itself — evaluator independence violated"
```

This is exercised through the real HTTP API end to end — real Gate authorization, real isolated workspace,
real `git diff`-equivalent filesystem diff, real `classifyMutation()`, real `evaluatePromotion()` — never a
substitution of the imported decision function for a hand-asserted result. The same scenario is
additionally covered directly against `runPromotionEvaluation()` in
`tests/improvement/promotion-evaluator.test.ts` ("a candidate that touches the evaluator's own path is
REJECTed unconditionally") and in `tests/improvement/mutation-boundary.test.ts`.

## Honest scope note

This boundary protects `packages/improvement-evaluator/`'s own source code from candidate mutation. It does
not — and does not claim to — protect against a compromised host, a supply-chain compromise of the
Node.js runtime the evaluator itself runs under, or a kernel/hypervisor-level compromise. See the threat
model's dedicated limitations for the complete list of what this volume does not claim.
