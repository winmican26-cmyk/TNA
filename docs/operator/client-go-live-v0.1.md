# TNA Operator CLI v0.1 — Client Go-Live Assessment

`tna go-live assess --tenant <id> [--test-action <id>] [--bypass-tna-chain] [--bypass-external-credential] [--allow-known-bypass]`
(`apps/tna-operator/src/go-live.ts`).

> **TNA Client Go-Live Assessment evaluates configured operational readiness against available system
> evidence. It does not certify security, regulatory compliance, contractual compliance, or absence of
> risk.**

## Statuses

`GO` / `GO_WITH_LIMITATIONS` / `NO_GO` / `INSUFFICIENT_EVIDENCE`.

## Blocking checks (any failure → NO_GO)

deployment readiness, Gate available, Ledger available, Sentinel available, tenant ACTIVE, at least one
active service identity, no tools pending policy review (schema drift or unreviewed discovery).

## Non-blocking checks (failure → GO_WITH_LIMITATIONS, never NO_GO on their own)

at least one reachable MCP server, at least one enabled tool, backup recency (when supplied), test
action completion (when `--test-action` supplied).

## Bypass assessment (section 112)

Reuses the real, accepted `computeBypassAssessment()` from `packages/client-schema` — no duplicate
logic. `KNOWN_BYPASS` can **never** produce a clean `GO`: it forces `NO_GO` unless the operator
explicitly passes `--allow-known-bypass`, in which case the result is `GO_WITH_LIMITATIONS` — never a
clean `GO` even then. No bypass attestation supplied at all produces `INSUFFICIENT_EVIDENCE`, never a
guessed `GO`.

## Snapshot binding

Every assessment carries `snapshot_hash` — a SHA-256 of the tenant id, timestamp, every check, the
bypass assessment, and the resulting status. A later config change cannot retroactively alter what an
earlier assessment said.

## TNA-127 (operator acceptance does not rewrite evidence)

Passing `--allow-known-bypass` changes how a KNOWN_BYPASS is *scored* (NO_GO → GO_WITH_LIMITATIONS); it
never changes what the underlying evidence says. There is no flag anywhere in this module that can turn
a real Ledger-unavailable or Sentinel-unavailable check into a passing one — those remain hard,
unconditional blockers.
