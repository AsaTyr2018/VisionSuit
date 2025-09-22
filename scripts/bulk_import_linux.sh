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

auth_info=$(python3 <<'PY' "$login_body"
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)

token = data.get('token')
user = data.get('user') or {}
role = user.get('role')

if not token:
    raise SystemExit('Token not found in login response')

print(token)
print(role or '')
PY
) || {
  log "Unable to extract authentication details from VisionSuit response."
  rm -f "$login_body"
  exit 1
}

rm -f "$login_body"

auth_token=$(printf '%s\n' "$auth_info" | sed -n '1p')
user_role=$(printf '%s\n' "$auth_info" | sed -n '2p')

if [ "${user_role:-}" != "ADMIN" ]; then
  log "Bulk import is restricted to admin accounts. Detected role: '${user_role:-unknown}'."
  exit 1
fi

log "Authenticated as $server_username (role: $user_role). Starting bulk upload via VisionSuit API."

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

  log "Uploading '$base_name' with preview '$(basename "$preview_path")'."

  request_payload=(
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
  request_payload+=(
    -F "files=@$(abs_path "$lora_file");type=$model_mime"
  )

  preview_mime=$(mime_type "$preview_path")
  request_payload+=(
    -F "files=@$(abs_path "$preview_path");type=$preview_mime"
  )

  response_file=$(mktemp)
  http_code=$(curl "${request_payload[@]}" -o "$response_file" -w '%{http_code}' "$upload_url") || {
    log "Upload request failed for '$base_name'."
    skip_count=$((skip_count + 1))
    rm -f "$response_file"
    continue
  }

  if [[ ! "$http_code" =~ ^2 ]]; then
    log "Upload failed for '$base_name' (HTTP $http_code): $(cat "$response_file")"
    skip_count=$((skip_count + 1))
    rm -f "$response_file"
    continue
  fi

  gallery_slug=$(python3 <<'PY' "$response_file"
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)

slug = data.get('gallerySlug')
print(slug or '')
PY
) || {
    log "Upload succeeded for '$base_name' but gallery slug could not be parsed."
    skip_count=$((skip_count + 1))
    rm -f "$response_file"
    continue
  }

  if [ -z "$gallery_slug" ]; then
    log "Upload succeeded for '$base_name' but gallery information was missing."
    skip_count=$((skip_count + 1))
    rm -f "$response_file"
    continue
  fi

  log "Model upload complete for '$base_name'. Gallery slug: $gallery_slug."
  rm -f "$response_file"

  total_images=${#other_images[@]}
  if [ "$total_images" -gt 0 ]; then
    max_batch=12
    uploaded_batches=0
    uploaded_images=0
    start_index=0
    batch_failed=false

    while [ "$start_index" -lt "$total_images" ]; do
      chunk=("${other_images[@]:$start_index:$max_batch}")
      chunk_count=${#chunk[@]}

      if [ "$chunk_count" -le 0 ]; then
        break
      fi

      batch_number=$((uploaded_batches + 1))
      batch_payload=(
        -sS
        -H "Authorization: Bearer $auth_token"
        --form-string "assetType=image"
        --form-string "context=gallery"
        --form-string "title=$base_name"
        --form-string "visibility=private"
        --form-string "galleryMode=existing"
        --form-string "targetGallery=$gallery_slug"
      )

      for img in "${chunk[@]}"; do
        img_mime=$(mime_type "$img")
        batch_payload+=(
          -F "files=@$(abs_path "$img");type=$img_mime"
        )
      done

      batch_response=$(mktemp)
      batch_code=$(curl "${batch_payload[@]}" -o "$batch_response" -w '%{http_code}' "$upload_url") || {
        log "Image batch $batch_number failed for '$base_name'."
        skip_count=$((skip_count + 1))
        rm -f "$batch_response"
        batch_failed=true
        break
      }

      if [[ ! "$batch_code" =~ ^2 ]]; then
        log "Image batch $batch_number failed for '$base_name' (HTTP $batch_code): $(cat "$batch_response")"
        skip_count=$((skip_count + 1))
        rm -f "$batch_response"
        batch_failed=true
        break
      fi

      rm -f "$batch_response"
      uploaded_batches=$((uploaded_batches + 1))
      uploaded_images=$((uploaded_images + chunk_count))
      log "Uploaded image batch $batch_number for '$base_name' ($chunk_count image(s))."
      start_index=$((start_index + chunk_count))
    done

    if [ "$batch_failed" = true ]; then
      continue
    fi

    log "Completed additional image uploads for '$base_name': $uploaded_images image(s) across $uploaded_batches batch(es)."
  else
    log "No additional images found for '$base_name'; only the preview was uploaded."
  fi

  upload_count=$((upload_count + 1))
done < <(find "$loras_dir" -maxdepth 1 -type f -name '*.safetensors' -print0)

log "Completed import run: $upload_count uploaded, $skip_count skipped."
