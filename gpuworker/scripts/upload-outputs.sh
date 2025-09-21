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
: "${MINIO_OUTPUTS_BUCKET:?Set MINIO_OUTPUTS_BUCKET in $ENV_FILE or the environment}"

SOURCE_DIR="${1:-${OUTPUT_ROOT:-/var/lib/comfyui/outputs}}"
PREFIX="${MINIO_OUTPUTS_PREFIX:-}" 
REGION="${MINIO_REGION:-us-east-1}"
SCHEME_FLAG=()

if [[ "${MINIO_SECURE:-true}" == "false" ]]; then
  SCHEME_FLAG=("--no-verify-ssl")
fi

export AWS_ACCESS_KEY_ID="$MINIO_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$MINIO_SECRET_KEY"
export AWS_DEFAULT_REGION="$REGION"
export AWS_EC2_METADATA_DISABLED=true

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Output directory $SOURCE_DIR does not exist" >&2
  exit 1
fi

SYNC_DEST="s3://$MINIO_OUTPUTS_BUCKET/${PREFIX}" 
SYNC_DEST="${SYNC_DEST%/}"

aws --endpoint-url "$MINIO_ENDPOINT" "${SCHEME_FLAG[@]}" s3 sync \
  "$SOURCE_DIR" "$SYNC_DEST" \
  --acl private \
  --no-progress

echo "Outputs uploaded from $SOURCE_DIR to $SYNC_DEST"
