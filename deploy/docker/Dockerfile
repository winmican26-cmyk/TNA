# TNA Deployment Engineering v0.1 (Volume 9). Multi-stage build (section 8): the builder stage has the
# full TypeScript toolchain; the runtime stage carries only compiled output, production dependencies,
# and a non-root user. Build from the repository root:
#   docker build -f deploy/docker/Dockerfile -t tna-platform:0.1.0 .
# syntax=docker/dockerfile:1

FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
# Deterministic, lockfile-pinned install (section 113) — never an unbounded `npm install`.
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The official Node image already ships a non-root `node` user (uid/gid 1000) — reused rather than
# reinvented (section 9).
RUN mkdir -p /data && chown -R node:node /app /data
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist/apps ./dist/apps
COPY --from=builder --chown=node:node /app/dist/packages ./dist/packages
COPY --from=builder --chown=node:node /app/package.json ./package.json
USER node
ENV TNA_DATA_DIR=/data
EXPOSE 4618
# No shell form, no package-manager entrypoint wrapper — a single direct exec so SIGTERM reaches main.js
# as PID 1 (section 53), not an intermediate shell.
ENTRYPOINT ["node", "dist/apps/tna-platform/src/main.js"]
