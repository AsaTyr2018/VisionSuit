#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICES_DIR="$ROOT_DIR/services"
LEGACY_DIR="$ROOT_DIR/Legacy-scripts"

BACKEND_SERVICE="$SERVICES_DIR/vs-backend.sh"
FRONTEND_SERVICE="$SERVICES_DIR/vs-frontend.sh"
LEGACY_INSTALL="$LEGACY_DIR/install.sh"
LEGACY_ROLLBACK="$LEGACY_DIR/rollback.sh"

log() {
  printf '[maintenance] %s\n' "$1"
}

require_executable() {
  local file="$1"
  if [[ ! -x "$file" ]]; then
    log "Making $file executable."
    chmod +x "$file"
  fi
}

start_services() {
  require_executable "$BACKEND_SERVICE"
  require_executable "$FRONTEND_SERVICE"
  "$BACKEND_SERVICE" start
  "$FRONTEND_SERVICE" start
}

stop_services() {
  require_executable "$FRONTEND_SERVICE"
  require_executable "$BACKEND_SERVICE"
  "$FRONTEND_SERVICE" stop || true
  "$BACKEND_SERVICE" stop || true
}

status_services() {
  require_executable "$BACKEND_SERVICE"
  require_executable "$FRONTEND_SERVICE"
  "$BACKEND_SERVICE" status || true
  "$FRONTEND_SERVICE" status || true
}

install_stack() {
  if [[ -x "$LEGACY_INSTALL" ]]; then
    log "Delegating installation to legacy workflow."
    "$LEGACY_INSTALL" "$@"
    return
  fi

  log "No legacy installer found; running dependency bootstrap."
  npm --prefix "$ROOT_DIR/backend" install
  npm --prefix "$ROOT_DIR/frontend" install
}

update_stack() {
  log "Updating backend dependencies."
  npm --prefix "$ROOT_DIR/backend" install
  log "Applying pending database migrations."
  npm --prefix "$ROOT_DIR/backend" run prisma:migrate
  log "Updating frontend dependencies."
  npm --prefix "$ROOT_DIR/frontend" install
  log "Frontend dependency refresh complete."
}

rollback_stack() {
  if [[ -x "$LEGACY_ROLLBACK" ]]; then
    log "Delegating rollback to legacy workflow."
    "$LEGACY_ROLLBACK" "$@"
    return
  fi
  log "No rollback helper available."
  exit 1
}

usage() {
  cat <<USAGE
Usage: $0 <command>

Commands:
  start       Start vs-Backend and vs-Frontend services.
  stop        Stop the VisionSuit services.
  restart     Restart both services.
  status      Print service status information.
  install     Run the installation workflow (delegates to legacy script when present).
  update      Refresh dependencies and database migrations.
  rollback    Trigger the rollback workflow (delegates to legacy script when present).
USAGE
}

case "${1:-}" in
  start)
    start_services
    ;;
  stop)
    stop_services
    ;;
  restart)
    stop_services
    start_services
    ;;
  status)
    status_services
    ;;
  install)
    shift
    install_stack "$@"
    ;;
  update)
    shift
    update_stack "$@"
    ;;
  rollback)
    shift
    rollback_stack "$@"
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
