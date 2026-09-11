# TNA Client Integration v0.1 — MCP Transport

## Purpose (§12, §14, §28–29)

This document describes the stdio transport used by the MCP Gateway to communicate with external MCP
servers. Every decision here is a security boundary.

## stdio transport (§12)

Newline-delimited JSON-RPC 2.0 over the child process's stdin/stdout. Stderr is captured (last 2000
chars) for diagnostics but never parsed as protocol data.

## shell:false (§14)

```typescript
spawn(executable, [...args], {
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: buildChildEnv(envAllowlist, extraEnv),
});
```

The child process is spawned with `shell: false`:

- **No shell interpretation.** Shell metacharacters in arguments are literal, not commands.
- **No glob expansion.** Wildcards are not expanded.
- **No environment variable substitution.** `$VAR` in arguments is literal.

## Explicit argv (§14)

```typescript
interface McpServerRegistration {
  readonly executable: string;       // bare path, not a shell command
  readonly args: readonly string[];  // argument vector, not concatenated
}
```

Validation enforces:
- `executable`: `^[A-Za-z0-9][A-Za-z0-9._/\\:-]{0,499}$` — no spaces, no shell metacharacters
- `args`: each ≤2000 chars, each checked for `;|&` backticks `$(` — rejected even though
  `shell:false` makes them inert (defense in depth)

## Environment allowlist (§28–29)

The child does NOT inherit the gateway's full environment. `buildChildEnv()` constructs a fresh env:

1. **Allowlisted names.** Only variables whose names appear in the registration's `env_allowlist`
   (matching `^[A-Z_][A-Z0-9_]{0,127}$`) are copied from `process.env`.
2. **PATH.** Automatically included if not already allowlisted, so the child can resolve executables.
3. **Extra env (credential injection, §29).** The `extraEnv` option injects key-value pairs not from
   the gateway's own environment — the credential delivery mechanism.

### What is NOT inherited

Everything else: database connection strings, TNA service credentials, operator tokens, internal
configuration. A compromised MCP server that dumps its `process.env` sees only allowlisted variables
and the injected credential.

## Credential isolation (§29)

`credential_ref` on an MCP server registration is an opaque reference. When the gateway spawns the
child, the actual credential value is resolved and injected via `extraEnv`, scoped to this one
process invocation. The credential never appears in persisted registration fields, never persists in
the gateway's environment after the child exits.

## Resource bounds

| Bound | Value |
|---|---|
| `MAX_MCP_SERVERS_PER_TENANT` | 10 |
| `MAX_TOOLS_PER_SERVER` | 200 |
| `MAX_TOOL_SCHEMA_BYTES` | 32,768 bytes |
| `MAX_MCP_RESULT_BYTES` | 131,072 bytes |
| Executable path | 500 chars max |
| Argument | 2,000 chars max each |
| Env name | 128 chars max |
