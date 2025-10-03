#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/run"
LOG_DIR="$ROOT_DIR/logs"
SOCKET_DIR="$RUN_DIR/ssh"
PID_FILE="$RUN_DIR/vs-external-connector.pid"
LOG_FILE="$LOG_DIR/vs-external-connector.log"

mkdir -p "$RUN_DIR" "$LOG_DIR" "$SOCKET_DIR"

log() {
  printf '[vs-external-connector] %s\n' "$1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if [[ -n "$pid" && -d "/proc/$pid" ]]; then
      return 0
    fi
  fi
  return 1
}

start_connector() {
  if is_running; then
    log "External connector already running (PID $(cat "$PID_FILE"))."
    exit 0
  fi

  if ! command_exists ssh; then
    log "ssh is required but not installed."
    exit 1
  fi

  local ssh_host="${EXTERNAL_CONNECTOR_SSH_HOST:-}"
  local ssh_user="${EXTERNAL_CONNECTOR_SSH_USER:-}"
  if [[ -z "$ssh_host" || -z "$ssh_user" ]]; then
    log "EXTERNAL_CONNECTOR_SSH_HOST and EXTERNAL_CONNECTOR_SSH_USER must be set before starting the connector."
    exit 1
  fi

  local ssh_port="${EXTERNAL_CONNECTOR_SSH_PORT:-22}"
  local bind_host="${EXTERNAL_CONNECTOR_BIND_HOST:-127.0.0.1}"
  local bind_port="${EXTERNAL_CONNECTOR_BIND_PORT:-6432}"
  local remote_host="${EXTERNAL_CONNECTOR_REMOTE_HOST:-127.0.0.1}"
  local remote_port="${EXTERNAL_CONNECTOR_REMOTE_PORT:-5432}"
  local ssh_key="${EXTERNAL_CONNECTOR_SSH_KEY:-}"
  local known_hosts="${EXTERNAL_CONNECTOR_SSH_KNOWN_HOSTS:-}"
  local strict_host_key_checking="${EXTERNAL_CONNECTOR_SSH_STRICT_HOST_KEY_CHECKING:-accept-new}"
  local server_alive_interval="${EXTERNAL_CONNECTOR_SERVER_ALIVE_INTERVAL:-30}"
  local server_alive_count="${EXTERNAL_CONNECTOR_SERVER_ALIVE_COUNT_MAX:-3}"

  local -a ssh_cmd
  ssh_cmd=(
    ssh
    -o ExitOnForwardFailure=yes
    -o ServerAliveInterval="${server_alive_interval}"
    -o ServerAliveCountMax="${server_alive_count}"
    -o StrictHostKeyChecking="${strict_host_key_checking}"
  )

  if [[ -n "$known_hosts" ]]; then
    ssh_cmd+=(-o UserKnownHostsFile="$known_hosts")
  fi

  if [[ -n "$ssh_key" ]]; then
    ssh_cmd+=(-i "$ssh_key")
  fi

  if [[ -n "${EXTERNAL_CONNECTOR_SSH_CONTROL_PATH:-}" ]]; then
    ssh_cmd+=(-o ControlPath="${EXTERNAL_CONNECTOR_SSH_CONTROL_PATH}")
    ssh_cmd+=(-o ControlMaster=auto)
    ssh_cmd+=(-o ControlPersist=600)
  fi

  if [[ -n "${EXTERNAL_CONNECTOR_SSH_EXTRA_OPTS:-}" ]]; then
    local -a extra_opts
    # shellcheck disable=SC2206
    extra_opts=( ${EXTERNAL_CONNECTOR_SSH_EXTRA_OPTS} )
    ssh_cmd+=("${extra_opts[@]}")
  fi

  ssh_cmd+=(-N)
  ssh_cmd+=(-L "${bind_host}:${bind_port}:${remote_host}:${remote_port}")
  ssh_cmd+=(-p "$ssh_port")
  ssh_cmd+=("${ssh_user}@${ssh_host}")

  log "Opening SSH tunnel ${bind_host}:${bind_port} -> ${remote_host}:${remote_port} via ${ssh_user}@${ssh_host}:${ssh_port}."
  nohup "${ssh_cmd[@]}" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 1

  if ! is_running; then
    log "External connector failed to start. Inspect $LOG_FILE for details."
    exit 1
  fi

  log "External connector launch initiated (PID $(cat "$PID_FILE"))."
}

stop_connector() {
  if ! is_running; then
    return
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if kill "$pid" >/dev/null 2>&1; then
    log "Stopping external connector (PID $pid)."
    wait "$pid" 2>/dev/null || true
  else
    log "Failed to send TERM to external connector (PID $pid)."
  fi
  rm -f "$PID_FILE"
}

status_connector() {
  if is_running; then
    log "External connector online (PID $(cat "$PID_FILE"))."
  else
    log "External connector offline."
  fi
}

case "${1:-}" in
  start)
    start_connector
    ;;
  stop)
    stop_connector
    ;;
  restart)
    stop_connector
    start_connector
    ;;
  status)
    status_connector
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
