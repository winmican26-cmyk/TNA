# TNA Client Integration v0.1 — Credential Lifecycle

## Purpose (§7–8, §56)

Every `ClientServiceIdentity` authenticates via a bearer token issued exactly once (at creation or
rotation) and never persisted in plaintext. The credential lifecycle is deliberately simple: issue →
hash → store-hash-only → authenticate-via-hash-comparison → rotate-or-revoke. No session tokens, no
OAuth flows, no JWTs — a single bearer token per service identity, verified against a stored SHA-256
hash.

## Issuance (§7)

`issueCredential()` produces:

```typescript
interface IssuedCredential {
  readonly credential_ref: string;  // `cred_<uuid>` — opaque reference for logging/rotation
  readonly token: string;           // `tnaclient_<uuid><uuid-no-dashes>` — bearer value
}
```

- `credential_ref` is a stable identifier for the credential slot — it appears in logs, in the
  service identity record, and in MCP server registrations that bind to this credential. It is not
  secret.
- `token` is the secret bearer value. It is returned to the caller exactly once — at the moment of
  issuance or rotation — and is never stored, logged, or retrievable again.

The token format (`tnaclient_` prefix + two UUIDs) is deliberately long and high-entropy. No claim
of cryptographic key-derivation strength is made beyond what `crypto.randomUUID()` provides.

## Hashing (§8)

```typescript
function hashCredentialToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

Only the SHA-256 hex digest of the token is persisted in the `credential_hash` column. The column has
a `UNIQUE` constraint — no two service identities can share the same credential hash, even across
tenants.

## No-plaintext-persistence rule (§8)

At no point does the raw token appear in:
- The `ClientServiceIdentity` interface (it has `credential_ref`, never `token` or `credential_hash`)
- Any query result from `getServiceIdentity` or `listServiceIdentities`
- The database in plaintext form — only `credential_hash` is stored
- Ledger evidence — only `credential_ref` is recorded

The only code path that holds the raw token is `issueCredential()` → the caller's return value.

## Authentication

`authenticateService(token)`:
1. Computes `SHA-256(token)` → `hashHex`
2. Queries `SELECT * FROM client_service_identities WHERE credential_hash = ?`
3. Rejects if no row, if status ≠ `ACTIVE`, or if `verifyCredentialToken` fails

The comparison (`verifyCredentialToken`) compares two fixed-length hex strings. Both sides are 64-
character SHA-256 hex digests, so a straightforward `===` comparison does not leak timing information
proportional to a variable-length secret's content.

## Rotation (§56)

`rotateCredential(tenantId, serviceId, expectedVersion)`:
1. CAS check — the identity's `state_version` must match `expectedVersion`
2. Identity must be `ACTIVE` — revoked identities cannot rotate
3. A new credential is issued (`issueCredential()`)
4. A single atomic `UPDATE` replaces `credential_hash`, `credential_ref`, and `last_rotated_at`
5. The old token immediately stops working — there is no dual-valid window
6. The new `IssuedCredential` (with the raw token) is returned to the caller

### No dual-valid window

Rotation is a single `UPDATE` statement within a `BEGIN IMMEDIATE` transaction. The old hash is
overwritten in the same row. From the instant the transaction commits, only the new token's hash
exists in the table — the old token's `authenticateService` call returns `null`.

### Rotation-race handling

If two concurrent `rotateCredential` calls race on the same service identity, exactly one wins (CAS)
and the other receives `CONFLICT`. The loser must re-read the identity (which now has the winner's
`state_version`) and retry if rotation is still desired.

## Revocation timing

When a service identity is revoked (`status` → `REVOKED`), `authenticateService` returns `null` for
any token — even if the token's hash still matches. The `status !== 'ACTIVE'` check runs before the
hash comparison.

When a tenant begins offboarding, all active service identities are bulk-revoked in the same
transaction. No credential survives the offboarding cascade.

## Secret detection at boundaries (§145)

`findSecretShapedField` is applied to every piece of client metadata before persistence. If any field
name matches a secret pattern (`api_key`, `password`, `client_secret`, etc.) or any value matches a
bearer-token pattern, the request is rejected — preventing inadvertent plaintext credential storage
in metadata fields.
