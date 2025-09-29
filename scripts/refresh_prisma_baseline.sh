#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export REPO_ROOT
BASELINE_NAME="00000000000000_baseline"
BASELINE_PATH="${REPO_ROOT}/backend/prisma/migrations/${BASELINE_NAME}/migration.sql"

DEFAULT_DB_DIR="${REPO_ROOT}/backend/prisma"

if [[ ! -f "${BASELINE_PATH}" ]]; then
  echo "Baseline migration not found at ${BASELINE_PATH}." >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL not provided. Attempting to locate the SQLite database under ${DEFAULT_DB_DIR}."
fi

resolve_db_path() {
  local url="$1"
  if [[ -z "${url}" ]]; then
    return 1
  fi
  python3 - "$url" <<'PY'
import os
import sys
from urllib.parse import urlparse, unquote

url = sys.argv[1]
parsed = urlparse(url)
if parsed.scheme != "file":
    sys.stderr.write("This helper currently supports Prisma SQLite connections (file: URLs) only.\n")
    sys.exit(2)
path = unquote(parsed.path)
if path.startswith("/"):
    resolved = path
else:
    repo_root = os.environ.get("REPO_ROOT") or os.getcwd()
    resolved = os.path.normpath(os.path.join(repo_root, path))
print(os.path.abspath(resolved))
PY
}

DB_PATH=""
if [[ -n "${DATABASE_URL:-}" ]]; then
  if ! DB_PATH="$(resolve_db_path "${DATABASE_URL}")"; then
    echo "Failed to resolve database path from DATABASE_URL=${DATABASE_URL}." >&2
    exit 1
  fi
fi

if [[ -z "${DB_PATH}" || ! -f "${DB_PATH}" ]]; then
  mapfile -t DB_CANDIDATES < <(find "${DEFAULT_DB_DIR}" -maxdepth 1 -type f -name '*.db' 2>/dev/null | sort)
  if (( ${#DB_CANDIDATES[@]} == 0 )); then
    echo "No SQLite database found under ${DEFAULT_DB_DIR}. Provide DATABASE_URL or create the database before running this script." >&2
    exit 1
  fi
  for candidate in "${DB_CANDIDATES[@]}"; do
    if [[ "$(basename "${candidate}")" == "dev.db" ]]; then
      DB_PATH="${candidate}"
      break
    fi
  done
  if [[ -z "${DB_PATH}" ]]; then
    DB_PATH="${DB_CANDIDATES[0]}"
  fi
  echo "Resolved SQLite database to ${DB_PATH}."
fi

DB_PATH="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${DB_PATH}")"

if [[ ! -f "${DB_PATH}" ]]; then
  echo "Database file ${DB_PATH} was not found. Aborting." >&2
  exit 1
fi

RESOLVED_DATABASE_URL="file:${DB_PATH}"
export DATABASE_URL="${RESOLVED_DATABASE_URL}"
echo "Using DATABASE_URL=${DATABASE_URL}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required to adjust the Prisma migration history." >&2
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_PATH="${DB_PATH}.${TIMESTAMP}.backup"
cp "${DB_PATH}" "${BACKUP_PATH}"
echo "Created SQLite backup at ${BACKUP_PATH}."

echo "Current Prisma migration history:"
sqlite3 "${DB_PATH}" "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at;" || true

echo "Resetting Prisma migration records ..."
sqlite3 "${DB_PATH}" <<'SQL'
BEGIN;
DELETE FROM "_prisma_migrations";
COMMIT;
SQL

(
  cd "${REPO_ROOT}/backend"
  npx --yes prisma migrate resolve --applied "${BASELINE_NAME}" --schema prisma/schema.prisma >/dev/null
)

echo "Updated Prisma migration history:"
sqlite3 "${DB_PATH}" "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at;"

echo "Baseline consolidation complete. The original database remains available at ${BACKUP_PATH}."
