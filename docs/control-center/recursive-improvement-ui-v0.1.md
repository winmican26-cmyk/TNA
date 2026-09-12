# Recursive Improvement UI v0.1 — the flagship surface

## The idea this UI exists to make visible

> A successor can become better without automatically becoming more powerful.

## Real data, real gaps — stated plainly

Every field rendered on `/improvements` and `/improvements/:id` is read straight from the real
`apps/tna-improvement-governor` (Volume 12, frozen, untouched by this volume — see the preservation check in
`proof-of-work-control-center-v0.1.md`) via `GET /v1/improvements`, `/v1/improvements/:id`,
`/v1/improvements/:id/evidence`, `/v1/improvements/:id/lineage`. Two things the illustrative kickoff mockup
implied are **not retrievable from the real governor's HTTP API today**, and this UI says so rather than
inventing them:

1. **No numeric benchmark score.** The governor's real HTTP responses carry only the qualitative evaluation
   decision (`PROMOTE`/`REJECT`/`HOLD`) and the VAD verdict — never a benchmark number or delta. The
   "Competence" panel on the detail page shows the real decision/verdict and says explicitly that numeric
   scores are not exposed.
2. **No "holdout" concept.** Not implemented anywhere in the accepted backend. The detail page does not
   render a Holdout section pretending otherwise.
3. **No system-list route.** `GET /v1/improvements` requires an already-known internal `system_id` — there
   is no "list all systems for this tenant" route. The list page asks the operator/reviewer to paste a known
   system id rather than fabricating a systems directory.
4. **No raw objective text.** `GET /v1/improvements/:id` returns only `spec_hash`, not the spec's objective
   field — the detail page says so rather than showing a placeholder.

## Competence / Authority / Capability / Control-plane — kept visually separate

This is the core visual argument. Four independent panels, each sourced from a distinct real field:

| Panel | Real source |
|---|---|
| Competence | `evaluated.decision`, `evaluated.vad_final_state` |
| Authority | `evaluated.authority_within_ceiling` |
| Capability | `reconstruction.capabilityDelta.has_unexpected_gain` |
| Control plane | `evaluated.control_plane_changed` |

They are never collapsed into one combined score.

## The rejected-authority-expansion scenario

The real evaluator (`evaluatePromotion` in `packages/improvement-schema`) checks `authorityWithinCeiling`
**before** `benchmarksAllPass`. A candidate that both expanded its authority AND might have had a good
benchmark is rejected on authority grounds alone, and the real evidence never establishes whether its
benchmark was even measured. This UI's rejected-generation view therefore shows the real evaluator reason
verbatim (e.g. "Candidate authority profile exceeds its approved ceiling") plus an explicit note that a
benchmark claim is not supported by the evidence, rather than asserting "benchmark improved" for narrative
effect. See `docs/improvement/demo-control-center-v01`'s Flow 7 output for the real, non-fabricated version
of this scenario.

## Lineage

`GET /v1/improvements/:id/lineage` reconstructs the tree PURELY from each generation's own real Ledger
stream (`reconstructImprovementLineage`) — never from `ImprovementStore`. Rendered as a real parent/child
tree; node styling for an unrecognized `finalState` falls back to neutral/UNKNOWN, never a positive-looking
default.

## Security controls panel

The real 9-control assessment (`assessImprovementGeneration`, from Volume 12) —
spec-integrity/mutation-boundary-integrity/evaluator-independence/required-test-integrity/authority-ceiling
-compliance/capability-delta/canary-evidence/rollback-readiness/lineage-completeness — each
PASS/FAIL/INSUFFICIENT_EVIDENCE, with `overall` the most severe of all nine. Never fabricates PASS where
evidence is missing.

## Mutations

Approve/promote/rollback submit to the real governor and re-fetch its response (see `approval-ux-v0.1.md`).
The client's own role is never forwarded as the trusted Gate approver role — see finding 5 in
`control-center-threat-model-v0.1.md`.
