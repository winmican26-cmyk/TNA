# Deterministic Validation Gate v1

Status: IMPLEMENTED

## Purpose

The validation gate converts machine-verifiable evidence into a binary PASS/FAIL decision.

## Behavior

The gate in [packages/validation-gate/src/index.ts](../../packages/validation-gate/src/index.ts):

- accepts deterministic validator records
- fails closed if no evidence exists
- fails if a validator returns `FAIL`
- fails if the produced artifact violates the declared resource manifest
- passes only if all required evidence is deterministic and valid

## Model

Allowed validator statuses are:

- `PASS`
- `FAIL`
- `NOT_RUN`

The gate does not introduce partial pass semantics for binary acceptance criteria.
