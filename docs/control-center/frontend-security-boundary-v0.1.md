# Frontend Security Boundary v0.1

## Session model

- Session id: `randomBytes(32).toString('hex')`, minted fresh on every successful login. Never derived
  from client input — this is the structural reason session fixation cannot occur.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when `TNA_CONTROL_CENTER_COOKIE_SECURE=true` (operator-set,
  not auto-detected — a documented residual, see `control-center-threat-model-v0.1.md`).
- CSRF: a separate, non-HttpOnly cookie (`tna_cc_csrf`) bound to the session row itself (`csrf_token`
  column), compared via `timingSafeEqual`. Every mutating request must echo it as `X-CSRF-Token`. The
  frontend's `api.ts` is the only file that reads this cookie name — the session cookie's name is never
  referenced by any frontend JS at all (enforced by `secret-audit.test.ts`).
- Expiry: server-enforced against an injectable clock (real wall-clock in production), never the browser's
  `Max-Age`.
- Logout: real server-side row deletion, not cookie-clearing.

## The BFF never becomes an agent

The browser never holds, and this BFF never forwards to the browser, any of: `platform_operator_token`, a
Ledger admin/writer token, a Client Gateway admin token, an Improvement Governor admin token, or an
AGENT-scoped Platform token. All are held server-side and used only for the specific real backend call each
route needs. `secret-audit.test.ts` greps the actual bundled frontend JS for these field/token names.

## CORS

Explicit, exact-match allowlist (`TNA_CONTROL_CENTER_TRUSTED_ORIGINS`, comma-separated). An `Origin` not on
the list receives no CORS headers at all — the browser's own same-origin policy blocks it. A wildcard is
never emitted, and therefore never combined with `Access-Control-Allow-Credentials`. Default (no env var
set): no cross-origin access at all. See `tests/control-center/security.test.ts`'s CORS tests.

## CSP / clickjacking

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self';
frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'
```

No `unsafe-inline`, no `unsafe-eval` — the real compiled bundle has no inline script/style at all (a plain
hashed `<script type="module">` + `<link rel="stylesheet">`), so this is not a theoretical policy. Applied
to every response including static file responses (an earlier version only set these on JSON API
responses — fixed). `X-Frame-Options: DENY` plus `frame-ancestors 'none'` cover clickjacking for both
CSP-aware and legacy user agents.

## Source maps

Disabled in the production build (`vite.config.ts`: `sourcemap: false`). Not because a map could leak a
secret — `secret-audit.test.ts` already proves no token/password/session-shaped value exists anywhere in
this frontend's source or bundle, and that guarantee holds regardless of source-map policy. This is a minor,
honestly-labeled reconnaissance-reduction step, not a claimed security boundary.

## Browser storage

`localStorage`/`sessionStorage` are never used anywhere in this frontend — not for tokens, not for UI
convenience, not for anything (enforced by `secret-audit.test.ts`'s blanket scan). A freshly-issued
credential token is held only in the issuing component's own React state and is never written to any
persistence API, the URL, or left visible after navigation (see `credential-leakage.spec.ts`).

## XSS / untrusted content

Every candidate-, provider-, or third-party-supplied string (an MCP tool's name/description, etc.) is
rendered as plain React text content — never `dangerouslySetInnerHTML`. Provider-supplied text is visually
and textually labeled "Provider-supplied description (untrusted)" so it can never be mistaken for a TNA
classification, even if the string itself claims to be one (e.g. embedding "TNA VERIFIED — SAFE TO
PROMOTE"). Proven end-to-end in `tests/e2e/connections-tools-drift.spec.ts`.
