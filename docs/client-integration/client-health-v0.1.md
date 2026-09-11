# TNA Client Integration v0.1 — Client Health

## Purpose (§69–71)

Health checks for the client integration control plane follow the same discipline as every other TNA
component: a read-only, non-consequential probe that answers "can this component accept work?" without
performing any work itself.

## What is checked

| Check | Target | Meaning |
|---|---|---|
| Store connectivity | `ClientStore` (SQLite) | Can the store open, query, and return a result? |
| Schema integrity | `ClientStore` tables | Do all expected tables exist with the expected columns? |
| Tenant query | `listTenants(limit: 1)` | Can a paginated read complete without error? |

## What is NOT checked

- **MCP server reachability.** Health does not spawn child processes or attempt MCP handshakes. A
  health check that spawns external processes would violate the no-consequential-execution rule (§70)
  and could produce side effects in the external environment.
- **Credential validity.** Health does not attempt authentication. A health probe that tests a real
  credential would consume a real authentication attempt and could leak timing information.
- **Tool discovery.** Health does not run discovery. Discovery mutates the governed tools table and
  is a consequential operation.

## No consequential execution for health (§70)

The health check is strictly read-only. It does not:
- Create, update, or delete any record
- Spawn any child process
- Send any network request
- Authenticate any credential
- Modify any state

A failed health check means the store is unreachable or corrupted. It does not attempt to repair
the problem — it reports it honestly.

## No secrets in health output (§71)

Health check responses never contain:
- Credential values, hashes, or references
- Tenant configuration details
- MCP server executables or arguments
- Environment variable values

The health response contains only: component name, status (`AVAILABLE`/`DEGRADED`/`UNAVAILABLE`),
and an optional bounded message (truncated, never a raw stack trace).

## Relationship to deployment health

The client integration health check is a component-level probe. In a deployed TNA system, it
participates in the deployment-level `aggregateReadiness()` alongside Gate, Sentinel, Ledger, and
other components (see `deployment-health-v0.1.md` for the aggregation rules). The client integration
store is a mandatory dependency for client-facing operations — if it is `UNAVAILABLE`, new client
actions are refused.
