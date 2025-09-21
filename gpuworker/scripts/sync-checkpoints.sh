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

DEFAULT_MODEL_ROOT="${MODEL_ROOT:-/var/lib/comfyui/models}"
DEFAULT_MODEL_ROOT="${DEFAULT_MODEL_ROOT%/}"
TARGET_DIR="${1:-$DEFAULT_MODEL_ROOT/checkpoints}"
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

mkdir -p "$TARGET_DIR"

SOURCE="s3://$MINIO_MODELS_BUCKET"
if [[ -n "$PREFIX" ]]; then
  TRIMMED_PREFIX="${PREFIX#/}"
  TRIMMED_PREFIX="${TRIMMED_PREFIX%/}"
  SOURCE="$SOURCE/$TRIMMED_PREFIX"
fi

aws --endpoint-url "$MINIO_ENDPOINT" "${SCHEME_FLAG[@]}" s3 sync \
  "$SOURCE" "$TARGET_DIR" \
  --only-show-errors

echo "Checkpoint models synchronized to $TARGET_DIR"
