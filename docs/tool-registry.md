# Tool Registry

## Status

The registry is **implemented** as an in-process, server-owned allowlist. It is metadata plus trusted handlers; it is not a plugin loader, sandbox, or proof that an operating system prevented direct execution.

Each registration declares:

- `name`: exact tool identifier;
- `action`: exact policy action;
- `resourceType`: policy resource category;
- `allowedOperations`: exact operation set;
- `networkRequired`: whether a destination must be bound;
- `credentialsRequired`: secret names needed by the handler;
- `handler`: trusted implementation, never exposed to callers.

Broker issuance requires a registered tool compatible with the stored decision. Redemption checks tool name, action, resource, operation, and destination again. Registry metadata does not include the handler, and its public `invoke` method rejects with a broker-only error. The handler context contains identifiers and bindings, not credentials.

## Demo registration

`createDemoRegistry(directory)` registers `demo.deploy.execute` with `production.deploy`, infrastructure/write, `networkRequired: false`, and an empty credential list. Its simulated handler writes one deterministic JSON artifact named by execution ID under the caller-provided temporary directory. It performs no external request and emits no secret.

The production tool adapter, OS sandbox, network proxy, handler isolation, and registry persistence are **conceptual/unimplemented**. A registry entry must not be treated as an enforcement boundary against a compromised Gate host or a developer who can modify server code.
