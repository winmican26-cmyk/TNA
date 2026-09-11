# TNA Client Integration v0.1 — Tool Schema Drift

## Purpose (§18–19, §58–59)

Schema drift is the condition where an MCP server's current tool schema differs from the schema that
was last reviewed and policy-bound. Drift detection is a critical safety mechanism: it ensures that a
tool whose behavior has changed (as indicated by its schema changing) cannot continue executing under
a policy that was evaluated against the old behavior.

## What drift means

A governed tool has a `schema_hash` — the SHA-256 of the canonical representation of its
`input_schema`. When discovery runs (`recordDiscovery`), it recomputes the hash for each tool the
MCP server advertises. If the new hash differs from the stored hash, that tool has drifted.

Drift means the tool's *contract* has changed. It might:
- Accept new required parameters it didn't before
- Remove parameters it previously accepted
- Change the types or constraints of existing parameters
- Restructure its input entirely

Any of these changes could alter the tool's behavior in ways the prior risk classification and policy
binding did not account for.

## Detection mechanism

Detection is automatic and deterministic during discovery reconciliation:

```
for each discovered tool:
  newHash = SHA-256(canonical(discovered.input_schema))
  if existing tool exists AND existing.schema_hash ≠ newHash:
    → update schema and schema_hash
    → set enabled = false
    → set review_status = 'POLICY_REVIEW_REQUIRED'
```

No human judgment is needed to detect drift — it is a hash comparison. Human judgment is needed to
*resolve* drift (re-review, re-classify, re-bind).

## Impact on execution eligibility

A tool marked `POLICY_REVIEW_REQUIRED` is immediately ineligible for execution:
- `enabled` is set to `false`
- Any attempt to invoke this tool through the platform will be rejected
- The tool's prior policy binding still exists in the historical record but no longer governs
  execution

This is fail-closed: drift disables first, requires re-review to re-enable. The alternative —
allowing execution to continue under a stale policy — would mean the tool operates under assumptions
that may no longer be true.

## Re-review requirement

To re-enable a drifted tool, an operator must:

1. Review the new schema (stored on the tool after drift detection updated it)
2. Determine whether the risk classification still applies or needs adjustment
3. Call `enableTool` with the current `state_version`, a risk classification decision, and policy
   parameters — creating a new `ToolPolicyBinding` that includes the new `schema_hash`

The operator cannot skip this step. There is no "acknowledge drift and keep the old policy" shortcut.

## Server reconfiguration as drift trigger (§20)

Schema drift is not the only trigger for `POLICY_REVIEW_REQUIRED`. When an MCP server is
reconfigured (`reconfigureMcpServer`), all of its enabled tools are forced to
`POLICY_REVIEW_REQUIRED` — because the server's startup configuration (executable, arguments,
environment) has changed, and trust under the previous configuration does not carry forward.

## What drift does NOT mean

- Drift does not mean the tool is malicious. The MCP server may have been legitimately updated.
- Drift does not trigger automatic re-classification. The operator must decide.
- Drift does not delete the tool. The tool remains in the registry with its new schema.
- Drift does not affect other tools from the same server (unless they also drifted).

## Drift and removed tools

A tool absent from a discovery result is marked `REMOVED`, not `POLICY_REVIEW_REQUIRED`. Removal is
a separate condition from drift — the tool no longer exists on the server at all, versus the tool
still exists but its schema changed.
