# TNA Deployment Academy v0.1

A structured, hands-on course for learning to operate TNA — stored in the repository, run against real
TNA code, never graded by self-report.

## Honest scope

This is a real but intentionally reduced first pass. See
[curriculum-v0.1.md](curriculum-v0.1.md) for the four-level structure and
[../docs/operator/proof-of-work-operator-v0.1.md](../docs/operator/proof-of-work-operator-v0.1.md) for
the exact accounting of what exists (5 real, verified labs) versus what the full Volume 11 brief
described (15 labs and four complete assessments).

## Layout

```
academy/
├── README.md                    this file
├── curriculum-v0.1.md           the four-level structure
├── principles-map-v0.1.md       TNA-01 through TNA-64, organized by theme
├── question-bank/                validated Level 1–4 question resources
├── labs/                        real, verified lab implementations + the lab registry
└── lib/                         shared lab-safety helpers (path safety, ACADEMY_LAB_MODE gate)
```

## Running labs

```
npm run demo:academy:v01           # run every implemented lab and print a summary
npm run academy:verify -- <lab-id> # run one lab and print its real verification steps
npm run test:academy:v01           # the academy's own automated test suite
ACADEMY_LAB_MODE=true npm run academy:reset   # reset only the academy's own lab-state workspace
```

Known lab ids: `blocked-action`, `mcp-discovery`, `schema-drift`, `tenant-isolation`, `packaged-path`.

## Levels (brief)

1. **Foundations** — concepts and principles (TNA-01 through TNA-64)
2. **Operator** — the `tna` CLI, onboarding, MCP, evidence, incidents
3. **Deployment Engineer** — topology, config, secrets, backup/restore/upgrade
4. **Security / Control-Plane Specialist** — Authority Envelope, capability brokerage, Sentinel,
   Ledger causal chains, packaged-path assurance (TNA-64)

Completion is called **completion assessment**, never certification (section 33, 108).
