#!/bin/sh
# TNA pilot-deployment closure. Same pattern as client-gateway.sh/improvement-governor.sh —
# `apps/tna-control-center/src/config.ts` reads `TNA_CONTROL_CENTER_CLIENT_GATEWAY_ADMIN_TOKEN` as a
# literal environment value only (no `_FILE` variant). If a secret file is mounted, its contents become
# that env var; otherwise this is a no-op and behavior is unchanged from before this wrapper existed.
set -eu
if [ -f "${TNA_CONTROL_CENTER_CLIENT_GATEWAY_ADMIN_TOKEN_FILE:-/run/secrets/tna_client_gateway_admin_token}" ]; then
  TNA_CONTROL_CENTER_CLIENT_GATEWAY_ADMIN_TOKEN=$(cat "${TNA_CONTROL_CENTER_CLIENT_GATEWAY_ADMIN_TOKEN_FILE:-/run/secrets/tna_client_gateway_admin_token}")
  export TNA_CONTROL_CENTER_CLIENT_GATEWAY_ADMIN_TOKEN
fi
exec "$@"
