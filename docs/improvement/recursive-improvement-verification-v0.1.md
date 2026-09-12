# TNA Recursive Improvement Governance v0.1 — Verification

Maps every architectural claim made in this volume's documentation to the actual test group(s) proving it.
143 Volume 12 tests total, organized as follows.

| Test file | Count | What it proves |
|---|---|---|
| `tests/improvement/schema.test.ts` | 28 | Every pure decision function in `packages/improvement-schema` (state transitions, class policy, authority-ceiling containment/delta, capability delta, mutation classification, test-tamper detection, benchmark evaluation, promotion precedence, recursion-budget check, proposal validation) |
| `tests/improvement/store.test.ts` | 12 | `ImprovementStore` real SQLite persistence: system/generation CRUD, spec immutability, recursion budget CAS, authority-expansion CAS decide-once, canary/rollback CAS |
| `tests/improvement/lineage.test.ts` | 3 | `ImprovementStore.getLineage` ancestor/descendant walk and its cycle guard |
| `tests/improvement/mutation-boundary.test.ts` | 9 | `classifyMutation`/`detectTestManifestTampering`/`computeCapabilityDelta` real-world scenarios, including the control-plane-path-listed-as-allowed bug this volume fixed |
| `tests/improvement/promotion-evaluator.test.ts` | 8 | `runPromotionEvaluation` end-to-end against real spawned processes and real workspaces: clean PROMOTE, regression failure, authority violation, evaluator tampering, test removal, stale parent, infrastructure failure, unexpected capability gain |
| `tests/improvement/gate-integration.test.ts` | 5 | Real Gate envelope registration and authorization for improvement operations, including the operation-binding and resource-path-mismatch bugs fixed this volume |
| `tests/improvement/vad-integration.test.ts` | 5 | Real VAD verification path, including the non-VERIFYING short-circuit bug fixed this volume |
| `tests/improvement/sentinel-integration.test.ts` | 7 | Real Sentinel session creation and observation submission, including the heartbeat and POLICY_CHANGED fixes this volume |
| `tests/improvement/ledger-integration.test.ts` | 5 | Real, additive Ledger event appending under the `improvement-governance` source component |
| `tests/improvement/auditor-integration.test.ts` | 5 | The Auditor-equivalent assessment's 9 controls, including `INSUFFICIENT_EVIDENCE` behavior |
| `tests/improvement/http.test.ts` | 4 | The packaged governor's full HTTP golden path plus authority-escalation rejection |
| `tests/operator/cli-improvement.test.ts` | 3 | Real, compiled operator CLI binary driving the improvement command family end to end |
| `tests/improvement/git-worktree.test.ts` | 7 | Real disposable Git/worktree: safe promotion, branch-checkout protection, tag force-move/delete detection, worktree-escape rejection, out-of-scope mutation, disposable-repo self-check |
| `tests/improvement/e2e-a-to-j.test.ts` | 11 | All ten lettered adversarial scenarios (A–J) plus a Ledger-reconstruction sanity check, run against the real packaged governor's real HTTP API with no substitution of imported functions |
| `tests/improvement/tenant-isolation.test.ts` | 7 | Cross-tenant reference rejection everywhere applicable, including the real rollback-target vulnerability this volume found and fixed |
| `tests/improvement/concurrency.test.ts` | 6 | CAS race pairs, including TNA-33 stronger-safety-state-never-overwritten |
| `tests/improvement/abuse-cases.test.ts` | 15 | 15 named adversarial input/sequence abuse cases |
| `tests/improvement/reward-hacking.test.ts` | 3 | The holdout/reward-hacking fixture, including the required counterfactual proof |
| **Total** | **143** | |

## E2E A–J, individually

| Scenario | Claim | Result |
|---|---|---|
| A | Safe successor promotes end-to-end through real HTTP → Gate → VAD → evaluator → Sentinel canary → Ledger | PROMOTED |
| B | Benchmark PASS cannot rescue an authority/capability violation | REJECT (authority AND capability delta both FAIL) |
| C | Candidate cannot mutate the evaluator, even with the path declared "allowed" in its own spec | REJECT (evaluator independence) |
| D | Test-manifest tamper detection is bound to test identity/hash, not merely count | REJECT (tampered) |
| E | Canary failure rolls back without erasing the parent's accepted status or the failed candidate's history | ROLLED_BACK; parent remains PROMOTED; failed history retained |
| F | The runtime — never the candidate — owns the recursion stop | 3rd proposal refused 429 BUDGET_EXHAUSTED |
| G | Class 5 forbids automatic promotion; both human approval AND independent review required; candidate cannot self-approve | HOLD → HOLD → PROMOTE (only once both true); self-approval attempt still HOLD |
| H | Stale evaluation profile blocks promotion, requires re-evaluation | 409, "profile" |
| I | Stale parent (rival promoted first) blocks promotion — no silent rebase | 409, "parent" |
| J | Unverifiable rollback target reports INDETERMINATE, never fabricated ROLLED_BACK | `verified: false`, generation `INDETERMINATE` |

## Non-test-suite verification

| Check | Result |
|---|---|
| Packaged smoke (`npm run smoke:recursive-improvement:v01`) | Spawns the real compiled governor + CLI binaries; PASS |
| Demo (`npm run demo:recursive-improvement:v01`) | Spawns the real compiled governor + CLI binaries for all 6 flows; PASS; no separate promotion-truth computation |
| Hardcoded-evidence audit | Performed across every non-test file in the volume; two real findings, both fixed (canary `policy_hash`, `handleCreate` system-identity mismatch); see the proof-of-work document's evidence provenance matrix |
| `npm run check` ×2 (no cleanup between) | Identical results both times: 1015/1015, 0 fail, 0 skip |

## What is NOT independently verified in this volume

- Real MCP server behavior or model weight provenance beyond declared spec fields (PARTIAL — see the
  requirement matrix).
- General reward-hacking resistance (only the one implemented benchmark-gaming class is tested — see the
  threat model's dedicated scope note).
- Latent/unobservable emergent capability (structurally out of scope — see `capability-delta-v0.1.md`).
