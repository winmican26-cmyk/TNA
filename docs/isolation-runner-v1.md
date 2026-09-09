# Isolation Runner v1

## Status

The local `ChildProcessIsolationRunner` is **IMPLEMENTED** and **TESTED** as a process boundary. It is not an OS sandbox. Network isolation is **NOT IMPLEMENTED** by this runner.

## Enforced contract

- The registry supplies the executable; callers provide structured `command` and `args`, and the runner calls `spawn(..., { shell: false })`. Shell metacharacters remain argument data. There is no unrestricted shell route or agent-selected handler.
- `env` is an explicit allowlist. Keys must be valid environment names and names suggesting capabilities, credentials, tokens, passwords, private keys, or administration are rejected. The runner adds only fixed execution/tool/temp metadata.
- `workspace` and `cwd` are resolved with `realpath`. Relative `cwd` syntax rejects absolute paths, traversal, ambiguous separators, and control characters. The resolved directory must remain contained by the resolved workspace, so junction/symlink escapes are rejected where the platform exposes them.
- Runtime, stdout, stderr, and aggregate output limits are validated. Output is hashed and only a bounded preview is retained. A limit breach terminates the child.
- A runtime timeout terminates the child. On Windows, `taskkill /PID /T /F` is attempted; on other platforms the detached process group is terminated and force-killed after a short grace period. This is **PARTIALLY ENFORCED** because platform process semantics and hostile-host behavior remain outside the contract.

## Results and limits

The result maps normal exit to `SUCCEEDED`, non-zero exit or spawn error to `FAILED`, and timeout/output termination to `TERMINATED`. Evidence includes exit/signal, bounded output byte counts and SHA-256 digests, limits, runner identity, and network metadata.

`no_network` is metadata only and reports `enforcement: not-enforced`. The runner does not install a firewall, network namespace, kernel policy, proxy, or syscall filter. Therefore it does not claim OS sandboxing, kernel egress isolation, SSRF resistance, or protection from a compromised Gate host. A strict-network option fails closed rather than pretending to enforce it. Production sandboxing is **FUTURE**.
