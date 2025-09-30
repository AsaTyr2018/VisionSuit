#!/usr/bin/env bash
set -euo pipefail

# Final cutover helper that flips Prisma from SQLite to PostgreSQL and restarts
# VisionSuit services.

ENV_FILE=".env-migration"
BACKEND_ENV="/etc/visionsuit/vs-backend.env"
FRONTEND_ENV="/etc/visionsuit/vs-frontend.env"
SERVICES=(vs-backend vs-frontend)

usage() {
  cat <<USAGE
Usage: $0 [--env .env-migration] [--backend-env /etc/visionsuit/vs-backend.env]
          [--frontend-env /etc/visionsuit/vs-frontend.env] [--service name]

Options:
  --env <path>            Migration environment file (default: .env-migration)
  --backend-env <path>    Backend environment override file (default: /etc/visionsuit/vs-backend.env)
  --frontend-env <path>   Frontend environment override file (default: /etc/visionsuit/vs-frontend.env)
  --service <name>        Additional systemd service to restart; repeatable
  -h, --help              Show this help text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_FILE="$2"
      shift 2
      ;;
    --backend-env)
      BACKEND_ENV="$2"
      shift 2
      ;;
    --frontend-env)
      FRONTEND_ENV="$2"
      shift 2
      ;;
    --service)
      SERVICES+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[prisma-switch] Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[prisma-switch] Migration env file '$ENV_FILE' missing." >&2
  exit 1
fi

set -o allexport
source "$ENV_FILE"
set +o allexport

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[prisma-switch] DATABASE_URL missing from ${ENV_FILE}." >&2
  exit 1
fi

shadow_url="$DATABASE_URL"
if [[ "$shadow_url" == *\?* ]]; then
  shadow_url+="&schema=shadow"
else
  shadow_url+="?schema=shadow"
fi

log() {
  printf '[prisma-switch] %s\n' "$1"
}

update_env_file() {
  local path="$1"
  local temp="${path}.tmp"
  local backup="${path}.bak"
  mkdir -p "$(dirname "$path")"
  local backed_up=false
  if [[ -f "$path" ]]; then
    cp "$path" "$backup"
    backed_up=true
  fi
  {
    echo "DATABASE_URL=${DATABASE_URL}"
    echo "SHADOW_DATABASE_URL=${shadow_url}"
  } >"$temp"
  mv "$temp" "$path"
  chmod 600 "$path"
  if [[ "$backed_up" == true ]]; then
    log "Updated ${path} (backup saved to ${backup})."
  else
    log "Created ${path}."
  fi
}

update_env_file "$BACKEND_ENV"
update_env_file "$FRONTEND_ENV"

if command -v systemctl >/dev/null 2>&1; then
  for svc in "${SERVICES[@]}"; do
    log "Restarting systemd service ${svc}."
    if ! systemctl restart "$svc"; then
      echo "[prisma-switch] Failed to restart service ${svc}." >&2
      exit 1
    fi
  done
else
  log "systemctl not available; skipping service restart."
fi

log "Prisma cutover completed."

