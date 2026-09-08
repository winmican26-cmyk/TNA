# Authority Envelope v1.0

The strict Zod schema lives in `packages/authority-envelope/src/index.ts`. The API accepts JSON. The source design's YAML is represented by `examples/deployment-envelope.json`; v0.1 does not parse YAML over HTTP. The example adds explicit log, peer-contact, and secret-request bindings for the test scenarios; secret requests still always block. Remove unused bindings and tools when issuing an operational policy.

`docs/authority-envelope-v1.schema.json` is a generated JSON Schema for editor assistance and structural validation. Zod's additional cross-field checks (binding consistency, duplicate actions, approval references, and canonical file scopes) remain authoritative and are always applied by the API. JSON Schema alone does not replace those checks.

Every envelope includes agent identity and UTC expiry, objective, resource permissions, tool and network policies, secrets, peer-agent policy, limits, approvals, risk metadata, evidence metadata, and violation policy. Unknown fields at every modeled object level are rejected. Version must equal `1.0`.

## Explicit action bindings

The prose design needs one additional required field for safe execution: `action_bindings`. An agent cannot submit an outcome or resource operation and choose its own interpretation. An administrator binds each action to exactly one allowed outcome, tool, resource category, and operation:

```json
{
  "action": "production.deploy",
  "outcome": "deploy approved release",
  "tool": "deploy.execute",
  "resource_kind": "infrastructure",
  "operation": "write",
  "destination_required": true
}
```

Bindings must refer to allowed outcomes and allowed tools, cannot refer to forbidden outcomes or denied tools, and cannot duplicate an action. Reserved envelope mutation and agent registration actions cannot be bound. Repository/file/database/infrastructure actions use `read` or `write`; secrets use `access`; agent contact uses `communicate`. Approval rules must refer to distinct bound actions.

## Matching and limits

- Resource identifiers match exactly. File scopes additionally support a terminal `/**` for descendants. Paths must be absolute POSIX logical resource names, with no backslashes, percent encoding, repeated separators, dot segments, wildcard characters in requests, or control characters. `/workspace/logs/**` matches `/workspace/logs/deploy.log`, not `/workspace/logs-evil/a` or the directory itself. These are policy identifiers, not paths the API opens on Windows.
- Hostnames must be lowercase canonical hostnames without URLs, ports, trailing dots, or userinfo. They match exactly. No subdomain wildcards. An explicit deny overrides an allow. The source's `deny: ["*"]` means deny all *unlisted* destinations, so its explicit allow list remains usable. Every destination supplied is checked, and bindings can require one.
- A peer must be listed and registered with a nonrevoked identity. This authorizes a contact request only; transport-level peer authentication belongs to the future communication adapter.
- Secret access always blocks until the ephemeral credential broker exists, including declared secrets. The service never reads or returns secrets.
- Runtime begins with the first ALLOW. Expiry and runtime boundaries are exclusive: requests at the boundary block. A decision check does not kill a running process.
- Each ALLOW consumes one tool call, one external request if a destination is present, and the estimated cost. Costs have at most six decimal places and are accumulated in integer microdollars. Estimates are reservations, not measured invoices; an executor must enforce actual charges before production use.
- One initial ALLOW plus `max_retries_per_action` additional ALLOWs is permitted per action for the agent's lifetime. There is no agent-controlled counter reset or retry identifier.
- Missing approvals and insufficient remaining cost return HOLD. Other implemented violations return BLOCK. Hard policy checks and limits run before approval checks so an approval cannot widen authority.

Policy replacement is administrator-only and keeps lifetime counters. Every issuance has a new revision, including identical content. Approvals from previous revisions become invalid. SHA-256 policy hashes use stable key-sorted JSON; arrays retain their order.

## Evidence and deferred metadata

Every valid, authenticated authorization attempt stores its request, agent ID, decision ID, decision, reason, timestamp, envelope version/hash, and valid approval reference. The request records action, tool, resource, destination, and estimated cost. Malformed/unauthenticated requests and forbidden control-plane calls create separate rejection audit events, not authorization decisions.

Risk, rollback requirements, retention days, and violation response names are accepted policy metadata. v0.1 does **not** execute rollbacks, rotate secrets, terminate processes, send escalations, or automatically enforce retention. All decisions are always recorded regardless of `evidence.capture`; execution results, actual cost, verifier verdicts, and observed resource access need future trusted adapters.
