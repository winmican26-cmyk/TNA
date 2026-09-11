# TNA Platform — Sentinel Integration v0.1

## Direct package use

Unlike Gate, `SentinelRuntime` is a real package (`packages/sentinel-runtime`) — `platform-core`
depends on it through a narrow `SentinelPort` interface (`createSession`, `getSession`,
`submitObservation`, `completeSession`) rather than importing the concrete class, purely so tests can
substitute a deterministic fake for TERMINATE/HOLD branches without engineering a Sentinel policy rule
to fire on demand. A real `SentinelRuntime` instance satisfies this interface structurally — no
adapter class is needed at the composition root.

## Session creation (section 20)

Bound to the action's `agent_id`, `decision_id`, `correlation_id`, `expected_{action,tool,resource}`,
`allowed_operations` (intersected with Sentinel's own controlled vocabulary — an operation outside it
is simply omitted from the allow-list, which is fail-closed, not fail-open), `authority_expiry`
(decision time + requested runtime limit), and `runtime_limits`/`cost_limits` from the request.
Created strictly after capability issuance and strictly before any execution claim.

### Resource-identifier normalization (a discovered cross-system constraint)

Sentinel's `expected_resource`/observation `resource` pattern (`safeResourcePattern`) must start with
an alphanumeric character; Gate's own file-scoped resources (`validFile`) must start with `/`. These
two accepted subsystems' resource-identifier conventions are simply incompatible at the leading
character. `toSentinelResource()` (`packages/platform-core`) strips a leading `/` consistently
everywhere a resource crosses into Sentinel (session creation and both pre/post-action observations);
Gate, the connector, and Ledger all continue to see the resource exactly as the caller supplied it.
Found directly — the first real end-to-end test run failed with `expected_resource is required`
against a real Gate-file-shaped resource before this was added.

## Sentinel failure to start (section 21)

If session creation itself throws, the action fails closed to `INDETERMINATE`/`SENTINEL_UNAVAILABLE`
— there is no code path from a Sentinel failure to unmonitored execution. Proven directly with a fake
`SentinelPort` whose `createSession` always throws.

## The mandatory pre-action check (section 23)

Before any execution claim leads to a connector call, one `TOOL_CALL_REQUESTED` observation is
submitted (source `EXECUTION_BROKER` — an existing, already-allowed Sentinel observation source; no
Sentinel schema change was needed) carrying the platform's own trusted `tool`/`resource` — never
anything a connector itself might claim. Because the platform always submits the values it authorized,
not whatever a connector reports, a connector cannot cause its own tool/resource drift to be observed
(see `platform-connector-model-v0.1.md`'s "connector drift" note) — this is a structural guarantee, not
a convention.

- `decision === 'TERMINATE'` → the connector is never invoked. If `getSession().status === 'TERMINATED'`
  (containment confirmed), the action resolves to `TERMINATED`; otherwise `INDETERMINATE` — a stale or
  unconfirmed termination is never reported as a confirmed `TERMINATED` (carrying forward the Sentinel
  concurrency-closure lesson, TNA-33/38).
- `decision === 'HOLD'` → the connector is never invoked; the action resolves to
  `INDETERMINATE`/`SENTINEL_HOLD` (there is no dedicated platform-level "runtime hold" state distinct
  from Gate's own pre-execution `HELD` — see `platform-state-machine-v0.1.md` — this is a deliberate
  v0.1 simplification, recorded here rather than silently assumed).

Post-execution, a best-effort `EXECUTION_COMPLETED` observation and `completeSession()` call are made
— their failure never converts an already-succeeded connector call into a reported failure (TNA-47).

## Demo Flow 3 — genuine mid-flight revocation, not a synthetic trigger

The demo's Sentinel-termination flow does not manufacture an artificial rule match. It wires a real
`AuthorityRevalidator` reporting the agent revoked; Sentinel's own accepted evaluation logic consults
the revalidator on every evaluation not itself triggered by an explicit `*_RECHECK` observation —
including the platform's ordinary pre-action check — so the default policy's `AGENT_REVOKED` rule
(`CRITICAL`/`TERMINATE` by catalog default) fires for real. This models a genuine, realistic scenario:
an agent revoked after Gate's ALLOW but before execution completes, caught by Sentinel exactly as
designed.
