# Proof of Work: TNA Gate v0.3

## Scope

This is the VAD Atom 5 local evidence report. It covers only the child-process runner, application-level egress guard, strict tool input binding, evidence documentation, and harmless demo. Sentinel, Auditor, dashboards, cloud adapters, Vault/HSM, Kubernetes, browser automation, and unrestricted shell are outside Vol 3.

## Implemented surfaces

- `packages/isolation-runner`: **IMPLEMENTED** child-process boundary; `shell:false`; explicit environment; realpath workspace controls; timeout/output limits; process-tree termination. OS sandboxing and network enforcement are **NOT IMPLEMENTED**.
- `packages/egress-guard`: **IMPLEMENTED** URL, host, port, DNS, private/mapped address, redirect, and credential-strip checks for guarded requests. Kernel egress isolation and DNS TOCTOU elimination are **NOT IMPLEMENTED**.
- `packages/tool-inputs` and `packages/execution-broker`: **IMPLEMENTED** strict schemas, canonical SHA-256 `input_hash`, capability binding, substitution rejection, server-owned executable selection, single-use redemption, revocation recheck, and sanitized evidence.

## Evidence contract

Execution states are `REQUESTED`, `AUTHORIZED`, `CAPABILITY_ISSUED`, `STARTED`, `SUCCEEDED`, `FAILED`, `TERMINATED`, and `BLOCKED`. Evidence includes execution/capability/agent/decision identifiers, timestamps, state/reason, input hash, runner metadata, network metadata, runtime limit, exit code, termination reason, and stdout/stderr sizes and hashes. Secret-requiring tools fail closed without a secret broker; secrets are not capability fields or child environment values.

Single-use transactional consumption is the concurrency/idempotency basis. It prevents broker replay and races, but it is not exactly-once external execution. A real external side effect cannot be atomically committed with SQLite evidence, so a crash after the effect can remain indeterminate while replay stays blocked.

## Demo evidence

`npm run demo:v03` builds and runs a temporary, local-only direct package demo. It asserts and prints exactly these required outcomes: `BLOCK DIRECT TOOL INVOCATION`, `ALLOW AUTHORIZATION`, `CAPABILITY ISSUED`, `ISOLATED EXECUTION STARTED`, `EXECUTION SUCCEEDED`, `INPUT SUBSTITUTION BLOCKED`, `FILESYSTEM ESCAPE BLOCKED`, `NETWORK EGRESS BLOCKED`, `TIMEOUT TERMINATED`, and `REVOKED EXECUTION BLOCKED`. It creates local temporary scripts, uses no external network/cloud/credentials, and removes temporary state in `finally`.

## Verification reference

The Vol 2 baseline is annotated tag `tna-gate-v0.2`, peeled to commit `cdb53bec97d197214a7ca99a964f5d88324da693` (tag object `4d83bcf5cc853026f8d17171ab4f450d2c86481b`); the 80-test regression baseline remains required. See `docs/v0.3-verification.md` for commands, focused suites, acceptance matrix, and limitations.
