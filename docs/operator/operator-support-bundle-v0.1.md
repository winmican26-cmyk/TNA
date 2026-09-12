# TNA Operator CLI v0.1 — Incident/Support Package

`tna incident collect [--tenant <id>]` (`apps/tna-operator/src/incident.ts`) produces an
`IncidentPackage`:

```json
{
  "manifest": { "version": "1.0", "package_id": "inc_...", "created_at": "...", "tenant_scope": "ten_... | null", "files": [{ "name": "doctor", "sha256": "...", "bytes": 1234 }], "manifest_hash": "..." },
  "doctor": { },
  "platform_diagnostics": { },
  "client_gateway_health": { },
  "recent_actions": [ { "platform_action_id": "...", "state": "...", "error_code": "...", "explanation": { } } ]
}
```

## `IncidentPackageManifest v1`

Every included section is individually SHA-256 hashed (`files[].sha256`), and the manifest itself is
hashed (`manifest_hash`) over the package id, creation time, tenant scope, and the file list — tamper-
evident: a later dispute about "what was actually in this package" can be checked against this hash.

## Redaction

Every section is passed through `redactDeep()` (`apps/tna-operator/src/redact.ts`) before being placed
in the package — the same redaction the CLI applies to ordinary command output. No admin/service bearer
token, API key, or password-shaped field can appear in an incident package.

## Bounds

`INCIDENT_MAX_ACTIONS = 25` — the recent-actions section never grows unbounded.

## Tenant scoping

`--tenant <id>` scopes `client_gateway_health` to that tenant's own `GET /v1/admin/tenants/:id/health`
call. The platform client itself is bound to one deployment tenant by construction (Volume 8's own
single-tenant-per-deployment design) — cross-tenant leakage into `recent_actions` is structurally
impossible via this client, not merely filtered after the fact.

## Honest limitation: logs

This v0.1 collector does not gather raw process log files — the CLI has no log-file access surface in
this pass (it only calls HTTP endpoints). "Bounded logs" from the original brief is therefore not yet
implemented; `doctor` and `recent_actions` are the closest real substitute currently available.
