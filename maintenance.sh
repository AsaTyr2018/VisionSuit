#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICES_DIR="$ROOT_DIR/services"
LEGACY_DIR="$ROOT_DIR/Legacy-scripts"

BACKEND_SERVICE="$SERVICES_DIR/vs-backend.sh"
FRONTEND_SERVICE="$SERVICES_DIR/vs-frontend.sh"
CONNECTOR_SERVICE="$SERVICES_DIR/vs-external-connector.sh"
SYSTEMD_TEMPLATE_DIR="$SERVICES_DIR/systemd"
SYSTEMD_UNIT_DIR="/etc/systemd/system"
BACKEND_UNIT_NAME="vs-backend.service"
FRONTEND_UNIT_NAME="vs-frontend.service"
CONNECTOR_UNIT_NAME="visionsuit-external-connector.service"
BACKEND_UNIT_TEMPLATE="$SYSTEMD_TEMPLATE_DIR/$BACKEND_UNIT_NAME"
FRONTEND_UNIT_TEMPLATE="$SYSTEMD_TEMPLATE_DIR/$FRONTEND_UNIT_NAME"
CONNECTOR_UNIT_TEMPLATE="$SYSTEMD_TEMPLATE_DIR/$CONNECTOR_UNIT_NAME"
CONNECTOR_ENV_FILE="/etc/visionsuit/visionsuit-external-connector.env"
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

systemctl_available() {
  command -v systemctl >/dev/null 2>&1
}

systemd_unit_installed() {
  local unit="$1"
  systemctl_available && systemctl list-unit-files "$unit" --no-legend >/dev/null 2>&1
}

use_systemd_services() {
  systemd_unit_installed "$BACKEND_UNIT_NAME" && systemd_unit_installed "$FRONTEND_UNIT_NAME"
}

stop_legacy_pid_services() {
  if [[ -f "$FRONTEND_SERVICE" ]]; then
    require_executable "$FRONTEND_SERVICE"
    "$FRONTEND_SERVICE" stop || true
  fi
  if [[ -f "$BACKEND_SERVICE" ]]; then
    require_executable "$BACKEND_SERVICE"
    "$BACKEND_SERVICE" stop || true
  fi
  if [[ -f "$CONNECTOR_SERVICE" ]]; then
    require_executable "$CONNECTOR_SERVICE"
    "$CONNECTOR_SERVICE" stop || true
  fi
}

start_services() {
  if use_systemd_services; then
    log "Starting services via systemd."
    systemctl start "$BACKEND_UNIT_NAME" || log "systemctl start $BACKEND_UNIT_NAME failed."
    systemctl start "$FRONTEND_UNIT_NAME" || log "systemctl start $FRONTEND_UNIT_NAME failed."
    if systemd_unit_installed "$CONNECTOR_UNIT_NAME"; then
      systemctl start "$CONNECTOR_UNIT_NAME" || log "systemctl start $CONNECTOR_UNIT_NAME failed."
    fi
    return
  fi

  require_executable "$BACKEND_SERVICE"
  require_executable "$FRONTEND_SERVICE"
  "$BACKEND_SERVICE" start
  "$FRONTEND_SERVICE" start
  if [[ -f "$CONNECTOR_SERVICE" ]]; then
    require_executable "$CONNECTOR_SERVICE"
    "$CONNECTOR_SERVICE" start
  fi
}

stop_services() {
  if use_systemd_services; then
    log "Stopping services via systemd."
    systemctl stop "$FRONTEND_UNIT_NAME" || log "systemctl stop $FRONTEND_UNIT_NAME failed."
    systemctl stop "$BACKEND_UNIT_NAME" || log "systemctl stop $BACKEND_UNIT_NAME failed."
    if systemd_unit_installed "$CONNECTOR_UNIT_NAME"; then
      systemctl stop "$CONNECTOR_UNIT_NAME" || log "systemctl stop $CONNECTOR_UNIT_NAME failed."
    fi
    return
  fi

  stop_legacy_pid_services
}

status_services() {
  if use_systemd_services; then
    systemctl status "$BACKEND_UNIT_NAME" --no-pager || true
    systemctl status "$FRONTEND_UNIT_NAME" --no-pager || true
    if systemd_unit_installed "$CONNECTOR_UNIT_NAME"; then
      systemctl status "$CONNECTOR_UNIT_NAME" --no-pager || true
    fi
    return
  fi

  require_executable "$BACKEND_SERVICE"
  require_executable "$FRONTEND_SERVICE"
  "$BACKEND_SERVICE" status || true
  "$FRONTEND_SERVICE" status || true
  if [[ -f "$CONNECTOR_SERVICE" ]]; then
    require_executable "$CONNECTOR_SERVICE"
    "$CONNECTOR_SERVICE" status || true
  fi
}

install_systemd_unit() {
  local template="$1"
  local unit_name="$2"
  if [[ ! -f "$template" ]]; then
    log "Template for $unit_name not found at $template."
    return 1
  fi

  local rendered
  rendered="$(mktemp)"
  sed "s|@ROOT_DIR@|$ROOT_DIR|g" "$template" >"$rendered"
  install -Dm644 "$rendered" "$SYSTEMD_UNIT_DIR/$unit_name"
  rm -f "$rendered"
}

install_systemd_services() {
  if ! systemctl_available; then
    log "systemctl not available; skipping systemd unit installation."
    return
  fi

  stop_legacy_pid_services

  install_systemd_unit "$BACKEND_UNIT_TEMPLATE" "$BACKEND_UNIT_NAME" || return
  install_systemd_unit "$FRONTEND_UNIT_TEMPLATE" "$FRONTEND_UNIT_NAME" || return
  install_systemd_unit "$CONNECTOR_UNIT_TEMPLATE" "$CONNECTOR_UNIT_NAME" || return

  if ! systemctl daemon-reload; then
    log "systemctl daemon-reload failed."
    return
  fi

  if ! systemctl enable --now "$BACKEND_UNIT_NAME"; then
    log "Failed to enable $BACKEND_UNIT_NAME."
    return
  fi

  if ! systemctl enable --now "$FRONTEND_UNIT_NAME"; then
    log "Failed to enable $FRONTEND_UNIT_NAME."
    return
  fi

  if systemctl list-unit-files "$CONNECTOR_UNIT_NAME" --no-legend >/dev/null 2>&1; then
    if [[ -f "$CONNECTOR_ENV_FILE" ]]; then
      if ! systemctl enable "$CONNECTOR_UNIT_NAME"; then
        log "Failed to enable $CONNECTOR_UNIT_NAME."
      elif ! systemctl start "$CONNECTOR_UNIT_NAME"; then
        log "Failed to start $CONNECTOR_UNIT_NAME."
      else
        log "$CONNECTOR_UNIT_NAME enabled and started."
      fi
    else
      log "$CONNECTOR_UNIT_NAME installed. Populate $CONNECTOR_ENV_FILE and run 'systemctl enable --now $CONNECTOR_UNIT_NAME' to activate the fallback tunnel."
    fi
  fi

  log "Backend and frontend systemd services installed and enabled."
}

restart_systemd_services() {
  if ! use_systemd_services; then
    log "Systemd services not installed; skipping restart."
    return
  fi

  if ! systemctl restart "$BACKEND_UNIT_NAME"; then
    log "Failed to restart $BACKEND_UNIT_NAME."
    return
  fi

  if ! systemctl restart "$FRONTEND_UNIT_NAME"; then
    log "Failed to restart $FRONTEND_UNIT_NAME."
    return
  fi

  if systemd_unit_installed "$CONNECTOR_UNIT_NAME"; then
    if ! systemctl restart "$CONNECTOR_UNIT_NAME"; then
      log "Failed to restart $CONNECTOR_UNIT_NAME."
    fi
  fi

  log "Systemd services restarted."
}

install_stack() {
  if [[ -x "$LEGACY_INSTALL" ]]; then
    log "Delegating installation to legacy workflow."
    "$LEGACY_INSTALL" "$@"
  else
    log "No legacy installer found; running dependency bootstrap."
    npm --prefix "$ROOT_DIR/backend" install
    npm --prefix "$ROOT_DIR/frontend" install
  fi

  install_systemd_services
}

update_stack() {
  stop_legacy_pid_services
  log "Updating backend dependencies."
  npm --prefix "$ROOT_DIR/backend" install
  log "Applying pending database migrations."
  npm --prefix "$ROOT_DIR/backend" run prisma:migrate
  log "Updating frontend dependencies."
  npm --prefix "$ROOT_DIR/frontend" install
  log "Frontend dependency refresh complete."
  install_systemd_services
  restart_systemd_services
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
