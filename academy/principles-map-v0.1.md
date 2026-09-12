# TNA Principles Map v0.1 — TNA-01 through TNA-64, by Theme

Organized thematically for Academy Level 1, rather than as one flat numbered list. TNA-01 through
TNA-42 are documented inline within their own originating volumes' design docs (Gate v0.1-v0.3, VAD
Engine, Ledger, Sentinel, Auditor) — this map groups them by the subsystem/theme they belong to without
retyping their exact original wording; consult that volume's own docs for the precise text. TNA-43
onward are each individually titled in their own consolidation docs, reproduced here verbatim.

## Authority (Gate, Volumes 1-3)

The earliest principles (roughly TNA-01–TNA-20): authority is explicit and declared in an Authority
Envelope, never inferred from an agent's own claims; unknown tools/resources/agents fail closed;
approval requires a role distinct from the requester's own; revocation is durable and cannot be
retroactively undone by reissuing a policy. See `docs/authority-envelope-v1.md`,
`docs/threat-model.md`, `docs/v0.2-threat-model.md`, `docs/v0.3-threat-model.md`.

## Verification (VAD Engine, Volume 4)

Independent verification of produced work, separate from the agent that produced it; a runtime-owned
attempt/cost/clock budget the agent cannot manipulate; a strict verifier that cannot be talked into
accepting invented criteria. See `docs/vad/`.

## Evidence (Ledger, Volume 5)

Durable, hash-chained, tenant-isolated event evidence; orphan events (e.g. a capability redeemed
without ever having been issued) are rejected; evidence is reconstructible independent of the system
that produced it. See `docs/ledger/`.

## Runtime Control (Sentinel, Volume 6)

Authorization is not a one-time decision — observed runtime behavior can still diverge from what made
authorizing it acceptable, and Sentinel can HOLD or TERMINATE when it does; a lack of detected
violations is not proof none occurred. See `docs/sentinel/`.

## Assurance (Auditor, Volume 7)

Post-hoc control assessment never fabricates a pass from absent or corrupt evidence; TNA's own audit
result is not a claim of external regulatory/legal certification. See `docs/auditor/`.

## Integration (Platform, Volume 8)

- **TNA-43 — Integration Must Not Weaken Boundaries**
- **TNA-44 — Correlation Is a Security Property**
- **TNA-45 — Durable State Precedes Distributed Assumption**
- **TNA-46 — Evidence Delivery Must Survive Process Failure**
- **TNA-47 — External Success and Assurance Success Are Different Facts**
- **TNA-48 — Uncertain External Effects Must Not Be Retried Blindly**
- **TNA-49 — Delivery Ownership Must Be Durable**
- **TNA-50 — Causation Is Captured, Not Reconstructed**

See `docs/platform/platform-principles-v0.1.md`.

## Deployment (Volume 9)

- **TNA-51 — Secure Code Is Not Secure Deployment**
- **TNA-52 — Readiness Is a Security Decision**
- **TNA-53 — Recovery Must Preserve Truth**
- **TNA-54 — Backups Are Part of the Trust Boundary**
- **TNA-55 — Configuration Is Executable Authority**
- **TNA-56 — Operational Convenience Must Not Manufacture Trust**
- **TNA-57 — A Backup Set Is a Recovery Boundary**

See `docs/deployment/deployment-principles-v0.1.md`.

## External Tools (Client Integration, Volume 10)

- **TNA-58 — Discovery Does Not Grant Authority**
- **TNA-59 — External Tool Identity Must Be Stable**
- **TNA-60 — Schema Drift Is Authority Drift**
- **TNA-61 — Client Credentials Define the Real Enforcement Boundary**
- **TNA-62 — Offboarding Must Revoke Future Power Without Erasing History**
- **TNA-63 — Protocol Compatibility Does Not Imply Trust**
- **TNA-64 — The Packaged Path Is the Real Path**

See `docs/client-integration/client-integration-principles-v0.1.md`.

## Operational Truth (Operator Readiness, Volume 11)

- **TNA-65 — Human Operators Are Part of the Threat Model**
- **TNA-66 — Operational Truth Must Be Explainable**
- **TNA-67 — Diagnostics Must Not Become Authority**
- **TNA-68 — Training Must Be Verified**
- **TNA-69 — Training Authority and Production Authority Are Separate**
- **TNA-70 — Go-Live Is an Evidence Decision**
- **TNA-71 — Support Artifacts Are Security Artifacts**

See `docs/operator/operator-principles-v0.1.md` for the full account and evidence for each.
