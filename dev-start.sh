#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HOST_ADDRESS="${HOST:-0.0.0.0}"
BACKEND_PORT="${BACKEND_PORT:-4000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
PRISMA_STUDIO_HOST="${PRISMA_STUDIO_HOST:-127.0.0.1}"
PRISMA_STUDIO_PORT="${PRISMA_STUDIO_PORT:-5555}"

export HOST="$HOST_ADDRESS"

echo "Starting Prisma Studio on ${PRISMA_STUDIO_HOST}:${PRISMA_STUDIO_PORT} (proxied at /db)" >&2
(
  cd "$ROOT_DIR/backend"
  npx prisma studio --browser none --host "$PRISMA_STUDIO_HOST" --port "$PRISMA_STUDIO_PORT"
) &
PRISMA_STUDIO_PID=$!

echo "Starting VisionSuit backend on ${HOST_ADDRESS}:${BACKEND_PORT}" >&2
(
  cd "$ROOT_DIR/backend"
  HOST="$HOST_ADDRESS" PORT="$BACKEND_PORT" PRISMA_STUDIO_HOST="$PRISMA_STUDIO_HOST" PRISMA_STUDIO_PORT="$PRISMA_STUDIO_PORT" npm run dev
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
  for pid in "$PRISMA_STUDIO_PID" "$BACKEND_PID" "$FRONTEND_PID"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "$PRISMA_STUDIO_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
  wait "$FRONTEND_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

wait "$PRISMA_STUDIO_PID"
wait "$BACKEND_PID"
wait "$FRONTEND_PID"
