# TNA Recursive Improvement Governance v0.1 — Mutation Boundary

Source of truth: `packages/improvement-schema/src/index.ts` (`classifyMutation`,
`DEFAULT_FORBIDDEN_MUTATION_PATH_PREFIXES`, `EVALUATOR_PATH_PREFIX`, `detectTestManifestTampering`),
`packages/improvement-core/src/index.ts` (`assertInsideWorkspace`, `createIsolatedWorkspace`,
`candidateEnvironment`), and `packages/improvement-core/src/git-integration.ts`.

## Allowed vs. forbidden paths

- **Allowed**: `ImprovementSpec.allowed_mutation_paths` — a per-spec, explicitly declared, non-empty list
  of path prefixes the candidate is expected to touch. A changed path not covered by any prefix here is
  flagged `out_of_scope_paths` by `classifyMutation()` — a separate signal from control-plane sensitivity
  (an out-of-scope-but-harmless path touch and a control-plane path touch are both detected, independently).
- **Forbidden (explicit)**: `ImprovementSpec.forbidden_mutation_paths` — additional per-spec denials.
- **Forbidden (default, always-on)**: `DEFAULT_FORBIDDEN_MUTATION_PATH_PREFIXES` — a fixed list covering
  every accepted control-plane component: Gate (`apps/tna-gate-api/`, `packages/shared-schema/`,
  `packages/policy-engine/`, `packages/capability-core/`, `packages/authority-envelope/`,
  `packages/execution-broker/`, `packages/isolation-runner/`, `packages/egress-guard/`), Sentinel
  (`apps/tna-sentinel/`, `packages/sentinel-*`), VAD (`packages/vad-core/`, `packages/vad-runtime/`,
  `packages/verifier-core/`, `packages/validation-gate/`, `packages/evidence-core/`), Ledger
  (`packages/ledger-*`), Auditor (`apps/tna-auditor/`, `packages/auditor-*`), deployment-ops
  (`packages/deployment-*`), and the test suite itself (`tests/`).

**Critically, this default-forbidden list is computed unconditionally** — `classifyMutation()` never
consults the spec's own `allowed_mutation_paths` before flagging a control-plane path as touched. This
closes a real bug found during this volume's own construction: a low-class spec could otherwise
"legitimize" touching a forbidden path simply by listing it in its own `allowed_mutation_paths`. Whether a
control-plane touch is *permissible* for a given generation is a separate, later judgment
(`evaluatePromotion()`, which has both the mutation-diff report and the candidate's class available) — it
is never silenced before that governance runs.

## The evaluator path is a special case, unconditionally, for every class

`EVALUATOR_PATH_PREFIX = 'packages/improvement-evaluator/'` is checked independently of the forbidden-path
list above, and independently of class. `classifyMutation()` sets `evaluator_changed: true` the moment any
changed path starts with this prefix — there is no spec field, no class, and no approval level that removes
this flag. `evaluatePromotion()` REJECTs on `evaluator_changed` before checking anything else about class
policy. See `evaluator-independence-v0.1.md`.

## Workspace containment

`assertInsideWorkspace(root, candidate)` (`packages/improvement-core`) resolves `candidate` to its real,
absolute path and verifies it is a descendant of `root` — **never a plain string-prefix check**. For a
path that does not yet exist on disk, it verifies the resolved path string is contained; for a path that
does exist, it additionally calls `realpathSync()` on both root and candidate and compares the REAL
(symlink-resolved) paths. This defeats a candidate attempting to escape its own isolated workspace via a
symlink or an absolute/traversal path — tested in `git-worktree.test.ts` ("candidate attempts to escape the
worktree root via a symlink or absolute path — rejected by the real, already-proven assertInsideWorkspace
path safety").

`createIsolatedWorkspace(generationId, parentSourceRoot)` always copies the parent into a fresh,
generation-id-scoped directory under `improvement/.workspaces/` (verified via `assertInsideWorkspace`
first) — the parent workspace itself is never mutated, and an already-existing workspace for the same
generation id is refused (`CONFLICT`), never silently overwritten.

## Realpath checks and symlink/junction handling

Both the workspace-containment check above and the Git worktree checks below resolve real paths
(`realpathSync`), not string prefixes, specifically so a symlink or junction pointing outside the intended
boundary cannot be used to escape it — the same discipline Volume 11's Academy lab-safety checks already
established (`assertInsideLabWorkspace`).

## Candidate process environment

`candidateEnvironment(explicitAllowlist)` strips every environment variable whose NAME matches a
secret-shaped pattern (`SECRET_SHAPED_ENV_KEY` — API keys, passwords, tokens, credentials, bearer values,
signing keys) from the orchestrator's own `process.env` before layering on an explicit allowlist. Every
real spawned regression/security/benchmark command in `runPromotionEvaluation` runs under this stripped
environment — a candidate mutation process never inherits a promotion credential, another tenant's
credential, or any other secret-shaped variable merely because the orchestrating shell happened to have it
set. `assertNoSecretShapedNames()` additionally guards against a spec author's own declared allowlist
itself naming a secret-shaped variable.

## Control-plane mutation

See "Allowed vs. forbidden paths" above — `control_plane_changed` is true whenever any changed path's
classified `MutationArea` is one of `gate`, `sentinel`, `vad`, `ledger`, `auditor`, or `evaluation`.
`evaluatePromotion()` REJECTs unconditionally on `control_plane_changed && !classAtLeast(class,
'CLASS_4_CONTROL_PLANE')` — only Class 4 and Class 5 candidates may even be considered for a control-plane
touch, and even then only after every other check (regression, security, authority, capability,
benchmarks, class-appropriate approvals) also passes.

## Test mutation

`detectTestManifestTampering(before, after)` compares two `RequiredTestManifest` snapshots. A REQUIRED
entry's disappearance (by `test_id`) is flagged as `removed_required_tests` regardless of hash state — this
detection does not depend on hashes at all. A REQUIRED entry's `content_hash` changing is separately
flagged as `hash_changed_tests`, but **only when the BEFORE entry's `content_hash` is non-null** — a
manifest baseline recorded with a null hash structurally cannot have a later hash swap detected against it.
`tampered: true` if either list is non-empty; `evaluatePromotion()` REJECTs unconditionally on
`testTamper.tampered`, bound to test identity/hash — never merely to a shrinking test count. Tested in E2E D.

## Evaluator mutation

Covered above under "The evaluator path is a special case." Tested end-to-end in E2E C: a candidate that
mutates `packages/improvement-evaluator/src/index.ts` inside its own workspace is REJECTed unconditionally,
regardless of what else the candidate changed.

## Git/worktree protections

`packages/improvement-core/src/git-integration.ts` provides real (never simulated) Git support:

- `createGitWorktree()` always uses `git worktree add --detach` — the candidate workspace is checked out
  at a specific commit in DETACHED HEAD state, never on a named branch. This makes "candidate mutates the
  accepted branch" a real, git-enforced impossibility for the common case: git itself refuses to check out
  a branch that is already checked out in another worktree of the same repository.
- **Tags and other branches are NOT protected by worktree isolation** — refs are repository-wide, not
  per-worktree, so a candidate's own detached-HEAD worktree can still force-move or delete a tag using
  ordinary git commands. `detectGitRefTampering()` is a real, separate, implemented check (comparing
  before/after `snapshotGitRefs()` results) that exists specifically because git's own structural
  guarantees do not cover this case. Tested: tag force-move and tag deletion, both detected.
- `gitDiffNameStatus()` combines `git diff --name-status` (tracked-file changes) with
  `git ls-files --others --exclude-standard` (brand-new untracked files) — `git diff` alone never reports
  untracked files, which would otherwise make a wholly new out-of-scope file invisible to mutation-boundary
  classification. This gap was found and fixed during this volume's own construction.
- Every test exercising this module operates only against a fresh `mkdtempSync` repository under the OS
  temp directory — never this project's own real accepted repository, tags, or branches.
