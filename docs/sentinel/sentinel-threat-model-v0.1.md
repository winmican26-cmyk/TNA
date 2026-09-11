# TNA Sentinel v0.1 Threat Model

Status per category: MITIGATED, PARTIALLY MITIGATED, or NOT MITIGATED (explicit, by design or by
scope). "Mitigated" means a deterministic control exists and is tested — not that the category is
impossible.

| # | Threat | Status | Detail |
|---|---|---|---|
| 1 | Observation forgery | MITIGATED | controlled `ObservationSource` enum, source→type binding, no factory issues a governed agent observer/controller/admin identity |
| 2 | Source impersonation | MITIGATED | `assertCanObserve` rejects any type outside the bound sources' allowlist; proven with an EXECUTION_BROKER-bound principal attempting `AUTHORITY_RECHECK` |
| 3 | Missing observation | PARTIALLY MITIGATED | Sentinel can only evaluate what it is told (section 114) — a required source that never reports simply produces no evidence, not a synthesized alarm |
| 4 | Delayed observation | NOT MITIGATED | no freshness/staleness check on `timestamp` (informational only); a late-arriving observation is still processed at its actual `received_at` |
| 5 | Observation reorder | PARTIALLY MITIGATED | `sequence` is runtime-assigned and monotonic per session, so persisted order is trustworthy; nothing forces a producer's real-world event order to match submission order |
| 6 | Duplicate observation | MITIGATED | identical `observation_id`+content is idempotent; identical id with different content is `OBSERVATION_CONFLICT` |
| 7 | Session hijack (wrong caller acting on a session id) | MITIGATED | every session lookup is scoped by the caller's own `tenant_id`; a cross-tenant caller gets `NOT_FOUND`, not a usable handle |
| 8 | Tenant crossover | MITIGATED | `(tenant_id, sentinel_session_id)` composite scoping throughout the store and facade; proven with same-agent-id-shaped ids across two tenants |
| 9 | Policy drift | MITIGATED | `POLICY_CHANGED` rule + `AuthorityRevalidator`/`*_RECHECK` observation path; default action HOLD, not silent continuation |
| 10 | Authority drift (expiry) | MITIGATED | `AUTHORITY_EXPIRED` rule against Sentinel's own clock, independent of any external call |
| 11 | Revocation race | MITIGATED | revalidation is consulted per evaluation, not cached from session start; proven with the Sentinel G2 race test |
| 12 | Tool drift | MITIGATED | `TOOL_NOT_ALLOWED` |
| 13 | Resource drift | MITIGATED | `RESOURCE_NOT_ALLOWED`, separator-aware matching (VAD V2 lesson carried forward) |
| 14 | Destination drift | MITIGATED | `DESTINATION_NOT_ALLOWED`, `REDIRECT_NOT_ALLOWED` (evaluates the redirected destination, not just the original) |
| 15 | Input mutation | MITIGATED | `TOOL_INPUT_HASH_MISMATCH` |
| 16 | Capability mismatch | MITIGATED | `CAPABILITY_CONTEXT_MISMATCH` across all bound capability fields |
| 17 | Cost evasion | MITIGATED | `session_cost` is a runtime-owned aggregate; NaN/Infinity/negative increments are dropped, never trusted |
| 18 | Runtime evasion | MITIGATED | elapsed runtime is computed from Sentinel's own clock and `started_at`, never accepted from a caller |
| 19 | Heartbeat loss | MITIGATED (optional) | `MISSING_HEARTBEAT`, only when a session configures heartbeat monitoring |
| 20 | Containment failure | MITIGATED (honestly reported) | unconfirmed containment resolves to `INDETERMINATE`, never a false `TERMINATED`/`HELD`-confirmed |
| 21 | Containment uncertainty | MITIGATED (represented, not hidden) | `containment_status` distinguishes REQUESTED/CONFIRMED/UNCONFIRMED at the decision level |
| 22 | Emergency-stop bypass | MITIGATED | checked on every evaluation before ordinary rules run, at session/agent/tenant scope, admin-only to activate/release, persisted |
| 23 | Resume abuse | MITIGATED | `resume()` requires controller/admin; a reader-level (agent-equivalent) identity is rejected |
| 24 | Secret leakage | MITIGATED (fixed rule set) | same secret-shaped-field/value detector principle as the accepted Ledger — not general DLP |
| 25 | Resource exhaustion (payload/query) | MITIGATED | `MAX_OBSERVATION_PAYLOAD_BYTES`, bounded/paginated violation and decision queries |
| 26 | Privileged database rewrite | NOT MITIGATED (by design) | identical posture to the accepted Ledger — a party with direct SQLite file access can rewrite history; out of scope for an application-level control |
| 27 | Compromised host | NOT MITIGATED (by design) | see below |
| 28 | Compromised Sentinel process | NOT MITIGATED (by design) | if the Sentinel process itself is compromised, its own decisions/evidence cannot be trusted; no control in this milestone claims otherwise |
| 29 | Concurrent mixed-decision race | MITIGATED (concurrency closure pass) | fresh-read-inside-the-lock reconciliation (`reconcileAndClaim`/CAS with `state_version`) replaces the unconditional stale write; proven by `sentinel-v0.1-concurrency-closure.md` and `tests/sentinel/sentinel-concurrency-closure.test.ts` (14 tests) — see that closure doc for the originally-reported failure |
| 30 | Stale session-state overwrite | MITIGATED | a weaker decision computed from a stale snapshot can never overwrite a stronger status already committed; terminal statuses and an in-flight `TERMINATING` both short-circuit to `NO_OP_ALREADY_STRONGER` before any write is attempted |
| 31 | Containment/evidence divergence | MITIGATED (represented, not silently possible) | every decision — including a superseded one — is persisted with an honest `transition_result`; the session's single durable `status` always reflects whichever containment outcome actually won the claim, never a stale record |
| 32 | Stale resume after termination | MITIGATED | `resume()` re-reads the session's status inside the same exclusive transaction as its write and requires it to be exactly `HELD` at that moment; a session that has concurrently moved to `TERMINATING`/`TERMINATED`/`INDETERMINATE` fails to resume with `INVALID_TRANSITION` instead of silently succeeding from a stale snapshot |

## Compromised host limitation (section 113)

A Sentinel process running on a compromised host cannot be assumed to observe or contain a malicious
actor controlling that host. Sentinel's containment and observation model both depend on the
surrounding platform (execution broker, isolation runner, egress guard) honestly reporting what it
sees and honoring containment requests. This is not claimed otherwise anywhere in this milestone.

## Observability limitation (sections 114-115)

Sentinel can only evaluate behavior it observes. An action taken through an uninstrumented path —
one that never produces a bound-source observation — is invisible to every rule in the catalog.
**Absence of a detected violation is not proof that no violation occurred**; it only proves nothing
*observed* triggered a match. This is fundamental to any control built on submitted evidence rather
than kernel-level enforcement, and it is the reason `MISSING_EVENT ≠ SAFE_EVENT` is elevated to a
permanent principle (TNA-28/29) rather than left as a footnote.

## DNS rebinding (section 90)

`PRIVATE_NETWORK_DESTINATION` only classifies what it is given — a literal IP hostname, or a
`resolved_address` an observation explicitly reports. Sentinel does not itself perform DNS resolution
or re-resolve a hostname between observation and any real network call, so a DNS-rebinding attack
that changes resolution after the observation is submitted is not detected here. This mirrors the
same documented limitation in the accepted `egress-guard`'s own module doc.

## Fixed secret detection, not DLP (section 86)

`findSecretShapedField` (duplicated locally in `sentinel-schema`, same algorithm as the accepted
Ledger's) catches secret-shaped field names and bearer-token-shaped values. It is a fixed rule set —
it does not detect every possible secret encoding, and no claim of comprehensive data-loss prevention
is made.
