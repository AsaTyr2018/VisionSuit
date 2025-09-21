#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage: ${0##*/} [destination]

Downloads rendered outputs from the configured MinIO bucket for validation.
  destination   Local directory to write the files into (default: ./comfyui-test-outputs)
  -h, --help    Show this help message.
USAGE
}

DESTINATION="./comfyui-test-outputs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      DESTINATION="$1"
      shift
      ;;
  esac
done

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

mkdir -p "$DESTINATION"

SOURCE="s3://$MINIO_OUTPUTS_BUCKET"
PREFIX="${MINIO_OUTPUTS_PREFIX:-}"
if [[ -n "$PREFIX" ]]; then
  PREFIX="${PREFIX#/}"
  PREFIX="${PREFIX%/}"
  SOURCE="${SOURCE}/${PREFIX}"
fi

echo "Syncing outputs from '$SOURCE' to '$DESTINATION'..."
aws --endpoint-url "$MINIO_ENDPOINT" "${SCHEME_FLAG[@]}" s3 sync "$SOURCE" "$DESTINATION"
echo "Outputs downloaded to $DESTINATION"
