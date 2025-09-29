#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
RUN_DIR="$ROOT_DIR/run"
LOG_DIR="$ROOT_DIR/logs"
FRONTEND_PID_FILE="$RUN_DIR/vs-frontend.pid"

HOST_ADDRESS="${HOST:-0.0.0.0}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

log() {
  printf '[vs-frontend] %s\n' "$1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_running() {
  if [[ -f "$FRONTEND_PID_FILE" ]]; then
    local pid
    pid="$(cat "$FRONTEND_PID_FILE")"
    if [[ -n "$pid" && -d "/proc/$pid" ]]; then
      return 0
    fi
  fi
  return 1
}

start_frontend() {
  if ! command_exists npm; then
    log "npm is required but not installed."
    exit 1
  fi

  if is_running; then
    log "Frontend already running (PID $(cat "$FRONTEND_PID_FILE"))."
    exit 0
  fi

  log "Starting VisionSuit frontend on ${HOST_ADDRESS}:${FRONTEND_PORT}."
  (
    cd "$FRONTEND_DIR"
    nohup npm run dev -- --host "$HOST_ADDRESS" --port "$FRONTEND_PORT" \
      >> "$LOG_DIR/vs-frontend.log" 2>&1 &
    echo $! >"$FRONTEND_PID_FILE"
  )
  log "Frontend launch initiated (PID $(cat "$FRONTEND_PID_FILE"))."
}

stop_frontend() {
  if ! is_running; then
    return
  fi
  local pid
  pid="$(cat "$FRONTEND_PID_FILE")"
  if kill "$pid" >/dev/null 2>&1; then
    log "Stopping frontend (PID $pid)."
    wait "$pid" 2>/dev/null || true
  else
    log "Failed to send TERM to frontend (PID $pid)."
  fi
  rm -f "$FRONTEND_PID_FILE"
}

status_frontend() {
  if is_running; then
    log "Frontend online (PID $(cat "$FRONTEND_PID_FILE"))."
  else
    log "Frontend offline."
  fi
}

case "${1:-}" in
  start)
    start_frontend
    ;;
  stop)
    stop_frontend
    ;;
  restart)
    stop_frontend
    start_frontend
    ;;
  status)
    status_frontend
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
