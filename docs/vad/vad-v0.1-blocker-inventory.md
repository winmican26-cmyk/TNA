# VAD Engine v0.1 Blocker Inventory

This inventory is derived from the current architectural review. It lists every requirement currently marked PARTIAL, FAIL, or NOT IMPLEMENTED. It is scoped to v0.1 and does not authorize v0.2 or Volume 5 work.

| ID | Original requirement | Current status | Acceptance blocker? | Planned test | Planned implementation |
|---|---|---|---|---|---|
| ATM-05 | One-primary-goal rule represented | PARTIAL | DOCUMENTED NON-BLOCKING LIMITATION | Document structural-only scope | Keep one goal field; document semantic detection as future |
| ATM-12 | Spec mutation after execution start rejected | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Mutate active spec and assert hash mismatch blocks finalization | Immutable execution snapshot and hash comparison |
| RETRY-05 | Max attempts enforced | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Exhaust max_attempts and assert no next attempt | Runtime attempt guard |
| RETRY-06 | Attempt 4 impossible when max=3 | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Attempt 4 rejected structurally | Runtime attempt guard |
| RETRY-07 | Cost bound behavior | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Cost budget exhaustion prevents next attempt | Runtime budget policy |
| RETRY-08 | Runtime bound behavior | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Runtime exhaustion fails/escalates before new work | Runtime budget policy |
| VAL-06 | Forbidden dependency rejection | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Introduce forbidden dependency and assert failure | Dependency manifest comparison |
| VER-04 | Verifier excludes producer reasoning/history | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Verify input shape excludes producer history | Read-only verification input boundary |
| VER-05 | Verifier cannot mutate artifact | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Mutation attempt cannot affect stored artifact | Frozen/cloned verification input |
| VER-06 | Verifier cannot mutate spec | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Mutation attempt cannot affect active spec | Frozen execution snapshot |
| VER-07 | Verifier cannot mutate evidence | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Mutation attempt cannot affect evidence | Frozen/cloned evidence |
| VER-09 | Unknown verdict rejected | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Parse unknown verdict and assert invalid | Strict runtime verifier parser |
| VER-10 | Arbitrary prose rejected | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Parse prose and assert invalid | Strict runtime verifier parser |
| LVL-03 | Risk routing deterministic | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Risk maps to required verification level | Deterministic risk router |
| LVL-04 | Level 2 verifier cannot be skipped | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Level 2 flow without verifier is rejected | Runtime lifecycle precondition |
| HUM-01 | Human decision state modeled | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Decision record required before terminal state | Human decision model |
| HUM-02 | Actor recorded | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Missing actor rejected | Human decision validation |
| HUM-03 | Human decision timestamp recorded | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Missing timestamp rejected | Human decision validation |
| HUM-04 | Override behavior exists | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Override outcomes are accepted only through decision API | Override decision model |
| HUM-05 | Override rationale mandatory | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Empty override rationale rejected | Override validation |
| HUM-06 | Override cannot alter original spec | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Override spec mutation rejected | Immutable spec hash enforcement |
| EVD-01 | Evidence Package v2 implemented | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Complete package persisted and reloadable | Evidence package schema and store |
| EVD-08 | Verifier provenance | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Missing verifier identity rejected | Verifier identity field |
| EVD-09 | Attempts | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Attempt history persisted | Append-only attempt history |
| EVD-12 | Human decision evidence | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Decision appears in persisted evidence | Evidence package integration |
| EVD-16 | Runtime and cost classification | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Runtime and cost classifications persisted | Usage/budget evidence fields |
| EVD-18 | Final state and completion timestamp | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Terminal state and timestamp persisted | Lifecycle finalization record |
| EVI-02 | Persistence failure prevents ACCEPTED | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Inject write failure and assert no ACCEPTED | Atomic evidence finalization |
| EVI-03 | Artifact mutation invalidates evidence | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Mutate artifact after verification and block acceptance | Final artifact hash check |
| EVI-04 | Spec hash mismatch detected | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Stored/active hash mismatch blocks finalization | Integrity validator |
| EVI-05 | Artifact hash mismatch detected | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Stored/final artifact mismatch blocks finalization | Integrity validator |
| LIF-01 | State machine implemented | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Valid lifecycle path test | Explicit transition table |
| LIF-02 | States actually used | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Transition history contains operational states | Runtime controller |
| LIF-03 | Permitted transitions | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Valid transitions accepted | Transition table |
| LIF-04 | Illegal transitions rejected | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Illegal transitions rejected | Transition guard |
| LIF-05 | ESCALATED behavior | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Exhausted retries/cost reaches ESCALATED | Escalation policy |
| LIF-06 | FAILED behavior | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Gate failure reaches FAILED/RETRYING policy state | Runtime controller |
| LIF-07 | REJECTED behavior | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Verifier reject reaches REJECTED after human decision | Runtime controller |
| LIF-08 | ACCEPTED behavior | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Accepted terminal path requires evidence first | Runtime controller |
| CON-02 | Dependency contamination | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Forbidden dependency introduction rejected | Dependency comparison |
| IDD-01 | No simultaneous active runs | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Second active run rejected | Active-run lock |
| IDD-02 | Human decision cannot double-apply | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Second conflicting decision rejected | Decision idempotency |
| IDD-03 | Final evidence cannot finalize twice | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Conflicting second finalization rejected | Finalization ledger |
| IDD-04 | API retries do not duplicate execution | NOT IMPLEMENTED | DOCUMENTED NON-BLOCKING LIMITATION | No API layer exists in v0.1 | Explicitly scope API idempotency to future |
| LOG-03 | Bounded outputs | PARTIAL | DOCUMENTED NON-BLOCKING LIMITATION | Document current bounded summaries | No broad output policy in v0.1 |
| DEM-01 | ATOM CREATED event | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Accepted demo event trace | Lifecycle event log |
| DEM-02 | PRODUCER ATTEMPT 1 event | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Accepted demo event trace | Lifecycle event log |
| DEM-03 | DETERMINISTIC GATE FAILED event | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Accepted demo includes first failure | Demo/runtime flow |
| DEM-04 | FRESH RETRY CREATED event | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Retry event trace | Demo/runtime flow |
| DEM-05 | PRODUCER ATTEMPT 2 event | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Retry event trace | Demo/runtime flow |
| DEM-07 | INDEPENDENT VERIFIER STARTED event | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Verifier event trace | Demo/runtime flow |
| DEM-08 | VERIFIER ACCEPTED event | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Verifier event trace | Demo/runtime flow |
| DEM-09 | HUMAN DECISION RECORDED event | NOT IMPLEMENTED | MANDATORY ACCEPTANCE BLOCKER | Human decision event trace | Demo/runtime flow |
| DEM-10 | Evidence package complete event | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Persisted package assertion | Evidence store |
| DEM-11 | ATOM ACCEPTED event | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Terminal state assertion | Lifecycle runtime |
| DEM-12 | Rejected demo sequence | PARTIAL | MANDATORY ACCEPTANCE BLOCKER | Rejected end-to-end flow | Rejection runtime |

## Classification note

The only documented non-blocking limitations are semantic one-primary-goal understanding, API idempotency where no API layer exists, and broad output bounding where the v0.1 runtime does not expose an unbounded output surface. All other non-PASS requirements above remain mandatory acceptance blockers.

No implementation change is implied by this inventory alone. It is the pre-build source for remediation atoms.
