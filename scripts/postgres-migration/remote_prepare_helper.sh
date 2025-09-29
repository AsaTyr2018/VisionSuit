#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<USAGE
Usage: $SCRIPT_NAME [--config <file>] --unix-user <name> --pg-role <role> [options]

Prepare a remote host for VisionSuit PostgreSQL migrations by creating a dedicated SSH user
and PostgreSQL role with the required privileges. When a configuration file is present the
script becomes non-interactive so that operators only need to execute it remotely.

Required arguments:
  --unix-user <name>        Linux user to create or update for SSH access.
  --pg-role <role>          PostgreSQL role used for migrations and schema changes.

Optional arguments:
  --config <file>           Source automation defaults from the provided file (default:
                            visionsuit_migration_config.env next to this script).
  --ssh-pubkey <key>        Public key string to place in the UNIX user's and root's authorized_keys.
  --ssh-pubkey-file <path>  Read the public key from a local file on the remote host.
  --sudo-access             Add the UNIX user to the sudo group when available.
  --pg-createdb             Grant CREATEDB on the PostgreSQL role (default: disabled).
  --pg-database <name>      Grant CONNECT, TEMP, and CREATE on the specified database when it exists.
  -h, --help                Show this help text.

The configuration file accepts the same variable names as the long options above. Variables set
through CLI arguments take precedence over file-based defaults.
USAGE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_CONFIG_FILE="${SCRIPT_DIR}/visionsuit_migration_config.env"

UNIX_USER=""
SSH_PUBKEY=""
SSH_PUBKEY_FILE=""
SUDO_ACCESS=false
CLI_SUDO_ACCESS_SET=false
PG_ROLE=""
PG_CREATEDB=false
CLI_PG_CREATEDB_SET=false
PG_DATABASE=""
CONFIG_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -lt 2 ]] && { echo "[remote-prepare] --config requires a value." >&2; usage; exit 1; }
      CONFIG_FILE="$2"
      shift 2
      ;;
    --unix-user)
      [[ $# -lt 2 ]] && { echo "[remote-prepare] --unix-user requires a value." >&2; usage; exit 1; }
      UNIX_USER="$2"
      shift 2
      ;;
    --ssh-pubkey)
      [[ $# -lt 2 ]] && { echo "[remote-prepare] --ssh-pubkey requires a value." >&2; usage; exit 1; }
      SSH_PUBKEY="$2"
      shift 2
      ;;
    --ssh-pubkey-file)
      [[ $# -lt 2 ]] && { echo "[remote-prepare] --ssh-pubkey-file requires a value." >&2; usage; exit 1; }
      SSH_PUBKEY_FILE="$2"
      shift 2
      ;;
    --sudo-access)
      SUDO_ACCESS=true
      CLI_SUDO_ACCESS_SET=true
      shift
      ;;
    --pg-role)
      [[ $# -lt 2 ]] && { echo "[remote-prepare] --pg-role requires a value." >&2; usage; exit 1; }
      PG_ROLE="$2"
      shift 2
      ;;
    --pg-createdb)
      PG_CREATEDB=true
      CLI_PG_CREATEDB_SET=true
      shift
      ;;
    --pg-database)
      [[ $# -lt 2 ]] && { echo "[remote-prepare] --pg-database requires a value." >&2; usage; exit 1; }
      PG_DATABASE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "[remote-prepare] Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      echo "[remote-prepare] Unexpected argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

CLI_UNIX_USER="$UNIX_USER"
CLI_PG_ROLE="$PG_ROLE"
CLI_PG_DATABASE="$PG_DATABASE"
CLI_SSH_PUBKEY="$SSH_PUBKEY"
CLI_SSH_PUBKEY_FILE="$SSH_PUBKEY_FILE"
CLI_SUDO_ACCESS="$SUDO_ACCESS"
CLI_PG_CREATEDB="$PG_CREATEDB"

if [[ -z "$CONFIG_FILE" && -f "$DEFAULT_CONFIG_FILE" ]]; then
  CONFIG_FILE="$DEFAULT_CONFIG_FILE"
fi

if [[ -n "$CONFIG_FILE" ]]; then
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "[remote-prepare] Configuration file ${CONFIG_FILE} does not exist." >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
  echo "[remote-prepare] Loaded automation defaults from ${CONFIG_FILE}."
  [[ -n "$CLI_UNIX_USER" ]] && UNIX_USER="$CLI_UNIX_USER"
  [[ -n "$CLI_PG_ROLE" ]] && PG_ROLE="$CLI_PG_ROLE"
  [[ -n "$CLI_PG_DATABASE" ]] && PG_DATABASE="$CLI_PG_DATABASE"
  if ! $CLI_SUDO_ACCESS_SET; then
    SUDO_ACCESS="$SUDO_ACCESS"
  else
    SUDO_ACCESS="$CLI_SUDO_ACCESS"
  fi
  if ! $CLI_PG_CREATEDB_SET; then
    PG_CREATEDB="$PG_CREATEDB"
  else
    PG_CREATEDB="$CLI_PG_CREATEDB"
  fi
  [[ -n "$CLI_SSH_PUBKEY" ]] && SSH_PUBKEY="$CLI_SSH_PUBKEY"
  [[ -n "$CLI_SSH_PUBKEY_FILE" ]] && SSH_PUBKEY_FILE="$CLI_SSH_PUBKEY_FILE"
fi

if [[ -z "$UNIX_USER" ]]; then
  echo "[remote-prepare] --unix-user is required." >&2
  usage
  exit 1
fi

if [[ -z "$PG_ROLE" ]]; then
  echo "[remote-prepare] --pg-role is required." >&2
  usage
  exit 1
fi

if [[ -n "$SSH_PUBKEY" && -n "$SSH_PUBKEY_FILE" ]]; then
  echo "[remote-prepare] Provide either --ssh-pubkey or --ssh-pubkey-file, not both." >&2
  exit 1
fi

if [[ -n "$SSH_PUBKEY_FILE" ]]; then
  if [[ ! -f "$SSH_PUBKEY_FILE" ]]; then
    echo "[remote-prepare] Public key file ${SSH_PUBKEY_FILE} does not exist." >&2
    exit 1
  fi
  SSH_PUBKEY=$(<"$SSH_PUBKEY_FILE")
fi

if ! command -v useradd >/dev/null 2>&1; then
  echo "[remote-prepare] useradd is required on the remote host." >&2
  exit 1
fi

if ! id "$UNIX_USER" >/dev/null 2>&1; then
  echo "[remote-prepare] Creating UNIX user ${UNIX_USER}."
  useradd --create-home --shell /bin/bash "$UNIX_USER"
else
  echo "[remote-prepare] UNIX user ${UNIX_USER} already exists; ensuring home directory is present."
  home_dir=$(getent passwd "$UNIX_USER" | cut -d: -f6)
  if [[ -n "$home_dir" && ! -d "$home_dir" ]]; then
    mkdir -p "$home_dir"
    chown "$UNIX_USER":"$UNIX_USER" "$home_dir"
  fi
fi

home_dir=$(getent passwd "$UNIX_USER" | cut -d: -f6)
if [[ -z "$home_dir" ]]; then
  echo "[remote-prepare] Unable to determine home directory for ${UNIX_USER}." >&2
  exit 1
fi

if [[ -n "$SSH_PUBKEY" ]]; then
  echo "[remote-prepare] Installing provided SSH public key for ${UNIX_USER}."
  install -d -m 700 "$home_dir/.ssh"
  touch "$home_dir/.ssh/authorized_keys"
  if ! grep -qxF "$SSH_PUBKEY" "$home_dir/.ssh/authorized_keys" 2>/dev/null; then
    printf '%s\n' "$SSH_PUBKEY" >>"$home_dir/.ssh/authorized_keys"
  fi
  chmod 600 "$home_dir/.ssh/authorized_keys"
  chown -R "$UNIX_USER":"$UNIX_USER" "$home_dir/.ssh"

  echo "[remote-prepare] Granting root login for the provided SSH public key."
  install -d -m 700 /root/.ssh
  touch /root/.ssh/authorized_keys
  if ! grep -qxF "$SSH_PUBKEY" /root/.ssh/authorized_keys 2>/dev/null; then
    printf '%s\n' "$SSH_PUBKEY" >>/root/.ssh/authorized_keys
  fi
  chmod 600 /root/.ssh/authorized_keys
  chown root:root /root/.ssh /root/.ssh/authorized_keys
fi

if $SUDO_ACCESS; then
  if getent group sudo >/dev/null 2>&1; then
    echo "[remote-prepare] Adding ${UNIX_USER} to sudo group."
    usermod -aG sudo "$UNIX_USER"
  else
    echo "[remote-prepare] sudo group not found; skipping sudo access grant." >&2
  fi
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "[remote-prepare] psql client is required on the remote host." >&2
  exit 1
fi

hostname_value=$(hostname -f 2>/dev/null || hostname)
summary_file="${home_dir}/visionsuit_remote_access.txt"
key_fingerprint="No SSH public key supplied."
key_note="VisionSuit server must supply the matching private key to authenticate."
root_login_status="Root login unavailable until an SSH key is installed."
config_copy_path="${home_dir}/visionsuit_migration_config.env"
config_summary_note="Applied configuration: (not supplied)"

if [[ -n "$SSH_PUBKEY" ]]; then
  if command -v ssh-keygen >/dev/null 2>&1; then
    if fingerprint_output=$(ssh-keygen -lf <(printf '%s\n' "$SSH_PUBKEY") 2>/dev/null); then
      key_fingerprint="$fingerprint_output"
    else
      key_fingerprint="Unable to derive fingerprint from provided SSH public key."
    fi
  else
    key_fingerprint="ssh-keygen unavailable; fingerprint not generated."
  fi
  key_note="Store the matching private key on the VisionSuit server to authenticate as ${UNIX_USER} or root over SSH."
  root_login_status="Enabled for the shared SSH key (stored in /root/.ssh/authorized_keys)."
else
  key_note="Add the VisionSuit server public key with --ssh-pubkey before attempting remote automation."
fi

createdb_status="disabled"
if $PG_CREATEDB; then
  createdb_status="enabled"
fi

if [[ -n "$CONFIG_FILE" ]]; then
  config_summary_note="Applied configuration: ${config_copy_path}"
fi

cat <<SUMMARY >"$summary_file"
VisionSuit Remote Access Summary
================================
Generated: $(date -u +'%Y-%m-%dT%H:%M:%SZ')
Host: ${hostname_value}

SSH Access
----------
User: ${UNIX_USER}
Home directory: ${home_dir}
Authorized key fingerprint: ${key_fingerprint}
Authorized key material: ${SSH_PUBKEY:-'(none supplied)'}
Root login: ${root_login_status}

PostgreSQL Role
---------------
Role name: ${PG_ROLE}
CREATEDB privilege: ${createdb_status}
Authentication: passwordless role provisioning (configure pg_hba.conf for host-based access)

Notes
-----
${key_note}

Automation assets stored with this user:
  - Remote summary: ${summary_file}
  - ${config_summary_note}
SUMMARY

chmod 600 "$summary_file"
chown "$UNIX_USER":"$UNIX_USER" "$summary_file"
echo "[remote-prepare] Wrote access summary to ${summary_file}."

if [[ -n "$CONFIG_FILE" ]]; then
  echo "[remote-prepare] Copying automation configuration to ${config_copy_path}."
  install -m 600 "$CONFIG_FILE" "$config_copy_path"
  chown "$UNIX_USER":"$UNIX_USER" "$config_copy_path"
fi

run_as_postgres() {
  if command -v sudo >/dev/null 2>&1; then
    sudo -u postgres "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u postgres -- "$@"
  else
    local cmd
    printf -v cmd '%q ' "$@"
    su -l postgres -c "$cmd"
  fi
}

tmp_sql=$(mktemp)
cat <<'SQL' >"$tmp_sql"
DO $$
DECLARE
  role_name text := :'ROLE_NAME';
  role_flags text := :'ROLE_FLAGS';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
    EXECUTE format('CREATE ROLE %I WITH %s', role_name, role_flags);
    RAISE NOTICE 'Created role %', role_name;
  ELSE
    EXECUTE format('ALTER ROLE %I WITH %s', role_name, role_flags);
    RAISE NOTICE 'Role % already existed; updated attributes.', role_name;
  END IF;
END;
$$;
SQL

role_flags="LOGIN"
if $PG_CREATEDB; then
  role_flags+=" CREATEDB"
fi

echo "[remote-prepare] Ensuring PostgreSQL role ${PG_ROLE} exists with required privileges."
run_as_postgres psql -v ON_ERROR_STOP=1 --set=ROLE_NAME="$PG_ROLE" --set=ROLE_FLAGS="$role_flags" -f "$tmp_sql"
rm -f "$tmp_sql"

if [[ -n "$PG_DATABASE" ]]; then
  echo "[remote-prepare] Applying database grants on ${PG_DATABASE} for ${PG_ROLE}."
  tmp_db_sql=$(mktemp)
  cat <<'SQL' >"$tmp_db_sql"
DO $$
DECLARE
  db_name text := :'DB_NAME';
  role_name text := :'ROLE_NAME';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = db_name) THEN
    RAISE NOTICE 'Database % not found; skipping grants.', db_name;
    RETURN;
  END IF;
  EXECUTE format('GRANT CONNECT, TEMP ON DATABASE %I TO %I', db_name, role_name);
  EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', db_name, role_name);
END;
$$;
SQL
  run_as_postgres psql -v ON_ERROR_STOP=1 --set=DB_NAME="$PG_DATABASE" --set=ROLE_NAME="$PG_ROLE" -f "$tmp_db_sql"
  rm -f "$tmp_db_sql"
fi

echo "[remote-prepare] Remote host preparation complete."
