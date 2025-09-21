#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage: ${0##*/} --workflow WORKFLOW.json [options]

Queues a ComfyUI workflow via the HTTP API and waits for completion.

Options:
  -f, --workflow FILE     Workflow JSON exported from ComfyUI (required).
  -H, --host HOST         ComfyUI host (default: 127.0.0.1).
  -p, --port PORT         ComfyUI port (default: 8188).
      --scheme SCHEME     URL scheme for the ComfyUI API (default: http).
      --url URL           Full base URL (overrides scheme/host/port).
      --env-file FILE     MinIO environment file (default: /etc/comfyui/minio.env).
      --export-dir DIR    Automatically run test-export-outputs into DIR after success.
  -s, --sleep SECONDS     Polling interval in seconds (default: 2).
  -h, --help              Show this help message.
USAGE
}

ensure_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command '$1' is not available." >&2
    exit 1
  fi
}

SCHEME="http"
HOST="127.0.0.1"
PORT="8188"
BASE_URL=""
WORKFLOW_FILE=""
ENV_FILE="${MINIO_ENV_FILE:-/etc/comfyui/minio.env}"
EXPORT_DIR=""
SLEEP_SECONDS=2

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--workflow|-w)
      WORKFLOW_FILE="$2"
      shift 2
      ;;
    -H|--host)
      HOST="$2"
      shift 2
      ;;
    -p|--port)
      PORT="$2"
      shift 2
      ;;
    --scheme)
      SCHEME="$2"
      shift 2
      ;;
    --url)
      BASE_URL="${2%/}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --export-dir)
      EXPORT_DIR="$2"
      shift 2
      ;;
    -s|--sleep)
      SLEEP_SECONDS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$WORKFLOW_FILE" ]]; then
  echo "--workflow is required." >&2
  usage
  exit 1
fi

if [[ ! -f "$WORKFLOW_FILE" ]]; then
  echo "Workflow file '$WORKFLOW_FILE' not found." >&2
  exit 1
fi

ensure_command curl
ensure_command jq

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "$BASE_URL" ]]; then
  BASE_URL="${SCHEME}://${HOST}:${PORT}"
else
  BASE_URL="${BASE_URL%/}"
fi

CLIENT_ID="${COMFY_CLIENT_ID:-$(cat /proc/sys/kernel/random/uuid)}"
PAYLOAD=$(jq -n --arg client_id "$CLIENT_ID" --slurpfile prompt "$WORKFLOW_FILE" '{prompt: $prompt[0], client_id: $client_id}')

QUEUE_RESPONSE=$(curl -sS -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$BASE_URL/prompt")
PROMPT_ID=$(printf '%s' "$QUEUE_RESPONSE" | jq -r '.prompt_id // .promptId // .id // empty')

if [[ -z "$PROMPT_ID" ]]; then
  echo "Failed to retrieve prompt ID from response: $QUEUE_RESPONSE" >&2
  exit 1
fi

echo "Queued workflow with prompt ID $PROMPT_ID (client: $CLIENT_ID)."

declare -i attempt=0
STATUS_LABEL="queued"
COMPLETED="false"
FAILED="false"

while true; do
  ((attempt++))
  sleep "$SLEEP_SECONDS"

  QUEUE_JSON=$(curl -sS "$BASE_URL/queue" || true)
  PENDING_INDEX=""
  QUEUE_INDEX=""
  if [[ -n "$QUEUE_JSON" ]]; then
    PENDING_INDEX=$(printf '%s' "$QUEUE_JSON" | jq -r --arg id "$PROMPT_ID" '((.pending // []) | map(.prompt_id) | index($id)) // empty') || true
    QUEUE_INDEX=$(printf '%s' "$QUEUE_JSON" | jq -r --arg id "$PROMPT_ID" '((.queue // []) | map(.prompt_id) | index($id)) // empty') || true
  fi

  HISTORY_JSON=$(curl -sS "$BASE_URL/history/$PROMPT_ID" || true)
  HISTORY_NODE=""
  if [[ -n "$HISTORY_JSON" ]]; then
    HISTORY_NODE=$(printf '%s' "$HISTORY_JSON" | jq -c --arg id "$PROMPT_ID" '
      if type == "object" then
        if has("history") then (.history[$id] // empty)
        elif has($id) then (.[$id] // empty)
        else .
        end
      else empty
      end
    ') || true
  fi

  if [[ -n "$HISTORY_NODE" && "$HISTORY_NODE" != "null" ]]; then
    STATUS_LABEL=$(printf '%s' "$HISTORY_NODE" | jq -r '.status.status? // .status.state? // .status.text? // ""')
    COMPLETED=$(printf '%s' "$HISTORY_NODE" | jq -r '(.status.completed? // false) | tostring')
    FAILED=$(printf '%s' "$HISTORY_NODE" | jq -r '((.status.failed? // false) or (.status.status? == "error") or (.status.status? == "failed")) | tostring')
    PROGRESS=$(printf '%s' "$HISTORY_NODE" | jq -r '.status.progress? // empty')
  else
    STATUS_LABEL="queued"
    COMPLETED="false"
    FAILED="false"
    PROGRESS=""
  fi

  if [[ -n "$QUEUE_INDEX" ]]; then
    POSITION=$((QUEUE_INDEX + 1))
    echo "[Attempt $attempt] Waiting in queue position $POSITION (status: ${STATUS_LABEL:-unknown})."
  elif [[ -n "$PENDING_INDEX" ]]; then
    echo "[Attempt $attempt] Workflow is running (status: ${STATUS_LABEL:-unknown})."
  else
    if [[ "$COMPLETED" == "true" ]]; then
      echo "[Attempt $attempt] Workflow completed successfully."
    elif [[ "$FAILED" == "true" ]]; then
      echo "[Attempt $attempt] Workflow reported failure (status: ${STATUS_LABEL:-unknown})."
    else
      if [[ -n "$PROGRESS" && "$PROGRESS" != "null" ]]; then
        echo "[Attempt $attempt] Workflow progress: $PROGRESS (status: ${STATUS_LABEL:-unknown})."
      else
        echo "[Attempt $attempt] Workflow is waiting for completion (status: ${STATUS_LABEL:-unknown})."
      fi
    fi
  fi

  if [[ "$FAILED" == "true" ]]; then
    ERROR_MESSAGE=""
    if [[ -n "$HISTORY_NODE" && "$HISTORY_NODE" != "null" ]]; then
      ERROR_MESSAGE=$(printf '%s' "$HISTORY_NODE" | jq -r '.status.error? // .status.message? // empty')
    fi
    [[ -n "$ERROR_MESSAGE" ]] && echo "Error details: $ERROR_MESSAGE" >&2
    exit 1
  fi

  if [[ "$COMPLETED" == "true" ]]; then
    break
  fi

done

if [[ -z "$HISTORY_NODE" || "$HISTORY_NODE" == "null" ]]; then
  HISTORY_JSON=$(curl -sS "$BASE_URL/history/$PROMPT_ID" || true)
  if [[ -n "$HISTORY_JSON" ]]; then
    HISTORY_NODE=$(printf '%s' "$HISTORY_JSON" | jq -c --arg id "$PROMPT_ID" '
      if type == "object" then
        if has("history") then (.history[$id] // empty)
        elif has($id) then (.[$id] // empty)
        else .
        end
      else empty
      end
    ') || true
  fi
fi

echo "Generated assets:"
if [[ -n "$HISTORY_NODE" && "$HISTORY_NODE" != "null" ]]; then
  ASSET_LINES=$(printf '%s' "$HISTORY_NODE" | jq -r '
    if .outputs then
      .outputs | to_entries[] | . as $entry |
      ($entry.value.images[]? | "- Node \($entry.key) image: \(.subfolder // ".")/\(.filename)") ,
      ($entry.value.gifs[]? | "- Node \($entry.key) gif: \(.subfolder // ".")/\(.filename)") ,
      ($entry.value.files[]? | "- Node \($entry.key) file: \(.subfolder // ".")/\(.filename)") ,
      ($entry.value.text[]? | "- Node \($entry.key) text: \(.text)")
    else
      empty
    end
  ')
  if [[ -n "$ASSET_LINES" ]]; then
    while IFS= read -r line; do
      printf '%s\n' "$line"
    done <<<"$ASSET_LINES"
  else
    echo "- No asset metadata was reported by ComfyUI."
  fi
else
  echo "- Unable to retrieve asset metadata."
fi

if [[ -n "$EXPORT_DIR" ]]; then
  if command -v test-export-outputs >/dev/null 2>&1; then
    echo "Exporting outputs to '$EXPORT_DIR' via test-export-outputs..."
    test-export-outputs "$EXPORT_DIR"
  else
    echo "test-export-outputs not found on PATH; skipping automatic export." >&2
  fi
fi

exit 0
