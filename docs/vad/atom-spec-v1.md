# Atom Specification v1

Status: IMPLEMENTED

## Summary

The VAD Atom Specification is a strict, machine-readable structure that captures a single bounded unit of work. It requires a single primary goal, explicit success criteria, bounded risk, resource manifest, constraint list, and execution limits.

## Schema

The implementation enforces a strict object shape in [packages/vad-core/src/index.ts](../../packages/vad-core/src/index.ts).

Core rules:

- Version must be `1.0`.
- Unknown root fields and nested fields are rejected.
- `goal` is required and must be non-empty.
- `success_criteria` must contain at least one deterministic criterion.
- Resource manifest must include `read`, `write`, and `create` arrays.
- `constraints.forbidden` must exist and contain strings.
- `limits.max_attempts`, `max_runtime_seconds`, and `max_cost_usd` are required and must be positive.

## Hashing

Canonicalization is deterministic and independent of object insertion order. The canonical representation is hashed with SHA-256 to produce `spec_hash`.
