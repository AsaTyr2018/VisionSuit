#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
RUN_DIR="$ROOT_DIR/run"
LOG_DIR="$ROOT_DIR/logs"
BACKEND_PID_FILE="$RUN_DIR/vs-backend.pid"
PRISMA_PID_FILE="$RUN_DIR/vs-prisma-studio.pid"

HOST_ADDRESS="${HOST:-0.0.0.0}"
BACKEND_PORT="${BACKEND_PORT:-4000}"
PRISMA_STUDIO_HOST="${PRISMA_STUDIO_HOST:-127.0.0.1}"
PRISMA_STUDIO_PORT="${PRISMA_STUDIO_PORT:-5555}"
START_PRISMA_STUDIO="${START_PRISMA_STUDIO:-1}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

log() {
  printf '[vs-backend] %s\n' "$1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_running() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" && -d "/proc/$pid" ]]; then
      return 0
    fi
  fi
  return 1
}

start_prisma_studio() {
  if [[ "$START_PRISMA_STUDIO" == "0" ]]; then
    log "Skipping Prisma Studio launch (START_PRISMA_STUDIO=0)."
    return
  fi

  if is_running "$PRISMA_PID_FILE"; then
    log "Prisma Studio already running (PID $(cat "$PRISMA_PID_FILE"))."
    return
  fi

  log "Starting Prisma Studio on ${PRISMA_STUDIO_HOST}:${PRISMA_STUDIO_PORT}."
  (
    cd "$BACKEND_DIR"
    nohup npx prisma studio --browser none --hostname "$PRISMA_STUDIO_HOST" --port "$PRISMA_STUDIO_PORT" \
      >> "$LOG_DIR/vs-prisma-studio.log" 2>&1 &
    echo $! >"$PRISMA_PID_FILE"
  )
}

start_backend() {
  if ! command_exists npm; then
    log "npm is required but not installed."
    exit 1
  fi

  if is_running "$BACKEND_PID_FILE"; then
    log "Backend already running (PID $(cat "$BACKEND_PID_FILE"))."
    exit 0
  fi

  log "Ensuring Prisma client artifacts are current."
  (
    cd "$BACKEND_DIR"
    npx --yes prisma generate >/dev/null 2>&1 || npx --yes prisma generate
  )

  start_prisma_studio

  log "Starting VisionSuit backend on ${HOST_ADDRESS}:${BACKEND_PORT}."
  (
    cd "$BACKEND_DIR"
    nohup env HOST="$HOST_ADDRESS" PORT="$BACKEND_PORT" \
      PRISMA_STUDIO_HOST="$PRISMA_STUDIO_HOST" PRISMA_STUDIO_PORT="$PRISMA_STUDIO_PORT" \
      npm run dev >> "$LOG_DIR/vs-backend.log" 2>&1 &
    echo $! >"$BACKEND_PID_FILE"
  )
  log "Backend launch initiated (PID $(cat "$BACKEND_PID_FILE"))."
}

stop_pid() {
  local pid_file="$1"
  local name="$2"
  if ! is_running "$pid_file"; then
    return
  fi
  local pid
  pid="$(cat "$pid_file")"
  if kill "$pid" >/dev/null 2>&1; then
    log "Stopping $name (PID $pid)."
    wait "$pid" 2>/dev/null || true
  else
    log "Failed to send TERM to $name (PID $pid)."
  fi
  rm -f "$pid_file"
}

stop_backend() {
  stop_pid "$BACKEND_PID_FILE" "backend"
  stop_pid "$PRISMA_PID_FILE" "Prisma Studio"
}

status_backend() {
  if is_running "$BACKEND_PID_FILE"; then
    log "Backend online (PID $(cat "$BACKEND_PID_FILE"))."
  else
    log "Backend offline."
  fi
  if [[ "$START_PRISMA_STUDIO" != "0" ]]; then
    if is_running "$PRISMA_PID_FILE"; then
      log "Prisma Studio online (PID $(cat "$PRISMA_PID_FILE"))."
    else
      log "Prisma Studio offline."
    fi
  fi
}

case "${1:-}" in
  start)
    start_backend
    ;;
  stop)
    stop_backend
    ;;
  restart)
    stop_backend
    start_backend
    ;;
  status)
    status_backend
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
