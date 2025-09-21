#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "This installer must be run as root or with sudo." >&2
  exit 1
fi

COMFY_USER="${COMFY_USER:-comfyui}"
COMFY_GROUP="${COMFY_GROUP:-$COMFY_USER}"
COMFY_REPO="${COMFY_REPO:-https://github.com/comfyanonymous/ComfyUI.git}"
COMFY_BRANCH="${COMFY_BRANCH:-master}"
COMFY_DIR="${COMFY_DIR:-/opt/comfyui}"
COMFY_VENV="${COMFY_VENV:-$COMFY_DIR/.venv}"
MODEL_ROOT="${MODEL_ROOT:-/var/lib/comfyui/models}"
LORA_ROOT="${LORA_ROOT:-/var/lib/comfyui/loras}"
OUTPUT_ROOT="${OUTPUT_ROOT:-/var/lib/comfyui/outputs}"
BIN_ROOT="${BIN_ROOT:-/usr/local/lib/comfyui}"
SYMLINK_DIR="${SYMLINK_DIR:-/usr/local/bin}"
SERVICE_FILE="${SERVICE_FILE:-/etc/systemd/system/comfyui.service}"
MINIO_ENV_FILE="${MINIO_ENV_FILE:-/etc/comfyui/minio.env}"
MINIO_ENV_DIR="$(dirname "$MINIO_ENV_FILE")"
TORCH_PACKAGE_SPEC="${TORCH_PACKAGE_SPEC:-torch torchvision torchaudio}"
CUDA_TORCH_INDEX_URL="${CUDA_TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu121}"
ROCM_TORCH_INDEX_URL="${ROCM_TORCH_INDEX_URL:-https://download.pytorch.org/whl/rocm5.6}"
CPU_TORCH_INDEX_URL="${CPU_TORCH_INDEX_URL:-https://download.pytorch.org/whl/cpu}"
TORCH_INDEX_URL="${TORCH_INDEX_URL:-$CUDA_TORCH_INDEX_URL}"
GPU_VENDOR="${GPU_VENDOR:-unknown}"
SCRIPTS_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts"
SCRIPT_NAMES=(generate-model-manifest.sh sync-loras.sh upload-outputs.sh)
MINIO_TARGET_ENDPOINT="${MINIO_ENDPOINT:-}"
MINIO_TARGET_SECURE="${MINIO_SECURE:-}"

log() {
  printf '\n[%s] %s\n' "$(date --iso-8601=seconds)" "$*"
}

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}

ensure_aws_cli() {
  if command -v aws >/dev/null 2>&1; then
    log "AWS CLI already installed"
    return
  fi

  if apt-cache show awscli >/dev/null 2>&1; then
    log "Installing AWS CLI from APT"
    if apt-get install -y --no-install-recommends awscli; then
      return
    fi
    log "WARNING: Failed to install AWS CLI from APT; falling back to official bundle"
  else
    log "AWS CLI package not available in APT repositories; downloading official bundle"
  fi

  local arch
  arch="$(uname -m)"
  local bundle_url=""
  case "$arch" in
    x86_64|amd64)
      bundle_url="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"
      ;;
    aarch64|arm64)
      bundle_url="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip"
      ;;
    *)
      log "ERROR: Unsupported architecture $arch for AWS CLI bundle; install AWS CLI manually and re-run the installer."
      return 1
      ;;
  esac

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap "rm -rf \"$tmpdir\"" RETURN

  log "Installing AWS CLI v2 from official bundle"
  curl -sSL "$bundle_url" -o "$tmpdir/awscliv2.zip"
  unzip -q "$tmpdir/awscliv2.zip" -d "$tmpdir"
  "$tmpdir/aws/install" --update -i /usr/local/aws-cli -b /usr/local/bin
  rm -rf "$tmpdir"
  trap - RETURN
  log "AWS CLI v2 installation complete"
}

install_packages() {
  log "Installing system dependencies"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-venv \
    python3-pip \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    curl \
    wget \
    unzip \
    jq \
    pkg-config \
    pciutils \
    lsb-release \
    gnupg

  ensure_aws_cli

  if apt-cache show ubuntu-drivers-common >/dev/null 2>&1; then
    apt-get install -y --no-install-recommends ubuntu-drivers-common
  else
    log "WARNING: ubuntu-drivers-common not available in APT sources; NVIDIA driver recommendations will use the default fallback."
  fi
}

detect_gpu_vendor() {
  if [[ "$GPU_VENDOR" != "unknown" ]]; then
    log "GPU vendor preset to $GPU_VENDOR; skipping auto-detection"
    return
  fi

  if command -v nvidia-smi >/dev/null 2>&1; then
    GPU_VENDOR="nvidia"
    log "Detected NVIDIA GPU via nvidia-smi"
    return
  fi

  if command -v rocminfo >/dev/null 2>&1 || command -v rocm-smi >/dev/null 2>&1; then
    GPU_VENDOR="amd"
    log "Detected AMD GPU via ROCm utilities"
    return
  fi

  if command -v lspci >/dev/null 2>&1; then
    if lspci | grep -qi 'NVIDIA'; then
      GPU_VENDOR="nvidia"
      log "Detected NVIDIA GPU via lspci"
      return
    fi
    if lspci | grep -Eqi 'VGA.*(AMD|ATI)|3D.*(AMD|ATI)|Display.*(AMD|ATI)'; then
      GPU_VENDOR="amd"
      log "Detected AMD GPU via lspci"
      return
    fi
  fi

  GPU_VENDOR="none"
  log "No supported discrete GPU detected"
}

install_nvidia_driver() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    log "NVIDIA driver already present (nvidia-smi detected)"
    return
  fi

  log "Installing NVIDIA GPU driver"
  local recommended_driver=""
  if command -v ubuntu-drivers >/dev/null 2>&1; then
    recommended_driver="$(ubuntu-drivers devices 2>/dev/null | awk '/recommended/ {print $3; exit}')"
  fi

  if [[ -n "$recommended_driver" ]]; then
    log "Installing recommended driver: $recommended_driver"
    if ! apt-get install -y "$recommended_driver"; then
      log "WARNING: Failed to install $recommended_driver. Falling back to nvidia-driver-535."
      if ! apt-get install -y nvidia-driver-535; then
        log "WARNING: Failed to install nvidia-driver-535 as a fallback. Please install NVIDIA drivers manually."
      fi
    fi
  else
    log "Falling back to default NVIDIA driver package (nvidia-driver-535)"
    if ! apt-get install -y nvidia-driver-535; then
      log "WARNING: Failed to install nvidia-driver-535. Please install NVIDIA drivers manually."
    fi
  fi

  if command -v nvidia-smi >/dev/null 2>&1; then
    log "NVIDIA driver installation complete"
  else
    log "WARNING: NVIDIA driver installation did not expose nvidia-smi. Reboot or manual intervention may be required."
  fi
}

add_amd_repositories() {
  local release="$(lsb_release -cs 2>/dev/null || echo jammy)"
  case "$release" in
    jammy|focal|noble)
      ;;
    *)
      log "WARNING: AMD repositories do not officially list $release. Falling back to jammy packages."
      release="jammy"
      ;;
  esac
  local keyring="/usr/share/keyrings/amd-rocm.gpg"
  if [[ ! -f "$keyring" ]]; then
    log "Adding AMD ROCm repository key"
    wget -qO- https://repo.radeon.com/rocm/rocm.gpg.key | gpg --dearmor >"$keyring"
  fi

  cat <<EOF >/etc/apt/sources.list.d/amdgpu.list
deb [arch=amd64 signed-by=$keyring] https://repo.radeon.com/amdgpu/latest/ubuntu $release main
EOF

  cat <<EOF >/etc/apt/sources.list.d/rocm.list
deb [arch=amd64 signed-by=$keyring] https://repo.radeon.com/rocm/apt/debian/ $release main
EOF

  apt-get update -y
}

install_amd_driver() {
  if command -v rocminfo >/dev/null 2>&1 || command -v rocm-smi >/dev/null 2>&1; then
    log "AMD ROCm runtime already present"
    return
  fi

  log "Installing AMD GPU driver and ROCm runtime"
  add_amd_repositories

  if ! apt-get install -y --no-install-recommends amdgpu-dkms hip-runtime-amd rocm-hip-runtime rocminfo; then
    log "WARNING: Failed to install AMD ROCm packages. Verify repository support for your distribution."
  else
    log "AMD ROCm runtime installation complete"
  fi
}

configure_torch_runtime() {
  case "$GPU_VENDOR" in
    nvidia)
      TORCH_INDEX_URL="$CUDA_TORCH_INDEX_URL"
      log "Configuring PyTorch wheels for NVIDIA GPUs via $TORCH_INDEX_URL"
      install_nvidia_driver
      ;;
    amd)
      TORCH_INDEX_URL="$ROCM_TORCH_INDEX_URL"
      log "Configuring PyTorch wheels for AMD GPUs via $TORCH_INDEX_URL"
      install_amd_driver
      ;;
    none)
      TORCH_INDEX_URL="$CPU_TORCH_INDEX_URL"
      log "No discrete GPU detected. Installing CPU-only PyTorch wheels via $TORCH_INDEX_URL"
      ;;
    *)
      TORCH_INDEX_URL="$CPU_TORCH_INDEX_URL"
      log "Unable to detect GPU vendor. Defaulting to CPU PyTorch wheels via $TORCH_INDEX_URL"
      ;;
  esac
}

ensure_user() {
  if ! id "$COMFY_USER" &>/dev/null; then
    log "Creating system user $COMFY_USER"
    useradd --system --create-home --shell /usr/sbin/nologin "$COMFY_USER"
  fi
}

clone_repo() {
  if [[ -d "$COMFY_DIR/.git" ]]; then
    log "Updating existing ComfyUI checkout"
    git -C "$COMFY_DIR" fetch origin
    git -C "$COMFY_DIR" checkout "$COMFY_BRANCH"
    git -C "$COMFY_DIR" pull --ff-only origin "$COMFY_BRANCH"
  else
    log "Cloning ComfyUI into $COMFY_DIR"
    install -d -m 0755 "$COMFY_DIR"
    git clone --branch "$COMFY_BRANCH" "$COMFY_REPO" "$COMFY_DIR"
  fi
  chown -R "$COMFY_USER":"$COMFY_GROUP" "$COMFY_DIR"
}

setup_python() {
  log "Configuring Python virtual environment"
  python3 -m venv "$COMFY_VENV"
  source "$COMFY_VENV/bin/activate"
  pip install --upgrade pip wheel setuptools
  if [[ -f "$COMFY_DIR/requirements.txt" ]]; then
    pip install -r "$COMFY_DIR/requirements.txt"
  fi
  if [[ -n "$TORCH_PACKAGE_SPEC" ]]; then
    log "Installing PyTorch packages via $TORCH_INDEX_URL"
    pip install --index-url "$TORCH_INDEX_URL" $TORCH_PACKAGE_SPEC
  fi
  pip install --upgrade xformers || true
  deactivate
  chown -R "$COMFY_USER":"$COMFY_GROUP" "$COMFY_VENV"
}

prepare_directories() {
  log "Ensuring asset directories exist"
  install -d -m 0775 "$MODEL_ROOT"
  install -d -m 0775 "$LORA_ROOT"
  install -d -m 0775 "$OUTPUT_ROOT"
  chown -R "$COMFY_USER":"$COMFY_GROUP" "$MODEL_ROOT" "$LORA_ROOT" "$OUTPUT_ROOT"
}

install_support_scripts() {
  log "Installing MinIO helper scripts"
  install -d -m 0755 "$BIN_ROOT"
  for script in "${SCRIPT_NAMES[@]}"; do
    if [[ -f "$SCRIPTS_SRC_DIR/$script" ]]; then
      install -m 0755 "$SCRIPTS_SRC_DIR/$script" "$BIN_ROOT/$script"
      ln -sf "$BIN_ROOT/$script" "$SYMLINK_DIR/${script%.sh}"
    else
      log "WARNING: Missing helper script $script in $SCRIPTS_SRC_DIR"
    fi
  done
}

prompt_minio_endpoint() {
  if [[ -n "$MINIO_TARGET_ENDPOINT" ]]; then
    log "Using MinIO endpoint from environment: $MINIO_TARGET_ENDPOINT"
  else
    if [[ ! -t 0 ]]; then
      echo "MINIO_ENDPOINT must be supplied when running non-interactively." >&2
      exit 1
    fi
    echo
    echo "MinIO configuration"
    echo "-------------------"
    echo "Enter the MinIO endpoint URL that this worker should target."
    echo "Example: http://192.168.1.10:9000"
    while true; do
      read -rp "MinIO endpoint: " user_input
      if [[ -n "$user_input" ]]; then
        break
      fi
      echo "A MinIO endpoint (IP or hostname) is required."
    done
    if [[ "$user_input" != *"://"* ]]; then
      user_input="http://$user_input"
    fi
    MINIO_TARGET_ENDPOINT="${user_input%/}"
    log "Captured MinIO endpoint: $MINIO_TARGET_ENDPOINT"
  fi

  if [[ -z "$MINIO_TARGET_SECURE" ]]; then
    if [[ "$MINIO_TARGET_ENDPOINT" =~ ^https:// ]]; then
      MINIO_TARGET_SECURE="true"
    else
      MINIO_TARGET_SECURE="false"
    fi
  fi
}

stage_minio_env() {
  install -d -m 0750 "$MINIO_ENV_DIR"
  if [[ ! -f "$MINIO_ENV_FILE" ]]; then
    log "Creating MinIO environment template at $MINIO_ENV_FILE"
    cat <<EOT >"$MINIO_ENV_FILE"
# Populate with production credentials before starting ComfyUI
MINIO_ENDPOINT="$MINIO_TARGET_ENDPOINT"
MINIO_REGION="us-east-1"
MINIO_ACCESS_KEY="change-me"
MINIO_SECRET_KEY="change-me"
MINIO_MODELS_BUCKET="comfyui-models"
MINIO_LORAS_BUCKET="comfyui-loras"
MINIO_OUTPUTS_BUCKET="comfyui-outputs"
MINIO_SECURE="$MINIO_TARGET_SECURE"
EOT
    chmod 0640 "$MINIO_ENV_FILE"
  else
    log "Updating MinIO endpoint in $MINIO_ENV_FILE"
    local escaped_endpoint
    escaped_endpoint="$(escape_sed_replacement "$MINIO_TARGET_ENDPOINT")"
    if grep -q '^MINIO_ENDPOINT=' "$MINIO_ENV_FILE"; then
      sed -i -E "s|^MINIO_ENDPOINT=.*|MINIO_ENDPOINT=\"$escaped_endpoint\"|" "$MINIO_ENV_FILE"
    else
      printf '\nMINIO_ENDPOINT="%s"\n' "$MINIO_TARGET_ENDPOINT" >>"$MINIO_ENV_FILE"
    fi

    local escaped_secure
    escaped_secure="$(escape_sed_replacement "$MINIO_TARGET_SECURE")"
    if grep -q '^MINIO_SECURE=' "$MINIO_ENV_FILE"; then
      sed -i -E "s|^MINIO_SECURE=.*|MINIO_SECURE=\"$escaped_secure\"|" "$MINIO_ENV_FILE"
    else
      printf 'MINIO_SECURE="%s"\n' "$MINIO_TARGET_SECURE" >>"$MINIO_ENV_FILE"
    fi
  fi
  chown -R "$COMFY_USER":"$COMFY_GROUP" "$MINIO_ENV_DIR"
}

install_service() {
  log "Writing comfyui systemd service"
  cat <<EOF2 >"$SERVICE_FILE"
[Unit]
Description=ComfyUI headless worker
After=network-online.target
Wants=network-online.target

[Service]
User=$COMFY_USER
Group=$COMFY_GROUP
WorkingDirectory=$COMFY_DIR
EnvironmentFile=$MINIO_ENV_FILE
Environment=COMFYUI_MODEL_DIR=$MODEL_ROOT
Environment=COMFYUI_LORA_DIR=$LORA_ROOT
Environment=COMFYUI_OUTPUT_DIR=$OUTPUT_ROOT
Environment=PYTHONUNBUFFERED=1
ExecStart=$COMFY_VENV/bin/python main.py --listen 0.0.0.0 --disable-auto-launch --port 8188
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF2
  systemctl daemon-reload
  log "Enable with: systemctl enable --now comfyui.service"
}

main() {
  install_packages
  detect_gpu_vendor
  configure_torch_runtime
  ensure_user
  clone_repo
  setup_python
  prepare_directories
  prompt_minio_endpoint
  install_support_scripts
  stage_minio_env
  install_service
  log "Installation complete. Populate $MINIO_ENV_FILE with MinIO credentials before starting the service."
}

main "$@"
