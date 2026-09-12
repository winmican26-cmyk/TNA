# TNA Recursive Improvement Governance v0.1 — Evaluation Profiles

Source of truth: `packages/improvement-schema/src/index.ts` (`EvaluationProfile`, `BenchmarkResult`,
`evaluateBenchmark`), `packages/improvement-evaluator/src/index.ts` (`runPromotionEvaluation`), and
`apps/tna-improvement-governor/src/server.ts` (`handleEvaluate`, `POST /v1/systems/:id/evaluation-profile`).

## Regression tests

`EvaluateBody.regressionTestCommand` (an array of command tokens, e.g. `[execPath, 'regression.mjs']`) is
spawned for real by `runPromotionEvaluation`'s internal `runCommand()` helper inside the candidate's real,
isolated workspace, under the secret-stripped `candidateEnvironment()`. `regressionSuitePassed` is `true`
only if the process actually ran (`ranSuccessfully`) AND exited `0`. If no regression command is configured
at all (`null`), it is treated as passing by default — an explicitly documented v0.1 simplification for
fixtures that have no regression suite of their own, never silently assumed by any caller that does have
one.

## Security tests

Same mechanism as regression tests (`securityTestCommand`/`securityTestsPassed`), run as a second,
independent real process.

## Benchmarks

`EvaluateBody.benchmarks` is an array of `{benchmarkId, command, threshold, parentScore}`. For each one,
`runPromotionEvaluation` spawns the real command, parses its stdout as a number (`Number(run.stdout.trim())`
— a `NaN` result marks evidence incomplete, never treated as a passing score), and calls
`evaluateBenchmark(benchmarkId, generationId, parentScore, candidateScore, threshold, evidenceRef)`, which
computes `delta = candidateScore - parentScore` and sets `status: delta >= threshold ? 'PASS' : 'FAIL'`.
`benchmarksAllPass` requires every configured benchmark to individually PASS AND requires that every
configured benchmark actually produced a result (`benchmarkResults.length === inputs.benchmarks.length`) —
a benchmark that could not be evaluated at all does not silently count as passing.

## Holdouts

There is no separate "holdout" field in the schema — a holdout is simply an additional entry in the same
`benchmarks` array, using a benchmark command whose input data the candidate has no way to have seen (see
`improvement/fixtures/reward-hacking/`). Because `benchmarksAllPass` requires every listed benchmark to
pass, adding a holdout benchmark to the required list is what defeats literal memorization of a public
benchmark — proven in `tests/improvement/reward-hacking.test.ts`, including the required counterfactual
(omitting the holdout would have let the memorizing candidate PROMOTE). This detects one specific
benchmark-gaming class only — see the threat model's dedicated scope section.

## Thresholds

Per-benchmark `threshold` is compared against `delta` (candidate score minus parent score), not against
the raw candidate score — a benchmark configured with `threshold: 0` requires the candidate to be no worse
than the parent, not merely above some absolute floor.

## Profile hashes

`EvaluateBody.evaluationProfileHash` (a caller-supplied string identifying which evaluation criteria were
actually used) is recorded on the resulting `PromotionDecision.evaluation_profile_hash`. The governor's
`handleEvaluate` also records the FIRST evaluation profile hash ever used for a system as that system's
"active" profile (`activeEvaluationProfileHashBySystem`, an in-memory v0.1 map keyed by the real internal
`system_id`) — a later, explicit call to `POST /v1/systems/:id/evaluation-profile` can change it.

## Stale-evaluator (stale evaluation-profile) detection

`handlePromote` compares the generation's LAST recorded `PromotionDecision.evaluation_profile_hash` against
the system's CURRENT active-profile-hash entry. If they differ, promotion is blocked with HTTP 409 and the
generation's evidence is never silently promoted under criteria that no longer apply — the caller must
re-evaluate. Tested in E2E H. This mechanism required a real fix during this volume's construction: the
`POST /v1/systems/:id/evaluation-profile` route originally wrote the active-hash map under the
caller-facing system NAME rather than the real internal `system_id` `handleEvaluate`/`handlePromote` read
by, silently defeating the check entirely — now resolved consistently through `findSystemByName`.

## Required-test manifests

`RequiredTestManifest`/`detectTestManifestTampering` — see `mutation-boundary-v0.1.md`'s "Test mutation"
section for the full mechanism. `EvaluateBody.requiredTestManifestBefore`/`requiredTestManifestAfter` are
both caller-supplied to `/evaluate`; the evaluator never trusts a candidate's own claim about what tests
exist.
