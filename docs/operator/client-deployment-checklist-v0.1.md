# TNA Client Deployment Checklist v0.1

Run through this before a new client tenant goes live. Each row names the real command that verifies
it — this is a checklist for a human, backed by real evidence, not a self-attestation form.

| # | Item | Verified by |
|---|---|---|
| 1 | Deployment is up and healthy | `tna status` / `tna doctor` |
| 2 | A recent backup exists | Volume 9's `npm run tna:backup` / manifest inspection (not yet wrapped by a `tna` subcommand — see proof-of-work) |
| 3 | Client tenant created and ACTIVE | `tna tenant show` |
| 4 | At least one service identity created | `tna service list` |
| 5 | Secret/credential model reviewed with the client | manual — the CLI never displays a credential twice |
| 6 | Bypass assessment attestation collected from the client | `tna go-live assess --bypass-tna-chain --bypass-external-credential` |
| 7 | MCP server(s) registered | `tna mcp list` |
| 8 | Tools discovered | `tna mcp discover` |
| 9 | Risk reviewed for each tool | `tna tool inspect` |
| 10 | Policy bound (tools enabled) | `tna tool list` (`enabled: true`) |
| 11 | Sentinel coverage confirmed | `tna doctor` (`platform.sentinel`) |
| 12 | Ledger verified | `tna doctor` (`platform.ledger`) |
| 13 | A real test action completes | `tna go-live assess --test-action <id>` |
| 14 | Incident contacts documented | manual |
| 15 | Backup schedule documented | manual |
| 16 | Offboarding owner named | manual |
| 17 | Go-live assessment is GO or GO_WITH_LIMITATIONS with accepted limitations | `tna go-live assess` |
| 18 | Handoff package generated and hash recorded | `tna handoff generate` |

Items without a `tna` command are real operational practices this volume does not automate — named here
so they are not silently skipped.
