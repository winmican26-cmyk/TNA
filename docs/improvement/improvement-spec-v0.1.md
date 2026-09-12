# TNA Recursive Improvement Governance v0.1 — ImprovementSpec

Source of truth: `packages/improvement-schema/src/index.ts` (`ImprovementSpec`, `buildImprovementSpec`,
`SPEC_INPUT_FIELDS`) and `packages/improvement-store/src/index.ts` (`ImprovementStore.saveSpec`/`getSpec`).

## What becomes immutable

The entire `ImprovementSpec` object — every field listed below — becomes immutable once saved.

## When it becomes immutable

`ImprovementStore.saveSpec(tenantId, generationId, specId, spec, specHash)` is called once, by the
governor's `handleCreate` route, at the moment a generation is proposed (the same call that creates the
`PROPOSED` generation record). `saveSpec` checks whether a spec already exists under that `spec_id`; if it
does, it compares the stored hash against the newly-supplied hash and throws
`ImprovementError('SPEC_IMMUTABLE', ...)` on any mismatch, otherwise it is a no-op. In practice this means
the spec is immutable from `PROPOSED` onward — there is no code path anywhere in the governor that calls
`saveSpec` a second time with different content for the same `spec_id`, and if one ever did, the store
itself would refuse it rather than silently accept a rewrite.

## Spec hashing

`buildImprovementSpec()` computes `spec_hash = hash(withoutHash)` where `hash()` is SHA-256 over a
canonical (key-sorted, `undefined`-stripped) JSON representation (`canonical()`/`hash()`, shared with every
other content-addressed value in this volume — benchmark results, capability/authority deltas, canary
policy, test manifests). The hash covers every field of the spec except `spec_id`, `created_at`, and
`spec_hash` itself (which cannot logically hash themselves). The generation record stores this hash
(`ImprovementGeneration.spec_hash`) so a generation is permanently bound to the exact spec content it was
created against.

## Fields (`ImprovementSpec`)

| Field | Purpose |
|---|---|
| `spec_id` | Runtime-minted, never caller-supplied |
| `system_id`, `tenant_id` | Ownership |
| `parent_generation_id` | `null` for a root spec |
| `objective` | Non-empty, ≤4000 chars |
| `improvement_class` | One of `CLASS_0_CONFIG`..`CLASS_5_AUTHORITY_OR_EVALUATOR` — see `improvement-classification-v0.1.md` |
| `allowed_mutation_paths` | Must declare at least one path — an unbounded mutation scope is never valid |
| `forbidden_mutation_paths` | Explicit additional denials (on top of the always-on `DEFAULT_FORBIDDEN_MUTATION_PATH_PREFIXES` — see `mutation-boundary-v0.1.md`) |
| `allowed_tool_changes`, `allowed_dependency_changes`, `allowed_model_changes` | Declared scope for MCP/dependency/model changes (structural validation only — see the requirement matrix's "real MCP/model-change governance" PARTIAL rating) |
| `authority_ceiling` | See `authority-ceiling-v0.1.md` |
| `resource_limits` | `max_runtime_ms`, `max_cost_usd`, `max_tool_calls`, `max_external_calls`, `max_changed_files`, `max_changed_bytes` |
| `evaluation_profile_id`, `required_benchmarks`, `required_security_tests`, `promotion_thresholds` | See `evaluation-profile-v0.1.md` |
| `canary_policy` | See `canary-policy-v0.1.md` |
| `rollback_policy` | See `rollback-v0.1.md` |
| `max_iterations`, `max_runtime_ms`, `max_cost_usd` | Spec-level ceilings (distinct from the system-level `RecursionBudget` — see `recursion-budget-v0.1.md`) |
| `created_by`, `created_at` | Provenance |

## Validation performed by `buildImprovementSpec()`

- Rejects any key not in the fixed `SPEC_INPUT_FIELDS` list — an unknown field is a hard `INVALID_INPUT`
  error, not silently ignored.
- `system_id`/`tenant_id` must be safe identifiers (`safeId()` — bounded length, restricted character set).
- `objective` must be a non-empty, bounded string.
- `improvement_class` must be one of the six defined classes.
- Every path/array-of-strings field is type-checked.
- `allowed_mutation_paths` must be non-empty.
- **Secret-shaped value scan**: `containsSecretShapedValue()` scans every string leaf of the input for a
  bearer-token-shaped pattern and rejects the whole spec if found. This is deliberately a *value*-only
  scan, not `findSecretShapedField()`'s *key-name* scan — `authority_ceiling` legitimately has a field
  literally named `credentials` (a list of credential-reference identifiers, never secret material itself),
  and a key-name scan would have produced a false-positive rejection of every legitimate spec.

## Candidate cannot modify its own active authoritative spec

There is no code path anywhere in this volume — HTTP route, CLI command, or store method — by which a
candidate (or any caller) can rewrite an already-saved spec's content. The only way to change what a
generation is evaluated against is to propose a **new generation** with a new spec, which then goes through
the entire pipeline again from `PROPOSED`. This is the concrete mechanism behind TNA-72's "competence
change is not the same as control-plane change": a candidate can produce a better implementation, but it
cannot retroactively loosen the rules it is being judged by.
