#!/bin/sh
# TNA pilot-deployment closure. Same pattern as client-gateway.sh — `apps/tna-improvement-governor`'s
# config.ts only reads TNA_IMPROVEMENT_ADMIN_TOKEN as a literal environment value, no `_FILE` variant.
set -eu
if [ -f "${TNA_IMPROVEMENT_ADMIN_TOKEN_FILE:-/run/secrets/tna_improvement_admin_token}" ]; then
  TNA_IMPROVEMENT_ADMIN_TOKEN=$(cat "${TNA_IMPROVEMENT_ADMIN_TOKEN_FILE:-/run/secrets/tna_improvement_admin_token}")
  export TNA_IMPROVEMENT_ADMIN_TOKEN
fi
exec "$@"
