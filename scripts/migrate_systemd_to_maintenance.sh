#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="visionsuit-dev.service"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}"
WANTS_PATH="/etc/systemd/system/multi-user.target.wants/${SERVICE_NAME}"
MAINTENANCE_WRAPPER="/usr/local/bin/visionsuit-maintenance"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MAINTENANCE_SCRIPT="${ROOT_DIR}/maintenance.sh"

DRY_RUN=false
FORCE=false

info() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$1"
}

warn() {
  printf '\033[1;33m[warn]\033[0m %s\n' "$1"
}

success() {
  printf '\033[1;32m[ok]\033[0m %s\n' "$1"
}

error() {
  printf '\033[1;31m[err]\033[0m %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<USAGE
Usage: sudo $0 [--dry-run] [--force]

Disables the legacy ${SERVICE_NAME} unit, removes it from the systemd tree,
and configures the VisionSuit maintenance controller as the new operational entry point.

Options:
  --dry-run   Show the actions that would be executed without applying changes.
  --force     Continue even when the legacy service cannot be found. Helpful when
              the unit file was manually removed but enablement symlinks persist.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      ;;
  esac
done

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  error "This migration must be executed with root privileges. Re-run with sudo."
fi

if [[ ! -x "$MAINTENANCE_SCRIPT" ]]; then
  error "Maintenance controller not found at $MAINTENANCE_SCRIPT. Run this from the cloned repository."
fi

run() {
  if $DRY_RUN; then
    info "[dry-run] $*"
    return 0
  fi

  "$@"
}

systemd_available=true
if ! command -v systemctl >/dev/null 2>&1; then
  systemd_available=false
  warn "systemctl not found. Skipping systemd actions and only installing the maintenance wrapper."
fi

unit_exists=false
if $systemd_available; then
  if systemctl list-unit-files "$SERVICE_NAME" --no-legend >/dev/null 2>&1; then
    unit_exists=true
  elif [[ -f "$UNIT_PATH" ]]; then
    unit_exists=true
    warn "${SERVICE_NAME} is not registered with systemctl but the unit file exists."
  elif [[ -L "$WANTS_PATH" ]]; then
    warn "Enablement symlink detected without the primary unit file."
  fi
fi

if ! $unit_exists && ! $FORCE && $systemd_available; then
  warn "Legacy unit ${SERVICE_NAME} was not detected. Proceeding with maintenance wrapper installation."
fi

if $systemd_available && $unit_exists; then
  info "Stopping ${SERVICE_NAME}"
  if ! run systemctl stop "$SERVICE_NAME"; then
    warn "systemctl stop ${SERVICE_NAME} reported a non-zero exit code (likely already inactive)."
  fi

  info "Disabling ${SERVICE_NAME}"
  if ! run systemctl disable "$SERVICE_NAME"; then
    warn "systemctl disable ${SERVICE_NAME} reported a non-zero exit code."
  fi
fi

if [[ -e "$UNIT_PATH" ]]; then
  info "Removing unit file ${UNIT_PATH}"
  run rm -f "$UNIT_PATH"
fi

if [[ -L "$WANTS_PATH" ]]; then
  info "Removing enablement symlink ${WANTS_PATH}"
  run rm -f "$WANTS_PATH"
fi

if $systemd_available; then
  info "Reloading systemd daemon"
  run systemctl daemon-reload
fi

if [[ ! -d "$(dirname "$MAINTENANCE_WRAPPER")" ]]; then
  info "Creating $(dirname "$MAINTENANCE_WRAPPER")"
  run mkdir -p "$(dirname "$MAINTENANCE_WRAPPER")"
fi

if [[ -e "$MAINTENANCE_WRAPPER" && ! -w "$MAINTENANCE_WRAPPER" ]]; then
  error "Cannot update $MAINTENANCE_WRAPPER. Check permissions or remove the file manually."
fi

info "Installing maintenance controller wrapper at ${MAINTENANCE_WRAPPER}"
wrapper_contents="#!/usr/bin/env bash
exec \"${MAINTENANCE_SCRIPT}\" \"\$@\"
"

if $DRY_RUN; then
  printf '%s' "$wrapper_contents"
else
  printf '%s' "$wrapper_contents" >"$MAINTENANCE_WRAPPER"
  chmod +x "$MAINTENANCE_WRAPPER"
fi

success "Legacy systemd automation replaced. Use 'visionsuit-maintenance start|stop|status' to manage services."

if $DRY_RUN; then
  warn "No changes were made because --dry-run was supplied."
fi

info "Next steps"
cat <<NEXT
- Use 'visionsuit-maintenance start' to launch the backend and frontend service helpers.
- Review existing crontab or deployment tooling to ensure they call the new maintenance entry point instead of systemctl.
- Inspect '/etc/systemd/system' for any remaining VisionSuit units if you manage additional custom services.
NEXT
