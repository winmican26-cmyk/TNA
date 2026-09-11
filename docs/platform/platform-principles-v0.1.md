# TNA Principles TNA-43 – TNA-50 (Volume 8 — TNA Platform Integration v0.1)

These principles were established, tested, and cited inline throughout the Volume 8 (TNA Platform
Integration v0.1) documentation and its subsequent distributed-evidence closure pass. This document
consolidates them in one place for reference; it does not replace or restate the numbered principles
from earlier volumes (TNA-1 through TNA-42), which remain documented inline within their own
respective volumes' docs (Gate, VAD, Ledger, Sentinel, Auditor).

## TNA-43 — Integration Must Not Weaken Boundaries

An orchestration layer that sits on top of already-accepted components may coordinate them, but must
not reimplement, bypass, or dilute any accepted component's own enforcement. The platform orchestrates;
it does not replace any of Gate/VAD/Ledger/Sentinel/Auditor's own accepted logic. See
`platform-overview-v0.1.md`.

## TNA-44 — Correlation Is a Security Property

A `correlation_id`/`tenant_id`/`platform_action_id` linking evidence across subsystems is not merely a
convenience for reconstruction — it is itself a security-relevant boundary. A system must treat cross-
tenant or cross-action correlation collisions (even deliberately forced, white-box ones) as an integrity
threat to be tested against directly, not an implementation detail. Proven by the cross-tenant colliding-
correlation-id regression in `platform-causation.test.ts` and threat model category #39.

## TNA-45 — Durable State Precedes Distributed Assumption

A safety guarantee proven only against in-process/single-connection state (a mutex, a same-runtime
`Promise.all()`) must not be described or relied upon as a distributed guarantee until it is proven
against genuinely independent, concurrently live connections to the same durable store. See the
distributed-evidence closure pass, Finding 1, and threat model category #31.

## TNA-46 — Evidence Delivery Must Survive Process Failure

Evidence of a governed action must not be lost because the process that observed it crashed before
delivering it. A transactional outbox — state change and evidence obligation committed in one local
transaction, delivered with bounded, idempotent retry — is the mechanism; surviving a real process
restart (and, per the closure pass, surviving loss of the specific process that held a delivery claim)
is the test. See `platform-outbox-v0.1.md` and the distributed-evidence closure pass, Finding 1.

## TNA-47 — External Success and Assurance Success Are Different Facts

A connector's reported execution outcome and the system's ability to durably record evidence of that
outcome are two independent facts and must never be merged into one. A successful execution whose
evidence delivery later degrades must report `execution result: SUCCEEDED` and
`evidence delivery: DEGRADED` as the two separate, honest facts they are — never silently upgraded to
one clean "success." See `platform-outbox-v0.1.md` and threat model category #17.

## TNA-48 — Uncertain External Effects Must Not Be Retried Blindly

Once an external connector may have performed a non-idempotent side effect, the system cannot
universally confirm or roll it back. Every genuinely uncertain outcome (unconfirmed containment, a
crash mid-execution, exhausted evidence-delivery retries) must resolve to `INDETERMINATE` — an honest
representation of real uncertainty — never a guessed `SUCCEEDED`/`FAILED`, and never a blind automatic
retry of the external effect itself. See `platform-threat-model-v0.1.md`, "Connector side-effect
limitation."

## TNA-49 — Delivery Ownership Must Be Durable

A distributed evidence obligation must have a durable owner or lease; process-local belief is
insufficient. A claim that "this process owns delivery of this record" must be encoded in the durable
store itself (a database-level lease with an owner identity, a fencing token, and an expiry), not merely
held in one process's memory — so that a second, independently live process sharing the same durable
store can neither believe it also owns the same obligation nor be permanently locked out by a claimant
that has since died. Established by the distributed-evidence closure pass, Finding 1 — see
`platform-v0.1-distributed-evidence-closure.md` and threat model categories #31-35.

## TNA-50 — Causation Is Captured, Not Reconstructed

Evidence must retain the causal facts that existed when its obligation was created; later mutable state
must not rewrite provenance. An event's recorded cause must be captured once, at the instant the event's
own obligation becomes true, and frozen from that point forward — never re-derived at delivery time from
whatever the causing entity's state currently happens to be, since that state may have legitimately
changed since. Established by the distributed-evidence closure pass, Finding 2 — see
`platform-v0.1-distributed-evidence-closure.md` and threat model categories #36-39.
