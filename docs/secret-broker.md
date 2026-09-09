# Secret Broker

## Status

Secret access remains **fail-closed**. The broker interface (`SecretBroker`) is implemented as a narrow contract, and the execution broker refuses a credential-requiring tool when no secret broker is configured. The demo tool requires no credentials. No secret value is present in capability payloads, evidence, artifacts, responses, or logs.

A future secret broker may lease named, short-lived credentials to a trusted handler using the execution and agent identities. The handler must receive only the declared lease, leases must be released in a `finally` path, and the agent must never see the value. Declaring a secret in an Authority Envelope is not itself permission to read one, and an approval cannot bypass the missing broker.

## Required production controls

A real implementation needs KMS/HSM-backed secret retrieval or an equivalent managed secret store, audience-bound leases, TTL enforcement, rotation, audit events without values, least-privilege service identity, memory/transport protection, and revocation/reconciliation behavior. Those controls are **conceptual and unimplemented** in v0.2. The current interface does not claim process isolation, memory erasure, or protection from a compromised host.
