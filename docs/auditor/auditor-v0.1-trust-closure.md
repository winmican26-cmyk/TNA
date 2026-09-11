# TNA Auditor v0.1 — Trust Closure Pass

## Origin

The original TNA Auditor v0.1 implementation reached a green 526-test suite (two consecutive
`npm run check` runs) and all five demo flows passing, and was recorded as `READY FOR ARCHITECTURAL
ACCEPTANCE REVIEW` in `proof-of-work-auditor-v0.1.md`. An architectural review conducted *after* that
point — the same discipline applied to the Sentinel concurrency closure (`
docs/sentinel/sentinel-v0.1-concurrency-closure.md`) — found two trust-boundary gaps that no
individual test had caught, because each existing test correctly proved what it set out to prove
without needing the property that turned out to be missing. This document is the closure of both
findings: a narrow, scoped architectural fix plus a permanent regression suite. It does not begin any
new Auditor feature work, does not add new controls, does not add regulatory mappings, does not build a
frontend, and does not declare `tna-auditor-v0.1` accepted or tag it — that remains the reviewer's call,
on top of the original acceptance materials (preserved, unmodified) and this document.

Two new candidate permanent TNA principles came out of this review:

- **TNA-41 — Evidence integrity is transitive to the conclusion.** A conclusion cannot be stronger than
  the integrity of the specific evidence used to derive it.
- **TNA-42 — Integrity does not imply authenticity.** A perfectly hashed assertion can still be false;
  trust requires an authenticated provenance boundary.

---

## Finding 1 — evidence-integrity qualification was per-control, not architectural

### Root cause

`TNA-INTEG-001` (the dedicated Ledger-integrity control) checked `verifyStream` results directly, and
`TNA-AUTH-001` additionally ran its own bespoke per-event integrity check before allowing PASS. No
other control did. This is a *convention*, not a *guarantee*: correctness depended on every present and
future evaluator author individually remembering to add the same check. A control whose evaluator
never thought to consult stream integrity could PASS on evidence drawn from a stream that had already
failed verification elsewhere in the very same evidence bundle.

### Before behavior

Given a `TNA-RUNTIME-001` (Sentinel active-monitoring) evaluation over one valid Gate stream and one
Sentinel stream whose `verifyStream` result was `INVALID`: the evaluator itself had no integrity
awareness at all, so a fully-bound, correctly-correlated `AUTHORIZATION_ALLOWED` +
`SENTINEL_SESSION_STARTED` pair produced `PASS`, citing the corrupted event as supporting evidence,
indistinguishable in the result from a genuinely trustworthy pass. The same was true for every other
control outside `TNA-INTEG-001`/`TNA-AUTH-001` — `TNA-VER-001` (VAD), `TNA-CAP-003`, `TNA-REVOKE-001`,
and the rest.

### Fix design

Evidence-integrity qualification is now computed once, centrally, at collection time — never left to
an individual evaluator to (re-)determine:

- `StreamIntegritySummary.qualification: EvidenceQualification` (`VALID | INVALID | UNVERIFIED |
  UNAVAILABLE`) replaces the previous boolean `valid` field on `EvidenceBundle.stream_integrity`. A
  boolean cannot distinguish "confirmed corrupt" (`verifyStream` returned `false`) from "never checked"
  (`verifyStream` itself threw, or the stream is absent from the map) — and that distinction matters:
  confirmed corruption and unconfirmed integrity are different claims and should not be conflated.
- `eventRef(event, bundle)` — the single point where a piece of Ledger evidence becomes something a
  control evaluator or a package reviewer can cite — now stamps `integrity_qualification` directly onto
  the returned `EvidenceRef`, defaulting to `UNVERIFIED` (never silently `VALID`) if the stream is
  somehow absent from the bundle's map. The qualification travels with the reference everywhere it
  goes, rather than needing a separate cross-reference.
- One architectural gate, `qualifyEvidenceIntegrity(control, result, context)` in `auditor-controls`,
  runs inside `evaluateControl()` for every result before it is ever returned to a caller:
  - `TNA-INTEG-001` is exempt — it *is* the integrity signal itself, and independently resolves to
    `FAIL` on exactly this condition via its own evaluator; running the gate on it would be circular.
  - Only `PASS`/`PARTIAL` results are inspected (a `FAIL`/`NOT_APPLICABLE`/`INSUFFICIENT_EVIDENCE`/
    `ERROR` result carries no unqualified positive claim that corrupt evidence could be propping up).
  - Every `LEDGER_EVENT`-typed ref the evaluator actually cited (`result.evidence_refs` — every
    evaluator in the catalog populates it with exactly the events it used, never a subset) is
    inspected: any `INVALID` ref downgrades the result to `INSUFFICIENT_EVIDENCE` (confirmed
    corruption); else any `UNVERIFIED`/`UNAVAILABLE` ref also downgrades to `INSUFFICIENT_EVIDENCE`
    (never confirmed valid — unverified evidence cannot support a high-assurance result either);
    otherwise the result passes through unchanged.
  - The downgrade is always to `INSUFFICIENT_EVIDENCE`, never `FAIL`. Corrupt or unverified evidence
    means *the evidence* cannot support the claim — not that the underlying technical control
    definitely does not exist. A dependent control's own correctness is simply unknown from this
    evidence; that is exactly what `INSUFFICIENT_EVIDENCE` means.

Because the gate inspects only the refs an evaluator itself collected, a control that never touched a
corrupted stream is structurally unaffected by that corruption — an irrelevant corrupt stream elsewhere
in the same bundle never poisons an unrelated control's result, with **no special-casing required** to
achieve that: it falls out directly from the gate only ever looking at what was actually cited.

### Tests added

`tests/auditor/auditor-controls.test.ts`:

- Corrupt VAD evidence (`TNA-VER-001`, `atom:atom-1` stream marked `INVALID`) → `INSUFFICIENT_EVIDENCE`,
  `EVIDENCE_INTEGRITY_INVALID` — proven against a baseline PASS with the same events, valid streams.
- Corrupt Sentinel evidence mixed with valid Gate evidence (`TNA-RUNTIME-001`, `sentinel:sess-1` marked
  `INVALID` while `agent:agent-1` stays `VALID`) → `INSUFFICIENT_EVIDENCE` — this is simultaneously the
  required "corrupt Sentinel evidence" case and the required "mixed valid+invalid evidence" case (a
  control needing evidence from two streams, one valid and one not, still cannot PASS).
- An irrelevant corrupt stream (`atom:atom-x`, marked `INVALID`) present in the same bundle as a
  `TNA-AUTH-001` evaluation that only ever cites `agent:agent-1` → `TNA-AUTH-001` still `PASS`,
  unaffected.

Already present before this closure pass began (retained, not duplicated): `TNA-AUTH-001` (Gate) with
an `INVALID` `agent:agent-1` stream → explicit `INSUFFICIENT_EVIDENCE` with reason
`EVIDENCE_INTEGRITY_INVALID`; `TNA-INTEG-001` → `FAIL` on the same corruption (the dedicated-control
case, exempt from the gate by design). `tests/auditor/auditor-abuse-cases.test.ts` carries the
equivalent end-to-end version through `AuditorRuntime`, and `scripts/demo-auditor-v01.ts` Flow C now
additionally asserts the dependent-control case explicitly (`TNA-AUTH-001 == INSUFFICIENT_EVIDENCE`,
not merely `!= PASS`) — demonstrating the fix through the full evaluation pipeline, not only at the
evaluator-unit level.

### After behavior

Every control in the catalog — Gate, VAD, Ledger, Sentinel alike — now shares one enforcement point for
evidence integrity. A future control author cannot reintroduce this gap by forgetting to add an
integrity check; there is no check to add. The only way to bypass the gate is to be `TNA-INTEG-001`
itself, which is exempt by explicit design, not oversight.

---

## Finding 2 — manifest hash integrity was being treated as sufficient for trust

### Root cause

`verifyManifestIntegrity(manifest)` recomputes `manifest_hash` from `manifest.claims` and compares —
this proves the manifest is internally *consistent* (its content hasn't been altered without the hash
being recomputed to match). It says nothing about whether the *claims themselves* are true, or about
who actually produced the manifest. Before this closure pass, any manifest that passed this one check
and was installed by an `admin` principal was consulted by every manifest-backed control evaluator,
with no separate check of *provenance*. Hash integrity and claim authenticity were conflated into one
boolean gate.

### Before behavior

An administrator (or anything holding admin credentials) could call `buildManifest([{ claim_id: 'x',
control_id: 'TNA-CONTAIN-001', ..., description: 'Claims the concurrency-safe containment fix is in
place' }])` — which computes a perfectly correct hash over that fabricated content — install it via
`setManifest`, and have `TNA-CONTAIN-001` (or any other manifest-backed control) `PASS` as if the
component genuinely were the accepted, tested implementation. The manifest was real, stored, and
internally consistent; the claim inside it could still be entirely false, and nothing distinguished
that case from the genuine accepted baseline.

### Fix design

Manifest trust now has two independent, separately-enforced dimensions:

- **Integrity** (`verifyManifestIntegrity`, unchanged in meaning): does the hash match the content?
- **Authenticity** (`trust_class: ManifestTrustClass`, new — `BUILT_IN_ACCEPTED_BASELINE |
  ADMIN_PROVIDED | VERIFIED_EXTERNAL | UNTRUSTED`): where did this manifest actually come from, as
  determined by which trusted code path produced it — never by a caller-settable flag.

Only `BUILT_IN_ACCEPTED_BASELINE` can automatically satisfy an implementation-level control claim in
v0.1:

- `buildAcceptedBaselineManifest()` is the *only* function that can produce a
  `BUILT_IN_ACCEPTED_BASELINE`-classified manifest — it calls an unexported helper
  (`buildManifestWithTrustClass`) no other function can reach, bound to the six pinned accepted
  tag/commit anchors (`tna-gate-v0.1`, `tna-gate-v0.2`, `tna-gate-v0.3`, `vad-engine-v0.1`,
  `tna-ledger-v0.1`, `tna-sentinel-v0.1` — the exact commit SHAs recorded in each milestone's own
  proof-of-work document), compiled into trusted code, never accepted as caller input.
- `buildManifest(claims, ...)` — the caller-facing constructor used by `setManifest` — always forces
  `trust_class: 'ADMIN_PROVIDED'`. There is no parameter through which a caller can request any other
  classification.
- `AuditorRuntime` computes the accepted-baseline manifest exactly once, in its constructor
  (`builtInManifest`), and `EvaluationContext.manifest` — the *only* manifest any control evaluator ever
  sees during a real assessment run — is unconditionally set to it. `setManifest`/`getManifest` operate
  on a completely separate, always-`ADMIN_PROVIDED` manifest, stored purely for visibility/audit
  purposes; it is never wired into evaluation, no matter how internally hash-consistent it is.
- `setManifest` additionally rejects outright (`MANIFEST_INVALID`) any manifest whose declared
  `trust_class` is not `ADMIN_PROVIDED` — there is no way for a caller to reach
  `BUILT_IN_ACCEPTED_BASELINE` through the admin API, even by constructing the object manually and
  bypassing `buildManifest`.
- `manifestClaims(context, controlId)` (in `auditor-controls`) requires both `manifestValid &&
  manifestAuthentic` (`trust_class === 'BUILT_IN_ACCEPTED_BASELINE'`) before any claim counts.
  `evaluateManifestOnly` — the shared helper behind every manifest-backed control — gained a new branch:
  hash-valid but not authentic → `INSUFFICIENT_EVIDENCE` with reason `MANIFEST_NOT_AUTHENTIC`, never a
  silent pass-through.

No PKI or signing infrastructure was introduced. v0.1 needs none: the "authentic" set is exactly the six
already-accepted milestones, expressible as one compiled, pinned manifest. A future `VERIFIED_EXTERNAL`
classification (externally signed manifests from a party other than this codebase's own build) is
explicitly out of scope here and left for a later volume's design — not built now, per the closure
instruction not to start new feature work.

### Tests added

`tests/auditor/auditor-controls.test.ts`:

- An admin-installed manifest (`buildManifest`, `trust_class: 'ADMIN_PROVIDED'`) fabricating a claim for
  `TNA-EVID-001` — hash independently verified as internally consistent
  (`verifyManifestIntegrity(manifest) === true`, i.e. a *correctly self-computed hash*) — still yields
  `INSUFFICIENT_EVIDENCE`/`MANIFEST_NOT_AUTHENTIC` when evaluated, never `PASS`. This single test
  satisfies both the "admin fake manifest cannot satisfy a trusted claim" requirement and the "admin's
  correctly self-computed hash still cannot elevate trust" requirement — they are the same scenario,
  since `buildManifest` always computes a correct hash from its content; there is no way to construct
  an admin manifest with a *wrong* hash that would even reach the authenticity check.

`tests/auditor/auditor-engine.test.ts`:

- A caller-provided manifest whose object literal declares `trust_class: 'BUILT_IN_ACCEPTED_BASELINE'`
  is rejected by `setManifest` (`MANIFEST_INVALID`) and never installed — `getManifest` afterward
  returns `null`.
- `getBuiltInManifest()` always reports `trust_class: 'BUILT_IN_ACCEPTED_BASELINE'`, and installing an
  `ADMIN_PROVIDED` manifest via `setManifest` has zero effect on it — the two are structurally
  independent.

### After behavior

An admin can still install and retrieve a supplementary manifest for visibility/audit purposes — that
capability is preserved — but it can never, under any circumstance reachable through the public API,
cause a control to `PASS` on its own say-so. The only manifest that can automatically satisfy a claim is
the one this codebase itself compiles and pins to the six already-accepted milestones.

---

## Binding into the assessment hash and export

Both qualification dimensions are bound into `computeAssessmentHash`:

- `EvidenceRef.integrity_qualification` was already part of every ref hashed as part of
  `evidence_manifest` — no separate change needed there, but it means tampering a ref's qualification
  after export (e.g. `UNVERIFIED → VALID`) changes the recomputed hash.
- A new `manifestTrustClass: string` parameter is hashed directly (`manifest_trust_class` in the hashed
  object), fed from `AuditorRuntime`'s own `builtInManifest.trust_class` at finalization time — never
  from caller input.

This means replay can never silently reclassify `UNVERIFIED → VALID` or `ADMIN_PROVIDED →
BUILT_IN_ACCEPTED_BASELINE` — either change is a hash mismatch, caught by `verifyAuditPackage`.

The exported audit package (`AuditPackage`) exposes both, without exposing any secret:

- Every `evidence_manifest` entry carries its own `integrity_qualification`.
- A new top-level `manifest_trust_summary: { manifest_id, manifest_hash, trust_class }` field exposes
  exactly which manifest evaluation consulted for this run, sourced from `runtime.getBuiltInManifest()`.

### Tests added

`tests/auditor/auditor-package.test.ts`:

- The exported package's `evidence_manifest` entries all carry a valid `integrity_qualification`, and
  `manifest_trust_summary.trust_class` reads `BUILT_IN_ACCEPTED_BASELINE`.
- Tampering one `evidence_manifest[i].integrity_qualification` after export breaks
  `verifyAuditPackage` (`ASSESSMENT_HASH_MISMATCH`).
- Tampering `manifest_trust_summary.trust_class` after export (e.g. escalating `ADMIN_PROVIDED →
  VERIFIED_EXTERNAL`) independently breaks `verifyAuditPackage` too.

---

## What was preserved unchanged

- All 526 previously-accepted tests remain green, unweakened, unmodified in intent — see Verification
  below. No existing assertion was loosened to accommodate this pass.
- The control catalog itself: no control added, removed, or given new evaluation semantics beyond the
  integrity-qualification gate and the authenticity check both apply uniformly through the existing
  `evaluateControl`/`evaluateManifestOnly` machinery. `TNA-INTEG-001`'s own FAIL-on-corruption behavior
  is unchanged.
- The six accepted tag/commit anchors themselves, and every claim's `description`/`test_reference` —
  `buildAcceptedBaselineManifest()`'s content is unchanged; only its `trust_class` stamping and the
  exclusivity of the code path that can produce it are new.
- The HTTP API, the demo's Flow A/B/E mechanics, and `AuditorLedgerAdapter` — untouched.
- No new control, no regulatory mapping, no frontend, no new volume.

## Demo changes

Flow C (corrupt Ledger) gained one additional assertion: `TNA-AUTH-001` (a *dependent* control citing
the corrupted stream) resolves to the explicit `INSUFFICIENT_EVIDENCE` state, not merely a generic
`!= PASS` check — demonstrating Finding 1's fix through the real evaluation pipeline, in addition to the
pre-existing `TNA-INTEG-001 == FAIL` assertion for the dedicated control.

Flow D (containment uncertainty) was redesigned. Its previous mechanism — temporarily installing a
manifest that omitted the `TNA-CONTAIN-001` claim, forcing that control to fail, then restoring the full
manifest afterward — relied on the admin-manifest-swap path this closure pass makes structurally
impossible (an admin-installed manifest is never wired into evaluation at all now; see Finding 2). Flow
D now demonstrates the same "containment truthfulness" property with real evidence alone: Sentinel
reports `SENTINEL_TERMINATED` (a confirmed-containment claim) while `containment_status` is still
`CONTAINMENT_UNCONFIRMED` — a fabricated-confirmation scenario `TNA-CONTAIN-001`'s own evaluator FAILs
directly on the field-consistency check, independent of any manifest. This is, if anything, closer to
the control's actual intent (TNA-33/38: never fabricate confirmed containment) than the old
manifest-swap mechanism was, and it doubles as a real-evidence demonstration rather than a
manifest-shaped workaround. No other flow changed.

## Verification

```
npm run check   # typecheck && lint && build+test
```

Run twice consecutively, no cleanup between runs:

- Run 1: 535 tests, 535 pass, 0 fail (526 pre-existing baseline + 9 new trust-closure tests).
- Run 2 (immediately after): 535 tests, 535 pass, 0 fail.

```
npm run demo:auditor:v01
```

All five flows (A–E) print every required line and exit 0. Flow C carries the additional
dependent-control assertion described above; Flow D's events were redesigned as described above but its
observable outcome (`TNA-CONTAIN-001` cannot PASS while containment is fabricated/unconfirmed, overall
outcome not `PASS`) is unchanged in substance.

## New regression coverage

9 new tests across 3 files:

| File | Tests | What they prove |
|---|---|---|
| `auditor-controls.test.ts` | 4 | corrupt VAD evidence blocks `TNA-VER-001`; corrupt Sentinel evidence mixed with valid Gate evidence blocks `TNA-RUNTIME-001` (mixed-evidence case); an irrelevant corrupt stream does not poison `TNA-AUTH-001`; an admin-installed hash-valid manifest cannot satisfy `TNA-EVID-001` |
| `auditor-engine.test.ts` | 2 | a caller-declared `trust_class: BUILT_IN_ACCEPTED_BASELINE` is rejected by `setManifest`; the built-in manifest is always `BUILT_IN_ACCEPTED_BASELINE` and unaffected by `setManifest` |
| `auditor-package.test.ts` | 3 | the exported package exposes `integrity_qualification`/`manifest_trust_summary`; tampering either after export breaks `verifyAuditPackage` |

## Mandatory blockers remaining

**0**

## Recommendation

> **READY FOR ARCHITECTURAL ACCEPTANCE REVIEW**

This closure pass does not declare `tna-auditor-v0.1` accepted and does not tag it. Acceptance remains
the reviewer's call, on top of the original acceptance materials (`proof-of-work-auditor-v0.1.md` and
the rest of `docs/auditor/`, preserved unmodified in their original 526-test/5-flow claims) and this
document.
