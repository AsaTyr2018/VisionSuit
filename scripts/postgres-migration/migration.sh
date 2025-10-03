#!/usr/bin/env bash
set -euo pipefail

# VisionSuit SQLite -> PostgreSQL migration orchestrator.
#
# The script relies on `.env-migration` created by preflight.sh. It backs up the
# source SQLite database, performs the transfer with pgloader or a sqlite3
# export/import fallback, and validates row counts to ensure the import is
# trustworthy.

ENV_FILE=".env-migration"
WORK_DIR="run/migration"
SKIP_TUNNEL="${MIGRATION_SKIP_TUNNEL:-0}"
DIRECT_FALLBACK="${MIGRATION_DIRECT_FALLBACK:-1}"

usage() {
  cat <<USAGE
Usage: $0 [--env .env-migration] [--workdir run/migration]

Options:
  --env <path>       Path to the migration env file (default: .env-migration)
  --workdir <path>   Working directory used for dumps and logs (default: run/migration)
  -h, --help         Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_FILE="$2"
      shift 2
      ;;
    --workdir)
      WORK_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[migration] Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[migration] Migration env file '$ENV_FILE' is missing. Run preflight first." >&2
  exit 1
fi

set -o allexport
source "$ENV_FILE"
set +o allexport

for var in SQLITE_PATH DATABASE_URL POSTGRES_USER POSTGRES_PASSWORD POSTGRES_HOST POSTGRES_PORT POSTGRES_DB; do
  if [[ -z "${!var:-}" ]]; then
    echo "[migration] Required variable '$var' missing from ${ENV_FILE}." >&2
    exit 1
  fi
done

if ! [[ "$POSTGRES_PORT" =~ ^[0-9]+$ ]]; then
  echo "[migration] POSTGRES_PORT must be numeric (current value: ${POSTGRES_PORT})." >&2
  exit 1
fi

if [[ "$SKIP_TUNNEL" != "1" ]]; then
  for var in POSTGRES_SSH_HOST POSTGRES_SSH_PORT POSTGRES_SSH_USER POSTGRES_SSH_KEY POSTGRES_INTERNAL_HOST; do
    if [[ -z "${!var:-}" ]]; then
      echo "[migration] Required variable '$var' missing from ${ENV_FILE}." >&2
      exit 1
    fi
  done
  if [[ ! -f "$POSTGRES_SSH_KEY" ]]; then
    echo "[migration] SSH key '$POSTGRES_SSH_KEY' not found." >&2
    exit 1
  fi
  if ! [[ "$POSTGRES_SSH_PORT" =~ ^[0-9]+$ ]]; then
    echo "[migration] POSTGRES_SSH_PORT must be numeric." >&2
    exit 1
  fi
fi

if [[ ! -f "$SQLITE_PATH" ]]; then
  echo "[migration] SQLite database '${SQLITE_PATH}' not found." >&2
  exit 1
fi

mkdir -p "$WORK_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SQLITE_BAK="$WORK_DIR/sqlite-backup-${TIMESTAMP}.db"
log_file="$WORK_DIR/migration-${TIMESTAMP}.log"

log() {
  printf '[migration] %s\n' "$1" | tee -a "$log_file"
}

log "Creating SQLite safety backup at ${SQLITE_BAK}."
cp "$SQLITE_PATH" "$SQLITE_BAK"

urlencode() {
  local raw="$1"
  local length=${#raw}
  local encoded=""
  local i char ord
  for ((i = 0; i < length; i++)); do
    char=${raw:i:1}
    case "$char" in
      [a-zA-Z0-9.~_-])
        encoded+="$char"
        ;;
      *)
        LC_CTYPE=C printf -v ord '%d' "'$char"
        printf -v encoded '%s%%%02X' "$encoded" "$ord"
        ;;
    esac
  done
  printf '%s' "$encoded"
}

psql_args=()

psql_exec() {
  PGPASSWORD="$POSTGRES_PASSWORD" psql "${psql_args[@]}" "$@"
}

drop_existing() {
  log "Dropping existing tables on PostgreSQL to ensure clean import."
  psql_exec --set ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE
    rec record;
BEGIN
    FOR rec IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS "' || rec.tablename || '" CASCADE';
    END LOOP;
END $$;
SQL
}

ACTIVE_HOST=""
ACTIVE_PORT=""
ACTIVE_MODE=""
ACTIVE_TUNNEL_PID=""

teardown_connection() {
  if [[ -n "$ACTIVE_TUNNEL_PID" ]]; then
    kill "$ACTIVE_TUNNEL_PID" 2>/dev/null || true
    wait "$ACTIVE_TUNNEL_PID" 2>/dev/null || true
    ACTIVE_TUNNEL_PID=""
  fi
}

cleanup_all() {
  teardown_connection
}
trap cleanup_all EXIT

allocate_tunnel_port() {
  local desired="$1"
  local chosen="$desired"
  if command -v lsof >/dev/null 2>&1 && lsof -Pi :"$desired" -sTCP:LISTEN >/dev/null 2>&1; then
    if ! command -v python3 >/dev/null 2>&1; then
      echo "[migration] python3 is required to allocate an alternate tunnel port." >&2
      return 1
    fi
    chosen=$(python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    s.bind(('127.0.0.1', 0))
    print(s.getsockname()[1])
PY
)
  fi
  printf '%s' "$chosen"
}

setup_connection() {
  local mode="$1"
  teardown_connection

  if [[ "$mode" == "tunnel" ]]; then
    local local_port
    local_port=$(allocate_tunnel_port "$POSTGRES_PORT") || return 1
    ACTIVE_HOST="127.0.0.1"
    ACTIVE_PORT="$local_port"
    ACTIVE_MODE="tunnel"
    log "Establishing SSH tunnel to ${POSTGRES_SSH_USER}@${POSTGRES_SSH_HOST}:${POSTGRES_SSH_PORT} (local port ${ACTIVE_PORT})."
    SSH_CMD=(ssh -i "$POSTGRES_SSH_KEY" -p "$POSTGRES_SSH_PORT" -o BatchMode=yes -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new)
    "${SSH_CMD[@]}" -N -L "${ACTIVE_PORT}:${POSTGRES_INTERNAL_HOST}:${POSTGRES_PORT}" "${POSTGRES_SSH_USER}@${POSTGRES_SSH_HOST}" &
    ACTIVE_TUNNEL_PID=$!
    sleep 1
    if ! kill -0 "$ACTIVE_TUNNEL_PID" 2>/dev/null; then
      wait "$ACTIVE_TUNNEL_PID" 2>/dev/null || true
      echo "[migration] Failed to establish SSH tunnel. Check SSH connectivity and credentials." >&2
      teardown_connection
      return 1
    fi
  else
    ACTIVE_HOST="$POSTGRES_HOST"
    ACTIVE_PORT="$POSTGRES_PORT"
    ACTIVE_MODE="direct"
    log "Using direct PostgreSQL connection to ${ACTIVE_HOST}:${ACTIVE_PORT}."
  fi

  if ! [[ "$ACTIVE_PORT" =~ ^[0-9]+$ ]]; then
    echo "[migration] Resolved PostgreSQL port '${ACTIVE_PORT}' is not numeric." >&2
    teardown_connection
    return 1
  fi

  psql_args=(--host "$ACTIVE_HOST" --port "$ACTIVE_PORT" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB")
  return 0
}

perform_transfer() {
  drop_existing

  if command -v pgloader >/dev/null 2>&1; then
    log "Using pgloader for migration (${ACTIVE_MODE} connection)."
    local load_file="$WORK_DIR/pgloader-${TIMESTAMP}-${ACTIVE_MODE}.load"
    local encoded_pg_user encoded_pg_password encoded_pg_db postgres_url
    encoded_pg_user=$(urlencode "$POSTGRES_USER")
    encoded_pg_password=$(urlencode "$POSTGRES_PASSWORD")
    encoded_pg_db=$(urlencode "$POSTGRES_DB")
    postgres_url="postgresql://${encoded_pg_user}:${encoded_pg_password}@${ACTIVE_HOST}:${ACTIVE_PORT}/${encoded_pg_db}"
    cat <<LOAD >"$load_file"
LOAD DATABASE
     FROM 'sqlite:///${SQLITE_PATH}'
     INTO ${postgres_url}

 WITH include drop, create tables, create indexes, reset sequences
 SET work_mem TO '128MB', maintenance_work_mem TO '256MB'
 SET search_path TO 'public';
LOAD
    log "Executing pgloader with load file ${load_file}."
    pgloader "$load_file" | tee -a "$log_file"
  else
    log "pgloader not found – falling back to sqlite3 dump." >&2
    require() {
      if ! command -v "$1" >/dev/null 2>&1; then
        echo "[migration] Required command '$1' missing." >&2
        exit 1
      fi
    }
    require sqlite3
    require psql

    local sqlite_sql="$WORK_DIR/sqlite-export-${TIMESTAMP}.sql"
    log "Exporting SQLite schema and data to ${sqlite_sql}."
    sqlite3 "$SQLITE_PATH" .dump >"$sqlite_sql"
    log "Importing dump into PostgreSQL (this may take a while)."
    psql_exec -f "$sqlite_sql" >>"$log_file" 2>&1
  fi
}

attempt_modes=()

if [[ "$SKIP_TUNNEL" != "1" ]]; then
  attempt_modes+=("tunnel")
else
  attempt_modes+=("direct")
fi

if [[ "$DIRECT_FALLBACK" == "1" && "$SKIP_TUNNEL" != "1" ]]; then
  attempt_modes+=("direct")
fi

if [[ ${#attempt_modes[@]} -eq 0 ]]; then
  echo "[migration] No connection strategies available." >&2
  exit 1
fi

success_mode=""

for mode in "${attempt_modes[@]}"; do
  if ! setup_connection "$mode"; then
    log "Connection setup for ${mode} strategy failed; trying next option if available."
    continue
  fi

  set +e
  ( set -e; perform_transfer )
  status=$?
  set -e

  if [[ $status -eq 0 ]]; then
    success_mode="$mode"
    break
  fi

  log "Migration attempt via ${mode} connection failed with status ${status}."
  teardown_connection
done

if [[ -z "$success_mode" ]]; then
  echo "[migration] All migration strategies failed. Review the log above for details." >&2
  exit 1
fi

log "Running vacuum/analyze on PostgreSQL."
psql_exec --set ON_ERROR_STOP=1 -c "VACUUM ANALYZE;" >>"$log_file" 2>&1

log "Validating row counts between SQLite and PostgreSQL."

count_tables=$(sqlite3 "$SQLITE_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
missing_tables=()
for table in $count_tables; do
  sqlite_count=$(sqlite3 "$SQLITE_PATH" "SELECT COUNT(*) FROM \"$table\";")
  pg_count=$(psql_exec --no-align --tuples-only --quiet -c "SELECT COUNT(*) FROM \"$table\";" || echo "-1")
  if [[ "$pg_count" != "$sqlite_count" ]]; then
    missing_tables+=("$table")
    log "Mismatch detected for table '$table': sqlite=${sqlite_count}, postgres=${pg_count}"
  else
    log "Validated table '$table' with ${sqlite_count} rows."
  fi
done

if [[ ${#missing_tables[@]} -gt 0 ]]; then
  echo "[migration] Row count validation failed for: ${missing_tables[*]}." >&2
  exit 1
fi

log "SQLite to PostgreSQL migration completed successfully via ${success_mode:-$ACTIVE_MODE} connection."

