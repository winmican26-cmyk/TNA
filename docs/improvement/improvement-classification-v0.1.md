# TNA Recursive Improvement Governance v0.1 — Improvement Classification

Source of truth: `packages/improvement-schema/src/index.ts` (`IMPROVEMENT_CLASSES`, `CLASS_RANK`,
`CLASS_POLICY`, `classAtLeast`).

## The six classes, as implemented

| Class | Rank | Meaning |
|---|---|---|
| `CLASS_0_CONFIG` | 0 | Configuration-only change |
| `CLASS_1_CODE` | 1 | Application code change within the declared mutation scope |
| `CLASS_2_TOOL` | 2 | Tool/capability change (new or modified tool access) |
| `CLASS_3_MODEL` | 3 | Model change |
| `CLASS_4_CONTROL_PLANE` | 4 | A change that touches control-plane paths (Gate/Sentinel/VAD/Ledger/Auditor/deployment-ops — see `mutation-boundary-v0.1.md`) with explicit, class-appropriate authorization |
| `CLASS_5_AUTHORITY_OR_EVALUATOR` | 5 | A change affecting the candidate's own authority ceiling or the evaluator itself |

`classAtLeast(cls, minimum)` compares by this fixed rank order — used specifically in `evaluatePromotion()`
to decide whether a control-plane path touch is permissible at all for a given class (only `CLASS_4` and
`CLASS_5` may touch control-plane paths; every other class is REJECTed unconditionally if it does — see
`promotion-policy-v0.1.md`).

## Per-class promotion policy (`CLASS_POLICY`)

| Class | `allow_automated_promotion` | `requires_human_approval` | `requires_independent_review` | `allow_self_promotion` |
|---|---|---|---|---|
| `CLASS_0_CONFIG` | true | false | false | **false** |
| `CLASS_1_CODE` | true | false | false | **false** |
| `CLASS_2_TOOL` | false | true | false | **false** |
| `CLASS_3_MODEL` | false | true | false | **false** |
| `CLASS_4_CONTROL_PLANE` | false | true | false | **false** |
| `CLASS_5_AUTHORITY_OR_EVALUATOR` | false | true | **true** | **false** |

`allow_self_promotion` is `false` for every class, with no override path in the type system — the field
exists specifically so a caller cannot construct a policy value claiming otherwise. Class 4 and Class 5
never auto-promote regardless of benchmark score; Class 5 additionally requires BOTH human approval and
independent review before `evaluatePromotion()` can return `PROMOTE` — approval by only one of the two
leaves the generation in `HOLD`, tested explicitly in E2E G ("human approval alone is insufficient for
Class 5 — independent review is also required").

## Competence change vs. authority change vs. control-plane change

This is the distinction Volume 12 exists to enforce structurally (TNA-72), and classification is where it
is drawn as an actual type rather than prose:

- **Competence change** (`CLASS_0`/`CLASS_1`): the candidate gets better at its task within its existing,
  unchanged authority and without touching anything the control plane owns. This is the only category
  eligible for automated promotion.
- **Authority change** (implicit in `CLASS_2`/`CLASS_3`, and explicit for any class via a separate
  `AuthorityExpansionRequest` — see `authority-ceiling-v0.1.md`): the candidate's granted
  operations/resources/tools/budget widens. Always requires human approval; never automated.
- **Control-plane/evaluator change** (`CLASS_4`/`CLASS_5`): the candidate's spec explicitly declares an
  intent to touch the machinery that governs promotion itself (Gate, Sentinel, VAD, Ledger, Auditor, or —
  for Class 5 specifically — the evaluator or the candidate's own authority ceiling). This is the highest
  -risk category: Class 4 requires human approval; Class 5 requires human approval AND independent review,
  and is the only class where two distinct approval gates must both clear before promotion.

## The evaluator boundary is orthogonal to class

Regardless of declared class, `classifyMutation()` unconditionally flags any touch to
`packages/improvement-evaluator/` as `evaluator_changed`, and `evaluatePromotion()` REJECTs unconditionally
on that signal before even consulting the class policy table. There is no class — including Class 5 — that
can promote a generation that mutated the evaluator itself. Class 5's "authority-or-evaluator" naming
reflects that a spec *intending* to touch the evaluator must be classified 5 (and go through both approval
gates) to be considered at all, but classification alone never grants the mutation — the unconditional
`evaluator_changed` REJECT still applies regardless of class. See `evaluator-independence-v0.1.md`.
