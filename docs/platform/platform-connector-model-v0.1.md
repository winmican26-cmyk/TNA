# TNA Platform Connector Model v0.1

## `ToolConnector` (sections 57-58)

```ts
interface ToolConnector {
  connector_id: string; tenant_id?: string; tool: string; action: string;
  allowed_operations: readonly string[]; risk_classification: 'LOW'|'MEDIUM'|'HIGH'; network_required: boolean;
  execute(context: ToolConnectorContext): Promise<ToolConnectorResult> | ToolConnectorResult;
}
```

A connector describes a registered, trusted tool's identity and the actual work it performs. It
performs no authorization or mediation itself — `platform-connectors` package code does I/O nowhere.

## Execution stays broker-mediated (sections 22, 24, 57)

`buildToolRegistry()` (`apps/tna-platform/src/connectors.ts`) adapts each registered `ToolConnector`
into a Gate `ToolDefinition`, whose `handler` calls `connector.execute()`. The connector never becomes
directly callable from the platform API — invocation only ever happens inside
`ExecutionBroker.redeem()`, after capability verification, exactly like every other Gate-mediated tool.

## Trusted registry (section 76)

```ts
class ConnectorRegistry { register(connector): void; get(tenantId, tool): ToolConnector | null; list(tenantId): readonly ToolConnector[] }
```

Tenant-scoped: a connector registered for one tenant is not resolvable for another. Connectors are
registered only at trusted startup configuration (`buildDefaultConnectorRegistry()`); an agent cannot
submit handler code, a shell command, or a URL and have it executed as a new tool — an unregistered
`tool` in a request fails closed with `CONNECTOR_UNKNOWN` before any authorization call is made.

## The one demo connector (section 58)

`DEMO_ECHO_CONNECTOR` — deterministic, no filesystem/network/process access, no production
credentials, `risk_classification: 'LOW'`. The platform's own tests and demo instead register a
`log.write`-bound handler reusing the accepted `tests/fixture.ts` envelope's own action binding
(action=`log.write`, tool=`log.write`, resource pattern `/workspace/logs/**`) so authorization is
exercised against a real, already-accepted envelope shape rather than a bespoke one built from scratch
for this milestone alone.

## Connector drift (section 78)

A connector cannot make itself appear to drift undetected: the platform's Sentinel observations always
carry the *registered* `tool`/`resource` values from the stored request, never anything the connector
itself reports at execution time (the connector's return value only ever becomes a `result_hash`, per
`platform-gate-integration-v0.1.md`'s discovered constraint that Gate's broker discards the raw
handler input anyway). A connector registered under one identity cannot silently masquerade as another
through any code path the platform actually exercises — `buildDriftingConnector()`
(`packages/platform-connectors`) exists only to support a direct Sentinel-level test proving
`TOOL_NOT_ALLOWED` independently catches a mismatch if one were ever submitted; it is never wired into
the real demo/app flows.
