#!/usr/bin/env bash
# VisionSuit bulk import helper for Linux/macOS clients.
# Configure these connection settings before running the script.
server_ip="192.168.1.10"
server_username="admin@example.com"
server_port=4000

default_visibility=${VISIONSUIT_VISIBILITY:-private}
default_gallery_mode=${VISIONSUIT_GALLERY_MODE:-new}
default_category=${VISIONSUIT_CATEGORY:-}
default_description=${VISIONSUIT_DESCRIPTION:-}
default_gallery_target=${VISIONSUIT_TARGET_GALLERY:-}
default_trigger=${VISIONSUIT_TRIGGER:-}
default_tags=${VISIONSUIT_TAGS:-}

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

python_safe_json() {
  CONFIG_JSON="$1" python3 - "$2" <<'PY'
import json
import os
import sys

key = sys.argv[1]
raw = os.environ.get('CONFIG_JSON', '')
if not raw:
    print('')
    raise SystemExit(0)

data = json.loads(raw)
value = data.get(key)

if value is None:
    print('')
elif isinstance(value, str):
    print(value)
else:
    print(json.dumps(value, ensure_ascii=False))
PY
}

compute_upload_profile() {
  python3 - "$@" <<'PY'
import json
import os
import sys

(
    _script,
    base_name,
    metadata_candidate,
    default_visibility,
    default_gallery_mode,
    default_gallery_target,
    default_description,
    default_category,
    default_trigger,
    default_tags,
) = sys.argv

metadata_path = metadata_candidate if metadata_candidate else ''
metadata = {}

if metadata_path:
    if not os.path.isfile(metadata_path):
        metadata_path = ''
    else:
        try:
            with open(metadata_path, 'r', encoding='utf-8') as handle:
                loaded = json.load(handle)
        except json.JSONDecodeError as exc:  # pragma: no cover - defensive guard
            sys.stderr.write(
                f"Metadata file '{metadata_path}' is not valid JSON: {exc.msg} (line {exc.lineno}, column {exc.colno}).\n"
            )
            raise SystemExit(2)
        if isinstance(loaded, dict):
            metadata = loaded
        else:
            sys.stderr.write(f"Metadata file '{metadata_path}' must contain a JSON object.\n")
            raise SystemExit(2)

def normalize_str(value):
    if value is None:
        return ''
    if isinstance(value, (int, float)):
        return str(value)
    return str(value).strip()

def normalize_visibility(value):
    warnings = []
    normalized = value.strip().lower()
    if normalized not in {'public', 'private'}:
        warnings.append(
            f"Visibility '{value}' is not supported; falling back to 'private'."
        )
        normalized = 'private'
    return normalized, warnings

def normalize_gallery_mode(value, fallback):
    warnings = []
    normalized = value.strip().lower()
    if normalized not in {'new', 'existing'}:
        warnings.append(
            f"Gallery mode '{value}' is not supported; falling back to '{fallback}'."
        )
        normalized = fallback
    return normalized, warnings

def parse_tags(default_raw, metadata_value):
    collected = []

    def extend_from(value):
        if value is None:
            return
        if isinstance(value, (list, tuple, set)):
            for entry in value:
                if entry is None:
                    continue
                extend_from(entry)
            return
        text = str(value).strip()
        if not text:
            return
        if ',' in text:
            for part in text.split(','):
                extend_from(part)
        else:
            collected.append(text)

    extend_from(default_raw if default_raw else None)
    extend_from(metadata_value)

    normalized = []
    seen = set()
    for entry in collected:
        trimmed = entry.strip()
        if not trimmed:
            continue
        key = trimmed.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(trimmed)
    return normalized

title = normalize_str(metadata.get('title')) or base_name
description = metadata.get('description')
if description is None or not str(description).strip():
    description = default_description
else:
    description = str(description)

description = description or ''

visibility_source = normalize_str(metadata.get('visibility')) or default_visibility or 'private'
visibility, visibility_warnings = normalize_visibility(visibility_source)

fallback_gallery_mode = default_gallery_mode.strip().lower() if default_gallery_mode else 'new'
if fallback_gallery_mode not in {'new', 'existing'}:
    fallback_gallery_mode = 'new'

gallery_mode_source = normalize_str(metadata.get('galleryMode')) or fallback_gallery_mode
gallery_mode, gallery_warnings = normalize_gallery_mode(gallery_mode_source, fallback_gallery_mode)

category = normalize_str(metadata.get('category')) or default_category or ''

trigger = normalize_str(metadata.get('trigger')) or default_trigger or base_name
if not trigger:
    trigger = base_name

target_gallery_value = normalize_str(metadata.get('targetGallery')) or default_gallery_target or ''
if '{title}' in target_gallery_value:
    target_gallery_value = target_gallery_value.replace('{title}', title)

if gallery_mode == 'new':
    target_gallery = target_gallery_value or f"{title} Collection"
else:
    target_gallery = target_gallery_value

if gallery_mode == 'existing' and not target_gallery:
    sys.stderr.write(
        "Gallery mode is set to 'existing', but no target gallery slug or title was provided."
    )
    raise SystemExit(3)

tags = parse_tags(default_tags, metadata.get('tags'))

warnings = []
warnings.extend(visibility_warnings)
warnings.extend(gallery_warnings)

config = {
    'title': title,
    'description': description,
    'visibility': visibility,
    'galleryMode': gallery_mode,
    'targetGallery': target_gallery,
    'trigger': trigger,
    'category': category,
    'tags': tags,
    'metadataPath': metadata_path,
    'warnings': warnings,
}

print(json.dumps(config, ensure_ascii=False))
PY
}

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

  metadata_candidate=""
  candidate_from_lora_dir="$(dirname "$lora_file")/$base_name.json"
  candidate_from_root="$loras_dir/$base_name.json"
  if [ -f "$candidate_from_lora_dir" ]; then
    metadata_candidate="$candidate_from_lora_dir"
  elif [ -f "$candidate_from_root" ]; then
    metadata_candidate="$candidate_from_root"
  elif [ -f "$image_folder/metadata.json" ]; then
    metadata_candidate="$image_folder/metadata.json"
  fi

  tmp_config_err=$(mktemp)
  if ! config_json=$(compute_upload_profile "$base_name" "${metadata_candidate:-}" "$default_visibility" "$default_gallery_mode" "$default_gallery_target" "$default_description" "$default_category" "$default_trigger" "$default_tags" 2>"$tmp_config_err"); then
    error_message=$(tr -d '\r' <"$tmp_config_err" | tr '\n' ' ')
    rm -f "$tmp_config_err"
    log "Skipping '$base_name' because $error_message"
    skip_count=$((skip_count + 1))
    continue
  fi
  rm -f "$tmp_config_err"

  metadata_path=$(python_safe_json "$config_json" metadataPath)
  title=$(python_safe_json "$config_json" title)
  description=$(python_safe_json "$config_json" description)
  visibility=$(python_safe_json "$config_json" visibility)
  gallery_mode=$(python_safe_json "$config_json" galleryMode)
  target_gallery=$(python_safe_json "$config_json" targetGallery)
  trigger=$(python_safe_json "$config_json" trigger)
  category=$(python_safe_json "$config_json" category)
  tags_json=$(python_safe_json "$config_json" tags)
  warnings_json=$(python_safe_json "$config_json" warnings)

  tags=()
  if [ -n "$tags_json" ] && [ "$tags_json" != "[]" ]; then
    while IFS= read -r tag; do
      if [ -n "$tag" ]; then
        tags+=("$tag")
      fi
    done < <(python3 - "$tags_json" <<'PY'
import json
import sys

data = json.loads(sys.argv[1])
for entry in data:
    if isinstance(entry, str) and entry.strip():
        print(entry.strip())
PY
)
  fi

  if [ -n "$metadata_path" ]; then
    log "Loaded metadata overrides from $metadata_path"
  fi

  if [ -n "$warnings_json" ] && [ "$warnings_json" != "[]" ]; then
    while IFS= read -r warning; do
      if [ -n "$warning" ]; then
        log "Metadata warning for '$base_name': $warning"
      fi
    done < <(python3 - "$warnings_json" <<'PY'
import json
import sys

for entry in json.loads(sys.argv[1]):
    if isinstance(entry, str) and entry.strip():
        print(entry.strip())
PY
)
  fi

  if [ -z "$title" ]; then
    title="$base_name"
  fi

  if [ -z "$trigger" ]; then
    trigger="$base_name"
  fi

  if [ -z "$visibility" ]; then
    visibility="private"
  fi

  if [ "$gallery_mode" != "existing" ] && [ "$gallery_mode" != "new" ]; then
    gallery_mode="new"
  fi

  if [ -z "$target_gallery" ]; then
    if [ "$gallery_mode" = "new" ]; then
      target_gallery="$title Collection"
    else
      log "Skipping '$base_name' because no target gallery was provided for existing mode."
      skip_count=$((skip_count + 1))
      continue
    fi
  fi

  log "Uploading '$title' (source '$base_name') with preview '$(basename "$preview_path")'."

  request_payload=(
    -sS
    -H "Authorization: Bearer $auth_token"
    --form-string "assetType=lora"
    --form-string "context=asset"
    --form-string "title=$title"
    --form-string "visibility=$visibility"
    --form-string "galleryMode=$gallery_mode"
    --form-string "targetGallery=$target_gallery"
    --form-string "trigger=$trigger"
  )

  if [ -n "$description" ]; then
    request_payload+=(--form-string "description=$description")
  fi

  if [ -n "$category" ]; then
    request_payload+=(--form-string "category=$category")
  fi

  for tag in "${tags[@]}"; do
    request_payload+=(--form-string "tags=$tag")
  done

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
    log "Upload request failed for '$title'."
    skip_count=$((skip_count + 1))
    rm -f "$response_file"
    continue
  }

  if [[ ! "$http_code" =~ ^2 ]]; then
    log "Upload failed for '$title' (HTTP $http_code): $(cat "$response_file")"
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
    log "Upload succeeded for '$title' but gallery slug could not be parsed."
    skip_count=$((skip_count + 1))
    rm -f "$response_file"
    continue
  }

  if [ -z "$gallery_slug" ]; then
    log "Upload succeeded for '$title' but gallery information was missing."
    skip_count=$((skip_count + 1))
    rm -f "$response_file"
    continue
  fi

  log "Model upload complete for '$title' (source '$base_name'). Gallery slug: $gallery_slug."
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
        --form-string "title=$title"
        --form-string "visibility=$visibility"
        --form-string "galleryMode=existing"
        --form-string "targetGallery=$gallery_slug"
      )

      if [ -n "$description" ]; then
        batch_payload+=(--form-string "description=$description")
      fi

      if [ -n "$category" ]; then
        batch_payload+=(--form-string "category=$category")
      fi

      for tag in "${tags[@]}"; do
        batch_payload+=(--form-string "tags=$tag")
      done

      for img in "${chunk[@]}"; do
        img_mime=$(mime_type "$img")
        batch_payload+=(
          -F "files=@$(abs_path "$img");type=$img_mime"
        )
      done

      batch_response=$(mktemp)
      batch_code=$(curl "${batch_payload[@]}" -o "$batch_response" -w '%{http_code}' "$upload_url") || {
        log "Image batch $batch_number failed for '$title'."
        skip_count=$((skip_count + 1))
        rm -f "$batch_response"
        batch_failed=true
        break
      }

      if [[ ! "$batch_code" =~ ^2 ]]; then
        log "Image batch $batch_number failed for '$title' (HTTP $batch_code): $(cat "$batch_response")"
        skip_count=$((skip_count + 1))
        rm -f "$batch_response"
        batch_failed=true
        break
      fi

      rm -f "$batch_response"
      uploaded_batches=$((uploaded_batches + 1))
      uploaded_images=$((uploaded_images + chunk_count))
      log "Uploaded image batch $batch_number for '$title' ($chunk_count image(s))."
      start_index=$((start_index + chunk_count))
    done

    if [ "$batch_failed" = true ]; then
      continue
    fi

    log "Completed additional image uploads for '$title': $uploaded_images image(s) across $uploaded_batches batch(es)."
  else
    log "No additional images found for '$title'; only the preview was uploaded."
  fi

  upload_count=$((upload_count + 1))
done < <(find "$loras_dir" -maxdepth 1 -type f -name '*.safetensors' -print0)

log "Completed import run: $upload_count uploaded, $skip_count skipped."
