# TNA Ledger Schema Evolution

Status: FUTURE (design notes only — no migration engine exists in v0.1)

## Current state

Every event carries `version: "1.0"`. `validateEventInput` rejects anything else with
`UNSUPPORTED_VERSION` rather than attempting to reinterpret it (section 82). There is no version
negotiation and no migration engine in v0.1.

## Append-compatible changes (do not require a version bump)

- Adding a new optional field to an existing context block, as long as its absence remains
  meaningful (validated as `undefined`, not defaulted).
- Adding a new value to `SourceComponent` or `ActorType`, as long as existing values keep their
  meaning.
- Adding a new event type to the registry, as long as no existing type's completeness rules change.

These are additive: an old reader that does not know about a new optional field simply ignores it in
its own context-block destructuring; it does not need to be re-verified to keep working with
existing data.

## Breaking changes (require a version bump)

- Removing or renaming any required field.
- Changing what a completeness rule requires for an existing event type.
- Changing the set of fields bound into `EventHashCore` (this changes every future event's hash
  computation and must be versioned explicitly, since it is not backward-verifiable against events
  hashed under the old core).
- Narrowing an enum (removing a previously-valid `ActorType`, `SourceComponent`, or event type).

## Migration strategy (future)

Not built in v0.1. The intended shape, when needed:

1. Bump `version` to `"1.1"` (or `"2.0"` for a hash-core change) and accept both the old and new
   version in `validateEventInput` for a defined deprecation window.
2. Historical events are never rewritten to the new version — `ledger-integrity-model-v1.md`'s
   append-only guarantee applies to schema version too. A reader that needs to reason uniformly
   across versions does so by branching on the stored `version` field per event, not by expecting a
   backfill.
3. If a hash-core change is unavoidable, `computeEventHash` must dispatch on `version` so that
   verification of pre-existing events keeps using the hash core they were actually written with.
   This is not implemented today because only one version exists; it is the reason `version` is
   bound into `EventHashCore` itself.

## What NOT to do

- Do not silently reinterpret an unsupported version as the current one (section 82).
- Do not add a "migrate in place" tool that rewrites historical event rows — that would violate
  append-only history (TNA-20) for the sake of schema convenience.
