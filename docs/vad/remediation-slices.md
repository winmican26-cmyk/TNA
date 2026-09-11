# Sequential final remediation slices

Controlling brief: `final-remediation-brief.md`. Work stays in TNA; existing Gate tags and failing evidence are preserved. No VAD tag or self-acceptance is authorized.

Each slice requires captured failing-first evidence, focused green tests, a full regression run, and a recorded completion result before the next begins. Independent review is attempted when available; unavailable reviewer capacity is recorded honestly, never converted into ACCEPT.

| Slice | Scope | Exit criterion |
|---|---|---|
| S0 | V5 prerequisite: current file-store repeatability defect | Same-record retries are idempotent, conflicts reject, unique fixtures clean themselves, full suite green |
| S1 | G1 current decision validity | Approval/runtime/envelope/issuance/revocation checked and TTL capped; six required regressions green |
| S2 | G2 pre-invocation rechecks | Required leases validated; authority rechecked after async preparation; blocked paths invoke zero handlers |
| S3 | G3 outcome/evidence separation | Terminal evidence failure yields indeterminate outcome, consumed token, one invocation and no automatic retry |
| S4 | V1 trusted validation/verifier contract | Registered trusted validators, exact criterion coverage, hashes and strict verdict checks; fake PASS/NOT_RUN reject |
| S5 | V2 actual resource/dependency checks | Actual snapshots/diffs, operation-aware canonical paths, forbidden dependency comparison; escape tests green |
| S6 | V3–V5 operational lifecycle integration | One durable store, immutable snapshots, actual hashes, owned counters/clock/lock, atomic complete final evidence; restart/concurrency tests green |
| S7 | P2 and delivery correctness | Explicit non-public egress ranges, correct package/entrypoint/setup metadata, historical docs marked |
| S8 | Final proof and review package | Two consecutive clean checks without manual cleanup; three demos; reconciled tests and requirement matrix; stop for architectural review |

S6 groups V3–V5 because atomic finalization, durable run ownership and lifecycle counters must share one operational persistence boundary. It will be decomposed into serial substeps with their own focused proof; it is not permission to develop those steps in parallel. S0 does not claim V5 complete.

Baseline evidence is in `remediation-evidence/baseline-git.log` and `baseline-check.log`. Baseline HEAD: `718a801ff9e3085faf4e69d1dbf924a1b6e6c047`; branch `tna-gate-v0.2`.
