# TNA Gate v0.1 threat model

## Trust boundary

The governed agent is untrusted. Gate's process, operating system, database, administrator credential, independently held approver credentials, and eventual executor are trusted. Policies are stored outside the agent runtime. An agent can submit requests but cannot issue envelopes, register identities, grant approvals, or revoke other agents.

| Attack | Implemented defense | Verification |
|---|---|---|
| Undeclared tool | Exact action/tool binding and tool allow/deny lists | Abuse tests |
| Undeclared file/resource | Per-category read/write scopes; canonical file paths | Traversal, encoding, prefix and operation tests |
| Unapproved external host | Required destinations and exact allow/deny matching | Missing host, suffix spoof, explicit deny tests |
| Unauthorized agent contact | Listed, registered, nonrevoked peer required | Unknown and unregistered peer tests |
| Secret access | Fail closed until broker is implemented | Secret request test |
| Execution after expiry | Envelope expiry and first-ALLOW runtime checks | Exact boundary tests |
| Cost/tool-call excess | Durable atomic reservations; integer microdollars | Ceiling and concurrent-spend tests |
| Objective reinterpretation | Administrator-issued action bindings to approved outcomes | Unknown/forbidden action and binding tests |
| Stale approval | Exact request + policy hash/revision + role + expiry + one-time consumption | Replay, altered request, reissue and expiry tests |
| Agent edits its own envelope | Separate administrator credential and endpoint checks | Agent mutation REST tests |

Additional checks cover identity spoofing, cross-agent evidence access, forged approval roles, malformed requests, evidence-write rollback, restart persistence, and hash-chain integrity.

## Evidence guarantees

SQLite uses immediate transactions, WAL, and full synchronous writes. Decision state, budget reservations, consumed approvals, and audit entries commit together. No success is returned when evidence cannot be committed. The append-only application interface links each audit entry to its predecessor with SHA-256 and verifies the chain at startup.

The hash chain detects ordinary record modification but does not resist a privileged attacker who rewrites the database and recomputes the chain, deletes its tail, or rolls back the whole database. External anchoring, remote append-only storage, encryption, retention enforcement, and backups are deployment work beyond v0.1. Protect database files and their directory from agent access.

## Integration requirements and limitations

An authorization API alone cannot prevent direct tool calls. The future trusted executor must own all tool/network/credential access and derive the submitted action, resource and destination from what it actually executes. A malicious agent's self-reported cost or hostname is not proof of actual behavior. Responses are not signed, single-use execution capabilities; this milestone does not protect against a rogue executor replaying an ALLOW.

The service authorizes logical file names, without opening files, resolving symlinks, or checking filesystem mount boundaries. A future filesystem adapter must perform those checks. Hostname authorization does not resolve DNS, prevent rebinding, or constrain redirects. Peer allowlists do not establish a mutually authenticated connection.

Credential bearer tokens are intended for local integration here. The entrypoint binds loopback only. Production exposure needs TLS, operator identity management, credential rotation, rate limits, bounded/paginated audit queries, request monitoring, a supported deployment/runtime review, and external evidence protection. Local operator tokens do not attest that a human personally reviewed an approval. Role separation depends on distributing credentials to separate trusted operators.

Limits count ALLOW reservations, not actual tool execution; abandoned reservations are not refunded. Lifetime counters never reset through policy replacement. Runtime stops future authorizations but does not terminate a process. Termination, rotation, rollback, escalation, verifier hooks, measured cost, and resource access telemetry remain unimplemented adapters. There is no dashboard, Sentinel, Ledger UI, Auditor, or VAD orchestration in this build.
