#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage: ${0##*/} [--models PATH] [--loras PATH]

Uploads local checkpoints and LoRA adapters into the MinIO buckets configured in /etc/comfyui/minio.env.
  --models PATH   File or directory containing checkpoint files to upload to the models bucket.
  --loras PATH    File or directory containing LoRA adapters to upload to the LoRA bucket.
  -h, --help      Show this help message.

Provide at least one of --models or --loras.
USAGE
}

MODELS_PATH=""
LORAS_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --models)
      MODELS_PATH="${2:-}"
      shift 2
      ;;
    --loras)
      LORAS_PATH="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$MODELS_PATH" && -z "$LORAS_PATH" ]]; then
  echo "Error: specify --models and/or --loras." >&2
  usage >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required. Install it before running this script." >&2
  exit 1
fi

ENV_FILE="${MINIO_ENV_FILE:-/etc/comfyui/minio.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${MINIO_ENDPOINT:?Set MINIO_ENDPOINT in $ENV_FILE or the environment}"
: "${MINIO_ACCESS_KEY:?Set MINIO_ACCESS_KEY in $ENV_FILE or the environment}"
: "${MINIO_SECRET_KEY:?Set MINIO_SECRET_KEY in $ENV_FILE or the environment}"

if [[ -n "$MODELS_PATH" ]]; then
  : "${MINIO_MODELS_BUCKET:?Set MINIO_MODELS_BUCKET in $ENV_FILE or the environment}"
fi
if [[ -n "$LORAS_PATH" ]]; then
  : "${MINIO_LORAS_BUCKET:?Set MINIO_LORAS_BUCKET in $ENV_FILE or the environment}"
fi

REGION="${MINIO_REGION:-us-east-1}"
SCHEME_FLAG=()
if [[ "${MINIO_SECURE:-true}" == "false" ]]; then
  SCHEME_FLAG=("--no-verify-ssl")
fi

export AWS_ACCESS_KEY_ID="$MINIO_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$MINIO_SECRET_KEY"
export AWS_DEFAULT_REGION="$REGION"
export AWS_EC2_METADATA_DISABLED=true

destination_uri() {
  local bucket="$1"
  local prefix="$2"
  local trimmed_prefix="${prefix#/}"
  trimmed_prefix="${trimmed_prefix%/}"
  if [[ -n "$trimmed_prefix" ]]; then
    echo "s3://$bucket/$trimmed_prefix/"
  else
    echo "s3://$bucket/"
  fi
}

upload_payload() {
  local label="$1"
  local path="$2"
  local bucket="$3"
  local prefix="$4"

  if [[ ! -e "$path" ]]; then
    echo "Error: $label source '$path' does not exist." >&2
    exit 1
  fi

  local destination
  destination=$(destination_uri "$bucket" "$prefix")

  echo "Uploading $label from '$path' to '$destination'..."
  if [[ -d "$path" ]]; then
    aws --endpoint-url "$MINIO_ENDPOINT" "${SCHEME_FLAG[@]}" s3 cp "$path" "$destination" --recursive
  else
    aws --endpoint-url "$MINIO_ENDPOINT" "${SCHEME_FLAG[@]}" s3 cp "$path" "$destination"
  fi
  echo "Uploaded $label to $destination"
}

if [[ -n "$MODELS_PATH" ]]; then
  upload_payload "checkpoints" "$MODELS_PATH" "$MINIO_MODELS_BUCKET" "${MINIO_MODELS_PREFIX:-}"
fi

if [[ -n "$LORAS_PATH" ]]; then
  upload_payload "LoRA adapters" "$LORAS_PATH" "$MINIO_LORAS_BUCKET" "${MINIO_LORAS_PREFIX:-}"
fi

echo "Upload complete."
