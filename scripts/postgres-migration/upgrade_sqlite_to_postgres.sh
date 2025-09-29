#!/usr/bin/env bash
set -euo pipefail

# Automate the migration from SQLite to PostgreSQL for existing VisionSuit deployments.
# The workflow stops application services, backs up the SQLite database, imports data
# with pgloader, executes Prisma migrations, verifies table row counts, and then
# restarts the stack. Each phase is controlled through environment variables so
# operators can dry-run or reuse individual helpers when rehearsing cutovers.

POSTGRES_URL="${POSTGRES_URL:-}"
SQLITE_PATH="${SQLITE_PATH:-backend/prisma/dev.db}"

log() {
  printf '[upgrade] %s\n' "$1"
}

abort() {
  printf '[upgrade] %s\n' "$1" >&2
  exit 1
}

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
      abort "Invalid boolean value: ${value}"
      ;;
  esac
}

require_command() {
  local binary="$1"
  if ! command -v "$binary" >/dev/null 2>&1; then
    abort "Required command not found in PATH: ${binary}"
  fi
}

if [[ -z "${POSTGRES_URL}" ]]; then
  abort "POSTGRES_URL environment variable is required."
fi

if [[ ! -f "${SQLITE_PATH}" ]]; then
  abort "SQLite database not found at ${SQLITE_PATH}."
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

UPGRADE_SKIP_TARGET_PREPARE="${UPGRADE_SKIP_TARGET_PREPARE:-false}"
UPGRADE_REQUIRED_EXTENSIONS="${UPGRADE_REQUIRED_EXTENSIONS:-pg_trgm,uuid-ossp}"
UPGRADE_REQUIRE_TLS="${UPGRADE_REQUIRE_TLS:-true}"
UPGRADE_CREATE_DB="${UPGRADE_CREATE_DB:-false}"
UPGRADE_DRY_RUN="${UPGRADE_DRY_RUN:-false}"
UPGRADE_BACKUP_DIR="${UPGRADE_BACKUP_DIR:-${REPO_ROOT}/backups/postgres-migration}"
UPGRADE_CREATE_SQLITE_DUMP="${UPGRADE_CREATE_SQLITE_DUMP:-true}"
UPGRADE_STOP_SERVICES="${UPGRADE_STOP_SERVICES:-true}"
UPGRADE_RESUME_SERVICES="${UPGRADE_RESUME_SERVICES:-true}"
UPGRADE_PRISMA_PROJECT_DIR="${UPGRADE_PRISMA_PROJECT_DIR:-${REPO_ROOT}/backend}"
UPGRADE_PRISMA_SCHEMA_PATH="${UPGRADE_PRISMA_SCHEMA_PATH:-}"
UPGRADE_PRISMA_MIGRATE_DEPLOY="${UPGRADE_PRISMA_MIGRATE_DEPLOY:-true}"
UPGRADE_PRISMA_GENERATE="${UPGRADE_PRISMA_GENERATE:-true}"
UPGRADE_PRISMA_MIGRATE_STATUS="${UPGRADE_PRISMA_MIGRATE_STATUS:-true}"
UPGRADE_VERIFY_ROW_COUNTS="${UPGRADE_VERIFY_ROW_COUNTS:-true}"
UPGRADE_PGLOADER_BIN="${UPGRADE_PGLOADER_BIN:-pgloader}"
UPGRADE_PGLOADER_EXTRA_ARGS="${UPGRADE_PGLOADER_EXTRA_ARGS:-}"
UPGRADE_HEALTHCHECK_CMD="${UPGRADE_HEALTHCHECK_CMD:-}"
UPGRADE_SKIP_SANITY="${UPGRADE_SKIP_SANITY:-false}"
UPGRADE_AUTOMATION_ONLY="${UPGRADE_AUTOMATION_ONLY:-false}"
UPGRADE_SANITY_PRISMA_PROJECT="${UPGRADE_SANITY_PRISMA_PROJECT:-${UPGRADE_PRISMA_PROJECT_DIR}}"
UPGRADE_SANITY_SSH_TARGET="${UPGRADE_SANITY_SSH_TARGET:-}"
UPGRADE_SANITY_SSH_PORT="${UPGRADE_SANITY_SSH_PORT:-22}"
UPGRADE_SANITY_SSH_IDENTITY="${UPGRADE_SANITY_SSH_IDENTITY:-}"
UPGRADE_SANITY_REQUIRED_EXTENSIONS="${UPGRADE_SANITY_REQUIRED_EXTENSIONS:-$UPGRADE_REQUIRED_EXTENSIONS}"
UPGRADE_SANITY_MIN_POSTGRES_MAJOR="${UPGRADE_SANITY_MIN_POSTGRES_MAJOR:-14}"
UPGRADE_SANITY_MIN_PRISMA_MAJOR="${UPGRADE_SANITY_MIN_PRISMA_MAJOR:-6}"
UPGRADE_AUTOMATION_DIR="${UPGRADE_AUTOMATION_DIR:-${REPO_ROOT}/scripts/postgres-migration/generated}"
UPGRADE_REMOTE_UNIX_USER="${UPGRADE_REMOTE_UNIX_USER:-visionsuit-migrator}"
UPGRADE_REMOTE_SUDO_ACCESS="${UPGRADE_REMOTE_SUDO_ACCESS:-true}"
UPGRADE_REMOTE_PG_ROLE="${UPGRADE_REMOTE_PG_ROLE:-visionsuit_migrate}"
UPGRADE_REMOTE_PG_CREATEDB="${UPGRADE_REMOTE_PG_CREATEDB:-true}"
UPGRADE_REMOTE_PG_DATABASE="${UPGRADE_REMOTE_PG_DATABASE:-visionsuit}"
UPGRADE_REMOTE_SSH_KEY_NAME="${UPGRADE_REMOTE_SSH_KEY_NAME:-visionsuit_migration}"
UPGRADE_REMOTE_CONFIG_FILENAME="${UPGRADE_REMOTE_CONFIG_FILENAME:-visionsuit_migration_config.env}"

ensure_automation_assets() {
  local automation_dir="$UPGRADE_AUTOMATION_DIR"
  mkdir -p "$automation_dir"

  local key_path="${automation_dir}/${UPGRADE_REMOTE_SSH_KEY_NAME}"
  local pub_path="${key_path}.pub"
  if [[ ! -f "$key_path" || ! -f "$pub_path" ]]; then
    log "Generating dedicated SSH key pair for remote automation in ${automation_dir}."
    ssh-keygen -t ed25519 -N '' -f "$key_path" >/dev/null
  fi

  local public_key
  public_key=$(<"$pub_path")

  local sudo_flag="false"
  if parse_bool "$UPGRADE_REMOTE_SUDO_ACCESS"; then
    sudo_flag="true"
  fi

  local createdb_flag="false"
  if parse_bool "$UPGRADE_REMOTE_PG_CREATEDB"; then
    createdb_flag="true"
  fi

  local config_path="${automation_dir}/${UPGRADE_REMOTE_CONFIG_FILENAME}"
  {
    printf '# VisionSuit migration automation config generated %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    printf 'UNIX_USER=%q\n' "$UPGRADE_REMOTE_UNIX_USER"
    printf 'SUDO_ACCESS=%q\n' "$sudo_flag"
    printf 'PG_ROLE=%q\n' "$UPGRADE_REMOTE_PG_ROLE"
    printf 'PG_CREATEDB=%q\n' "$createdb_flag"
    printf 'PG_DATABASE=%q\n' "$UPGRADE_REMOTE_PG_DATABASE"
    printf 'SSH_PUBKEY=%q\n' "$public_key"
  } >"$config_path"

  chmod 600 "$config_path"

  log "Prepared remote automation assets:"
  log "  - SSH private key: ${key_path}"
  log "  - SSH public key: ${pub_path}"
  log "  - Remote config: ${config_path}"
  log "Copy these files alongside remote_prepare_helper.sh before executing it on the PostgreSQL host."

  if [[ -z "${UPGRADE_SANITY_SSH_IDENTITY// }" ]]; then
    UPGRADE_SANITY_SSH_IDENTITY="$key_path"
  fi

  export VISIONSUIT_AUTOMATION_CONFIG="$config_path"
  export VISIONSUIT_AUTOMATION_PUBLIC_KEY="$pub_path"
  export VISIONSUIT_AUTOMATION_PRIVATE_KEY="$key_path"
}

set_bool() {
  local var_name="$1"
  local raw_value="$2"
  if parse_bool "$raw_value"; then
    printf -v "$var_name" '%s' true
  else
    printf -v "$var_name" '%s' false
  fi
}

set_bool SKIP_TARGET_PREPARE "$UPGRADE_SKIP_TARGET_PREPARE"
set_bool REQUIRE_TLS "$UPGRADE_REQUIRE_TLS"
set_bool CREATE_DB "$UPGRADE_CREATE_DB"
set_bool DRY_RUN "$UPGRADE_DRY_RUN"
set_bool CREATE_SQLITE_DUMP "$UPGRADE_CREATE_SQLITE_DUMP"
set_bool STOP_SERVICES "$UPGRADE_STOP_SERVICES"
set_bool RESUME_SERVICES "$UPGRADE_RESUME_SERVICES"
set_bool PRISMA_MIGRATE_DEPLOY "$UPGRADE_PRISMA_MIGRATE_DEPLOY"
set_bool PRISMA_GENERATE "$UPGRADE_PRISMA_GENERATE"
set_bool PRISMA_MIGRATE_STATUS "$UPGRADE_PRISMA_MIGRATE_STATUS"
set_bool VERIFY_ROW_COUNTS "$UPGRADE_VERIFY_ROW_COUNTS"
set_bool SKIP_SANITY "$UPGRADE_SKIP_SANITY"
set_bool AUTOMATION_ONLY "$UPGRADE_AUTOMATION_ONLY"

require_command sqlite3
require_command psql
require_command ssh-keygen
if ! $DRY_RUN; then
  require_command "$UPGRADE_PGLOADER_BIN"
fi

ensure_automation_assets

if $AUTOMATION_ONLY; then
  log "UPGRADE_AUTOMATION_ONLY=true – automation assets are ready; exiting without running the migration sequence."
  exit 0
fi

if ! $SKIP_SANITY; then
  SANITY_SCRIPT="${SCRIPT_DIR}/sanity_check.sh"
  if [[ ! -x "$SANITY_SCRIPT" ]]; then
    abort "Sanity check helper not found at ${SANITY_SCRIPT}."
  fi
  if [[ -z "$UPGRADE_SANITY_SSH_TARGET" ]]; then
    abort "UPGRADE_SANITY_SSH_TARGET must be set unless UPGRADE_SKIP_SANITY=true."
  fi
  declare -a SANITY_ARGS=(
    --prisma-project "$UPGRADE_SANITY_PRISMA_PROJECT"
    --postgres-url "$POSTGRES_URL"
    --ssh-target "$UPGRADE_SANITY_SSH_TARGET"
    --min-postgres-major "$UPGRADE_SANITY_MIN_POSTGRES_MAJOR"
    --min-prisma-major "$UPGRADE_SANITY_MIN_PRISMA_MAJOR"
  )
  if [[ -n "${UPGRADE_SANITY_REQUIRED_EXTENSIONS// }" ]]; then
    SANITY_ARGS+=("--require-extensions" "$UPGRADE_SANITY_REQUIRED_EXTENSIONS")
  fi
  if [[ -n "${UPGRADE_SANITY_SSH_PORT// }" ]]; then
    SANITY_ARGS+=("--ssh-port" "$UPGRADE_SANITY_SSH_PORT")
  fi
  if [[ -n "$UPGRADE_SANITY_SSH_IDENTITY" ]]; then
    SANITY_ARGS+=("--ssh-identity" "$UPGRADE_SANITY_SSH_IDENTITY")
  fi
  log "Running Prisma/PostgreSQL compatibility validation."
  if ! "$SANITY_SCRIPT" "${SANITY_ARGS[@]}"; then
    abort "Compatibility validation failed."
  fi
else
  log "Skipping Prisma/PostgreSQL compatibility validation (UPGRADE_SKIP_SANITY=true)."
fi

MAINTENANCE_ENGAGED=false
MAINTENANCE_SCRIPT="${UPGRADE_MAINTENANCE_SCRIPT:-${REPO_ROOT}/maintenance.sh}"

cleanup_actions() {
  local status="$1"
  if $MAINTENANCE_ENGAGED && $RESUME_SERVICES; then
    log "Attempting to restart services via ${MAINTENANCE_SCRIPT}."
    if [[ -x "$MAINTENANCE_SCRIPT" ]]; then
      if ! "$MAINTENANCE_SCRIPT" start; then
        printf '[upgrade] Failed to restart services; manual intervention required.\n' >&2
      else
        log "Services restarted."
      fi
    else
      printf '[upgrade] Maintenance script %s is not executable; skipped automatic restart.\n' "$MAINTENANCE_SCRIPT" >&2
    fi
  fi
  exit "$status"
}

trap 'cleanup_actions $?' EXIT

if ! $SKIP_TARGET_PREPARE; then
  declare -a PREPARE_ARGS
  if $CREATE_DB; then
    PREPARE_ARGS+=("--create-db")
  fi
  if [[ -n "${UPGRADE_REQUIRED_EXTENSIONS// }" ]]; then
    PREPARE_ARGS+=("--extensions" "$UPGRADE_REQUIRED_EXTENSIONS")
  fi
  if $REQUIRE_TLS; then
    PREPARE_ARGS+=("--require-tls")
  fi
  log "Running target validation before migration."
  if ! "$SCRIPT_DIR/prepare_postgres_target.sh" "${PREPARE_ARGS[@]}" "$POSTGRES_URL"; then
    abort "PostgreSQL target preparation failed."
  fi
else
  log "Skipping target validation (UPGRADE_SKIP_TARGET_PREPARE=true)."
fi

timestamp="$(date -u +%Y%m%d-%H%M%S)"
sqlite_absolute="$(python3 - <<'PY'
import pathlib, sys
print(pathlib.Path(sys.argv[1]).resolve())
PY
"$SQLITE_PATH")"

backup_base_name="$(basename "$sqlite_absolute").${timestamp}"
backup_dir="$UPGRADE_BACKUP_DIR"
backup_sqlite_path="$backup_dir/${backup_base_name}"
backup_dump_path="${backup_sqlite_path}.sql"

if ! $DRY_RUN; then
  mkdir -p "$backup_dir"
  log "Backing up SQLite database to ${backup_sqlite_path}."
  sqlite3 "$sqlite_absolute" ".backup '$backup_sqlite_path'"
  if $CREATE_SQLITE_DUMP; then
    log "Creating SQLite dump at ${backup_dump_path}."
    sqlite3 "$sqlite_absolute" .dump >"$backup_dump_path"
  fi
else
  log "Dry run enabled – skipping backup generation."
fi

if $STOP_SERVICES && [[ -x "$MAINTENANCE_SCRIPT" ]]; then
  log "Stopping services via ${MAINTENANCE_SCRIPT}."
  if ! "$MAINTENANCE_SCRIPT" stop; then
    abort "Failed to stop services using ${MAINTENANCE_SCRIPT}."
  fi
  MAINTENANCE_ENGAGED=true
elif $STOP_SERVICES; then
  log "Maintenance script ${MAINTENANCE_SCRIPT} not executable; skipping service stop."
fi

if ! $DRY_RUN; then
  log "Importing SQLite data into PostgreSQL with ${UPGRADE_PGLOADER_BIN}."
  sqlite_uri="$(python3 - <<'PY'
import pathlib, sys, urllib.parse
path = pathlib.Path(sys.argv[1]).resolve()
print('sqlite:///' + urllib.parse.quote(str(path)))
PY
"$sqlite_absolute")"
  mapfile -t PGLOADER_ARGS < <(python3 - <<'PY'
import shlex, os
extra = os.environ.get('UPGRADE_PGLOADER_EXTRA_ARGS', '')
print('\n'.join(arg for arg in shlex.split(extra)))
PY
)
  "$UPGRADE_PGLOADER_BIN" "${PGLOADER_ARGS[@]}" "$sqlite_uri" "$POSTGRES_URL"
else
  log "Dry run enabled – skipping pgloader import."
fi

prisma_schema_args=()
if [[ -n "$UPGRADE_PRISMA_SCHEMA_PATH" ]]; then
  prisma_schema_args=(--schema "$UPGRADE_PRISMA_SCHEMA_PATH")
fi

if ! $DRY_RUN && $PRISMA_MIGRATE_DEPLOY; then
  log "Applying Prisma migrations against PostgreSQL."
  DATABASE_URL="$POSTGRES_URL" npm --prefix "$UPGRADE_PRISMA_PROJECT_DIR" exec -- prisma migrate deploy "${prisma_schema_args[@]}"
elif $PRISMA_MIGRATE_DEPLOY; then
  log "Dry run enabled – skipping Prisma migrate deploy."
fi

if ! $DRY_RUN && $PRISMA_GENERATE; then
  log "Regenerating Prisma client for PostgreSQL."
  DATABASE_URL="$POSTGRES_URL" npm --prefix "$UPGRADE_PRISMA_PROJECT_DIR" exec -- prisma generate "${prisma_schema_args[@]}"
elif $PRISMA_GENERATE; then
  log "Dry run enabled – skipping Prisma generate."
fi

if ! $DRY_RUN && $PRISMA_MIGRATE_STATUS; then
  log "Checking Prisma migration status on PostgreSQL."
  DATABASE_URL="$POSTGRES_URL" npm --prefix "$UPGRADE_PRISMA_PROJECT_DIR" exec -- prisma migrate status "${prisma_schema_args[@]}"
elif $PRISMA_MIGRATE_STATUS; then
  log "Dry run enabled – skipping Prisma migrate status."
fi

integrity_failed=false
if ! $DRY_RUN && $VERIFY_ROW_COUNTS; then
  log "Verifying row counts between SQLite and PostgreSQL."
  mapfile -t TABLES < <(sqlite3 "$sqlite_absolute" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
  for table in "${TABLES[@]}"; do
    [[ -z "$table" ]] && continue
    sqlite_count=$(sqlite3 "$sqlite_absolute" "SELECT COUNT(*) FROM \"$table\";" || echo "error")
    if [[ "$sqlite_count" == "error" ]]; then
      printf '[upgrade] Failed to count rows for table %s in SQLite.\n' "$table" >&2
      integrity_failed=true
      continue
    fi
    postgres_count=$(psql "$POSTGRES_URL" -X --tuples-only --no-align --set ON_ERROR_STOP=1 -c "SELECT COUNT(*) FROM \"$table\";" 2>/tmp/upgrade_postgres_count.err || echo "error")
    if [[ "$postgres_count" == "error" ]]; then
      printf '[upgrade] Failed to count rows for table %s in PostgreSQL.\n' "$table" >&2
      cat /tmp/upgrade_postgres_count.err >&2 || true
      integrity_failed=true
      continue
    fi
    if [[ "$sqlite_count" != "$postgres_count" ]]; then
      printf '[upgrade] Row count mismatch detected for %s (sqlite=%s, postgres=%s).\n' "$table" "$sqlite_count" "$postgres_count" >&2
      integrity_failed=true
    else
      log "Verified ${table}: ${sqlite_count} rows."
    fi
  done
  rm -f /tmp/upgrade_postgres_count.err
elif $VERIFY_ROW_COUNTS; then
  log "Dry run enabled – skipping row count verification."
fi

if $integrity_failed; then
  abort "Row count verification failed. Review the logs before promoting PostgreSQL."
fi

if [[ -n "$UPGRADE_HEALTHCHECK_CMD" ]]; then
  if ! $DRY_RUN; then
    log "Running health check command: ${UPGRADE_HEALTHCHECK_CMD}"
    if ! eval "$UPGRADE_HEALTHCHECK_CMD"; then
      abort "Health check command failed."
    fi
  else
    log "Dry run enabled – skipping health check command."
  fi
fi

log "SQLite to PostgreSQL migration completed successfully."
