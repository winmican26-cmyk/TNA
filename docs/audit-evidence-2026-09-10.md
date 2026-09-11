# Audit execution evidence — 2026-09-10

Workspace: `C:\Users\mican\Documents\TNA`. Source baseline: `718a801ff9e3085faf4e69d1dbf924a1b6e6c047`, plus untracked VAD additions. Runtime: Node 24.14.0, npm 11.9.0. Audit does not modify application source or existing tests.

## Full check

Observed fresh `npm run check`: typecheck PASS; ESLint PASS; build PASS; 126 tests, 125 pass, 1 fail; exit code 1. Gate: 110/110 passing; VAD: 15/16 passing. Failure reproduced by the focused command below. Existing generated VAD evidence was preserved, not deleted to obtain a green result.

## Focused VAD rerun

Command: `node --test dist/tests/vad/vad-engine.test.js`. Exit code 1.

```text
✔ atom spec rejects unsupported version (9.3141ms)
✔ canonical spec hash ignores insertion order (3.5305ms)
✔ resource manifest detects undeclared file changes (0.6844ms)
✔ validation gate accepts deterministic evidence and rejects false self-claims (1.0971ms)
✔ retry context excludes prior producer conversation history (5.071ms)
✔ verifier rejects invented criteria and missing criteria (2.1281ms)
✔ accepted demo atom completes the VAD flow (3.4506ms)
✔ lifecycle rejects illegal terminal transitions and records legal history (1.3319ms)
✔ runtime budget makes attempt four impossible and enforces cost and runtime (3.9369ms)
✔ strict verifier parser rejects malformed output and unmet acceptance (3.7634ms)
✔ human override requires an auditable decision and preserves the spec hash (1.5024ms)
✔ acceptance requires persisted evidence and rejects integrity mismatches (2.2621ms)
✖ file evidence store persists final evidence and prevents conflicting finalization (35.7408ms)
✔ accepted Level 2 flow persists evidence before entering ACCEPTED (8.6047ms)
✔ rejected and exhausted flows persist evidence and close safely (4.0306ms)
✔ active execution registry rejects duplicate runs (1.1445ms)
ℹ tests 16
ℹ suites 0
ℹ pass 15
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 414.5903

✖ failing tests:

test at dist\tests\vad\vad-engine.test.js:203:1
✖ file evidence store persists final evidence and prevents conflicting finalization (35.7408ms)
  Error: Conflicting final evidence
      at FileEvidenceStore.persist (file:///C:/Users/mican/Documents/TNA/dist/packages/vad-runtime/src/index.js:108:23)
      at async TestContext.<anonymous> (file:///C:/Users/mican/Documents/TNA/dist/tests/vad/vad-engine.test.js:212:5)
      at async Test.run (node:internal/test_runner/test:1125:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:787:7)
```

## VAD adversarial probes

Command: `node docs/audit-probes.mjs`. These probes print observed insecure behavior; exit code 0 means the probe ran, not that the product passed an acceptance test. All fixtures are in memory.

```json
{
  "notRunGate": "PASS",
  "nonzeroExitGate": "PASS",
  "readOnlyWriteDetected": false,
  "prefixEscapeDetected": false,
  "traversalDetected": false,
  "emptyEvidenceVerdict": "ACCEPT",
  "emptyCriteriaParse": "ACCEPT",
  "fourAttemptsNumberedOne": "RETRYING",
  "incompleteAcceptance": "ACCEPTED",
  "specMutationError": "Spec hash mismatch after execution start",
  "persistedAfterSpecMutation": [
    "ACCEPTED"
  ]
}
```

## Gate adversarial probes

Command: `node docs/audit-gate-probes.mjs`. Uses real Gate policy checks with fake clocks and no-op trusted handlers; no network or real privileged action.

```text
(node:46264) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
{
  "expiredApprovalAndRuntime": {
    "state": "SUCCEEDED",
    "handlerCalls": 1,
    "millisecondsAfterAuthorization": 2000,
    "approvalAndRuntimeLimitMs": 1000
  },
  "revokedDuringLease": {
    "state": "SUCCEEDED",
    "revoked": true,
    "handlerCalls": 1
  },
  "successEvidenceFailureError": "Handler failed",
  "successEvidenceFailure": {
    "handlerCalls": 1,
    "recordedState": "FAILED"
  },
  "addressClassification": {
    "198.19.0.1": false,
    "224.0.0.1": false,
    "ff02::1": false
  }
}
```

## Demos

Both `npm run demo:v02` and `npm run demo:v03` completed with exit code 0. v0.2 printed direct-call rejection, missing-approval HOLD, ALLOW, capability issuance, successful execution, replay rejection and revoked-capability rejection. v0.3 printed those core stages plus input substitution rejection, child execution, filesystem preflight rejection, standalone Egress Guard rejection and timeout termination. These demo outputs do not override the adversarial findings.

## Review boundary

Two read-only reviewers were dispatched for Gate and VAD. Both hit an agent usage limit before final verdicts. Preliminary observations were checked locally; no independent ACCEPT verdict is claimed. A suspected descendant-process timeout issue was inspected but not reproduced on this Windows host and is not counted as a confirmed finding.

