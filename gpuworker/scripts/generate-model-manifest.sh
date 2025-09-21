#!/usr/bin/env bash
set -euo pipefail

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
: "${MINIO_MODELS_BUCKET:?Set MINIO_MODELS_BUCKET in $ENV_FILE or the environment}"

COMFY_DIR="${COMFY_DIR:-/opt/comfyui}"
MANIFEST_PATH="${1:-$COMFY_DIR/config/minio-model-manifest.json}"
PREFIX="${MINIO_MODELS_PREFIX:-}"
REGION="${MINIO_REGION:-us-east-1}"
SCHEME_FLAG=()

if [[ "${MINIO_SECURE:-true}" == "false" ]]; then
  SCHEME_FLAG=("--no-verify-ssl")
fi

export AWS_ACCESS_KEY_ID="$MINIO_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$MINIO_SECRET_KEY"
export AWS_DEFAULT_REGION="$REGION"
export AWS_EC2_METADATA_DISABLED=true

mkdir -p "$(dirname "$MANIFEST_PATH")"

QUERY='Contents[].{"key":Key,"size":Size,"last_modified":LastModified}'
if [[ -n "$PREFIX" ]]; then
  FILTER=(--prefix "$PREFIX")
else
  FILTER=()
fi

aws --endpoint-url "$MINIO_ENDPOINT" "${SCHEME_FLAG[@]}" s3api list-objects-v2 \
  --bucket "$MINIO_MODELS_BUCKET" \
  "${FILTER[@]}" \
  --query "$QUERY" \
  --output json >"$MANIFEST_PATH.tmp"

if [[ ! -s "$MANIFEST_PATH.tmp" ]]; then
  echo "[]" >"$MANIFEST_PATH.tmp"
fi

mv "$MANIFEST_PATH.tmp" "$MANIFEST_PATH"
echo "Model manifest written to $MANIFEST_PATH"
