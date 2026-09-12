# TNA Operator CLI v0.1 — Incident Scenarios

Real operator guidance for each honest degraded state `tna doctor`/`tna status` can report. None of
these are simulated for this document — every scenario below is a real, reachable state of the accepted
Volumes 1-10 architecture.

## Gate outage

`doctor`'s `platform.gate` check reports FAIL (mandatory). Consequence: no new consequential action can
be authorized (`PlatformGateOrchestrator.authorize` fails). `tna action explain` on any action affected
by this shows `SENTINEL_UNAVAILABLE`-shaped guidance is NOT what applies here — a Gate outage prevents
authorization entirely, before Sentinel is ever reached.

**Safe escalation**: stop initiating new high-risk work, collect an incident package
(`tna incident collect`), verify Gate's own process/store health directly, restore only if the store
itself is corrupted.

## Sentinel outage

`doctor`'s `platform.sentinel` check reports FAIL. Consequence: `PlatformExecutionOrchestrator.run`
fails closed at the Sentinel-session-creation step (`SENTINEL_UNAVAILABLE`) — it never falls back to
unmonitored execution. `go-live assess` reports `sentinel_available: false`, which is a blocking check
(NO_GO).

## Ledger outage

`doctor`'s `platform.ledger` check reports FAIL. Distinguish **execution** from **evidence delivery**:
an action's own `state` can be `COMPLETED` (the real external effect happened) while its evidence
obligation is `EVIDENCE_DEGRADED` in the outbox — never silently upgraded to a clean "audited" claim
(TNA-47, carried forward). `tna action explain` reports this distinction explicitly.

## MCP failure

`tna action explain` on an MCP-backed action distinguishes `MCP_SERVER_UNAVAILABLE`,
`MCP_SCHEMA_DRIFT`, `MCP_PROTOCOL_ERROR`, `MCP_TIMEOUT`, and `MCP_INDETERMINATE` — each with distinct
guidance (see `apps/tna-operator/src/explain.ts`).

## Dead letter

`doctor`'s `platform.outbox_dead_letter` check reports FAIL when `> 0`. This means one or more evidence-
delivery events exhausted their retry budget — investigate the Ledger connection and the specific
dead-lettered events (`GET /v1/platform/outbox/dead-letters`, exposed but not yet wrapped by a dedicated
CLI subcommand in this pass — see the proof-of-work's "Remaining Limitations").

## Ledger corruption

A real Ledger integrity failure is not automatically repaired by any command in this volume. `go-live
assess` reports `NO_GO` (ledger_available: false is a blocking check). No CLI command in this pass
offers automatic repair — none should exist.

## Safe escalation (general)

1. Stop initiating new high-risk execution.
2. `tna incident collect [--tenant <id>]`.
3. Verify Ledger integrity directly (existing accepted tooling, e.g. `packages/ledger-core`'s
   `verifyAll`/`verifyStream`, not yet wrapped by a dedicated `tna` subcommand in this pass).
4. Review the outbox (`doctor`'s dead-letter/pending counts).
5. Restore only if actually required — never as a first response to a reported degradation.

No command in this CLI takes a destructive or corrective action automatically.
