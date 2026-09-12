# TNA Deployment Academy v0.1 — Curriculum

Four levels. Each lesson follows: Objective, Prerequisites, Concept, Architecture, Commands, Hands-on
Lab, Expected Result, Failure Exercise, Verification, Questions. Honest scope note, unchanged from the
original submission: full narrative lesson prose for every topic below is not written out lesson-by-lesson
in this pass — the topics, the real labs, the 120-question bank, and the principles map are all complete
and real; the long-form narrative lesson text remains future work. This mirrors the same "structure real,
breadth partial" discipline recorded throughout this volume's proof-of-work.

**Historical note (kept, not erased):** the original Volume 11 submission shipped only 5 of the 15 labs
described below and no question bank or assessments — it was honestly assessed as NOT READY rather than
accepted with unmet requirements. This document now reflects the closure pass that followed: all 15 labs,
the full 120-question bank, and all 4 level assessments are real and tested. See
[docs/operator/proof-of-work-operator-v0.1.md](../docs/operator/proof-of-work-operator-v0.1.md) for the
complete, unedited progression from that first checkpoint to this one.

## Current state (this pass)

- **4 levels**, 15 labs total, distributed as below.
- **Question bank**: 120 questions (Level 1: 25, Level 2: 30, Level 3: 30, Level 4: 35) — schema
  `AcademyQuestion v1`, `correct_answer` never exposed to learner-facing output. See
  [question-bank/principles-coverage-v0.1.md](question-bank/principles-coverage-v0.1.md).
- **4 level assessments** (`AcademyAssessment v1`) — never called certifications. PASSED requires a
  knowledge score ≥ 70% (`KNOWLEDGE_PASSING_SCORE`, the same threshold at every level) **and** every
  required lab for that level showing a genuinely PASSED, evidence-backed status in the runtime-owned
  progress store — knowledge alone can never pass a level, and no self-reported lab result counts.
- **Progress model** (`AcademyProgress v1`, `apps/tna-operator/src/academy/progress-store.ts`): the only
  code path that can write a PASSED lab status is `recordLabAttempt`, called immediately after actually
  running the real verifier. Retakes preserve full attempt history (`academy_attempts`, append-only) and
  the current summary (`academy_progress`).
- **Academy CLI**: `tna academy status`, `tna academy lesson <id> --level N`, `tna academy lab start <id>`,
  `tna academy lab verify <id>`, `tna academy assessment <level> [--questions | --answers '<json>']`.
  Every academy command is `viewer`-role-sufficient by design (section 34 of the closure brief) — Academy
  is training-only and structurally cannot touch production authority (TNA-69).
- **Deterministic, non-self-reported lab verification**: every lab reports real step-level evidence from
  actually exercising TNA code (Gate, Sentinel, VAD, Ledger, MCP gateway, client store, deployment-ops,
  the packaged client gateway binary) — never a bare boolean, never a learner-asserted result.

## Level 1 — Foundations

Agents vs. tools; authority; capability; Gate; Sentinel; VAD; Ledger; Auditor; Platform; Deployment;
Client Integration; MCP. Principles: see [principles-map-v0.1.md](principles-map-v0.1.md). Question bank:
25 questions (`question-bank/level-1.json`).

**Labs** (3, all required for the Level 1 assessment):
- `lab-01-blocked-action` — a real Gate BLOCK, zero execution, durable evidence.
- `lab-02-held-action` — a real Gate HOLD; self-approval by the requesting agent or an admin is rejected;
  only a genuine approver role can approve; the approval is single-use.
- `lab-04-vad-rejection` — a real VAD `REJECT` decision reaches a terminal `REJECTED` lifecycle state with
  persisted evidence.

## Level 2 — Operator

The `tna` CLI; status/health; client onboarding; MCP registration; tool review; approvals; evidence
inspection; audit; suspension; offboarding; incident response. Question bank: 30 questions
(`question-bank/level-2.json`).

**Labs** (6, all required for the Level 2 assessment):
- `lab-07-mcp-discovery` — discovery of a real spawned MCP fixture never itself grants execution authority
  (TNA-58); every discovered tool is `enabled:false`, `review_status:DISCOVERED`.
- `lab-08-schema-drift` — a tool's schema changing after registration is detected as drift, not silently
  accepted as a routine update.
- `lab-09-client-bypass` — `computeBypassAssessment` proves a known bypass forces NO_GO by default, and
  `allow_known_bypass_with_limitations` can only ever reach GO_WITH_LIMITATIONS, never a clean GO.
- `lab-10-tenant-isolation` — cross-tenant access to another tenant's governed tools, client actions,
  service identities, and MCP servers is rejected; each tenant still reads its own state correctly.
- `lab-13-incident-triage` — `tna doctor` and `tna incident collect` against a genuinely unreachable
  client gateway both honestly report FAIL, never a false-positive healthy reading.
- `lab-14-client-offboarding` — offboarding revokes the service identity and its credential in the real
  `ClientStore`, while historical client actions remain readable afterward (evidence is not destroyed).

## Level 3 — Deployment Engineer

Backup consistency; restore; outbox delivery and recovery; persistent state; upgrade/rollback concepts.
Question bank: 30 questions (`question-bank/level-3.json`).

**Labs** (2, both required for the Level 3 assessment; both are destructive and require
`ACADEMY_LAB_MODE=true` plus an in-workspace target path — see "Lab safety" below):
- `lab-11-backup-restore` — a real backup is refused while the running-instance lock is held, succeeds
  once released, verifies, and a full restore after destroying the data directory reconstructs the same
  action and Ledger evidence.
- `lab-12-outbox-failure` — a simulated Ledger outage leaves an action's execution outcome unaffected
  (evidence delivery and execution correctness are independent); recovery redelivers under the same
  deterministic event identity (`outboxLedgerEventId`), never a duplicate.

## Level 4 — Security / Control-Plane Specialist

Authority Envelope; capability brokerage; Sentinel observations and emergency stop; Ledger causal chains
and tamper detection; the packaged client gateway path. Question bank: 35 questions
(`question-bank/level-4.json`).

**Labs** (4, all required for the Level 4 assessment):
- `lab-03-sentinel-termination` — a real emergency stop plus a real observation drives a TERMINATE
  decision; the lab never fabricates a confirmed `TERMINATED` state when the real result is only
  `TERMINATING`.
- `lab-05-ledger-reconstruction` — a full in-process Gate → Sentinel → execution flow reconstructs
  correctly from the Ledger alone (`reconstructPlatformAction`), field by field.
- `lab-06-ledger-corruption` (destructive, lab-workspace-only) — a directly tampered Ledger event hash is
  detected by `verifyLedgerIntegrity` and never silently auto-repaired or hidden on reopening.
- `lab-15-packaged-path` — real Gate/Sentinel/MCP/Ledger evidence through the actual packaged
  `tna-client-gateway` binary, not a library call (reinforces TNA-64).

## Lab safety

Destructive labs (`lab-06`, `lab-11`) require `ACADEMY_LAB_MODE=true` and confine every file operation to
`academyLabWorkspaceRoot()` inside the Academy's own disposable workspace (`academy/lib/lab-paths.ts`).
`../` traversal, an absolute path outside the workspace, and a symlink/junction escape are all rejected —
see `tests/academy/lab-safety.test.ts` (0 skips; the original Windows symlink-escape test was converted to
use an NTFS junction, which needs no elevation, rather than being re-justified as an acceptable skip).

## Assessments

Four deterministic level assessments (`AcademyAssessment v1`, `apps/tna-operator/src/academy/assessment.ts`)
— never called certifications. A learner submits raw `{question_id, answer}` pairs; the knowledge score is
always computed server-side against the sealed question bank's own `correct_answer`, never accepted as a
pre-supplied score. Passing a level requires knowledge score ≥ 70% **and** every lab required for that
level showing PASSED with real `verified_at`/`evidence_refs` in the progress store — a hand-written or
otherwise evidence-less "PASSED" row is downgraded to FAILED before it can count. See
`tests/academy/assessment.test.ts` and `tests/operator/cli-academy.test.ts` for the tamper-resistance and
real-CLI-process proof, and [lab-matrix-v0.1.md](lab-matrix-v0.1.md) for the full per-lab control mapping.
