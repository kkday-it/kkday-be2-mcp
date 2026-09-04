#!/usr/bin/env bash
#
# Runs a probe script against a non-default environment, using credentials that
# already live in the gitignored .env. Never echoes a credential value.
#
#   ./scripts/env-for.sh stage npm run probe-sit-bm -- 26KK... BCS
#   ./scripts/env-for.sh prod  npm run probe-sit-bm -- 26KK... BCS
#
# Default (no wrapper) = whatever AUTHSVC_URL / GATEWAY_URL / API_AUTH_SERVICE_KEY
# .env already points at, i.e. SIT be2-220.
#
# ⚠️  `prod` runs against PRODUCTION. The blueMountain ticket endpoints are reads,
#     but they are NOT side-effect free: UserFilter auto-creates a `task_user` row
#     for the calling identity on first call (see docs/be2-mcp/sit-bluemountain-contract.md §6).
#
# .env key names are asymmetric for historical reasons (STAGE_AUTHSVC_SERVICE_KEY vs
# PRODUCTION_AUTHSVC_SERVICE_KEY); the mapping lives here so callers never repeat it.
set -euo pipefail
cd "$(dirname "$0")/.."

[ $# -ge 2 ] || { echo "usage: $0 <stage|prod> <command...>" >&2; exit 2; }
ENV_NAME="$1"; shift

# Read one key out of .env without printing its value; fall back to $2 if the key
# is absent. URLs (non-secret) carry a default here; creds have no default and are
# validated below. `.env` is NOT sourced, so every override must flow through get().
get() {
  local v; v="$(grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//')"
  printf '%s' "${v:-${2:-}}"
}

case "$ENV_NAME" in
  stage)
    export AUTHSVC_URL="$(get STAGE_AUTHSVC_URL https://auth.stage.kkday.com)"
    export GATEWAY_URL="$(get STAGE_GATEWAY_URL https://api-gateway.stage.kkday.com)"
    export API_AUTH_SERVICE_KEY="$(get STAGE_AUTHSVC_SERVICE_KEY)"
    export AUTH_email="$(get STAGE_email)"
    export AUTH_pwd="$(get STAGE_pwd)"
    export APP_ENV=stage
    ;;
  prod)
    export AUTHSVC_URL="$(get PROD_AUTHSVC_URL https://auth.kkday.com)"
    export GATEWAY_URL="$(get PROD_GATEWAY_URL https://api-gateway.kkday.com)"
    export API_AUTH_SERVICE_KEY="$(get PRODUCTION_AUTHSVC_SERVICE_KEY)"
    export AUTH_email="$(get PROD_email)"
    export AUTH_pwd="$(get PROD_pwd)"
    export APP_ENV=prod
    echo "⚠️  PRODUCTION — reads only, but blueMountain auto-creates a task_user row on first call." >&2
    ;;
  *)
    echo "unknown environment '$ENV_NAME' (expected: stage | prod)" >&2; exit 2 ;;
esac

for v in API_AUTH_SERVICE_KEY AUTH_email AUTH_pwd; do
  [ -n "${!v}" ] || { echo "missing $ENV_NAME credential for $v — check .env" >&2; exit 1; }
done

echo "-> [$ENV_NAME] AUTHSVC_URL=$AUTHSVC_URL  GATEWAY_URL=$GATEWAY_URL" >&2
exec "$@"
