#!/usr/bin/env bash
set -euo pipefail

# Placeholder script for provisioning a new VisionSuit instance directly on PostgreSQL.
# The final implementation will coordinate Prisma migrations and environment configuration
# during a clean installation.

POSTGRES_URL="${POSTGRES_URL:-}"
if [[ -z "${POSTGRES_URL}" ]]; then
  echo "[fresh-install] POSTGRES_URL environment variable is required." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

parse_bool() {
  local value="${1:-}"
  case "${value,,}" in
    ""|"1"|"true"|"yes"|"on")
      return 0
      ;;
    "0"|"false"|"no"|"off")
      return 1
      ;;
    *)
      echo "[fresh-install] Invalid boolean value: ${value}" >&2
      exit 1
      ;;
  esac
}

FRESH_INSTALL_REQUIRED_EXTENSIONS="${FRESH_INSTALL_REQUIRED_EXTENSIONS:-pg_trgm,uuid-ossp}"
FRESH_INSTALL_CREATE_DB="${FRESH_INSTALL_CREATE_DB:-true}"
FRESH_INSTALL_REQUIRE_TLS="${FRESH_INSTALL_REQUIRE_TLS:-true}"

declare -a PREPARE_ARGS

if parse_bool "$FRESH_INSTALL_CREATE_DB"; then
  PREPARE_ARGS+=("--create-db")
fi

if [[ -n "${FRESH_INSTALL_REQUIRED_EXTENSIONS// }" ]]; then
  PREPARE_ARGS+=("--extensions" "$FRESH_INSTALL_REQUIRED_EXTENSIONS")
fi

if parse_bool "$FRESH_INSTALL_REQUIRE_TLS"; then
  PREPARE_ARGS+=("--require-tls")
fi

echo "[fresh-install] Preparing PostgreSQL target before Prisma deploy."
"${SCRIPT_DIR}/prepare_postgres_target.sh" "${PREPARE_ARGS[@]}" "$POSTGRES_URL"

cat <<'PLAN'
[fresh-install] Next steps after preparing the database target:
  1. Generate Prisma client artifacts configured for PostgreSQL.
     - npm --prefix backend run prisma:generate
  2. Apply prisma migrate deploy against the PostgreSQL connection string.
     - DATABASE_URL="$POSTGRES_URL" npm --prefix backend run prisma:migrate-deploy
  3. Update backend/.env and frontend overrides so DATABASE_URL and SHADOW_DATABASE_URL point at PostgreSQL.
  4. Run smoke tests (maintenance.sh health, API heartbeat, basic create/read flows) before enabling public access.
PLAN
