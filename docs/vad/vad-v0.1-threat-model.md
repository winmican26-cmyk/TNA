# VAD Engine v0.1 Threat Model

Status: IMPLEMENTED IN PART

## Assets

- Atom specification integrity
- Resource manifest integrity
- Validation evidence integrity
- Verifier correctness
- Human decision traceability

## Threats

### Malformed atom

A malformed Atom Spec may be submitted with unsupported version, unknown fields, or invalid limits.

Mitigation:

- strict parsing
- unknown field rejection
- explicit numeric validation

### Mutable spec

A producer or verifier might attempt to change the spec after execution starts.

Mitigation:

- canonical hash generation
- immutable spec identity
- validation against the original spec

### Resource escape

A producer may modify undeclared files or create unauthorized outputs.

Mitigation:

- resource manifest enforcement
- independent comparison of declared versus actual files

### False producer claim

A producer may claim success without passing the deterministic gate.

Mitigation:

- deterministic evidence requirements
- gate failure closed behavior
- verifier independent of producer narrative

### Retry runaway

A retry loop may continue beyond the bounded attempt count or cost envelope.

Mitigation:

- max attempts enforcement
- explicit limits in Atom Spec
- design for bounded execution and escalation

### Verifier mutation

A verifier may invent criteria or omit required criteria.

Mitigation:

- verifier output schema validation
- exact criterion set matching
- fail-closed invalid verdict behavior

### Evidence failure

A final completion may be reported without persistent evidence.

Mitigation:

- deterministic evidence is required by the gate
- completion is tied to evidence presence

## Residual Risk

This v0.1 milestone intentionally does not claim full semantic understanding of arbitrary work. It enforces deterministic structural safety and evidence integrity but does not claim fully autonomous or adversarially complete software engineering.
