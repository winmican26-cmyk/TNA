# Tool Input Binding

## Status

Strict tool input validation and canonical hashing are **IMPLEMENTED** and **TESTED**. This is a broker binding, not a general command parser or an authorization to select an executable.

`ToolInputRegistry` selects schemas by the server-owned tool name. The demo deployment schema is strict, limits serialized input to 256 bytes, accepts only the bounded `release` pattern and literal `demo-production`, canonicalizes recursively with sorted object keys, and records SHA-256 as `input_hash`. The broker validates the stored decision input at issuance and recomputes the hash at redemption.

The capability binds action, tool, resource, operation, destination, agent, decision, policy identifiers, and `input_hash`. Redeem rejects unknown fields, missing input, invalid schema, changed resource, changed input, or a mismatched hash. Tool substitutions are rejected before invocation. A registered tool's adapter constructs the isolated request; the caller cannot supply an executable callback, handler, or arbitrary command.

This prevents substitution within the implemented broker path. It does not validate the behavior of a trusted adapter after it receives the already-validated input, and it does not constrain a compromised Gate host. Those are **PARTIALLY ENFORCED** / **FUTURE** concerns.
