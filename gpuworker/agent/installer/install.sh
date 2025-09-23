#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="/opt/visionsuit-gpu-agent"
CONFIG_DIR="/etc/visionsuit-gpu-agent"
SERVICE_NAME="visionsuit-gpu-agent.service"
SYSTEMD_DIR="/etc/systemd/system"
PYTHON_BIN="python3"

if [[ "${EUID}" -ne 0 ]]; then
  echo "This installer must be run as root." >&2
  exit 1
fi

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "python3 is required but was not found in PATH." >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files | grep -E "^${SERVICE_NAME}[[:space:]]" >/dev/null 2>&1; then
    echo "Stopping existing ${SERVICE_NAME} instance (if running)"
    if systemctl is-active --quiet "${SERVICE_NAME}"; then
      systemctl stop "${SERVICE_NAME}"
    fi
    echo "Disabling ${SERVICE_NAME}"
    systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
  fi
fi

if [[ -f "${SYSTEMD_DIR}/${SERVICE_NAME}" ]]; then
  echo "Removing existing systemd unit ${SYSTEMD_DIR}/${SERVICE_NAME}"
  rm -f "${SYSTEMD_DIR}/${SERVICE_NAME}"
fi

if [[ -d "${AGENT_ROOT}" ]]; then
  echo "Removing existing agent directory ${AGENT_ROOT}"
  rm -rf "${AGENT_ROOT}"
fi

install -d -o root -g root "${AGENT_ROOT}" "${CONFIG_DIR}"
install -d -o root -g root "${AGENT_ROOT}/workflows" "${AGENT_ROOT}/tmp"

if ! id visionsuit >/dev/null 2>&1; then
  useradd --system --home "${AGENT_ROOT}" --shell /usr/sbin/nologin visionsuit
fi

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude installer "${SOURCE_DIR}/" "${AGENT_ROOT}/"
else
  echo "rsync not found; falling back to cp." >&2
  find "${AGENT_ROOT}" -mindepth 1 -maxdepth 1 ! -name installer -exec rm -rf {} +
  cp -r "${SOURCE_DIR}"/* "${AGENT_ROOT}/"
  rm -rf "${AGENT_ROOT}/installer"
fi
chown -R visionsuit:visionsuit "${AGENT_ROOT}"

cd "${AGENT_ROOT}" || exit 1

if [[ ! -d venv ]]; then
  "${PYTHON_BIN}" -m venv venv
fi

source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

deactivate

if [[ ! -f "${CONFIG_DIR}/config.yaml" ]]; then
  cp "${AGENT_ROOT}/config/config.example.yaml" "${CONFIG_DIR}/config.yaml"
  chown visionsuit:visionsuit "${CONFIG_DIR}/config.yaml"
  chmod 640 "${CONFIG_DIR}/config.yaml"
  echo "A default configuration has been installed at ${CONFIG_DIR}/config.yaml. Please update it before starting the service."
fi

cp "${AGENT_ROOT}/config/visionsuit-gpu-agent.service" "${SYSTEMD_DIR}/${SERVICE_NAME}"
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo "VisionSuit GPU agent installation complete."
