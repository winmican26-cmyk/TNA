# Egress Guard v1

## Status

`EgressGuard` is **IMPLEMENTED** and **TESTED** as an application-level request preflight. It is **PARTIALLY ENFORCED**: it controls callers that use `guard.request`, not arbitrary sockets or a hostile process.

## Controls

The guard accepts only HTTP(S), rejects URL userinfo, canonicalizes host casing/trailing dots, checks approved ports, applies deny-before-allow host policy, and blocks localhost, private/reserved IPv4 and IPv6 ranges, IPv4-mapped private addresses, and metadata/link-local ranges. DNS names are resolved with all answers before each request; empty or failed resolution is blocked. Redirects are manual, bounded, resolved relative to the prior URL, and independently re-evaluated. Cross-origin redirects retain only a small forwarding set and strip authorization, cookies, proxy credentials, and policy-declared credential headers.

`mode: none` blocks without DNS or fetch. The Vol 3 local demo uses this mode and makes no external request. These controls are **TESTED** with malformed URLs, private/mapped addresses, denied hosts, DNS failures, redirects, and credential stripping.

## Limitations

DNS validation is a preflight check. DNS can change between lookup and connection, so DNS TOCTOU remains. The guard does not provide kernel-level egress isolation, prevent a child from bypassing it with its own socket, prove the peer identity, or make an allowlisted hostname SSRF-proof. TLS, proxy deployment, socket interception, and a kernel/network namespace policy are **FUTURE**. An isolated child currently reports network enforcement as `not-enforced`.
