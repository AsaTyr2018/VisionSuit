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
: "${MINIO_LORAS_BUCKET:?Set MINIO_LORAS_BUCKET in $ENV_FILE or the environment}"

TARGET_DIR="${1:-${LORA_ROOT:-/var/lib/comfyui/loras}}"
PREFIX="${MINIO_LORAS_PREFIX:-}"
REGION="${MINIO_REGION:-us-east-1}"
SCHEME_FLAG=()

if [[ "${MINIO_SECURE:-true}" == "false" ]]; then
  SCHEME_FLAG=("--no-verify-ssl")
fi

export AWS_ACCESS_KEY_ID="$MINIO_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$MINIO_SECRET_KEY"
export AWS_DEFAULT_REGION="$REGION"
export AWS_EC2_METADATA_DISABLED=true

mkdir -p "$TARGET_DIR"
FILTER_ARGS=()
if [[ -n "$PREFIX" ]]; then
  FILTER_ARGS+=("--exclude" "*" "--include" "$PREFIX*")
fi

aws --endpoint-url "$MINIO_ENDPOINT" "${SCHEME_FLAG[@]}" s3 sync \
  "s3://$MINIO_LORAS_BUCKET" "$TARGET_DIR" \
  --only-show-errors \
  "${FILTER_ARGS[@]}"

echo "LoRA weights synchronized to $TARGET_DIR"
