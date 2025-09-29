#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<USAGE
Usage: $SCRIPT_NAME [options] <postgres_connection_url>

Validate a remote PostgreSQL instance before running VisionSuit migrations.

Options:
  --create-db                 Create the database when it is missing.
  --extensions <list>         Comma-separated list of extensions to install (e.g. pg_trgm,uuid-ossp).
  --require-tls               Fail if the connection does not negotiate TLS.
  -h, --help                  Show this message.
USAGE
}

CREATE_DB=false
REQUIRE_TLS=false
EXTENSION_INPUT=""
POSTGRES_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --create-db)
      CREATE_DB=true
      shift
      ;;
    --extensions)
      if [[ $# -lt 2 ]]; then
        echo "[prepare-postgres] --extensions requires a comma-separated argument." >&2
        usage
        exit 1
      fi
      EXTENSION_INPUT="$2"
      shift 2
      ;;
    --require-tls)
      REQUIRE_TLS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "[prepare-postgres] Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -n "$POSTGRES_URL" ]]; then
        echo "[prepare-postgres] Multiple connection URLs supplied." >&2
        usage
        exit 1
      fi
      POSTGRES_URL="$1"
      shift
      ;;
  esac
done

if [[ -z "$POSTGRES_URL" ]]; then
  usage
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "[prepare-postgres] psql CLI is required but not found in PATH." >&2
  exit 1
fi

parse_output=$(python3 - <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit, parse_qs

if len(sys.argv) != 2:
    raise SystemExit("expected a single connection URL")
url = sys.argv[1]
parts = urlsplit(url)
if parts.scheme not in {"postgres", "postgresql"}:
    raise SystemExit(f"unsupported scheme: {parts.scheme or 'missing'}")
path = parts.path[1:] if parts.path.startswith('/') else parts.path
dbname = path or ''
if not dbname:
    dbname = 'postgres'
admin_parts = parts._replace(path='/postgres')
sslmode = parse_qs(parts.query).get('sslmode', [''])[0]
print(dbname)
print(urlunsplit(admin_parts))
print(sslmode)
PY
"$POSTGRES_URL" 2>/tmp/prepare_postgres_parse.err) || {
  cat /tmp/prepare_postgres_parse.err >&2 || true
  echo "[prepare-postgres] Unable to parse PostgreSQL connection string." >&2
  exit 1
}

readarray -t PARSED <<<"$parse_output"
DB_NAME="${PARSED[0]}"
ADMIN_DSN="${PARSED[1]}"
SSL_MODE="${PARSED[2]}"

IFS=',' read -r -a REQUIRED_EXTENSIONS <<<"$EXTENSION_INPUT"

if [[ -z "$DB_NAME" ]]; then
  echo "[prepare-postgres] Connection string must reference a database or default to postgres." >&2
  exit 1
fi

echo "[prepare-postgres] Validating connectivity to database '${DB_NAME}'."

connection_check() {
  psql "$POSTGRES_URL" \
    --set ON_ERROR_STOP=1 \
    --no-align \
    --tuples-only \
    --quiet \
    --command "SELECT current_database();" >/tmp/prepare_postgres_conn.out
}

if ! connection_output=$(connection_check 2>&1); then
  if $CREATE_DB && grep -qi "does not exist" <<<"$connection_output"; then
    echo "[prepare-postgres] Database '${DB_NAME}' not found. Attempting to create it."
    if ! psql "$ADMIN_DSN" --set ON_ERROR_STOP=1 --command "CREATE DATABASE \"${DB_NAME}\";" >/dev/null; then
      echo "[prepare-postgres] Failed to create database '${DB_NAME}'." >&2
      echo "$connection_output" >&2
      exit 1
    fi
    echo "[prepare-postgres] Database '${DB_NAME}' created successfully."
    connection_check >/dev/null 2>&1
  else
    echo "[prepare-postgres] Unable to reach PostgreSQL target." >&2
    echo "$connection_output" >&2
    exit 1
  fi
fi

if $REQUIRE_TLS; then
  echo "[prepare-postgres] Verifying TLS enforcement."
  if [[ -n "$SSL_MODE" ]]; then
    case "$SSL_MODE" in
      disable|allow)
        echo "[prepare-postgres] sslmode=${SSL_MODE} does not guarantee TLS." >&2
        exit 1
        ;;
    esac
  fi
  conninfo=$(psql "$POSTGRES_URL" -X -q --set ON_ERROR_STOP=1 -c '\conninfo' 2>&1 || true)
  if [[ "$conninfo" != *"SSL"* ]]; then
    echo "[prepare-postgres] TLS negotiation could not be confirmed from connection info:" >&2
    echo "$conninfo" >&2
    exit 1
  fi
fi

for ext in "${REQUIRED_EXTENSIONS[@]}"; do
  ext_trimmed="${ext//[[:space:]]/}"
  if [[ -z "$ext_trimmed" ]]; then
    continue
  fi
  echo "[prepare-postgres] Ensuring extension '${ext_trimmed}' is installed."
  if ! psql "$POSTGRES_URL" --set ON_ERROR_STOP=1 --command "CREATE EXTENSION IF NOT EXISTS \"${ext_trimmed}\";" >/dev/null; then
    echo "[prepare-postgres] Failed to install extension '${ext_trimmed}'." >&2
    exit 1
  fi
done

echo "[prepare-postgres] PostgreSQL target is ready for VisionSuit migrations."
