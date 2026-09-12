# TNA Recursive Improvement Governance v0.1 — Authority Ceiling

Source of truth: `packages/improvement-schema/src/index.ts` (`AuthorityCeiling`, `authorityWithinCeiling`,
`computeAuthorityDelta`, `AuthorityExpansionRequest`).

## The invariant

```
successor_authority ⊆ approved_authority_ceiling
```

`AuthorityCeiling` fields: `operations`, `tools`, `resources`, `destinations`, `network_access`,
`filesystem_scope`, `credentials`, `max_budget_usd`, `max_runtime_ms`, `max_parallelism`,
`external_side_effects`, `requires_approval_for`.

`authorityWithinCeiling(child, ceiling)` checks, field by field:

- Every array-shaped field of `child` (`operations`, `tools`, `resources`, `destinations`,
  `filesystem_scope`, `credentials`) must be a **subset** of the same field on `ceiling`.
- A boolean field (`network_access`, `external_side_effects`) on `child` may be `true` only if it is also
  `true` on `ceiling`.
- Every numeric field (`max_budget_usd`, `max_runtime_ms`, `max_parallelism`) on `child` must not exceed
  the corresponding value on `ceiling`.

If any of these fail, `authorityWithinCeiling` returns `false`, and `evaluatePromotion()` REJECTs
unconditionally: *"Candidate authority profile exceeds its approved ceiling."* This is checked before
benchmark results are even consulted (see `promotion-policy-v0.1.md`'s precedence order) — a candidate
cannot buy its way past an authority-ceiling violation with a better score. Tested in E2E B ("benchmark
PASS, authority/capability delta FAIL, final REJECT").

## Authority delta is always computed and surfaced

`computeAuthorityDelta(before, after)` computes exactly what was added and removed across every field —
`added_operations`, `added_tools`, `added_resources`, `added_destinations`, `added_filesystem_scope`,
`added_credentials`, `removed_operations`, `removed_tools`, `removed_resources`,
`network_access_gained`, `external_side_effects_gained`, `budget_increased`, `runtime_increased`,
`parallelism_increased` — plus two derived booleans, `is_expansion` and `is_reduction`. A candidate MAY
reduce its own authority; that reduction is still recorded as a real delta, never treated as "no delta."
The whole object is hashed (`delta_hash`) for content-addressed evidence.

## Why a candidate asking for authority does not receive it

Requesting more authority and being granted more authority are two structurally separate operations in this
volume:

1. **The candidate's own spec/profile** can never itself grant authority — `authorityWithinCeiling` only
   ever *checks* a candidate's declared profile against an already-approved ceiling; there is no code path
   where a candidate's own declared `authority_ceiling` or `candidateAuthorityProfile` field *becomes* the
   new approved ceiling by virtue of being declared. If a candidate's profile exceeds the ceiling it is
   currently held to, the result is an unconditional REJECT — not a grant, not a HOLD pending review of the
   candidate's own request. The candidate has no field it can set that widens what it is authorized to do.

2. **`AuthorityExpansionRequest`** is a wholly separate record type
   (`request_id`, `generation_id`, `requested_delta`, `reason`, `risk`, `requested_by`, `status`
   [`PENDING`/`APPROVED`/`REJECTED`], `approved_by`, `decision_reason`) — the only path by which a ceiling
   can ever actually widen. Crucially, `requested_delta` is never *inferred* from the candidate's spec or
   capability profile; a trusted caller must construct the request explicitly, stating exactly what
   authority is being asked for and why. Its `status` starts `PENDING` and can only be moved to `APPROVED`
   or `REJECTED` by a separate, real Gate-authorized decision (`decideAuthorityExpansionRequest`, CAS-
   protected, decide-once) — never by the candidate itself, and never automatically. Tested in
   `store.test.ts` and `abuse-cases.test.ts`.

So: a candidate declaring a wider authority profile in its own spec is simply rejected outright (path 1). A
*request* for wider authority is a separate, explicit, human-decided record that exists independently of
whether the candidate's code changes at all (path 2). Neither path lets the candidate's own declaration
become the new ceiling by itself — TNA-72 ("improvement does not grant authority") and TNA-73 ("a successor
cannot certify its own promotion") are both enforced by this separation, not by a single check that could
be bypassed by phrasing the request differently.
