# VAD Engine v0.1 Requirement Matrix

This file is the compact requirement matrix for the architectural review memo. The authoritative full narrative is in [vad-v0.1-architectural-review.md](vad-v0.1-architectural-review.md).

| Requirement ID | Original requirement | Status | Implementation location | Evidence |
|---|---|---|---|---|
| BAS-01 | Preserve Gate baseline | PASS | Git tags and commit metadata | `tna-gate-v0.3` tag exists at `718a801ff9e3085faf4e69d1dbf924a1b6e6c047` |
| BAS-02 | 110 Gate tests pass | PASS | Existing tests; fresh `npm run check` | `117 total tests, 117 pass, 0 fail` |
| BAS-03 | No Gate rewrite | PASS | `git status --short --branch` | Only VAD additions are uncommitted |
| ATM-01 | Strict Atom Spec | PASS | [packages/vad-core/src/index.ts](../../packages/vad-core/src/index.ts) | `finalizeAtomSpec` and `assertStrictKeys` |
| ATM-02 | Version 1.0 | PASS | same file | `if (version !== '1.0')` |
| ATM-03 | Unknown fields rejected | PASS | same file | `assertStrictKeys` |
| ATM-04 | Required fields enforced | PASS | same file | checks for `goal`, `risk`, `resources`, `constraints`, `limits` |
| ATM-05 | One-primary-goal rule | PARTIAL | same file | structural `goal` only, no semantic detector |
| ATM-06 | Explicit success criteria | PASS | same file | criterion validation |
| ATM-07 | Resource manifest required | PASS | same file | resource arrays are required |
| ATM-08 | Risk required | PASS | same file | `risk.level` required |
| ATM-09 | Limits required | PASS | same file | `max_attempts`, `max_runtime_seconds`, `max_cost_usd` |
| ATM-10 | Canonical spec hash | PASS | same file | `computeSpecHash` |
| ATM-11 | Insertion-order independence | PASS | same file | `sortedEntries` plus test |
| ATM-12 | Spec mutation after start rejected | PARTIAL | same file | no runtime mutation guard |
| PROD-01 | Provider-independent Producer | PASS | [packages/model-adapter/src/index.ts](../../packages/model-adapter/src/index.ts) | `DeterministicMockProducer.produce` |
| PROD-02 | Deterministic mock producer | PASS | same file | deterministic mock object |
| PROD-03 | Producer identity recorded | PASS | same file | `producer_id`, `provider`, `model` |
| PROD-04 | Provider/model recorded | PASS | same file | fields present |
| PROD-05 | Producer self-claim not evidence | PASS | [packages/validation-gate/src/index.ts](../../packages/validation-gate/src/index.ts) | gate check on evidence |
| RETRY-01 | Fresh retry behavior | PASS | same file | priorConversation reset |
| RETRY-02 | Original spec retained | PASS | same file | atom passed into producer |
| RETRY-03 | Relevant failure carried forward | PASS | same file | `failure` field used |
| RETRY-04 | No accumulated history | PASS | same file | test ensures `priorConversation` empty |
| RETRY-05 | Max attempts enforced | PARTIAL | same file | limit in spec, no runtime controller |
| RETRY-06 | Attempt 4 impossible when max=3 | PARTIAL | none | no execution controller |
| RETRY-07 | Cost bounds | PARTIAL | same file | model exists, but live enforcement absent |
| RETRY-08 | Runtime bounds | PARTIAL | same file | model exists, but live enforcement absent |
| VAL-01 | Validation gate exists | PASS | [packages/validation-gate/src/index.ts](../../packages/validation-gate/src/index.ts) | `ValidationGate.run` |
| VAL-02 | PASS/FAIL only | PASS | same file | `status: 'PASS' | 'FAIL'` |
| VAL-03 | Resource-manifest validation | PASS | same file and [packages/vad-core/src/index.ts](../../packages/vad-core/src/index.ts) | `isResourceViolation` |
| VAL-04 | Undeclared modification rejected | PASS | same file | test covers undeclared file |
| VAL-05 | Undeclared creation rejected | PASS | same file | same manifest logic |
| VAL-06 | Forbidden dependency rejection | PARTIAL | same file | spec model exists, no dependency scanner |
| VAL-07 | Producer assertion cannot override gate | PASS | same file and test | fail closed behavior |
| VAL-08 | Observed evidence required | PASS | same file | no-evidence => FAIL |
| VER-01 | Provider-independent verifier | PASS | [packages/verifier-core/src/index.ts](../../packages/verifier-core/src/index.ts) | `DefaultVerifier.verify` |
| VER-02 | Original spec input | PASS | same file | `VerificationInput.atom` |
| VER-03 | Deterministic evidence input | PASS | same file | `validationEvidence` |
| VER-04 | No reasoning history | PARTIAL | same file | structurally isolated but not API-enforced |
| VER-05 | Verifier cannot mutate artifact | PARTIAL | same file | no write permission boundary |
| VER-06 | Verifier cannot mutate spec | PARTIAL | same file | no immutability enforcement |
| VER-07 | Verifier cannot mutate evidence | PARTIAL | same file | no permission boundary |
| VER-08 | Strict schema | PASS | same file | `VerifierResult` and `VALID` logic |
| VER-09 | Unknown verdict rejected | NOT IMPLEMENTED | none | no runtime verdict validator |
| VER-10 | Arbitrary prose rejected | NOT IMPLEMENTED | none | no free-text output guard |
| VER-11 | Missing criterion rejected | PASS | same file | checks criterion omission |
| VER-12 | Invented criterion rejected | PASS | same file | checks invalid criterion IDs |
| VER-13 | ACCEPT with unmet criterion rejected | PASS | same file | fail conditions checked |
| VER-14 | Original criteria evaluated | PASS | same file | criteria mapped from `atom.success_criteria` |
| LVL-01 | Level 1 | PASS | [packages/validation-gate/src/index.ts](../../packages/validation-gate/src/index.ts) | mock producer + gate |
| LVL-02 | Level 2 | PASS | [packages/verifier-core/src/index.ts](../../packages/verifier-core/src/index.ts) | verifier present |
| LVL-03 | Risk routing deterministic | PARTIAL | [packages/vad-core/src/index.ts](../../packages/vad-core/src/index.ts) | risk defined but no routing policy |
| LVL-04 | Level 2 skipping prevented | PARTIAL | none | no router or lifecycle controller |
| LVL-05 | No Level 3 | PASS | repo contents | no Level 3 packages |
| LVL-06 | No Level 4 | PASS | repo contents | no Level 4 packages |
| HUM-01 | Human decision state modeled | PARTIAL | none | no `HumanDecision` record |
| HUM-02 | Actor recorded | NOT IMPLEMENTED | none | no actor field |
| HUM-03 | Timestamp recorded | PARTIAL | mock producer only | producer timestamps only |
| HUM-04 | Override exists | NOT IMPLEMENTED | none | no override model |
| HUM-05 | Override rationale mandatory | NOT IMPLEMENTED | none | no rationale field |
| HUM-06 | Override cannot silently alter spec | NOT IMPLEMENTED | none | no override logic |
| EVD-01 | Evidence Package v2 | PARTIAL | artifact and gate data | no dedicated package object |
| EVD-02 | atom identity | PASS | [packages/model-adapter/src/index.ts](../../packages/model-adapter/src/index.ts) | `atom_id` |
| EVD-03 | goal | PASS | [packages/vad-core/src/index.ts](../../packages/vad-core/src/index.ts) | `goal` required |
| EVD-04 | risk | PASS | same file | `risk.level` |
| EVD-05 | success criteria | PASS | same file | required criterion list |
| EVD-06 | spec hash | PASS | same file | `spec_hash` |
| EVD-07 | producer provenance | PASS | same file | fields present |
| EVD-08 | verifier provenance | PARTIAL | same file | no verifier identity field |
| EVD-09 | attempts | PARTIAL | same file | `attempt_number` only |
| EVD-10 | validation evidence | PASS | [packages/validation-gate/src/index.ts](../../packages/validation-gate/src/index.ts) | `validators` |
| EVD-11 | verification evidence | PASS | [packages/verifier-core/src/index.ts](../../packages/verifier-core/src/index.ts) | `VerifierResult` |
| EVD-12 | human decision | NOT IMPLEMENTED | none | no object |
| EVD-13 | artifact info | PASS | same file | `artifactHash`, `diffHash`, `filesChanged`, `declaredArtifacts` |
| EVD-14 | artifact hash/diff hash | PASS | same file | fields present |
| EVD-15 | resource comparison | PASS | same file | resource violation logic |
| EVD-16 | runtime/cost classification | PARTIAL | same file | usage fields exist but no runtime controller |
| EVD-17 | limits/constraints | PASS | same file | required fields |
| EVD-18 | final state and timestamp | PARTIAL | same file | `completed_at` exists, no state machine record |
| EVI-01 | Evidence required before completion | PASS | gate code | no evidence => FAIL |
| EVI-02 | Evidence persistence failure prevents ACCEPTED | NOT IMPLEMENTED | none | no persisted package |
| EVI-03 | Artifact mutation after verification invalidates evidence | NOT IMPLEMENTED | none | no post-verification integrity guard |
| EVI-04 | Spec hash mismatch detection | PARTIAL | same file | hash computed but not enforced as runtime guard |
| EVI-05 | Artifact hash mismatch detection | PARTIAL | same file | hash recorded but no runtime guard |
| LIF-01 | State machine implemented | PARTIAL | design/model files | conceptual state references only |
| LIF-02 | States actually used | PARTIAL | test file | some flow captured but not state machine |
| LIF-03 | Permitted transitions | NOT IMPLEMENTED | none | no transition table |
| LIF-04 | Illegal transitions rejected | NOT IMPLEMENTED | none | no transition engine |
| LIF-05 | ESCALATED state | NOT IMPLEMENTED | none | no state |
| LIF-06 | FAILED behavior | PARTIAL | validation gate | `FAIL` status exists |
| LIF-07 | REJECTED behavior | PARTIAL | verifier | `REJECT` exists |
| LIF-08 | ACCEPTED behavior | PARTIAL | verifier | `ACCEPT` exists |
| CON-01 | Resource contamination | PASS | same file | `isResourceViolation` |
| CON-02 | Dependency contamination | PARTIAL | same file | forbidden strings structural only |
| CON-03 | Semantic context contamination not overclaimed | PASS | [docs/vad/vad-v0.1-threat-model.md](vad-v0.1-threat-model.md) | explicit limitation statement |
| IDD-01 | simultaneous active runs | NOT IMPLEMENTED | none | no lock or scheduler |
| IDD-02 | human decision double apply | NOT IMPLEMENTED | none | no decision record |
| IDD-03 | conflicting final evidence | NOT IMPLEMENTED | none | no evidence ledger |
| IDD-04 | API retries duplicate prevention | NOT IMPLEMENTED | none | no API layer |
| LOG-01 | no credentials in logs | NOT APPLICABLE | none | no logging layer |
| LOG-02 | no provider API keys in evidence | PASS | same file | mock metadata contains no secrets |
| LOG-03 | bounded outputs | PARTIAL | validation gate | short result strings only |
| LOG-04 | no chain-of-thought storage | PASS | threat model doc | explicit design rule |
| DEM-01 | ATOM CREATED | PARTIAL | spec model | no runtime lifecycle event |
| DEM-02 | PRODUCER ATTEMPT 1 | PARTIAL | producer result | `attempt_number: 1` |
| DEM-03 | DETERMINISTIC GATE FAILED | PARTIAL | gate logic | can fail closed but no demo event record |
| DEM-04 | FRESH RETRY CREATED | PARTIAL | producer retry model | priorConversation reset |
| DEM-05 | PRODUCER ATTEMPT 2 | PARTIAL | producer model | conceptually possible but no full event chain |
| DEM-06 | DETERMINISTIC GATE PASSED | PASS | validation gate test | test exists |
| DEM-07 | INDEPENDENT VERIFIER STARTED | PARTIAL | verifier class | separate class but no lifecycle record |
| DEM-08 | VERIFIER ACCEPTED | PARTIAL | verifier test | accepts in model |
| DEM-09 | HUMAN DECISION RECORDED | NOT IMPLEMENTED | none | no human decision engine |
| DEM-10 | EVIDENCE PACKAGE COMPLETE | PARTIAL | producer/gate data | evidence exists but not packaged end-to-end |
| DEM-11 | ATOM ACCEPTED | PARTIAL | verifier result | `ACCEPT` returned |
| DEM-12 | rejected demo atom sequence | PARTIAL | verifier result | reject path exists but no persisted demo event chain |
| GEN-01 | All new VAD tests pass | PASS | [tests/vad/vad-engine.test.ts](../../tests/vad/vad-engine.test.ts) | `npm run check` |
| GEN-02 | No Level 3 | PASS | repo state | no Level 3 packages |
| GEN-03 | No Level 4 | PASS | repo state | no Level 4 packages |
| GEN-04 | No frontend | PASS | repo state | VAD package is local-only |

The requirement matrix is intentionally evidence-based and conservative. It marks only what is concretely supported by implementation or fresh test evidence.
