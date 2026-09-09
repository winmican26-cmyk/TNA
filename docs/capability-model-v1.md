# Capability Model v1

## Status

This document describes the implemented Vol 2 capability core. The token is an internal, short-lived authorization artifact, not a user credential and not a general-purpose bearer permission. It is **implemented** in `packages/capability-core`; KMS/HSM key storage is **conceptual** for this local milestone.

## Payload and bindings

A version `1` payload contains exactly these fields:

```json
{
  "version": 1,
  "capability_id": "uuid",
  "execution_id": "uuid",
  "agent_id": "deployment-agent-17",
  "decision_id": "dec_uuid",
  "action": "production.deploy",
  "tool": "demo.deploy.execute",
  "resource": "prod.deploy.release",
  "operation": "write",
  "destination": null,
  "policy_hash": "sha256-hex",
  "policy_issuance_id": "pol_uuid",
  "issued_at": "2026-09-09T12:00:00.000Z",
  "expires_at": "2026-09-09T12:00:30.000Z",
  "single_use": true,
  "nonce": "base64url-16-bytes"
}
```

The broker copies the action, tool, resource, operation, destination, policy hash, policy issuance revision, agent identity, and decision identity from the stored `ALLOW` decision and its associated policy record. The caller cannot supply or widen those bindings. Redemption checks the exact token binding against the registered tool and request, then rechecks revocation and current policy immediately before consuming the capability.

No payload field contains a reusable privileged credential, secret, approval credential, or handler output. The capability is valid only for its one execution and one agent.

## Integrity and canonicalization

The wire token is `base64url(canonical_payload).base64url(HMAC)`. The MAC is HMAC-SHA256 over the UTF-8 canonical payload. Canonicalization recursively sorts object keys lexicographically, preserves array order, uses JSON string escaping, and emits no insignificant whitespace. Verification checks base64url round-tripping, MAC length, timing-safe MAC equality, exact field set, field types, canonical bytes, timestamp format, and TTL.

The codec requires a key of at least 32 bytes. The default TTL is 30 seconds and the maximum is 60 seconds. Expiry is exclusive: `expires_at <= now` is rejected. A token issued in the future, modified token, forged MAC, malformed token, or token with a longer lifetime is rejected.

## Key handling

The local demo creates a random key in memory and never prints it. The persistent API reads `TNA_CAPABILITY_KEY` from its environment and disables execution when the value is absent or shorter than 32 bytes. Environment variables are a local-development mechanism, not a production key-management design. Production migration should use a KMS/HSM-backed signing service or key handle, protected key rotation with a versioned key identifier, controlled key access, audit trails, and a planned overlap window for verification. Key material must not enter tokens, SQLite evidence, logs, fixtures, or agent responses.

HMAC protects integrity and authenticity for a shared server-side secret; it does not provide non-repudiation. A compromised Gate process or key holder can mint tokens. The current implementation has one local key and no rotation protocol, so KMS/HSM migration remains **conceptual/unimplemented**.

## Lifetime

The effective authorization ends at the earliest of token expiry, agent revocation, current-policy mismatch, approval/policy invalidation represented by the stale decision check, or successful single-use consumption. SQLite records consumption transactionally before handler invocation. A failed or replayed redemption cannot invoke the handler again.
