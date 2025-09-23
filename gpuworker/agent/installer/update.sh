#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="/opt/visionsuit-gpu-agent"
CONFIG_DIR="/etc/visionsuit-gpu-agent"
SERVICE_NAME="visionsuit-gpu-agent.service"
SYSTEMD_DIR="/etc/systemd/system"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "This updater must be run as root." >&2
  exit 1
fi

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "Unable to locate a git repository at ${REPO_DIR}." >&2
  exit 1
fi

if [[ ! -d "${AGENT_ROOT}" ]]; then
  echo "Agent directory ${AGENT_ROOT} not found. Run the installer before attempting an update." >&2
  exit 1
fi

ORIGINAL_USER="${SUDO_USER:-}"

run_as_user() {
  local user="$1"
  shift
  if [[ -z "${user}" ]]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo -H -u "${user}" "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "${user}" -- "$@"
  else
    su - "${user}" -s /bin/bash -c "$(printf ' %q' "$@")"
  fi
}

echo "Updating VisionSuit repository at ${REPO_DIR}" 
if [[ -n "${ORIGINAL_USER}" ]]; then
  echo "Running git pull as ${ORIGINAL_USER}"
else
  echo "Running git pull as $(id -un)"
fi
run_as_user "${ORIGINAL_USER}" git -C "${REPO_DIR}" fetch --tags
run_as_user "${ORIGINAL_USER}" git -C "${REPO_DIR}" pull --ff-only

if [[ ! -d "${AGENT_SOURCE_DIR}" ]]; then
  echo "Source agent directory not found at ${AGENT_SOURCE_DIR}." >&2
  exit 1
fi

SERVICE_FILE="${SYSTEMD_DIR}/${SERVICE_NAME}"
AGENT_USER="${AGENT_USER:-}"
AGENT_GROUP="${AGENT_GROUP:-}"

if [[ -f "${SERVICE_FILE}" ]]; then
  if [[ -z "${AGENT_USER}" ]]; then
    AGENT_USER="$(awk -F= '/^User=/ {print $2}' "${SERVICE_FILE}" | tail -n 1)"
  fi
  if [[ -z "${AGENT_GROUP}" ]]; then
    AGENT_GROUP="$(awk -F= '/^Group=/ {print $2}' "${SERVICE_FILE}" | tail -n 1)"
  fi
fi

if [[ -z "${AGENT_USER}" ]]; then
  AGENT_USER="visionsuit"
fi
if [[ -z "${AGENT_GROUP}" ]]; then
  AGENT_GROUP="${AGENT_USER}"
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files | grep -E "^${SERVICE_NAME}[[:space:]]" >/dev/null 2>&1; then
    if systemctl is-active --quiet "${SERVICE_NAME}"; then
      echo "Stopping ${SERVICE_NAME}"
      systemctl stop "${SERVICE_NAME}"
    fi
  fi
fi

SYNC_EXCLUDES=(--exclude installer --exclude venv --exclude '__pycache__/')

if command -v rsync >/dev/null 2>&1; then
  echo "Syncing agent sources to ${AGENT_ROOT}"
  rsync -a --delete "${SYNC_EXCLUDES[@]}" "${AGENT_SOURCE_DIR}/" "${AGENT_ROOT}/"
else
  echo "rsync not available; falling back to tar copy" >&2
  tmp_tar="$(mktemp)"
  (cd "${AGENT_SOURCE_DIR}" && tar cf "${tmp_tar}" .)
  (cd "${AGENT_ROOT}" && tar xf "${tmp_tar}")
  rm -f "${tmp_tar}"
  find "${AGENT_ROOT}" -name '__pycache__' -type d -prune -exec rm -rf {} +
  rm -rf "${AGENT_ROOT}/installer"
fi

chown -R "${AGENT_USER}":"${AGENT_GROUP}" "${AGENT_ROOT}"

if [[ ! -x "${AGENT_ROOT}/venv/bin/pip" ]]; then
  echo "Virtual environment missing at ${AGENT_ROOT}/venv. Re-run the installer to recreate it." >&2
  exit 1
fi

run_as_user "${AGENT_USER}" "${AGENT_ROOT}/venv/bin/pip" install --upgrade pip
run_as_user "${AGENT_USER}" "${AGENT_ROOT}/venv/bin/pip" install --upgrade -r "${AGENT_ROOT}/requirements.txt"

if [[ -f "${AGENT_ROOT}/config/visionsuit-gpu-agent.service" ]]; then
  TEMP_SERVICE_UNIT="$(mktemp)"
  sed -e "s/@AGENT_USER@/${AGENT_USER}/g" \
      -e "s/@AGENT_GROUP@/${AGENT_GROUP}/g" \
      "${AGENT_ROOT}/config/visionsuit-gpu-agent.service" >"${TEMP_SERVICE_UNIT}"
  install -m 0644 "${TEMP_SERVICE_UNIT}" "${SYSTEMD_DIR}/${SERVICE_NAME}"
  rm -f "${TEMP_SERVICE_UNIT}"
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"
fi

echo "VisionSuit GPU agent update complete."
