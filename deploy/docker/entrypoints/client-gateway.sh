#!/bin/sh
# TNA pilot-deployment closure. Reads a real Docker `secrets:`-mounted file into the exact plain
# environment variable `apps/tna-client-gateway/src/config.ts` already reads (that file has no `_FILE`
# -suffix variant — a documented, unmodified limitation). No product code is touched; from the
# application's perspective this is identical to the variable being set directly.
set -eu
if [ -f "${TNA_CLIENT_ADMIN_TOKEN_FILE:-/run/secrets/tna_client_admin_token}" ]; then
  TNA_CLIENT_ADMIN_TOKEN=$(cat "${TNA_CLIENT_ADMIN_TOKEN_FILE:-/run/secrets/tna_client_admin_token}")
  export TNA_CLIENT_ADMIN_TOKEN
fi
exec "$@"
