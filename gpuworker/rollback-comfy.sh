#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "This rollback must be executed with root privileges." >&2
  exit 1
fi

COMFY_USER="${COMFY_USER:-comfyui}"
COMFY_GROUP="${COMFY_GROUP:-$COMFY_USER}"
COMFY_DIR="${COMFY_DIR:-/opt/comfyui}"
COMFY_VENV="${COMFY_VENV:-$COMFY_DIR/.venv}"
MODEL_ROOT_DEFAULT="$COMFY_DIR/models"
MODEL_ROOT="${MODEL_ROOT:-$MODEL_ROOT_DEFAULT}"
LORA_ROOT_DEFAULT="$MODEL_ROOT/loras"
LORA_ROOT="${LORA_ROOT:-$LORA_ROOT_DEFAULT}"
OUTPUT_ROOT_DEFAULT="$COMFY_DIR/output"
OUTPUT_ROOT="${OUTPUT_ROOT:-$OUTPUT_ROOT_DEFAULT}"
BIN_ROOT="${BIN_ROOT:-/usr/local/lib/comfyui}"
SYMLINK_DIR="${SYMLINK_DIR:-/usr/local/bin}"
SERVICE_FILE="${SERVICE_FILE:-/etc/systemd/system/comfyui.service}"
MINIO_ENV_FILE="${MINIO_ENV_FILE:-/etc/comfyui/minio.env}"
MINIO_ENV_DIR="$(dirname "$MINIO_ENV_FILE")"
SCRIPT_NAMES=(generate-model-manifest.sh sync-checkpoints.sh sync-loras.sh upload-outputs.sh)

DRY_RUN=false
ASSUME_YES=false

log() {
  local level="$1"; shift
  printf '[%s] %s\n' "$level" "$*"
}

usage() {
  cat <<'USAGE'
Usage: rollback-comfy.sh [options]

Removes the ComfyUI worker stack installed via gpuworker/install.sh. System
packages remain untouched; only ComfyUI assets, virtual environments, helper
scripts, MinIO configuration, and the systemd service are removed.

Options:
  -y, --yes       Run without interactive confirmation.
  -n, --dry-run   Show the planned actions without deleting files.
  -h, --help      Display this help message.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)
      ASSUME_YES=true
      shift
      ;;
    -n|--dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
done

confirm() {
  if $ASSUME_YES; then
    return
  fi
  read -r -p "Rollback ComfyUI installation at $COMFY_DIR? [y/N] " response
  case "$response" in
    [yY]|[yY][eE][sS])
      ;;
    *)
      log INFO "Aborted by user"
      exit 0
      ;;
  esac
}

remove_path() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    if $DRY_RUN; then
      log INFO "Would remove $path"
    else
      rm -rf "$path"
      log INFO "Removed $path"
    fi
  fi
}

remove_helper_link() {
  local link_path="$1"
  local target_path="$2"
  if [[ -L "$link_path" ]]; then
    if $DRY_RUN; then
      log INFO "Would remove helper $link_path"
    else
      rm -f "$link_path"
      log INFO "Removed helper $link_path"
    fi
    return
  fi

  if [[ -f "$link_path" ]]; then
    local resolved
    resolved="$(readlink -f "$link_path" 2>/dev/null || true)"
    if [[ "$resolved" == "$target_path" ]]; then
      if $DRY_RUN; then
        log INFO "Would remove helper $link_path"
      else
        rm -f "$link_path"
        log INFO "Removed helper $link_path"
      fi
    fi
  fi
}

stop_service() {
  local service_name
  service_name="$(basename "$SERVICE_FILE")"
  if ! command -v systemctl >/dev/null 2>&1; then
    return
  fi
  if $DRY_RUN; then
    if systemctl list-unit-files 2>/dev/null | grep -Fq "$service_name"; then
      log INFO "Would stop and disable $service_name"
    fi
    return
  fi

  if systemctl list-unit-files 2>/dev/null | grep -Fq "$service_name"; then
    if systemctl is-active --quiet "$service_name"; then
      systemctl stop "$service_name" || log WARN "Failed to stop $service_name"
    fi
    systemctl disable "$service_name" 2>/dev/null || true
  fi
}

remove_service_file() {
  local service_name
  service_name="$(basename "$SERVICE_FILE")"
  if $DRY_RUN; then
    if [[ -f "$SERVICE_FILE" ]]; then
      log INFO "Would remove $SERVICE_FILE"
      if command -v systemctl >/dev/null 2>&1; then
        log INFO "Would run systemctl daemon-reload"
      fi
    fi
    return
  fi

  if [[ -f "$SERVICE_FILE" ]]; then
    rm -f "$SERVICE_FILE"
    log INFO "Removed $SERVICE_FILE"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload || log WARN "systemctl daemon-reload failed"
    fi
  fi
}

remove_user_and_group() {
  if $DRY_RUN; then
    if id "$COMFY_USER" &>/dev/null; then
      log INFO "Would remove system user $COMFY_USER"
    fi
    if getent group "$COMFY_GROUP" >/dev/null 2>&1; then
      log INFO "Would remove group $COMFY_GROUP if no other members remain"
    fi
    return
  fi

  if id "$COMFY_USER" &>/dev/null; then
    if userdel --remove "$COMFY_USER" 2>/dev/null; then
      log INFO "Removed system user $COMFY_USER"
    else
      log WARN "Failed to remove user $COMFY_USER; remove manually if desired"
    fi
  fi

  if getent group "$COMFY_GROUP" >/dev/null 2>&1; then
    local members
    members="$(getent group "$COMFY_GROUP" | awk -F: '{print $4}')"
    if [[ -z "$members" ]]; then
      if groupdel "$COMFY_GROUP" 2>/dev/null; then
        log INFO "Removed group $COMFY_GROUP"
      else
        log WARN "Failed to remove group $COMFY_GROUP; remove manually if desired"
      fi
    else
      log WARN "Group $COMFY_GROUP still has members ($members); skipping removal"
    fi
  fi
}

confirm

log INFO "Stopping systemd service if present"
stop_service
remove_service_file

log INFO "Removing helper scripts"
for script in "${SCRIPT_NAMES[@]}"; do
  remove_path "$BIN_ROOT/$script"
  remove_helper_link "$SYMLINK_DIR/${script%.sh}" "$BIN_ROOT/$script"
done

log INFO "Removing MinIO environment"
remove_path "$MINIO_ENV_FILE"
if [[ -d "$MINIO_ENV_DIR" ]]; then
  if $DRY_RUN; then
    log INFO "Would remove directory $MINIO_ENV_DIR if empty"
  else
    rmdir "$MINIO_ENV_DIR" 2>/dev/null && log INFO "Removed empty directory $MINIO_ENV_DIR" || true
  fi
fi

log INFO "Removing ComfyUI directories"
remove_path "$OUTPUT_ROOT"
remove_path "$LORA_ROOT"
remove_path "$MODEL_ROOT"
remove_path "$COMFY_VENV"
remove_path "$COMFY_DIR"
remove_path "$BIN_ROOT"

log INFO "Removing system user and group if unused"
remove_user_and_group

log INFO "ComfyUI rollback complete"
