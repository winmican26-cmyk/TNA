# TNA Gate REST API v0.1

All routes require `Authorization: Bearer <credential>`. POST requests require `Content-Type: application/json` and have a 64 KiB body limit. Agent credentials come from registration. Operator credentials come from the server environment.

| Method | Path | Required identity | Result |
|---|---|---|---|
| POST | `/v1/agents/register` | Administrator | 201: agent ID and one-time plaintext token |
| POST | `/v1/envelopes` | Administrator | 201: policy version/hash |
| GET | `/v1/envelopes/:agentId` | Administrator or matching agent | Envelope, hash, issuance revision |
| POST | `/v1/authorize` | Matching agent | 200: ALLOW, BLOCK, or HOLD decision |
| POST | `/v1/approvals` | Matching independent approver role | 201: approval ID and expiry |
| POST | `/v1/revoke` | Administrator | Permanent revocation of agent |
| GET | `/v1/decisions/:id` | Administrator or decision's agent | Stored decision |
| GET | `/v1/agents/:id/activity` | Administrator or matching agent | Agent's recorded decisions |

Register using `{"id":"deployment-agent-17","name":"Deployment Agent"}`. Issue the JSON envelope as the request body. Update its example expiry before use; the historical design expires on 2026-09-09.

Authorize using:

```json
{
  "agentId": "deployment-agent-17",
  "action": "production.deploy",
  "tool": "deploy.execute",
  "resource": "prod.deploy.release",
  "destination": "deploy.internal.company",
  "estimatedCostUsd": 0.12
}
```

The first request returns HOLD because it requires approval. A release-manager credential can POST `/v1/approvals` with:

```json
{
  "request": {
    "agentId": "deployment-agent-17",
    "action": "production.deploy",
    "tool": "deploy.execute",
    "resource": "prod.deploy.release",
    "destination": "deploy.internal.company",
    "estimatedCostUsd": 0.12
  },
  "expiresAt": "2026-09-09T00:59:00Z"
}
```

Use a future approval expiry no later than the envelope expiry. Retry the exact authorization request with the returned `approvalId`. This reference is not a credential and grants no policy authority by itself.

Every authorization response includes `decisionId`, `agentId`, `decision`, `reason`, `severity`, `policyVersion`, `policyHash`, `requiresEvidence: true`, `timestamp`, `request`, and `approvalReference` (nullable). Missing policies have null version/hash. Both HOLD and BLOCK are normal decisions and use HTTP 200; callers must explicitly check `decision === "ALLOW"`.

Revoke using `{"agentId":"deployment-agent-17","reason":"Release complete"}`. A revoked agent's authorization requests remain authenticated so their BLOCK decisions can be logged; it cannot be reactivated by issuing a new policy. Agents may read their own historical decisions after revocation.

HTTP errors: 400 invalid schema/JSON, 401 missing or invalid credential, 403 wrong identity/role, 404 unknown resource/route, 409 conflicting state, 413 oversized body, 415 wrong content type, 503 persistence/internal failure. A 503 must never be treated as permission to execute. Rejected requests are audited without bearer credentials or submitted bodies.

`npm run demo` exercises this flow with fresh timestamps and throwaway credentials. See `scripts/demo.ts` for an executable client example.
