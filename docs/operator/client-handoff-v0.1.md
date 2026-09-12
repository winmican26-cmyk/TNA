# TNA Operator CLI v0.1 — Client Deployment Handoff

`tna handoff generate --tenant <id>` (admin-only; `apps/tna-operator/src/handoff.ts`) produces
`ClientDeploymentHandoff v1`:

```json
{
  "version": "1.0", "generated_at": "...", "deployment_id": "...", "component_versions": { },
  "tenant_id": "ten_...", "enabled_tools": [{ "tool_id": "...", "external_tool_name": "...", "risk_class": "LOW" }],
  "policy_bindings_count": 1, "known_limitations": ["..."], "bypass_assessment": "NO_KNOWN_BYPASS",
  "backup_status": "...", "health_status": "GO", "go_live_assessment": { }, "handoff_hash": "..."
}
```

No secret field appears anywhere in this document (proven in
`tests/operator/operator-units.test.ts`). `handoff_hash` is a SHA-256 over every other field — a later
dispute about "what configuration was actually handed over" can be settled against this hash rather than
memory.

`handoff generate` internally runs the same `go-live assess` logic first and embeds its result — the
handoff can never claim a healthier state than the go-live assessment it is built from.

## Known limitations always included

MCP server code is not inherently trusted; TNA cannot guarantee complete mediation against a parallel
client credential; there is no binary attestation for MCP servers. See
[proof-of-work-operator-v0.1.md](proof-of-work-operator-v0.1.md) for the complete, current list.
