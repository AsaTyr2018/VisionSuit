#!/usr/bin/env bash
# VisionSuit bulk import helper for Linux/macOS clients.
# Configure these connection settings before running the script.
server_ip="192.168.1.10"
server_username="admin@example.com"
server_port=4000

set -euo pipefail

loras_dir=${1:-"./loras"}
images_dir=${2:-"./images"}

api_base="http://$server_ip:$server_port/api"
login_url="$api_base/auth/login"
upload_url="$api_base/uploads"

log() {
  printf '[%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "Missing required command: $1"
    exit 1
  fi
}

require_command curl
require_command python3

if [ ! -d "$loras_dir" ]; then
  log "LoRA directory '$loras_dir' was not found."
  exit 1
fi

if [ ! -d "$images_dir" ]; then
  log "Image directory '$images_dir' was not found."
  exit 1
fi

mime_type() {
  python3 <<'PY' "$1"
import mimetypes
import sys
from pathlib import Path

path = Path(sys.argv[1])
mime, _ = mimetypes.guess_type(str(path))
print(mime or 'application/octet-stream')
PY
}

abs_path() {
  python3 <<'PY' "$1"
import os
import sys

print(os.path.abspath(sys.argv[1]))
PY
}

password_from_env=${VISIONSUIT_PASSWORD:-}
if [ -n "$password_from_env" ]; then
  api_password="$password_from_env"
else
  read -r -s -p "Password for $server_username: " api_password
  echo
fi

if [ -z "${api_password:-}" ]; then
  log "Password is required to authenticate with VisionSuit."
  exit 1
fi

login_payload=$(python3 <<'PY' "$server_username" "$api_password"
import json
import sys

email = sys.argv[1]
password = sys.argv[2]
print(json.dumps({'email': email, 'password': password}))
PY
)

login_body=$(mktemp)
http_code=$(curl -sS -o "$login_body" -w '%{http_code}' -X POST "$login_url" \
  -H 'Content-Type: application/json' \
  -d "$login_payload") || {
  rm -f "$login_body"
  log "Login request to VisionSuit API failed."
  exit 1
}

if [ "$http_code" != "200" ]; then
  log "Authentication failed (HTTP $http_code): $(cat "$login_body")"
  rm -f "$login_body"
  exit 1
fi

auth_token=$(python3 <<'PY' "$login_body"
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)

token = data.get('token')
if not token:
    raise SystemExit('Token not found in login response')

print(token)
PY
) || {
  log "Unable to extract token from VisionSuit login response."
  rm -f "$login_body"
  exit 1
}

rm -f "$login_body"

log "Authenticated as $server_username. Starting bulk upload via VisionSuit API."

upload_count=0
skip_count=0

while IFS= read -r -d '' lora_file; do
  base_name=$(basename "$lora_file" ".safetensors")
  image_folder="$images_dir/$base_name"

  if [ ! -d "$image_folder" ]; then
    log "Skipping '$base_name' because matching image folder '$image_folder' is missing."
    skip_count=$((skip_count + 1))
    continue
  fi

  mapfile -d '' -t raw_images < <(find "$image_folder" -type f \
    \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.bmp' \) -print0)

  if [ "${#raw_images[@]}" -eq 0 ]; then
    log "Skipping '$base_name' because no preview-ready images were found."
    skip_count=$((skip_count + 1))
    continue
  fi

  sorted_images=()
  if [ "${#raw_images[@]}" -gt 0 ]; then
    while IFS= read -r -d '' path; do
      sorted_images+=("$path")
    done < <(printf '%s\0' "${raw_images[@]}" | sort -z)
  fi

  if [ "${#sorted_images[@]}" -eq 0 ]; then
    log "Skipping '$base_name' because image sorting failed."
    skip_count=$((skip_count + 1))
    continue
  fi

  preview_index=$((RANDOM % ${#sorted_images[@]}))
  preview_path="${sorted_images[$preview_index]}"

  other_images=()
  for img in "${sorted_images[@]}"; do
    if [ "$img" != "$preview_path" ]; then
      other_images+=("$img")
    fi
  done

  if [ "${#other_images[@]}" -gt 10 ]; then
    trimmed=$(( ${#other_images[@]} - 10 ))
    other_images=("${other_images[@]:0:10}")
    log "Limiting additional images for '$base_name' to 10 due to API file cap (trimmed $trimmed)."
  fi

  form_args=(
    -sS
    -H "Authorization: Bearer $auth_token"
    --form-string "assetType=lora"
    --form-string "context=asset"
    --form-string "title=$base_name"
    --form-string "visibility=private"
    --form-string "galleryMode=new"
    --form-string "targetGallery=$base_name Collection"
    --form-string "trigger=$base_name"
  )

  model_mime="application/octet-stream"
  form_args+=(
    -F "files=@$(abs_path "$lora_file");type=$model_mime"
  )

  preview_mime=$(mime_type "$preview_path")
  form_args+=(
    -F "files=@$(abs_path "$preview_path");type=$preview_mime"
  )

  for img in "${other_images[@]}"; do
    img_mime=$(mime_type "$img")
    form_args+=(
      -F "files=@$(abs_path "$img");type=$img_mime"
    )
  done

  response_file=$(mktemp)
  http_code=$(curl "${form_args[@]}" -o "$response_file" -w '%{http_code}' "$upload_url") || {
    log "Upload request failed for '$base_name'."
    skip_count=$((skip_count + 1))
    rm -f "$response_file"
    continue
  }

  if [[ "$http_code" =~ ^2 ]]; then
    log "Uploaded '$base_name' with preview '$(basename "$preview_path")'."
    upload_count=$((upload_count + 1))
  else
    log "Upload failed for '$base_name' (HTTP $http_code): $(cat "$response_file")"
    skip_count=$((skip_count + 1))
  fi

  rm -f "$response_file"
done < <(find "$loras_dir" -maxdepth 1 -type f -name '*.safetensors' -print0)

log "Completed import run: $upload_count uploaded, $skip_count skipped."
