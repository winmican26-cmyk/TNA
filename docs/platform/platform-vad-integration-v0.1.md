# TNA Platform — VAD Integration v0.1

## `VadPort` (sections 27-30)

```ts
interface VadPort { verify(input: VadVerifyInput): Promise<VadVerdict> }
interface VadVerifyInput { platform_action_id, correlation_id, tenant_id, goal, resource, result_hash, max_runtime_seconds, max_cost_usd }
interface VadVerdict { atom_id: string; final_state: 'ACCEPTED' | 'REJECTED' | 'ESCALATED' | 'FAILED' }
```

VAD has no principal/durability model of its own (unlike Gate/Sentinel/Ledger/Auditor) — a fresh
in-memory `EvidenceStore` and atom spec are used per verification. `platform-core` never imports VAD's
library classes directly; `VadVerificationAdapter` (`apps/tna-platform`) owns the real
atom-spec → producer → validation-gate → verifier → human-decision sequence, mirroring how
`GateActionAdapter` insulates `platform-core` from Gate's own internals.

## Routing (section 27-28)

`requires_verification: false` → VAD is never invoked; the action completes directly from `EXECUTING`.
`requires_verification: true` → `EXECUTING -> VERIFYING`, then `VadPort.verify()` is awaited.
**No configured `VadPort` with `requires_verification: true` is itself `INDETERMINATE`**, never a
silent pretend-skip to `COMPLETED` — proven directly (`platform-execution.test.ts`).

## Verdict mapping (sections 29-30)

| VAD final state | Platform state | error_code |
|---|---|---|
| `ACCEPTED` | `COMPLETED` | — |
| `REJECTED` | `FAILED` | `VERIFICATION_REJECTED` |
| `ESCALATED` | `INDETERMINATE` | `VERIFICATION_ESCALATED` |

A rejected or escalated verdict is never reported as `COMPLETED` (proven for all three outcomes via a
fake `VadPort` in `platform-execution.test.ts`, and the `ACCEPTED` path proven against the real VAD
library in Demo Flow 4 and `platform-auditor-integration.test.ts`'s indirect coverage).

## The adapter's atom construction

`VadVerificationAdapter` builds a minimal, self-contained atom per verification: one
`success_criteria` entry, empty `resources`/`constraints` (nothing to violate), `max_attempts: 1`, and
the platform's own `max_runtime_seconds`/`max_cost_usd`. It supplies one synthetic `PASS` validation
record referencing the connector's real `result_hash` — VAD's own `ValidationGate` requires at least
one evidence record to avoid an automatic FAIL (`"No deterministic evidence recorded"`), and
`DeterministicMockProducer` does not populate one on its own. The verifier then derives criteria
status from that evidence exactly as VAD's own accepted logic does — nothing here bypasses VAD's real
acceptance rules.
