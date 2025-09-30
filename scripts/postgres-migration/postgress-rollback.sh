#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "[postgress-rollback] This script must be run as root." >&2
  exit 1
fi

DB_NAME="visionsuit"
DB_USER="visionsuit"
DB_PORT="5432"
LINUX_USER="visionsuit-migrator"
CONFIG_PATH="/root/vs-conf.txt"
KEY_DIR="/etc/visionsuit-migration"
FORCE=false

usage() {
  cat <<USAGE
Usage: $0 [options]
  --db-name <name>        PostgreSQL database to remove (default: visionsuit)
  --db-user <name>        PostgreSQL role to remove (default: visionsuit)
  --db-port <port>        PostgreSQL port (default: 5432)
  --linux-user <name>     Linux automation user to delete (default: visionsuit-migrator)
  --config <path>         Configuration file path to delete (default: /root/vs-conf.txt)
  --key-dir <path>        Directory that stores generated SSH keys (default: /etc/visionsuit-migration)
  --force                 Required confirmation flag. Drops database, role, user, and keys.
  -h, --help              Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-name)
      DB_NAME="$2"
      shift 2
      ;;
    --db-user)
      DB_USER="$2"
      shift 2
      ;;
    --db-port)
      DB_PORT="$2"
      shift 2
      ;;
    --linux-user)
      LINUX_USER="$2"
      shift 2
      ;;
    --config)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --key-dir)
      KEY_DIR="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[postgress-rollback] Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "$FORCE" != true ]]; then
  echo "[postgress-rollback] Refusing to run without --force. Review the target values and rerun when ready." >&2
  exit 1
fi

if ! [[ "$DB_PORT" =~ ^[0-9]+$ ]]; then
  echo "[postgress-rollback] PostgreSQL port must be numeric." >&2
  exit 1
fi

log() {
  printf '[postgress-rollback] %s\n' "$1"
}

fail() {
  echo "[postgress-rollback] $1" >&2
  exit 1
}

validate_identifier() {
  local value="$1"
  local label="$2"

  if [[ -z "$value" ]]; then
    fail "$label cannot be empty."
  fi

  if [[ "$value" == *'"'* ]]; then
    fail "$label must not contain double quotes."
  fi

  if ! [[ "$value" =~ ^[A-Za-z0-9_-]+$ ]]; then
    fail "$label may only contain letters, numbers, hyphens, and underscores."
  fi
}

validate_identifier "$DB_NAME" "Database name"
validate_identifier "$DB_USER" "Database user"
validate_identifier "$LINUX_USER" "Linux automation user"

if [[ "$LINUX_USER" == "root" ]]; then
  fail "Refusing to delete the root account."
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command '$1' not found."
  fi
}

for bin in psql sudo mktemp pgrep pkill userdel; do
  require_command "$bin"
done

POSTGRES_SUPER="postgres"
if id postgres >/dev/null 2>&1; then
  POSTGRES_SUPER="postgres"
else
  POSTGRES_SUPER="$(getent passwd | awk -F: '$1 ~ /postgres/ {print $1; exit}')"
fi

if [[ -z "$POSTGRES_SUPER" ]]; then
  fail "Unable to determine PostgreSQL superuser account."
fi

if [[ "$DB_USER" == "$POSTGRES_SUPER" ]]; then
  fail "Refusing to drop the PostgreSQL superuser role ($POSTGRES_SUPER)."
fi

log "Rolling back PostgreSQL database '$DB_NAME'."

db_exists=$(sudo -u "$POSTGRES_SUPER" psql -v ON_ERROR_STOP=1 -p "$DB_PORT" -d postgres -tA -v db_name="$DB_NAME" <<'SQL'
SELECT 1 FROM pg_database WHERE datname = :'db_name';
SQL
)

if [[ -n "${db_exists//[[:space:]]/}" ]]; then
  log "Terminating active connections to '$DB_NAME'."
  sudo -u "$POSTGRES_SUPER" psql -v ON_ERROR_STOP=1 -p "$DB_PORT" -d postgres -v db_name="$DB_NAME" <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'db_name'
  AND pid <> pg_backend_pid();
SQL

  log "Dropping PostgreSQL database '$DB_NAME'."
  sudo -u "$POSTGRES_SUPER" psql -v ON_ERROR_STOP=1 -p "$DB_PORT" -d postgres <<SQL
DROP DATABASE IF EXISTS "$DB_NAME";
SQL
else
  log "Database '$DB_NAME' not present; skipping drop."
fi

log "Rolling back PostgreSQL role '$DB_USER'."
role_exists=$(sudo -u "$POSTGRES_SUPER" psql -v ON_ERROR_STOP=1 -p "$DB_PORT" -d postgres -tA -v db_user="$DB_USER" <<'SQL'
SELECT 1 FROM pg_roles WHERE rolname = :'db_user';
SQL
)

if [[ -n "${role_exists//[[:space:]]/}" ]]; then
  log "Reassigning and dropping owned privileges for '$DB_USER'."
  sudo -u "$POSTGRES_SUPER" psql -v ON_ERROR_STOP=1 -p "$DB_PORT" -d postgres <<SQL
REASSIGN OWNED BY "$DB_USER" TO "$POSTGRES_SUPER";
DROP OWNED BY "$DB_USER";
SQL

  log "Dropping PostgreSQL role '$DB_USER'."
  sudo -u "$POSTGRES_SUPER" psql -v ON_ERROR_STOP=1 -p "$DB_PORT" -d postgres <<SQL
DROP ROLE IF EXISTS "$DB_USER";
SQL
else
  log "Role '$DB_USER' not present; skipping drop."
fi

if id "$LINUX_USER" >/dev/null 2>&1; then
  log "Removing Linux automation user '$LINUX_USER'."
  if pgrep -u "$LINUX_USER" >/dev/null 2>&1; then
    pkill -u "$LINUX_USER" || true
  fi
  userdel -r "$LINUX_USER" 2>/dev/null || userdel -rf "$LINUX_USER" 2>/dev/null || true
else
  log "Linux user '$LINUX_USER' not present; skipping removal."
fi

PRIVATE_KEY="$KEY_DIR/${LINUX_USER}"
PUBLIC_KEY="${PRIVATE_KEY}.pub"
PASSWORD_FILE="$KEY_DIR/${DB_USER}.pgpass"

for file in "$PRIVATE_KEY" "$PUBLIC_KEY" "$PASSWORD_FILE"; do
  if [[ -f "$file" ]]; then
    log "Removing file $file."
    rm -f "$file"
  fi
done

if [[ -d "$KEY_DIR" ]]; then
  shopt -s nullglob
  key_dir_contents=("$KEY_DIR"/*)
  shopt -u nullglob
  if [[ ${#key_dir_contents[@]} -eq 0 ]]; then
    log "Removing empty key directory $KEY_DIR."
    rmdir "$KEY_DIR"
  fi
fi

AUTHORIZED_KEYS_PATH="/root/.ssh/authorized_keys"
if [[ -f "$AUTHORIZED_KEYS_PATH" ]]; then
  if grep -q "visionsuit-migration" "$AUTHORIZED_KEYS_PATH"; then
    log "Pruning root authorized_keys entry for migration automation."
    tmp_file=$(mktemp)
    grep -v "visionsuit-migration" "$AUTHORIZED_KEYS_PATH" >"$tmp_file" || true
    mv "$tmp_file" "$AUTHORIZED_KEYS_PATH"
    chmod 600 "$AUTHORIZED_KEYS_PATH"
  fi
fi

if [[ -f "$CONFIG_PATH" ]]; then
  log "Removing configuration file $CONFIG_PATH."
  rm -f "$CONFIG_PATH"
fi

log "Rollback completed."
