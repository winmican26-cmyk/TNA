# TNA Control Catalog v0.1

`CONTROL_CATALOG_VERSION = 1.0`. 27 controls, covering all 17 mandatory categories (section 8). Both
profiles (`TNA_BASELINE_V01`, `TNA_HIGH_RISK_V01`) select the full catalog; `TNA_HIGH_RISK_V01`
promotes `TNA-RUNTIME-001`, `TNA-RUNTIME-005`, and `TNA-CONTAIN-002` to `CRITICAL` (see
`auditor-control-model-v1.md`).

For every control, `PASS` requires the stated evidence to exist, be within scope, and (where noted)
pass Ledger stream-integrity verification; `INSUFFICIENT_EVIDENCE` is returned when no qualifying
evidence exists in scope at all; `FAIL` requires either direct contradicting evidence or incomplete
required binding fields; `NOT_APPLICABLE` applies when the control's precondition never arose in this
scope (e.g. no revocation occurred).

| # | Control ID | Category | Criticality | Title |
|---|---|---|---|---|
| 1 | `TNA-IDENT-001` | IDENTITY | HIGH | Consequential actions carry bound agent identity |
| 2 | `TNA-AUTH-001` | AUTHORITY | **CRITICAL** | Authority binding is complete |
| 3 | `TNA-AUTH-002` | AUTHORITY | HIGH | Authority scope is not overly broad |
| 4 | `TNA-APPR-001` | APPROVAL | MEDIUM | Required approval evidence is present |
| 5 | `TNA-CAP-001` | CAPABILITY | HIGH | Capability lifetime is bounded and honored |
| 6 | `TNA-CAP-002` | CAPABILITY | HIGH | Capability single-use is enforced |
| 7 | `TNA-CAP-003` | CAPABILITY | **CRITICAL** | Capability revocation is enforced |
| 8 | `TNA-EXEC-001` | EXECUTION | HIGH | Execution is mediated through a bound capability |
| 9 | `TNA-EXEC-002` | EXECUTION | MEDIUM | Retries are runtime-bounded |
| 10 | `TNA-ISO-001` | ISOLATION | MEDIUM | Execution is isolation-mediated |
| 11 | `TNA-SEC-001` | SECRETS | HIGH | No raw secret exposure in evidence |
| 12 | `TNA-EGR-001` | EGRESS | MEDIUM | Application-level egress restriction exists |
| 13 | `TNA-VER-001` | VERIFICATION | HIGH | Producer and verifier identity are separated |
| 14 | `TNA-VER-002` | VERIFICATION | HIGH | Spec hash is immutably bound through the atom lifecycle |
| 15 | `TNA-EVID-001` | EVIDENCE | HIGH | Ledger's public surface is append-only |
| 16 | `TNA-HUMAN-001` | HUMAN_OVERSIGHT | HIGH | Human overrides are fully auditable |
| 17 | `TNA-INTEG-001` | INTEGRITY | **CRITICAL** | Ledger stream integrity holds for evidence used |
| 18 | `TNA-TEN-001` | TENANT_ISOLATION | HIGH | Tenant isolation is structurally enforced |
| 19 | `TNA-RUNTIME-001` | RUNTIME_DEFENSE | HIGH (CRITICAL in high-risk) | Runtime behavioral monitoring is active |
| 20 | `TNA-RUNTIME-002` | RUNTIME_DEFENSE | MEDIUM | Policy drift detection capability exists |
| 21 | `TNA-RUNTIME-003` | RUNTIME_DEFENSE | MEDIUM | Tool/resource drift detection capability exists |
| 22 | `TNA-RUNTIME-004` | RUNTIME_DEFENSE | MEDIUM | Runtime/cost bounds are enforced |
| 23 | `TNA-RUNTIME-005` | RUNTIME_DEFENSE | HIGH (CRITICAL in high-risk) | Authority is revalidated during execution |
| 24 | `TNA-CONTAIN-001` | CONTAINMENT | **CRITICAL** | Containment reporting is truthful |
| 25 | `TNA-CONTAIN-002` | CONTAINMENT | HIGH (CRITICAL in high-risk) | Emergency stop mechanism exists and is tenant isolated |
| 26 | `TNA-REVOKE-001` | REVOCATION | **CRITICAL** | Mid-execution revocation is enforced by Sentinel |
| 27 | `TNA-RECOV-001` | RECOVERY | HIGH | Containment uncertainty is honestly represented |

## Detail

### TNA-IDENT-001 — Consequential actions carry bound agent identity
Objective: prevent an action from being authorized without an identifiable, registered agent.
Evidence: `AUTHORIZATION_ALLOWED/BLOCKED/HELD` with `authority_context.agent_id`, plus
`AGENT_REGISTERED` for that agent. PASS: all bound and registered. PARTIAL: bound but not registered
in scope. FAIL: an event with no bound agent_id. INSUFFICIENT_EVIDENCE: no consequential events in
scope. Limitation: `EXECUTION_STARTED` is deliberately excluded — the accepted Gate adapter never
binds `authority_context.agent_id` on it (identity assurance there comes from `TNA-EXEC-001`'s
capability correlation instead).

### TNA-AUTH-001 — Authority binding is complete (CRITICAL)
Objective: every consequential authorization must bind agent, action, tool, resource, and policy_hash
(section 12). Evidence: `AUTHORIZATION_ALLOWED/BLOCKED` with all six fields. PASS: all bound and the
originating stream integrity-verified. FAIL: any decision missing a required field. PARTIAL: some but
not all decisions complete. INSUFFICIENT_EVIDENCE: no decisions in scope, or a fully-bound decision
comes from an integrity-invalid stream (section 16).

### TNA-AUTH-002 — Authority scope is not overly broad
Objective: an empty or wildcard (`*`) resource/tool binding must not automatically pass (section 72).
FAIL: any allowed decision with an empty/wildcard resource or tool. INSUFFICIENT_EVIDENCE: no allowed
decisions in scope.

### TNA-APPR-001 — Required approval evidence is present
Objective: approval-gated decisions must have explicit `APPROVAL_GRANTED/REJECTED` evidence. FAIL: a
held decision with no correlated approval event. NOT_APPLICABLE: no approval-gated decisions occurred.

### TNA-CAP-001 — Capability lifetime is bounded and honored
Objective: capabilities are short-lived and redemption respects that. FAIL: an issued capability with
no `authority_expiry`, or redemption after expiry. INSUFFICIENT_EVIDENCE: no issuance in scope.

### TNA-CAP-002 — Capability single-use is enforced
Objective: reuse of a redeemed capability is structurally rejected — never inferred from one
successful redemption alone (section 74). FAIL: an *observed* double-redemption of one capability_id
(direct counter-evidence). Otherwise falls back to the implementation manifest: PASS if a valid claim
exists, INSUFFICIENT_EVIDENCE otherwise.

### TNA-CAP-003 — Capability revocation is enforced (CRITICAL)
Objective: revocation must have demonstrable effect (negative evidence, sections 27, 75). PASS: every
revocation in scope is followed by a fresh (≤24h, section 17) block/rejection for that agent. PARTIAL:
enforcement proof exists but is stale. FAIL: a revocation followed by an `ALLOWED`/`REDEEMED` event for
the same agent — direct counter-evidence. INSUFFICIENT_EVIDENCE: revocation observed with no
enforcement evidence either way. NOT_APPLICABLE: no revocation occurred.

### TNA-EXEC-001 — Execution is mediated through a bound capability
Objective: no unmediated execution. FAIL: an `EXECUTION_STARTED` with no correlated
`CAPABILITY_REDEEMED`. INSUFFICIENT_EVIDENCE: no execution activity in scope.

### TNA-EXEC-002 — Retries are runtime-bounded
Objective: VAD attempt numbers are bounded, never caller-selected. FAIL: an atom with more than 10
recorded attempts and no visible ceiling. Falls back to the implementation manifest when no attempt
evidence exists in scope.

### TNA-ISO-001 — Execution is isolation-mediated
Manifest-backed structural control (execution runs through an isolation runner, not direct host
access). See `auditor-control-model-v1.md`'s manifest-backed-control rules.

### TNA-SEC-001 — No raw secret exposure in evidence
Objective: no secret-shaped field/value in collected evidence, and secret brokerage is manifest-
attested. FAIL: any collected event contains a secret-shaped payload field or Bearer-token-shaped
value. PARTIAL: clean evidence but no manifest attestation of brokerage.

### TNA-EGR-001 — Application-level egress restriction exists
Manifest-backed. Objective explicitly scoped to what the implementation provides (destination
allow-listing, private-address rejection) — never worded as a full SSRF/network-layer guarantee
(section 77).

### TNA-VER-001 — Producer and verifier identity are separated
Objective: independent verification (section 78). FAIL: a `VERIFIER` actor sharing identity with the
atom's own `PRODUCER` actor. INSUFFICIENT_EVIDENCE: no verification activity in scope.

### TNA-VER-002 — Spec hash is immutably bound through the atom lifecycle
Objective: `spec_hash` must not silently change between creation and finalization (section 79). FAIL:
a mismatch between an atom's `ATOM_CREATED` and `ATOM_ACCEPTED/REJECTED` spec_hash. PARTIAL: atoms
created in scope with no finalization yet.

### TNA-EVID-001 — Ledger's public surface is append-only
Manifest-backed (no PATCH/PUT/DELETE mutation route on the accepted Ledger HTTP API).

### TNA-HUMAN-001 — Human overrides are fully auditable
Objective: an override must carry actor, rationale-bearing decision, and spec_hash (section 81). FAIL:
an override missing any of those. NOT_APPLICABLE: no override occurred in scope — section 81's
explicit distinction between "the control design exists" and "an override event was observed."

### TNA-INTEG-001 — Ledger stream integrity holds for evidence used (CRITICAL)
Objective: corrupt evidence can never support an unqualified passing result anywhere in the assessment
(TNA-38). FAIL: any stream contributing evidence fails `verifyStream`. INSUFFICIENT_EVIDENCE: no
evidence streams collected.

### TNA-TEN-001 — Tenant isolation is structurally enforced
Objective: never inferred from `tenant_id` merely existing (section 89). FAIL: any collected event
carries a foreign tenant_id (a real cross-tenant leak). PARTIAL: clean evidence, no manifest
attestation of the structural isolation mechanism.

### TNA-RUNTIME-001 — Runtime behavioral monitoring is active
Objective: authorization without monitored runtime is materially weaker for high-risk activity
(section 84). FAIL/PARTIAL: an allowed decision with no correlated `SENTINEL_SESSION_STARTED`.

### TNA-RUNTIME-002 — Policy drift detection capability exists
PASS directly on an observed `SENTINEL_HOLD` from policy drift; otherwise manifest-backed (rule
implemented ≠ violation happened, section 85-86).

### TNA-RUNTIME-003 — Tool/resource drift detection capability exists
Same shape as RUNTIME-002, keyed on `SENTINEL_VIOLATION_DETECTED`.

### TNA-RUNTIME-004 — Runtime/cost bounds are enforced
PASS on any observed monitored session (runtime-owned counters are structurally always active once a
session exists); otherwise manifest-backed.

### TNA-RUNTIME-005 — Authority is revalidated during execution
PASS directly on an observed `AGENT_REVOKED` → `SENTINEL_TERMINATED` sequence; otherwise
manifest-backed (per-evaluation revalidation is a structural property, section 11).

### TNA-CONTAIN-001 — Containment reporting is truthful (CRITICAL)
**The single most important control in this catalog** (section 87). Objective: confirmed termination
reports `TERMINATED`; uncertain termination reports `INDETERMINATE`; never fabricated. FAIL: any
`SENTINEL_TERMINATED` event whose `payload.containment_status` is not `CONTAINMENT_CONFIRMED` (a
self-contradiction). Otherwise requires a valid manifest claim citing the Sentinel concurrency-closure
fix (`sentinel-v0.1-concurrency-closure.md`) to PASS — observed honest evidence alone is necessary but
not sufficient; the underlying implementation guarantee must also be attested.
INSUFFICIENT_EVIDENCE: no manifest supplied. FAIL: manifest supplied but does not (validly) attest
this control.

### TNA-CONTAIN-002 — Emergency stop mechanism exists and is tenant isolated
PASS directly on an observed `SENTINEL_EMERGENCY_STOP_ACTIVATED`; otherwise manifest-backed.

### TNA-REVOKE-001 — Mid-execution revocation is enforced by Sentinel (CRITICAL)
Negative evidence, same discipline as `TNA-CAP-003` but for Sentinel-monitored sessions specifically.
FAIL: a revocation during an active monitored session with no correlated Sentinel termination.
NOT_APPLICABLE: no revocation coincided with an active session.

### TNA-RECOV-001 — Containment uncertainty is honestly represented
Objective: an unconfirmed containment outcome must stay visibly unconfirmed (never quietly resolved to
look safe). FAIL: a `SENTINEL_CONTAINMENT_FAILED` event that also self-contradicts by claiming
`CONTAINMENT_CONFIRMED`. Otherwise manifest-backed.

## Known limitations (all controls)

- Every control is bounded by the scope and cutoff it was evaluated against — a `PASS` is a statement
  about the evidence in that window, not a universal guarantee (TNA-40).
- Manifest-backed controls reflect the referenced *component version's* implementation, not this
  specific execution's runtime behavior — see each control's own note above and
  `auditor-evidence-model-v0.1.md`.
