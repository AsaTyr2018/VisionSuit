#!/usr/bin/env bash
set -euo pipefail

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
: "${MINIO_MODELS_BUCKET:?Set MINIO_MODELS_BUCKET in $ENV_FILE or the environment}"
: "${MINIO_LORAS_BUCKET:?Set MINIO_LORAS_BUCKET in $ENV_FILE or the environment}"
: "${MINIO_OUTPUTS_BUCKET:?Set MINIO_OUTPUTS_BUCKET in $ENV_FILE or the environment}"

REGION="${MINIO_REGION:-us-east-1}"
SCHEME_FLAG=()
if [[ "${MINIO_SECURE:-true}" == "false" ]]; then
  SCHEME_FLAG=("--no-verify-ssl")
fi

export AWS_ACCESS_KEY_ID="$MINIO_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$MINIO_SECRET_KEY"
export AWS_DEFAULT_REGION="$REGION"
export AWS_EC2_METADATA_DISABLED=true

create_bucket() {
  local bucket="$1"

  if aws --endpoint-url "$MINIO_ENDPOINT" "${SCHEME_FLAG[@]}" s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    echo "Bucket '$bucket' already exists."
    return 0
  fi

  local create_args=(--bucket "$bucket")
  if [[ "$REGION" != "us-east-1" && -n "$REGION" ]]; then
    create_args+=(--create-bucket-configuration "LocationConstraint=$REGION")
  fi

  echo "Creating bucket '$bucket'..."
  aws --endpoint-url "$MINIO_ENDPOINT" "${SCHEME_FLAG[@]}" s3api create-bucket "${create_args[@]}"
  echo "Bucket '$bucket' created."
}

# Deduplicate buckets in case multiple roles share the same name.
declare -A PROCESSED=()
for bucket in "$MINIO_MODELS_BUCKET" "$MINIO_LORAS_BUCKET" "$MINIO_OUTPUTS_BUCKET"; do
  if [[ -z "$bucket" || -n "${PROCESSED[$bucket]:-}" ]]; then
    continue
  fi
  PROCESSED[$bucket]=1
  create_bucket "$bucket"
done

echo "All requested buckets are available."
