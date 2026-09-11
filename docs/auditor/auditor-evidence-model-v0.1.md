# TNA Auditor Evidence Model v0.1

## Evidence bundle

```ts
interface EvidenceBundle {
  tenant_id: string; evidence_cutoff_at: string; collected_at: string;
  events: readonly LedgerEvent[];               // deduplicated by event_id, sorted (stream_id, sequence)
  stream_integrity: Readonly<Record<string, { qualification: EvidenceQualification; reason: string | null; checked_at: string }>>;
  conflicts: readonly { description: string; event_ids: readonly string[] }[];
  truncated: boolean;
}
```

> Updated by the trust-closure pass (see "Trust-closure pass" section below): `stream_integrity`
> originally carried a boolean `valid` field. It is now `qualification: EvidenceQualification`
> (`VALID | INVALID | UNVERIFIED | UNAVAILABLE`) — a boolean cannot distinguish "confirmed corrupt"
> from "never checked," and that distinction turned out to matter (see Finding 1 below).

One immutable snapshot per assessment run, persisted in full (`auditor_runs.evidence_bundle_json`) so
replay never depends on Ledger's *current* state (section 19).

## Provider interface (section 65)

```ts
interface EvidenceProvider { collect(request: EvidenceRequest): Promise<EvidenceBundle>; }
```

- **`LedgerEvidenceProvider`** — the primary, preferred provider (section 13, 15). Never mutates
  Ledger; authenticates only as a tenant-scoped reader principal.
- **`StaticEvidenceProvider`** — deterministic in-memory provider for tests and the demo, applying the
  identical cutoff/time-range/dedup/conflict rules as the real provider.

Collection is bounded by a runtime-owned timeout (`DEFAULT_COLLECTION_TIMEOUT_MS = 10_000`, section
66) — never caller-configurable — and by `MAX_COLLECTED_EVENTS`/`MAX_PAGES_PER_QUERY` (section 111).

## The query-strategy problem, and its fix

`Ledger.getEventsByActor(principal, agentId)` matches on an event's `actor.id` — but the accepted
`GateLedgerAdapter` records almost every Gate event's actor as the *system component* that acted
(`{type:'SYSTEM', id:'tna-gate'}`, `'execution-broker'`, ...), not the governed agent the event
concerns. An agent-scoped evidence pull that used `getEventsByActor` alone would silently miss nearly
all Gate-originated evidence for that agent — a real gap, caught by testing against the actual
`GateLedgerAdapter` output rather than an idealized fixture (`tests/auditor/auditor-evidence.test.ts`
originally failed with zero collected events before this was fixed).

`LedgerEvidenceProvider`'s agent-scoped collection therefore pulls from three sources and unions them:

1. **`getStream(principal, 'agent:<agentId>')`** — Gate's own dedicated per-agent stream (registration,
   authorization, capability, execution events all land here).
2. **`getEventsByActor(principal, agentId)`** — catches the cases where the agent genuinely is the
   actor (e.g. `capabilityRedeemed`'s `actor: {type:'AGENT', id: agentId}`).
3. **`getEventsByDecision(principal, decisionId)`** for every `decision_id` surfaced by (1) — bridges
   evidence that lives in a *different* stream but carries the same `authority_context.decision_id`.
   This is how Sentinel's `SENTINEL_SESSION_STARTED` (stream `sentinel:<sessionId>`, `authority_context
   .agent_id` and `.decision_id` set by `SentinelLedgerAdapter`) becomes reachable from an agent-scoped
   assessment even though it never touches the `agent:<agentId>` stream.

`correlation_ids` in scope use `getEventsByCorrelation` directly — the right tool when the caller
names a specific atom/session/decision id explicitly.

## Documented limitation: VAD atom evidence is not agent-reachable

`VadLedgerAdapter` sets neither an `agent:<agentId>` stream membership nor
`authority_context.agent_id` on any VAD event (confirmed by reading the adapter directly, not
assumed). **An assessment scoped only by `agent_ids` cannot automatically discover that agent's VAD
atom evidence.** To assess VAD-related controls (`TNA-VER-001`, `TNA-VER-002`), the assessment's scope
must explicitly include the relevant `correlation_ids` (atom ids). This is stated here rather than
silently worked around — per section 93, "document this honestly. Do not over-generalize." A control
evaluator seeing no VAD evidence in an agent-only scope correctly returns `INSUFFICIENT_EVIDENCE`, not
a fabricated pass or a misleading fail.

## Evidence-after-cutoff (sections 18, 107)

Filtering is by each event's own runtime-assigned `received_at` against `evidence_cutoff_at` — never
by "how long ago `collect()` was called." An event written to Ledger after the cutoff timestamp is
excluded even if `collect()` itself runs much later (proven directly).

## Deduplication (section 67)

Events reachable through more than one of the three query paths above are deduplicated by
`event_id` before being handed to any control evaluator — duplicate evidence never inflates a count-
based control's confidence.

## Conflict detection (section 68)

One concrete, well-defined check: two trusted events (`AUTHORIZATION_ALLOWED` /
`AUTHORIZATION_BLOCKED` / `AUTHORIZATION_HELD`) disagreeing on the outcome of the *same*
`authority_context.decision_id`. This is not general-purpose contradiction detection — it is
documented as exactly this one check, recorded on the bundle as `conflicts`, and does not by itself
force any control result (a future control could consult it; v0.1 records it for visibility).

## Source trust (section 14)

`EVIDENCE_SOURCE_TRUST_LEVELS = TRUSTED_SYSTEM | VERIFIED_LEDGER | SIGNED_EXPORT |
CONFIGURATION_SNAPSHOT | OPERATOR_ASSERTION | UNTRUSTED_SELF_REPORT`. Every `EvidenceRef` the
provider produces is tagged `VERIFIED_LEDGER`; implementation-manifest claims are tagged
`TRUSTED_SYSTEM`. No code path in this milestone ever constructs an `EvidenceRef` at `OPERATOR_ASSERTION`
or `UNTRUSTED_SELF_REPORT` trust and has it satisfy a control — those levels exist in the schema for
future extension (e.g. an operator-attested control), not because v0.1 uses them.

## Historical vs. current state (section 69)

A historical `AUTHORIZATION_ALLOWED` event proves an authorization happened *then*. It does not prove
the authorizing policy configuration is correct *now*. No control in this catalog conflates the two:
event-based controls are phrased and evaluated as claims about the evidence in scope, and
manifest-backed controls are explicitly labeled as reflecting "the referenced component version," not
this specific execution.

## Implementation-evidence manifest (sections 90-92)

```ts
interface ControlImplementationClaim { claim_id, control_id, component, accepted_tag, accepted_commit, description, test_reference }
interface ControlImplementationManifest { version: '1.0'; manifest_id; created_at; claims; manifest_hash; trust_class: ManifestTrustClass }
```

`manifest_hash = hash(claims)` (canonical, sorted-key JSON + SHA-256, same algorithm as the rest of
the platform). `verifyManifestIntegrity(manifest)` recomputes and compares — a manifest is *never*
trusted merely because a caller sets `trusted: true`; a manifest whose hash does not match its own
content is rejected outright by `setManifest`. `buildManifest` additionally rejects a malformed claim
(e.g. an `accepted_commit` that isn't a 40-hex git SHA) before a hash is even computed.

`buildAcceptedBaselineManifest()` seeds the trusted default: one claim per accepted TNA milestone
capability (Gate v0.1-v0.3, VAD Engine v0.1, Ledger v0.1, Sentinel v0.1), each bound to its exact
accepted tag and commit SHA, with a `test_reference` pointing at the actual test/doc that
substantiates the claim.

> As of the trust-closure pass (see below), the sentence above — "only a manifest ... installed by an
> `admin` principal ... is ever consulted by a control evaluator" — is no longer true, and describes a
> gap that has since been closed. See Finding 2.

## Trust-closure pass: two evidence-trust gaps found after the initial green suite

An architectural review conducted *after* the original v0.1 acceptance suite went green (526 tests,
5/5 demo flows) found two trust-boundary gaps that no individual test caught, because each test
correctly proved what it set out to prove without needing the property that turned out to be missing.
Per the same "do not pretend it never existed" discipline applied to the Sentinel concurrency finding
(TNA-33/34), both are recorded here rather than silently patched. Full root-cause/fix/test detail is
in `docs/auditor/auditor-v0.1-trust-closure.md`; this section summarizes the resulting evidence-model
changes.

### Finding 1 — evidence integrity was checked per-control, not architecturally

Before the closure pass, `TNA-INTEG-001` checked stream integrity, and `TNA-AUTH-001` additionally ran
its own bespoke integrity check — but no other control did. A control whose evaluator never thought to
call `verifyStream()` could PASS on evidence from a stream that had already failed integrity
verification elsewhere in the same bundle. This is a *convention*, not a *guarantee*: a correct
implementation requires every evaluator author to remember to add the check, forever.

**Fix**: evidence-integrity qualification is now computed once, centrally, at collection time (`
stream_integrity`, `qualification: EvidenceQualification`), stamped onto every `EvidenceRef` the
instant it is created (`eventRef()`, so the qualification travels with the reference rather than
needing a separate lookup), and enforced by one architectural gate —
`qualifyEvidenceIntegrity(control, result, context)` in `auditor-controls` — that every non-`TNA-INTEG-001`
control result passes through inside `evaluateControl()` before it is ever returned. No evaluator
needs to know this gate exists. A PASS/PARTIAL result citing an `INVALID` (confirmed-corrupt) or
`UNVERIFIED`/`UNAVAILABLE` (never-confirmed) `LEDGER_EVENT` ref is downgraded to
`INSUFFICIENT_EVIDENCE` — never `FAIL`, since corrupt/unverified evidence means the evidence cannot
support the claim, not that the underlying technical control definitely does not exist. `TNA-INTEG-001`
itself is exempt (it *is* the integrity signal; it independently FAILs on this condition via its own
evaluator, and running the gate on it would be circular). Because the gate inspects only the refs an
evaluator itself cited, a control that never touched a corrupted stream is structurally unaffected —
an irrelevant corrupt stream never poisons an unrelated control's result, with no special-casing.

This is TNA-41: **evidence integrity is transitive to the conclusion** — a conclusion cannot be
stronger than the integrity of the specific evidence used to derive it.

### Finding 2 — manifest hash integrity was being treated as sufficient for trust

Before the closure pass, any manifest whose `manifest_hash` matched its own content, installed by an
admin principal, was consulted by every manifest-backed control evaluator. But a hash only proves the
manifest is internally *consistent* — that its content hasn't been altered without also updating the
hash. It says nothing about whether the *claims themselves* are true. An admin (or anything with admin
credentials) could construct a manifest asserting a nonexistent protection, compute a perfectly correct
hash over it, and have it accepted exactly as if it were the genuine accepted-baseline manifest.

**Fix**: manifest trust now has two independent, separately-enforced dimensions:

- **Integrity** (`verifyManifestIntegrity`, unchanged): does the hash match the content?
- **Authenticity** (`trust_class: ManifestTrustClass`, new — `BUILT_IN_ACCEPTED_BASELINE | ADMIN_PROVIDED
  | VERIFIED_EXTERNAL | UNTRUSTED`): where did this manifest actually come from?

Only `BUILT_IN_ACCEPTED_BASELINE` can automatically satisfy an implementation-level control claim in
v0.1. That classification is reachable through exactly one code path — `buildAcceptedBaselineManifest()`,
which calls an unexported helper no other function can reach — bound to the six pinned accepted
tag/commit anchors, compiled into trusted code, never accepted as caller input. `AuditorRuntime` computes
this manifest once in its constructor (`builtInManifest`) and it is the *only* manifest
`EvaluationContext.manifest` is ever set to during evaluation — `setManifest`/`getManifest` operate on a
completely separate, always-`ADMIN_PROVIDED`-classified manifest, stored for visibility/audit purposes
only, never wired into evaluation, no matter how internally hash-consistent it is. `setManifest` rejects
outright (`MANIFEST_INVALID`) any manifest whose `trust_class` isn't `ADMIN_PROVIDED` — there is no way
for a caller to reach `BUILT_IN_ACCEPTED_BASELINE` through the admin API. `manifestClaims()` (in
`auditor-controls`) requires both `manifestValid && manifestAuthentic` before a claim counts; a
hash-valid-but-inauthentic manifest yields `INSUFFICIENT_EVIDENCE` with reason `MANIFEST_NOT_AUTHENTIC`,
never a silent pass-through.

No PKI or signing infrastructure was introduced for this — v0.1 needs none, since the "authentic" set is
exactly the six already-accepted milestones, expressible as a compiled, pinned manifest. A future
`VERIFIED_EXTERNAL` classification (externally signed manifests) is out of scope here and left for a
later volume's design, not built now.

This is TNA-42: **integrity does not imply authenticity** — a perfectly hashed assertion can still be
false; trust requires an authenticated provenance boundary.

### Binding into the assessment hash and export

Both qualification dimensions are bound into `computeAssessmentHash` (evidence refs, which now carry
`integrity_qualification`, are hashed as before; a new `manifest_trust_class` parameter is hashed
directly) — replay can never silently reclassify `UNVERIFIED → VALID` or `ADMIN_PROVIDED → TRUSTED`,
because doing so changes the recomputed hash. The exported audit package exposes both: every
`evidence_manifest` entry carries its `integrity_qualification`, and a new top-level
`manifest_trust_summary: { manifest_id, manifest_hash, trust_class }` exposes which manifest evaluation
actually consulted, so a reviewer can see directly why evidence was (or was not) allowed to support a
control, without secrets ever being exposed. Tampering either field in an exported package is caught by
`verifyAuditPackage()` (assessment-hash mismatch).
