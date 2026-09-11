# TNA Ledger Reconstruction v1.0

Status: IMPLEMENTED, TESTED

## The question this answers

Per the Ledger's founding question (TNA-19): given only the Ledger's evidence — never the agent's
own narrative — can an auditor reconstruct what happened, under what authority, and what the
outcome was?

## reconstructGateAction

`Ledger.reconstructGateAction(principal, correlationId)` (correlation = the Gate `decision_id`)
walks every event sharing that correlation and derives:

- `who` — actor of the `AUTHORIZATION_ALLOWED` event.
- `authorizedUnder` — `decision_id` + `policy_hash` from that same event.
- `what` / `tool` / `resource` — the authorized action and its bound tool/resource.
- `approval` — actor of an `APPROVAL_GRANTED` event, if one exists in the correlation.
- `capability` — `capability_id` from `CAPABILITY_ISSUED`.
- `execution` — `execution_id` from `EXECUTION_STARTED`.
- `outcome` — derived from the last terminal execution event
  (`SUCCEEDED/FAILED/TERMINATED/INDETERMINATE`), or `UNKNOWN` if none exists yet.
- `evidence` — the ordered list of event references (`event_id, event_type, stream_id, sequence`)
  the reconstruction was built from, so every claim above is independently checkable against the
  underlying events.

Note that `AGENT_REGISTERED` is correlated to the agent's own lifecycle stream, not to any one
decision — it legitimately does not appear in a decision-scoped reconstruction (see
`ledger-stream-model-v1.md` §correlation vs. causation vs. stream). This is by design, not an
omission bug (confirmed by test: `ledger-query.test.ts`, "reconstructs a full Gate action").

## reconstructVadAtom

`Ledger.reconstructVadAtom(principal, correlationId)` (correlation = `atom:<atomId>`) derives:

- `atom` — `atom_id` + `spec_hash` from `ATOM_CREATED`.
- `attempts` — every `ATOM_ATTEMPT_STARTED`/`ATOM_ATTEMPT_FAILED` event, with attempt number.
- `validation` — `{ passed: true }` if an `ATOM_VALIDATION_PASSED` exists, `{ passed: false }` if
  only `ATOM_VALIDATION_FAILED` exists, `null` if neither has happened yet.
- `verification` — verdict from the latest `ATOM_VERIFICATION_ACCEPTED`/`REJECTED`.
- `humanDecision` — decision and actor from `ATOM_HUMAN_DECISION`.
- `finalState` — `ACCEPTED/REJECTED/ESCALATED`, or `UNKNOWN` if the atom hasn't reached one.
- `evidence` — same evidence-reference list as above.

This reproduces the full VAD narrative — fail → retry → pass → verify → human decision → accept —
purely from Ledger evidence, independent of the VAD runtime's own in-memory state
(`ledger-query.test.ts`, "reconstructs a full VAD atom lifecycle").

## Bounds

Both reconstructions fetch at most `MAX_RECONSTRUCTION_EVENTS` (500) events for a correlation. If
more exist, the result reports `truncated: true` and `evidence` contains exactly the 500 that were
examined — the caller is told the reconstruction is incomplete rather than silently receiving a
partial picture presented as complete (section 96; tested with 501 events in one correlation).
There is no continuation cursor for reconstruction in v0.1 — a truncated reconstruction currently
requires falling back to the paginated query API to see the remainder. Documented as a known
limitation, not implemented as a seamless continuation.
