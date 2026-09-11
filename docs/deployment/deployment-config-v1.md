# DeploymentConfig v1

Defined and validated by `packages/deployment-schema/src/index.ts`. TNA-55: configuration is executable
authority — it decides what network surface is exposed and which credentials are accepted, so it is
validated with the same rigor as any other security-relevant input.

## Shape

```ts
interface DeploymentConfig {
  version: '1';
  environment: 'development' | 'test' | 'production';
  tenant_id: string;
  network: { host: string; port: number; trust_proxy: boolean; cors_allow_origin: string | null };
  storage: { data_dir: string };
  secrets: {
    operator_token_ref: SecretRef; admin_token_ref: SecretRef; service_token_ref: SecretRef;
    capability_key_ref: SecretRef | null; // null only outside production
  };
  limits: { request_timeout_ms: number; headers_timeout_ms: number; max_body_bytes: number };
}
type SecretRef = { source: 'env' | 'file'; ref: string };
```

## Loading

`loadDeploymentConfigFromEnv(env)` builds the raw shape above from `TNA_*` environment variables (the
primary, container-idiomatic path — see `deployment-secrets-v0.1.md` for the exact variable names) and
passes it through `parseDeploymentConfig()`, the single strict structural validator. A JSON config object
built any other way (a config file, a test fixture) is validated by the exact same function — there is
only one validation code path.

## Strict validation (section 15)

`parseDeploymentConfig` throws `DeploymentConfigError` — never falls back to a default — on:

- any field not in the fixed allowed-key list at any nesting level (`UNKNOWN_FIELD`)
- `environment` outside `development|test|production`
- an invalid `host` (fails a hostname/IP pattern) or `port` (not an integer 1-65535)
- a non-boolean `trust_proxy`
- a `cors_allow_origin` that is not `null`, `"*"`, or a parseable URL
- an empty `tenant_id`, or one failing `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`
- an empty `storage.data_dir`
- a missing/malformed secret reference for any of the three mandatory tokens
- a `limits.*` value outside `[1, 600_000]` ms (timeouts) or `[1, 100MiB]` (body bytes) — this includes
  negative values (section 15's explicit "negative resource limit" example)

Then a **production-only** pass (`assertProductionSafe`) additionally rejects:

- `secrets.capability_key_ref === null` (section 17: no random in-memory key in production)
- `network.cors_allow_origin === '*'` (section 96)
- `network.host === '0.0.0.0'` with `trust_proxy === false` (implies a directly internet-facing bind
  with no trusted reverse proxy in front of it — section 26)

## Secret value checks (separate pass — requires I/O)

`resolveDeploymentSecrets(config, env)` reads every secret reference and, in production only, rejects
(`WEAK_SECRET`):

- any value on the known-weak list (`changeme`, `admin`, `secret`, `password`, `test-secret`, `default`,
  `insecure`, `placeholder`, `12345678`, `letmein`, ...) case-insensitively
- any value under 32 characters
- any value with two or fewer distinct characters (e.g. `aaaa...`)
- duplicate values across operator/admin/service tokens

## Config hash (section 74)

`computeConfigHash(config)` hashes the config's shape **excluding secret values, including secret
reference identifiers** (`env:TNA_ADMIN_TOKEN`, not the token itself) — changing which secret is
referenced, or any non-secret field, changes the hash; changing only the value a reference resolves to
does not (by design — the config didn't change, only the world it points at did). Exposed via
`GET /diagnostics` and in the backup manifest (`config_hash`), never as a raw config dump.

## Redaction

`redact(value)` (also in this package) deep-clones an arbitrary object, replacing any field whose name
matches a secret-shaped pattern (`secret|token|password|api_key|private_key|authorization|credential|
signing_key`, case-insensitive) or any string value matching `Bearer \S+` with `[REDACTED]`. Used by
`apps/tna-platform/src/logging.ts` on every structured log line and by the `/diagnostics` route.

See `deployment-config.test.ts` (21 tests) for the full validation matrix, and
`deployment-abuse-cases.test.ts` for the unknown-field-smuggling and default-secret abuse attempts.
