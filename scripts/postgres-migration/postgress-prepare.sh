#!/usr/bin/env bash
set -euo pipefail

# VisionSuit PostgreSQL target preparation helper.
#
# This script must run on the remote production host that will serve as the
# PostgreSQL backend for VisionSuit. It validates system prerequisites,
# installs PostgreSQL when missing, provisions a dedicated automation user with
# SSH key access (including root escalation), creates the VisionSuit database,
# and finally emits a configuration bundle (vs-conf.txt) that downstream
# VisionSuit automation will consume.
#
# Usage:
#   sudo ./postgress-prepare.sh [--db-name visionsuit] [--db-user visionsuit]
#       [--db-port 5432] [--linux-user visionsuit-migrator]
#       [--config /root/vs-conf.txt] [--force-regen-key]
#
# The generated configuration file includes a base64 encoded private key. Treat
# it with the same sensitivity as any SSH identity and transfer it securely to
# the VisionSuit host during the migration process.

if [[ "${EUID}" -ne 0 ]]; then
  echo "[postgress-prepare] This script must be run as root." >&2
  exit 1
fi

DB_NAME="visionsuit"
DB_USER="visionsuit"
DB_PORT="5432"
LINUX_USER="visionsuit-migrator"
CONFIG_PATH="/root/vs-conf.txt"
KEY_DIR="/etc/visionsuit-migration"
FORCE_REGEN_KEY=false
SSH_PORT="22"

usage() {
  cat <<USAGE
Usage: $0 [options]
  --db-name <name>        PostgreSQL database to provision (default: visionsuit)
  --db-user <name>        PostgreSQL role that will own the database (default: visionsuit)
  --db-port <port>        PostgreSQL port (default: 5432)
  --linux-user <name>     Linux automation user to create (default: visionsuit-migrator)
  --config <path>         Output path for the configuration file (default: /root/vs-conf.txt)
  --ssh-port <port>       SSH port that VisionSuit will use (default: 22)
  --force-regen-key       Regenerate SSH key material even when it already exists
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
    --ssh-port)
      SSH_PORT="$2"
      shift 2
      ;;
    --force-regen-key)
      FORCE_REGEN_KEY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[postgress-prepare] Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$SSH_PORT" ]]; then
  SSH_PORT="22"
fi

if ! [[ "$SSH_PORT" =~ ^[0-9]+$ ]]; then
  echo "[postgress-prepare] SSH port must be numeric." >&2
  exit 1
fi

log() {
  printf '[postgress-prepare] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[postgress-prepare] Required command '$1' not found." >&2
    exit 1
  fi
}

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y postgresql postgresql-contrib openssh-server jq
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y postgresql-server postgresql-contrib openssh jq
    if [[ ! -d /var/lib/pgsql/data ]]; then
      /usr/bin/postgresql-setup --initdb --unit postgresql
    fi
    if command -v systemctl >/dev/null 2>&1; then
      systemctl enable --now postgresql
    fi
  elif command -v yum >/dev/null 2>&1; then
    yum install -y postgresql-server postgresql-contrib openssh jq
    if [[ ! -d /var/lib/pgsql/data ]]; then
      /usr/bin/postgresql-setup initdb
    fi
    if command -v systemctl >/dev/null 2>&1; then
      systemctl enable --now postgresql
    fi
  else
    echo "[postgress-prepare] Unsupported package manager. Install PostgreSQL manually." >&2
    exit 1
  fi
}

# Ensure prerequisite tooling exists.
for bin in ssh-keygen openssl; do
  require_command "$bin"
done

if ! command -v psql >/dev/null 2>&1; then
  log "PostgreSQL client not detected, attempting installation."
  install_packages
fi

if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl is-active --quiet postgresql 2>/dev/null; then
    log "PostgreSQL service not active, attempting to start."
    systemctl enable --now postgresql >/dev/null 2>&1 || true
  fi
elif command -v service >/dev/null 2>&1; then
  service postgresql start >/dev/null 2>&1 || true
fi

# Create linux automation user
if ! id "$LINUX_USER" >/dev/null 2>&1; then
  log "Creating automation user '$LINUX_USER'."
  useradd --create-home --shell /bin/bash "$LINUX_USER"
fi

usermod -aG sudo "$LINUX_USER" 2>/dev/null || true
mkdir -p "/home/$LINUX_USER/.ssh"
chmod 700 "/home/$LINUX_USER/.ssh"

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"
PRIVATE_KEY="$KEY_DIR/${LINUX_USER}"
PUBLIC_KEY="${PRIVATE_KEY}.pub"

if [[ -f "$PRIVATE_KEY" && "$FORCE_REGEN_KEY" == false ]]; then
  log "Reusing existing SSH key at $PRIVATE_KEY."
else
  log "Generating SSH key pair for '$LINUX_USER'."
  ssh-keygen -t ed25519 -f "$PRIVATE_KEY" -N '' -C "visionsuit-migration" >/dev/null
fi

install -o "$LINUX_USER" -g "$LINUX_USER" -m 600 "$PRIVATE_KEY" "/home/$LINUX_USER/.ssh/id_ed25519"
install -o "$LINUX_USER" -g "$LINUX_USER" -m 644 "$PUBLIC_KEY" "/home/$LINUX_USER/.ssh/id_ed25519.pub"
install -o "$LINUX_USER" -g "$LINUX_USER" -m 600 "$PUBLIC_KEY" "/home/$LINUX_USER/.ssh/authorized_keys"

# Grant root login with same key for automation fallback
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat "$PUBLIC_KEY" >>/root/.ssh/authorized_keys
sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

log "Ensuring PostgreSQL role and database exist."
PG_ISREADY_BIN=$(command -v pg_isready || true)
if [[ -n "$PG_ISREADY_BIN" ]]; then
  "$PG_ISREADY_BIN" -p "$DB_PORT" -q || true
fi

POSTGRES_SUPER="postgres"
if id postgres >/dev/null 2>&1; then
  POSTGRES_SUPER="postgres"
else
  POSTGRES_SUPER="$(getent passwd | awk -F: '$1 ~ /postgres/ {print $1; exit}')"
fi

create_role_sql=$(cat <<SQL
DO $$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
      CREATE ROLE "$DB_USER" LOGIN PASSWORD NULL;
   END IF;
END
$$;
SQL
)

sudo -u "$POSTGRES_SUPER" psql -v ON_ERROR_STOP=1 -p "$DB_PORT" -c "$create_role_sql"

create_db_sql=$(cat <<SQL
DO $$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME') THEN
      CREATE DATABASE "$DB_NAME" OWNER "$DB_USER";
   END IF;
END
$$;
SQL
)

sudo -u "$POSTGRES_SUPER" psql -v ON_ERROR_STOP=1 -p "$DB_PORT" -c "$create_db_sql"

grant_sql=$(cat <<SQL
GRANT ALL PRIVILEGES ON DATABASE "$DB_NAME" TO "$DB_USER";
ALTER DATABASE "$DB_NAME" OWNER TO "$DB_USER";
SQL
)

sudo -u "$POSTGRES_SUPER" psql -v ON_ERROR_STOP=1 -p "$DB_PORT" -d "$DB_NAME" -c "$grant_sql"

# Generate application password
PASSWORD_FILE="$KEY_DIR/${DB_USER}.pgpass"
if [[ ! -f "$PASSWORD_FILE" ]]; then
  openssl rand -base64 32 >"$PASSWORD_FILE"
  chmod 600 "$PASSWORD_FILE"
fi
POSTGRES_PASSWORD="$(tr -d '\n' <"$PASSWORD_FILE")"

sudo -u "$POSTGRES_SUPER" psql -v ON_ERROR_STOP=1 -p "$DB_PORT" <<SQL
ALTER ROLE "$DB_USER" WITH PASSWORD '${POSTGRES_PASSWORD}' LOGIN;
GRANT CONNECT ON DATABASE "$DB_NAME" TO "$DB_USER";
SQL

HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname)"

PRIVATE_KEY_B64="$(base64 -w0 "$PRIVATE_KEY")"

cat >"$CONFIG_PATH" <<CONF
# VisionSuit PostgreSQL migration configuration
SSH_HOST=${HOSTNAME_FQDN}
SSH_PORT=${SSH_PORT}
SSH_USER=${LINUX_USER}
SSH_PRIVATE_KEY_BASE64=${PRIVATE_KEY_B64}
POSTGRES_HOST=${HOSTNAME_FQDN}
POSTGRES_INTERNAL_HOST=localhost
POSTGRES_PORT=${DB_PORT}
POSTGRES_DB=${DB_NAME}
POSTGRES_USER=${DB_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_SUPERUSER=${POSTGRES_SUPER}
CONF

chmod 600 "$CONFIG_PATH"
log "Configuration written to ${CONFIG_PATH}."
log "Transfer this file securely to the VisionSuit host (e.g. scp ${CONFIG_PATH} root@visionsuit:/root/config/)."

