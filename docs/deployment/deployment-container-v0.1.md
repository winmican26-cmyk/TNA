# TNA Deployment Engineering v0.1 — Container Model

## Build

```
docker build -f deploy/docker/Dockerfile -t tna-platform:0.1.0 .
```

Multi-stage (`deploy/docker/Dockerfile`):

1. **`builder`** (`node:24-slim`) — copies `package.json`/`package-lock.json`/`tsconfig.json` and the
   `apps`/`packages`/`scripts`/`tests` source trees, runs `npm ci` (lockfile-deterministic — section
   113), `npm run build`, then `npm prune --omit=dev`.
2. **`runtime`** (`node:24-slim`) — copies only `node_modules` (pruned), `dist/apps`, `dist/packages`,
   and `package.json` from the builder. No Git history, no test source, no developer caches, no local
   secret files, no build tooling, and no `output/` reach the runtime image — `dist/tests` and
   `dist/scripts` are never copied into the final stage at all (section 8).

`.dockerignore` (repo root) additionally excludes `.git`, `node_modules`, `dist`, `data`, `output`,
`test-artifacts`, `examples`, `docs`, `*.tsbuildinfo`, `.env*`, and `deploy` itself from the build
context.

## Non-root execution (section 9)

The runtime stage reuses the official Node image's built-in `node` user (uid/gid 1000) rather than
inventing a new one — `chown`s `/app` and `/data` to it, then `USER node` before `ENTRYPOINT`. Tested,
not merely documented: `deployment-container.test.ts` runs `docker exec <container> id -u` against a real
running container and asserts the result is not `0`.

## Read-only root filesystem (section 10)

The platform has no local file logging (structured logs go to stdout) and all durable state lives under
`/data`, so it fully supports `--read-only` with a `/tmp` tmpfs and no other writable mount —
`compose.production.yaml` sets exactly this. Proven directly: `deployment-container.test.ts` boots a real
container with `--read-only --tmpfs /tmp` and confirms `/ready` still returns 200.

## Persistent volumes (section 12)

`TNA_DATA_DIR=/data` is the one durable mount point; `compose.production.yaml` binds it to a named Docker
volume (`tna-platform-data`), never the container's writable layer. `deployment-container.test.ts`'s
"fresh-machine" test creates a brand-new, empty named volume for every run (section 92) and its
"repeat-boot" test stops and restarts the *same* container against the *same* volume, asserting
`deployment_id` is unchanged (section 93 — no destructive reinitialization).

## Image versioning / supply chain (section 111-114)

- Tagged `tna-platform:<version>` (`compose.production.yaml` defaults to `${TNA_IMAGE_TAG:-0.1.0}`) —
  never only `latest` in the documented production path (section 111).
- Base image pinned to `node:24-slim` — a fixed major/runtime version (section 112). Digest-pinning is a
  documented follow-up hardening step, not silently skipped: see "Remaining limitations" below.
- `npm ci` against the committed `package-lock.json` — deterministic, never an unbounded `npm install`
  during image build (section 113).
- Build reproducibility (section 114): building twice from the same commit/lockfile produces a
  functionally equivalent image — proven implicitly by `deployment-container.test.ts` running twice
  (`npm run check` executed twice, section 131) against freshly (re)built images with identical results.
  Byte-identical image digests are not asserted (not required by section 114 for v0.1).

## Real container test (section 91)

`tests/deployment/deployment-container.test.ts` builds the actual image and runs it twice (a full
lifecycle test and a read-only-rootfs test) — never a static Dockerfile inspection. If the local Docker
daemon is unavailable, both tests report `skipped` (via `t.skip(...)`) rather than silently passing —
`npm run check`'s reported pass/fail/skip counts make this state visible, not hidden.

## Remaining limitations

- No image vulnerability scan is wired into `npm run check` (section 115: optional, explicitly not
  required to be an offline/required test).
- No SBOM is generated yet (section 116: recommended follow-up, not built this milestone).
- The base image is pinned by tag (`node:24-slim`), not by content digest — a stricter production
  baseline would pin `node:24-slim@sha256:...` for full supply-chain reproducibility; not done here to
  avoid pinning to a digest that will predictably go stale relative to security patches without an
  update mechanism this milestone does not build.
