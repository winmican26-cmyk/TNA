# TNA Principles TNA-65 – TNA-71 (Volume 11 — TNA Operator Readiness & Deployment Academy v0.1)

TNA-01 through TNA-64 are preserved unchanged — see `academy/principles-map-v0.1.md` for the thematic
index. The following seven principles are established by this milestone's real implementation, each
backed by a specific, tested (or, where noted, structurally-guaranteed-by-construction) mechanism.

## TNA-65 — Human Operators Are Part of the Threat Model

Secure systems must assume well-intentioned humans can make incorrect, rushed, or ambiguous decisions.
Established by the operator role model (`apps/tna-operator/src/roles.ts`), the self-approval guard, the
mandatory `--reason` requirement on sensitive commands, and the wrong-tenant `--confirm` requirement on
`tenant offboard` — every one of these exists specifically because a competent operator can still make
the wrong call under time pressure, not because operators are assumed malicious.

## TNA-66 — Operational Truth Must Be Explainable

A system that blocks, holds, terminates, or becomes indeterminate must provide enough durable evidence
for an authorized operator to understand why. Established by `tna action explain`
(`apps/tna-operator/src/explain.ts`) — a deterministic, rules-based translation of Gate/Sentinel/MCP/VAD
error codes into operator-facing guidance, always alongside the original machine code, never concealing
it. Tested in `tests/operator/operator-units.test.ts`.

## TNA-67 — Diagnostics Must Not Become Authority

A diagnostic system may observe and explain state; it must not silently repair, approve, or rewrite the
state it evaluates. Established by `tna doctor` (`apps/tna-operator/src/doctor.ts`) issuing only GET
requests against the platform and client gateway's own read-only endpoints — there is no code path in
this module capable of mutation. Not yet independently proven by a dedicated negative test (see the
proof-of-work's "Remaining Limitations"); the guarantee currently rests on the module's own narrow GET-
only surface.

## TNA-68 — Training Must Be Verified

Reading documentation is not proof that an operator can execute a control correctly; operational
competence should be demonstrated through reproducible exercises. Established by the Deployment
Academy's lab verifier (`academy/labs/registry.ts`): every implemented lab performs real assertions
against real TNA state (a real Gate decision, a real spawned MCP process, real `ClientStore` records,
the real packaged client gateway) and a dedicated test (`tests/academy/lab-verifier.test.ts`) proves
every lab's `passed` result is backed by at least one real check — never a bare "student says complete."

## TNA-69 — Training Authority and Production Authority Are Separate

Completing a training program must never automatically grant real production privileges. Established
structurally: academy lab/progress state lives entirely under `academy/` and has no code path that
reads or writes an `OperatorProfile`'s role — running every lab in this volume changes nothing about
what any real operator profile is permitted to do.

## TNA-70 — Go-Live Is an Evidence Decision

A customer should not enter operational use because someone feels ready; readiness must be assessed
against explicit, current evidence and known limitations. Established by `ClientGoLiveAssessment v1`
(`apps/tna-operator/src/go-live.ts`): a deterministic function of real readiness/health data, never a
subjective judgment call, snapshot-bound so a later config change cannot retroactively alter what an
earlier assessment said, and structurally incapable of reporting a clean `GO` when Ledger or Sentinel is
unavailable or a known credential bypass exists. Tested exhaustively (9 unit tests covering every
blocking/non-blocking rule and the KNOWN_BYPASS invariant).

## TNA-71 — Support Artifacts Are Security Artifacts

Logs, diagnostics, incident packages, and handoff documents can expose the system as surely as
production credentials can; they require scoping, redaction, integrity, and access control. Established
by `tna incident collect`'s redaction (`redactDeep`, applied before packaging), per-file and manifest
SHA-256 hashing (`IncidentPackageManifest v1`), and tenant scoping bound to the same tenant-scoped
accepted APIs every other command uses. Proven directly: a real collected incident package never
contains the admin bearer token used to produce it.
