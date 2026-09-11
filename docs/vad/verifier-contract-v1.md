# Verifier Contract v1

Status: IMPLEMENTED

## Purpose

The verifier judges the produced work against the original Atom Spec and deterministic evidence, not against self-reported producer claims.

## Behavior

The verifier in [packages/verifier-core/src/index.ts](../../packages/verifier-core/src/index.ts) enforces:

- original success criteria must be evaluated
- missing criteria invalidate the result
- invented criteria invalidate the result
- resource violations reject the verdict
- failed deterministic validation rejects the verdict
- `ACCEPT` is only returned when all mandatory criteria are satisfied

## Verdicts

Allowed verdicts are:

- `ACCEPT`
- `REJECT`
- `REQUEST_CHANGES`
- `INVALID`

The implementation fails closed on malformed verifier output.
