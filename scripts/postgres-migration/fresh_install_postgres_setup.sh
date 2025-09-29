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
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

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
FRESH_INSTALL_SKIP_SANITY="${FRESH_INSTALL_SKIP_SANITY:-false}"
FRESH_INSTALL_SANITY_PRISMA_PROJECT="${FRESH_INSTALL_SANITY_PRISMA_PROJECT:-${REPO_ROOT}/backend}"
FRESH_INSTALL_SANITY_SSH_TARGET="${FRESH_INSTALL_SANITY_SSH_TARGET:-}"
FRESH_INSTALL_SANITY_SSH_PORT="${FRESH_INSTALL_SANITY_SSH_PORT:-22}"
FRESH_INSTALL_SANITY_SSH_IDENTITY="${FRESH_INSTALL_SANITY_SSH_IDENTITY:-}"
FRESH_INSTALL_SANITY_REQUIRED_EXTENSIONS="${FRESH_INSTALL_SANITY_REQUIRED_EXTENSIONS:-$FRESH_INSTALL_REQUIRED_EXTENSIONS}"
FRESH_INSTALL_SANITY_MIN_POSTGRES_MAJOR="${FRESH_INSTALL_SANITY_MIN_POSTGRES_MAJOR:-14}"
FRESH_INSTALL_SANITY_MIN_PRISMA_MAJOR="${FRESH_INSTALL_SANITY_MIN_PRISMA_MAJOR:-6}"

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

if parse_bool "$FRESH_INSTALL_SKIP_SANITY"; then
  echo "[fresh-install] Skipping Prisma/PostgreSQL sanity validation (FRESH_INSTALL_SKIP_SANITY=true)."
else
  SANITY_SCRIPT="${SCRIPT_DIR}/sanity_check.sh"
  if [[ ! -x "$SANITY_SCRIPT" ]]; then
    echo "[fresh-install] Sanity check helper not found at ${SANITY_SCRIPT}." >&2
    exit 1
  fi
  if [[ -z "$FRESH_INSTALL_SANITY_SSH_TARGET" ]]; then
    echo "[fresh-install] FRESH_INSTALL_SANITY_SSH_TARGET must be set unless FRESH_INSTALL_SKIP_SANITY=true." >&2
    exit 1
  fi
  declare -a SANITY_ARGS=(
    --prisma-project "$FRESH_INSTALL_SANITY_PRISMA_PROJECT"
    --postgres-url "$POSTGRES_URL"
    --ssh-target "$FRESH_INSTALL_SANITY_SSH_TARGET"
    --min-postgres-major "$FRESH_INSTALL_SANITY_MIN_POSTGRES_MAJOR"
    --min-prisma-major "$FRESH_INSTALL_SANITY_MIN_PRISMA_MAJOR"
  )
  if [[ -n "${FRESH_INSTALL_SANITY_REQUIRED_EXTENSIONS// }" ]]; then
    SANITY_ARGS+=("--require-extensions" "$FRESH_INSTALL_SANITY_REQUIRED_EXTENSIONS")
  fi
  if [[ -n "${FRESH_INSTALL_SANITY_SSH_PORT// }" ]]; then
    SANITY_ARGS+=("--ssh-port" "$FRESH_INSTALL_SANITY_SSH_PORT")
  fi
  if [[ -n "$FRESH_INSTALL_SANITY_SSH_IDENTITY" ]]; then
    SANITY_ARGS+=("--ssh-identity" "$FRESH_INSTALL_SANITY_SSH_IDENTITY")
  fi
  echo "[fresh-install] Running Prisma/PostgreSQL compatibility validation."
  "$SANITY_SCRIPT" "${SANITY_ARGS[@]}"
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
