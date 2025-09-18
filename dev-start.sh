#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HOST_ADDRESS="${HOST:-0.0.0.0}"
BACKEND_PORT="${BACKEND_PORT:-4000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

export HOST="$HOST_ADDRESS"

echo "Starting VisionSuit backend on ${HOST_ADDRESS}:${BACKEND_PORT}" >&2
(
  cd "$ROOT_DIR/backend"
  HOST="$HOST_ADDRESS" PORT="$BACKEND_PORT" npm run dev
) &
BACKEND_PID=$!

echo "Starting VisionSuit frontend on ${HOST_ADDRESS}:${FRONTEND_PORT}" >&2
(
  cd "$ROOT_DIR/frontend"
  npm run dev -- --host "$HOST_ADDRESS" --port "$FRONTEND_PORT"
) &
FRONTEND_PID=$!

cleanup() {
  trap - INT TERM EXIT
  for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "$BACKEND_PID" 2>/dev/null || true
  wait "$FRONTEND_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

wait "$BACKEND_PID"
wait "$FRONTEND_PID"
