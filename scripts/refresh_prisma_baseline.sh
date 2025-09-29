#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export REPO_ROOT
BASELINE_NAME="00000000000000_baseline"
BASELINE_PATH="${REPO_ROOT}/backend/prisma/migrations/${BASELINE_NAME}/migration.sql"

if [[ ! -f "${BASELINE_PATH}" ]]; then
  echo "Baseline migration not found at ${BASELINE_PATH}." >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL must be set to a Prisma SQLite connection string before running this script." >&2
  exit 1
fi

DB_PATH="$(python3 - <<'PY'
import os
import sys
from urllib.parse import urlparse, unquote

url = os.environ.get("DATABASE_URL", "")
parsed = urlparse(url)
if parsed.scheme != "file":
    sys.stderr.write("This helper currently supports Prisma SQLite connections (file: URLs) only.\n")
    sys.exit(1)
path = unquote(parsed.path)
if path.startswith("/"):
    resolved = path
else:
    repo_root = os.environ.get("REPO_ROOT") or os.getcwd()
    resolved = os.path.normpath(os.path.join(repo_root, path))
print(resolved)
PY
)"

if [[ -z "${DB_PATH}" ]]; then
  echo "Unable to resolve the SQLite database path from DATABASE_URL=${DATABASE_URL}." >&2
  exit 1
fi

if [[ ! -f "${DB_PATH}" ]]; then
  echo "Database file ${DB_PATH} was not found. Aborting." >&2
  exit 1
fi

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
