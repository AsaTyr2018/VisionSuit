#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="/opt/visionsuit-gpu-agent"
CONFIG_DIR="/etc/visionsuit-gpu-agent"
SERVICE_NAME="visionsuit-gpu-agent.service"
SYSTEMD_DIR="/etc/systemd/system"
PYTHON_BIN="python3"
AGENT_USER="${AGENT_USER:-visionsuit}"
AGENT_GROUP="${AGENT_GROUP:-$AGENT_USER}"

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

if ! getent group "${AGENT_GROUP}" >/dev/null 2>&1; then
  groupadd --system "${AGENT_GROUP}"
fi

if ! id "${AGENT_USER}" >/dev/null 2>&1; then
  if [[ "${AGENT_GROUP}" != "${AGENT_USER}" ]]; then
    useradd --system --home "${AGENT_ROOT}" --shell /usr/sbin/nologin --gid "${AGENT_GROUP}" "${AGENT_USER}"
  else
    useradd --system --home "${AGENT_ROOT}" --shell /usr/sbin/nologin "${AGENT_USER}"
  fi
else
  if ! id -nG "${AGENT_USER}" | tr ' ' '\n' | grep -Fx "${AGENT_GROUP}" >/dev/null 2>&1; then
    usermod -a -G "${AGENT_GROUP}" "${AGENT_USER}" >/dev/null 2>&1 || true
  fi
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
chown -R "${AGENT_USER}":"${AGENT_GROUP}" "${AGENT_ROOT}"

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
  chown "${AGENT_USER}":"${AGENT_GROUP}" "${CONFIG_DIR}/config.yaml"
  chmod 640 "${CONFIG_DIR}/config.yaml"
  echo "A default configuration has been installed at ${CONFIG_DIR}/config.yaml. Please update it before starting the service."
fi

CONFIG_SOURCE="${CONFIG_DIR}/config.yaml"
if [[ ! -f "${CONFIG_SOURCE}" ]]; then
  CONFIG_SOURCE="${AGENT_ROOT}/config/config.example.yaml"
fi

mapfile -t ACCESS_PATHS < <("${AGENT_ROOT}/venv/bin/python" - <<'PY' "${CONFIG_SOURCE}"
import sys
from pathlib import Path

try:
    import yaml  # type: ignore
except ModuleNotFoundError:
    raise SystemExit

config_path = Path(sys.argv[1])
if not config_path.exists():
    raise SystemExit

with config_path.open("r", encoding="utf-8") as handle:
    data = yaml.safe_load(handle) or {}

paths = set()
for key in ("base_models", "loras", "outputs", "workflows", "temp"):
    value = ((data.get("paths") or {}).get(key))
    if isinstance(value, str) and value:
        current = Path(value).resolve()
        for candidate in [current, *current.parents]:
            if str(candidate) == "/":
                continue
            paths.add(str(candidate))

if paths:
    print("\n".join(sorted(paths)))
PY
)

if ((${#ACCESS_PATHS[@]} > 0)); then
  if ! command -v setfacl >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -y >/dev/null 2>&1 || true
      apt-get install -y --no-install-recommends acl >/dev/null 2>&1 || true
    fi
  fi
  if command -v setfacl >/dev/null 2>&1; then
    echo "Granting ${AGENT_USER} access to ComfyUI asset directories"
    for path in "${ACCESS_PATHS[@]}"; do
      if [[ -d "${path}" ]]; then
        setfacl -m "u:${AGENT_USER}:rwx" "${path}" || true
        setfacl -d -m "u:${AGENT_USER}:rwx" "${path}" >/dev/null 2>&1 || true
      fi
    done
  else
    cat >&2 <<EOWARN
WARNING: Unable to locate the setfacl utility. The ${AGENT_USER} user may not have
permission to read or write the configured ComfyUI paths. Grant access manually or
re-run the installer after installing the "acl" package.
EOWARN
  fi
fi

SERVICE_TEMPLATE="${AGENT_ROOT}/config/visionsuit-gpu-agent.service"
TEMP_SERVICE_UNIT="$(mktemp)"
sed -e "s/@AGENT_USER@/${AGENT_USER}/g" -e "s/@AGENT_GROUP@/${AGENT_GROUP}/g" "${SERVICE_TEMPLATE}" >"${TEMP_SERVICE_UNIT}"
install -m 0644 "${TEMP_SERVICE_UNIT}" "${SYSTEMD_DIR}/${SERVICE_NAME}"
rm -f "${TEMP_SERVICE_UNIT}"

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo "VisionSuit GPU agent installation complete."
