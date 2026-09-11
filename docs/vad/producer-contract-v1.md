# Producer Contract v1

Status: IMPLEMENTED

## Purpose

The producer contract defines the bound between the Atom Spec and the implementation artifact generator. It is provider-independent and remains decoupled from any external model API.

## Contract

The implementation uses the deterministic mock producer in [packages/model-adapter/src/index.ts](../../packages/model-adapter/src/index.ts).

It returns:

- `atom_id`
- `spec_hash`
- `attempt_number`
- `producer_id`
- `provider`
- `model`
- `model_version`
- `started_at`
- `completed_at`
- `declared_output_artifacts`
- `artifact`
- `context`
- `usage`

## Fresh Retry Rule

Retry context excludes prior conversation history. The producer receives only the original spec, the required context, and the deterministic failure details from the previous attempt. This is enforced in the VAD regressions and the mock producer behavior.
