#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
DOCKER_COMPOSE_CMD=""
SERVER_IP=""
STARTUP_MODE="manual"
SYSTEMD_SERVICE_NAME="visionsuit-dev.service"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Fehler: Benötigtes Kommando '$1' wurde nicht gefunden." >&2
    echo "Bitte installiere es und führe das Skript anschließend erneut aus." >&2
    exit 1
  fi
}

detect_docker_compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker compose"
    return 0
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker-compose"
    return 0
  fi

  return 1
}

ensure_docker_requirements() {
  info "Prüfe Docker-Voraussetzungen"
  require_command docker

  if ! docker info >/dev/null 2>&1; then
    echo "Fehler: Docker-Daemon ist nicht verfügbar. Bitte stelle sicher, dass Docker läuft und du Zugriffsrechte besitzt." >&2
    exit 1
  fi

  if ! detect_docker_compose; then
    echo "Fehler: Weder 'docker compose' noch 'docker-compose' ist verfügbar." >&2
    echo "Bitte installiere Docker Compose (Plugin oder Legacy-Binary) und starte das Skript erneut." >&2
    exit 1
  fi

  success "Docker Compose erkannt (${DOCKER_COMPOSE_CMD})."
}

ensure_portainer() {
  local container_name="portainer"
  local volume_name="portainer_data"

  if docker container inspect "$container_name" >/dev/null 2>&1; then
    if ! docker ps --filter "name=^${container_name}$" --filter "status=running" --format '{{.Names}}' | grep -q "^${container_name}$"; then
      info "Starte vorhandenen Portainer-Container"
      docker start "$container_name" >/dev/null
    fi
    success "Portainer ist bereits installiert (https://$SERVER_IP:9443)."
    return
  fi

  if confirm "Portainer CE (Docker-Dashboard) installieren?"; then
    info "Installiere Portainer CE"
    if ! docker volume inspect "$volume_name" >/dev/null 2>&1; then
      docker volume create "$volume_name" >/dev/null
    fi
    docker run -d \
      --name "$container_name" \
      --restart unless-stopped \
      -p 8000:8000 \
      -p 9443:9443 \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$volume_name:/data" \
      portainer/portainer-ce:latest >/dev/null
    success "Portainer CE wurde gestartet (UI: https://$SERVER_IP:9443)."
  else
    info "Portainer-Installation übersprungen. Du kannst sie später jederzeit mit 'docker run portainer/portainer-ce' nachholen."
  fi
}

setup_minio_container() {
  local container_name="visionsuit-minio"
  local data_dir="$ROOT_DIR/docker-data/minio"
  local console_port="9001"

  if [[ "$minio_port" =~ ^[0-9]+$ ]]; then
    console_port="$((minio_port + 1))"
  fi

  mkdir -p "$data_dir"

  if docker container inspect "$container_name" >/dev/null 2>&1; then
    info "MinIO-Container '$container_name' existiert bereits."
    if confirm "Container mit neuer Konfiguration neu erstellen?"; then
      docker rm -f "$container_name" >/dev/null
    else
      if ! docker ps --filter "name=^${container_name}$" --filter "status=running" --format '{{.Names}}' | grep -q "^${container_name}$"; then
        docker start "$container_name" >/dev/null
      fi
      success "Vorhandener MinIO-Container wird weiterverwendet (Konsole: http://$SERVER_IP:$console_port)."
      return
    fi
  fi

  info "Starte MinIO über Docker"
  docker run -d \
    --name "$container_name" \
    --restart unless-stopped \
    -p "$minio_port:9000" \
    -p "$console_port:9001" \
    -v "$data_dir:/data" \
    -e MINIO_ROOT_USER="$minio_access_key" \
    -e MINIO_ROOT_PASSWORD="$minio_secret_key" \
    minio/minio server /data --console-address ":9001" >/dev/null
  success "MinIO läuft jetzt im Container '$container_name' (Konsole: http://$SERVER_IP:$console_port)."
}

info() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$1"
}

success() {
  printf '\033[1;32m✔\033[0m %s\n' "$1"
}

prompt_startup_mode() {
  info "Select how VisionSuit should start after installation"
  echo "  [1] Manual launch (run ./dev-start.sh yourself)"
  echo "  [2] Automatic launch via systemd service"

  local choice
  while true; do
    read -r -p "Startup mode [1]: " choice || true
    case "${choice:-1}" in
      1)
        STARTUP_MODE="manual"
        break
        ;;
      2)
        STARTUP_MODE="automatic"
        break
        ;;
      *)
        echo "Please enter 1 or 2."
        ;;
    esac
  done
}

print_manual_start_hint() {
  info "Manual startup selected"
  echo "Launch VisionSuit manually whenever needed:"
  echo "  HOST=${backend_host:-$SERVER_IP} BACKEND_PORT=${backend_port:-4000} FRONTEND_PORT=${frontend_port:-5173} ./dev-start.sh"
}

setup_systemd_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    info "systemd is not available on this host. Falling back to manual startup."
    STARTUP_MODE="manual"
    return
  fi

  local service_file="/etc/systemd/system/${SYSTEMD_SERVICE_NAME}"
  local service_user
  local service_group
  service_user="$(id -un)"
  service_group="$(id -gn)"

  info "Configuring systemd service (${SYSTEMD_SERVICE_NAME})"

  if [ -f "$service_file" ]; then
    info "An existing VisionSuit service definition was found."
    if confirm "Overwrite the existing service with the new configuration?"; then
      systemctl stop "$SYSTEMD_SERVICE_NAME" >/dev/null 2>&1 || true
      systemctl disable "$SYSTEMD_SERVICE_NAME" >/dev/null 2>&1 || true
    else
      if confirm "Restart the existing service now?"; then
        if systemctl restart "$SYSTEMD_SERVICE_NAME"; then
          success "VisionSuit service restarted."
        else
          info "Unable to restart the existing service. Please check systemctl status ${SYSTEMD_SERVICE_NAME}."
        fi
      else
        info "Keeping the current service definition."
      fi
      return
    fi
  fi

  local host_env
  host_env="${backend_host:-$SERVER_IP}"
  if [ -z "$host_env" ]; then
    host_env="0.0.0.0"
  fi

  if ! tee "$service_file" >/dev/null <<EOF
[Unit]
Description=VisionSuit stack (dev-start.sh)
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
User=$service_user
Group=$service_group
ExecStart=$ROOT_DIR/dev-start.sh
Environment=HOST=$host_env
Environment=BACKEND_PORT=${backend_port:-4000}
Environment=FRONTEND_PORT=${frontend_port:-5173}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  then
    info "Failed to write ${service_file}. Falling back to manual startup."
    STARTUP_MODE="manual"
    return
  fi

  if ! systemctl daemon-reload; then
    info "systemctl daemon-reload failed. Falling back to manual startup."
    STARTUP_MODE="manual"
    return
  fi

  if ! systemctl enable --now "$SYSTEMD_SERVICE_NAME"; then
    info "Failed to enable/start ${SYSTEMD_SERVICE_NAME}. Falling back to manual startup."
    STARTUP_MODE="manual"
    return
  fi

  success "VisionSuit systemd service enabled (${SYSTEMD_SERVICE_NAME})."
  info "Manage the service with 'systemctl status ${SYSTEMD_SERVICE_NAME}' or 'systemctl restart ${SYSTEMD_SERVICE_NAME}'."
}

configure_startup_mode() {
  if [ "$STARTUP_MODE" = "automatic" ]; then
    setup_systemd_service
    if [ "$STARTUP_MODE" != "automatic" ]; then
      print_manual_start_hint
    fi
  else
    print_manual_start_hint
  fi
}

prompt_default() {
  local prompt="$1"
  local default_value="$2"
  local answer
  read -r -p "$prompt [$default_value]: " answer || true
  if [ -z "$answer" ]; then
    answer="$default_value"
  fi
  printf '%s' "$answer"
}

generate_secret() {
  python3 - <<'PY'
import secrets

print(secrets.token_urlsafe(24))
PY
}

confirm() {
  local prompt="$1"
  local answer
  while true; do
    read -r -p "$prompt [y/N]: " answer || true
    case "${answer:-}" in
      [Yy]|[Yy][Ee][Ss]) return 0 ;;
      [Nn]|[Nn][Oo]|"") return 1 ;;
      *) echo "Bitte mit 'y' oder 'n' antworten." ;;
    esac
  done
}

is_valid_ipv4() {
  local ip="$1"
  if [[ ! $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    return 1
  fi

  IFS='.' read -r o1 o2 o3 o4 <<<"$ip"
  for octet in "$o1" "$o2" "$o3" "$o4"; do
    if [ "$octet" -lt 0 ] || [ "$octet" -gt 255 ]; then
      return 1
    fi
  done

  return 0
}

is_local_ipv4() {
  local ip="$1"
  case "$ip" in
    0.*|127.*|169.254.*) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_ipv4_with_default() {
  local prompt="$1"
  local default_value="$2"
  local value

  while true; do
    read -r -p "$prompt [$default_value]: " value || true
    if [ -z "$value" ]; then
      printf '%s' "$default_value"
      return
    fi

    if is_valid_ipv4 "$value" && ! is_local_ipv4 "$value"; then
      printf '%s' "$value"
      return
    fi

    echo "Bitte eine gültige Server-IP-Adresse (keine Loopback- oder Link-Local-IP) eingeben."
  done
}

prompt_for_ipv4() {
  local prompt="$1"
  local value

  while true; do
    read -r -p "$prompt: " value || true
    if is_valid_ipv4 "$value" && ! is_local_ipv4 "$value"; then
      printf '%s' "$value"
      return
    fi
    echo "Bitte eine gültige Server-IP-Adresse (keine Loopback- oder Link-Local-IP) eingeben."
  done
}

prompt_port_with_default() {
  local prompt="$1"
  local default_value="$2"
  local value

  while true; do
    read -r -p "$prompt [$default_value]: " value || true
    if [ -z "$value" ]; then
      printf '%s' "$default_value"
      return
    fi

    if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 65535 ]; then
      printf '%s' "$value"
      return
    fi

    echo "Bitte eine gültige Portnummer zwischen 1 und 65535 eingeben."
  done
}

mask_secret() {
  local value="$1"
  local length="${#value}"

  if [ "$length" -le 4 ]; then
    printf '****'
    return
  fi

  printf '%s***%s' "${value:0:2}" "${value: -2}"
}

detect_server_ip() {
  info "Ermittle Server-IP-Adresse"
  local -a candidates=()
  local line

  while IFS= read -r line; do
    candidates+=("$line")
  done < <(ip -4 -o addr show scope global 2>/dev/null | awk '!($2 ~ /^(docker|br-|veth|lo|cni|flannel|virbr|vz|lxc|kube|tun|tap)/) {print $4}' | cut -d'/' -f1 | sort -u)

  if [ "${#candidates[@]}" -eq 0 ]; then
    echo "Es konnte keine geeignete IP automatisch ermittelt werden."
    SERVER_IP="$(prompt_for_ipv4 "Bitte Server-IP-Adresse eingeben")"
    return
  fi

  if [ "${#candidates[@]}" -eq 1 ]; then
    local candidate="${candidates[0]}"
    echo "Gefundene IP-Adresse: $candidate"
    if confirm "Diese IP verwenden?"; then
      SERVER_IP="$candidate"
      return
    fi

    SERVER_IP="$(prompt_for_ipv4 "Bitte Server-IP-Adresse eingeben")"
    return
  fi

  echo "Mehrere mögliche IP-Adressen wurden gefunden:"
  local idx
  for idx in "${!candidates[@]}"; do
    printf '  [%d] %s\n' "$((idx + 1))" "${candidates[idx]}"
  done

  local selection
  while true; do
    read -r -p "Auswahl [1-${#candidates[@]}]: " selection || true
    if [[ "$selection" =~ ^[0-9]+$ ]] && [ "$selection" -ge 1 ] && [ "$selection" -le "${#candidates[@]}" ]; then
      SERVER_IP="${candidates[selection-1]}"
      break
    fi
    echo "Bitte eine gültige Zahl eingeben."
  done

  if ! confirm "IP ${SERVER_IP} verwenden?"; then
    SERVER_IP="$(prompt_for_ipv4 "Bitte Server-IP-Adresse eingeben")"
  fi
}

apply_configuration() {
  update_env_value "$BACKEND_DIR/.env" HOST "$backend_host"
  update_env_value "$BACKEND_DIR/.env" PORT "$backend_port"
  update_env_value "$BACKEND_DIR/.env" STORAGE_DRIVER "$storage_driver"
  update_env_value "$BACKEND_DIR/.env" MINIO_ENDPOINT "$minio_endpoint"
  update_env_value "$BACKEND_DIR/.env" MINIO_PORT "$minio_port"
  update_env_value "$BACKEND_DIR/.env" MINIO_USE_SSL "${minio_use_ssl,,}"
  update_env_value "$BACKEND_DIR/.env" MINIO_ACCESS_KEY "$minio_access_key"
  update_env_value "$BACKEND_DIR/.env" MINIO_SECRET_KEY "$minio_secret_key"
  update_env_value "$BACKEND_DIR/.env" MINIO_BUCKET_MODELS "$minio_bucket_models"
  update_env_value "$BACKEND_DIR/.env" MINIO_BUCKET_IMAGES "$minio_bucket_images"
  update_env_value "$BACKEND_DIR/.env" MINIO_AUTO_CREATE_BUCKETS "${minio_auto_create,,}"
  update_env_value "$BACKEND_DIR/.env" MINIO_PUBLIC_URL "$minio_public_url"

  if [ -n "${minio_region:-}" ]; then
    update_env_value "$BACKEND_DIR/.env" MINIO_REGION "$minio_region"
  fi

  update_env_value "$FRONTEND_DIR/.env" VITE_API_URL "$frontend_api_url"
  update_env_value "$FRONTEND_DIR/.env" FRONTEND_PORT "$frontend_port"
  update_env_value "$FRONTEND_DIR/.env" DEV_API_PROXY_TARGET "$frontend_dev_proxy_target"
}

read_env_value() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return 1
  fi
  local line
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  if [ -z "$line" ]; then
    return 1
  fi
  line="${line#${key}=}"
  line="${line%$'\r'}"
  line="${line#\"}"
  line="${line%\"}"
  printf '%s' "$line"
}

update_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"

  if [ ! -f "$file" ]; then
    touch "$file"
  fi

  python3 - "$file" "$key" "$value" <<'PY'
import pathlib
import sys

file_path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]

if file_path.exists():
    lines = file_path.read_text().splitlines()
else:
    lines = []

updated = False
for idx, line in enumerate(lines):
    if not line or line.startswith('#'):
        continue
    parts = line.split('=', 1)
    if parts[0] == key:
        lines[idx] = f"{key}={value}"
        updated = True
        break

if not updated:
    lines.append(f"{key}={value}")

file_path.write_text("\n".join(lines) + ("\n" if lines else ""))
PY
}

create_env_if_missing() {
  local example_file="$1"
  local target_file="$2"
  if [ ! -f "$target_file" ] && [ -f "$example_file" ]; then
    cp "$example_file" "$target_file"
    success "${target_file#$ROOT_DIR/} aus ${example_file#$ROOT_DIR/} erstellt."
  fi
}

ensure_node_and_npm() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    return
  fi

  info "Node.js (including npm) is required for the installation."

  local installer=""
  if command -v apt-get >/dev/null 2>&1; then
    installer="apt"
  elif command -v brew >/dev/null 2>&1; then
    installer="brew"
  fi

  if [ -z "$installer" ]; then
    echo "Fehler: Node.js ist nicht installiert und das Skript kann es auf diesem System nicht automatisch bereitstellen." >&2
    echo "Bitte installiere Node.js 18+ (inklusive npm) und starte das Skript erneut." >&2
    exit 1
  fi

  if [ "$installer" = "apt" ]; then
    if ! confirm "Node.js fehlt. Soll Node.js 18 LTS jetzt über NodeSource installiert werden?"; then
      echo "Installation abgebrochen, da Node.js benötigt wird." >&2
      exit 1
    fi

    local sudo_cmd=""
    if [ "$(id -u)" -ne 0 ]; then
      if command -v sudo >/dev/null 2>&1; then
        sudo_cmd="sudo"
      else
        echo "Fehler: Für die Installation von Node.js werden Root-Rechte oder sudo benötigt." >&2
        exit 1
      fi
    fi

    info "Installing Node.js 18 LTS via NodeSource"
    $sudo_cmd apt-get update
    $sudo_cmd apt-get install -y ca-certificates curl gnupg
    $sudo_cmd mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $sudo_cmd tee /etc/apt/keyrings/nodesource.gpg >/dev/null
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_18.x nodistro main" | $sudo_cmd tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    $sudo_cmd apt-get update
    $sudo_cmd apt-get install -y nodejs
  elif [ "$installer" = "brew" ]; then
    if ! confirm "Node.js fehlt. Soll Node.js jetzt über Homebrew installiert werden?"; then
      echo "Installation abgebrochen, da Node.js benötigt wird." >&2
      exit 1
    fi

    info "Installing Node.js via Homebrew"
    brew install node
  fi

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Fehler: Die automatische Installation von Node.js ist fehlgeschlagen." >&2
    exit 1
  fi

  success "Node.js $(node --version) und npm $(npm --version) bereitgestellt."
}

ensure_node_and_npm
require_command python3
ensure_docker_requirements

prompt_startup_mode

info "Installiere Backend-Abhängigkeiten"
(
  cd "$BACKEND_DIR"
  npm install
)

info "Installiere Frontend-Abhängigkeiten"
(
  cd "$FRONTEND_DIR"
  npm install
)

create_env_if_missing "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
create_env_if_missing "$FRONTEND_DIR/.env.example" "$FRONTEND_DIR/.env"

detect_server_ip

backend_port_default="$(read_env_value "$BACKEND_DIR/.env" PORT || printf '4000')"
if [[ ! "$backend_port_default" =~ ^[0-9]+$ ]]; then
  backend_port_default="4000"
fi

frontend_port_default="$(read_env_value "$FRONTEND_DIR/.env" FRONTEND_PORT || printf '5173')"
if [[ ! "$frontend_port_default" =~ ^[0-9]+$ ]]; then
  frontend_port_default="5173"
fi

frontend_dev_proxy_default="$(read_env_value "$FRONTEND_DIR/.env" DEV_API_PROXY_TARGET || printf 'http://%s:%s' "$SERVER_IP" "$backend_port_default")"

minio_port_default="$(read_env_value "$BACKEND_DIR/.env" MINIO_PORT || printf '9000')"
if [[ ! "$minio_port_default" =~ ^[0-9]+$ ]]; then
  minio_port_default="9000"
fi

minio_use_ssl_default="$(read_env_value "$BACKEND_DIR/.env" MINIO_USE_SSL || printf 'false')"
minio_use_ssl_default="${minio_use_ssl_default,,}"
if [ "$minio_use_ssl_default" != "true" ]; then
  minio_use_ssl_default="false"
fi

minio_access_key_default="$(read_env_value "$BACKEND_DIR/.env" MINIO_ACCESS_KEY || printf 'visionsuit')"
minio_secret_key_default="$(read_env_value "$BACKEND_DIR/.env" MINIO_SECRET_KEY || true)"
if [ -z "$minio_secret_key_default" ]; then
  minio_secret_key_default="$(generate_secret)"
fi

minio_bucket_models_default="$(read_env_value "$BACKEND_DIR/.env" MINIO_BUCKET_MODELS || printf 'visionsuit-models')"
minio_bucket_images_default="$(read_env_value "$BACKEND_DIR/.env" MINIO_BUCKET_IMAGES || printf 'visionsuit-images')"
minio_auto_create_default="$(read_env_value "$BACKEND_DIR/.env" MINIO_AUTO_CREATE_BUCKETS || printf 'true')"
minio_auto_create_default="${minio_auto_create_default,,}"
if [ "$minio_auto_create_default" != "false" ]; then
  minio_auto_create_default="true"
fi

minio_public_url_default="$(read_env_value "$BACKEND_DIR/.env" MINIO_PUBLIC_URL || true)"
minio_region_default="$(read_env_value "$BACKEND_DIR/.env" MINIO_REGION || true)"

storage_driver="minio"
backend_host="$SERVER_IP"
backend_port="$backend_port_default"
frontend_port="$frontend_port_default"
frontend_api_url="http://$SERVER_IP:$backend_port"
if [ -n "$frontend_dev_proxy_default" ]; then
  frontend_dev_proxy_target="$frontend_dev_proxy_default"
else
  frontend_dev_proxy_target="http://$SERVER_IP:$backend_port"
fi
minio_endpoint="$SERVER_IP"
minio_port="$minio_port_default"
minio_use_ssl="$minio_use_ssl_default"
minio_access_key="$minio_access_key_default"
minio_secret_key="$minio_secret_key_default"
minio_bucket_models="$minio_bucket_models_default"
minio_bucket_images="$minio_bucket_images_default"
minio_auto_create="$minio_auto_create_default"
minio_public_url="$minio_public_url_default"
minio_region="$minio_region_default"

if [ -z "$minio_public_url" ]; then
  if [ "$minio_use_ssl" = "true" ]; then
    minio_public_url="https://$SERVER_IP:$minio_port"
  else
    minio_public_url="http://$SERVER_IP:$minio_port"
  fi
else
  case "$minio_public_url" in
    *localhost*|127.*|0.0.0.0*)
      if [ "$minio_use_ssl" = "true" ]; then
        minio_public_url="https://$SERVER_IP:$minio_port"
      else
        minio_public_url="http://$SERVER_IP:$minio_port"
      fi
      ;;
  esac
fi

info "Konfigurationsvorschlag"
printf '  %-28s %s\n' "Server-IP:" "$SERVER_IP"
printf '  %-28s %s\n' "Backend Host:" "$backend_host"
printf '  %-28s %s\n' "Backend Port:" "$backend_port"
printf '  %-28s %s\n' "Frontend API URL:" "$frontend_api_url"
printf '  %-28s %s\n' "Frontend Dev-Port:" "$frontend_port"
printf '  %-28s %s\n' "Frontend Dev Proxy:" "$frontend_dev_proxy_target"
printf '  %-28s %s\n' "MinIO Endpoint:" "$minio_endpoint"
printf '  %-28s %s\n' "MinIO Port:" "$minio_port"
printf '  %-28s %s\n' "MinIO Access Key:" "$minio_access_key"
printf '  %-28s %s\n' "MinIO Secret Key:" "$(mask_secret "$minio_secret_key")"
printf '  %-28s %s / %s\n' "MinIO Buckets:" "$minio_bucket_models" "$minio_bucket_images"
printf '  %-28s %s\n' "MinIO Auto Buckets:" "$minio_auto_create"
printf '  %-28s %s\n' "MinIO Public URL:" "$minio_public_url"
printf '  %-28s %s\n' "MinIO Region:" "${minio_region:-(nicht gesetzt)}"

if ! confirm "Diese Einstellungen übernehmen?"; then
  info "Manuelle Konfiguration"
  backend_host="$(prompt_ipv4_with_default "Backend Host" "$backend_host")"
  backend_port="$(prompt_port_with_default "Backend Port" "$backend_port")"
  frontend_port="$(prompt_port_with_default "Frontend Dev-Port" "$frontend_port")"

  api_default="http://$backend_host:$backend_port"
  frontend_api_url="$(prompt_default "Frontend API URL" "$api_default")"
  if [ -z "$frontend_api_url" ]; then
    frontend_api_url="$api_default"
  fi

  if [ "$frontend_dev_proxy_target" = "$frontend_dev_proxy_default" ]; then
    frontend_dev_proxy_target="http://$backend_host:$backend_port"
  fi

  frontend_dev_proxy_target="$(prompt_default "Frontend Dev Proxy Target" "$frontend_dev_proxy_target")"
  if [ -z "$frontend_dev_proxy_target" ]; then
    frontend_dev_proxy_target="http://$backend_host:$backend_port"
  fi

  minio_endpoint="$(prompt_ipv4_with_default "MinIO Endpoint" "$minio_endpoint")"
  minio_port="$(prompt_port_with_default "MinIO Port" "$minio_port")"
  minio_use_ssl="$(prompt_default "MinIO HTTPS verwenden? (true/false)" "$minio_use_ssl")"
  minio_use_ssl="${minio_use_ssl,,}"
  if [ "$minio_use_ssl" != "true" ]; then
    minio_use_ssl="false"
  fi

  minio_access_key="$(prompt_default "MinIO Access Key" "$minio_access_key")"
  secret_input=""
  read -r -p "MinIO Secret Key ($(mask_secret "$minio_secret_key")) []: " secret_input || true
  if [ -n "$secret_input" ]; then
    minio_secret_key="$secret_input"
  fi

  minio_bucket_models="$(prompt_default "Bucket für Modell-Assets" "$minio_bucket_models")"
  minio_bucket_images="$(prompt_default "Bucket für Bild-Assets" "$minio_bucket_images")"
  minio_auto_create="$(prompt_default "Buckets automatisch erstellen? (true/false)" "$minio_auto_create")"
  minio_auto_create="${minio_auto_create,,}"
  if [ "$minio_auto_create" != "false" ]; then
    minio_auto_create="true"
  fi

  scheme="http"
  if [ "$minio_use_ssl" = "true" ]; then
    scheme="https"
  fi
  public_url_default="$scheme://$minio_endpoint:$minio_port"
  minio_public_url="$(prompt_default "MinIO Public URL" "${minio_public_url:-$public_url_default}")"
  if [ -z "$minio_public_url" ]; then
    minio_public_url="$public_url_default"
  fi

  region_input=""
  read -r -p "MinIO Region (optional) [${minio_region:-}]: " region_input || true
  if [ -n "$region_input" ]; then
    minio_region="$region_input"
  fi
fi

apply_configuration
success "Backend-Umgebung aktualisiert."
success "Frontend-Umgebung aktualisiert."
success "Storage-Umgebung aktualisiert."

setup_minio_container
ensure_portainer

if confirm "Soll 'npm run prisma:migrate' jetzt ausgeführt werden?"; then
  info "Führe Datenbankmigrationen aus"
  (
    cd "$BACKEND_DIR"
    npm run prisma:migrate
  )
fi

if confirm "Soll 'npm run seed' jetzt ausgeführt werden?"; then
  info "Befülle Demodaten"
  (
    cd "$BACKEND_DIR"
    npm run seed
  )
fi

if confirm "Jetzt einen Admin-Benutzer anlegen?"; then
  info "Lege Admin-Benutzer an"
  admin_email=""
  admin_password=""
  admin_name=""
  admin_bio=""

  while [ -z "$admin_email" ]; do
    read -r -p "Admin E-Mail: " admin_email || true
    if [ -z "$admin_email" ]; then
      echo "Die E-Mail darf nicht leer sein."
    fi
  done

  while [ -z "$admin_password" ]; do
    read -s -p "Admin Passwort: " admin_password || true
    echo
    if [ -z "$admin_password" ]; then
      echo "Das Passwort darf nicht leer sein."
    fi
  done

  while [ -z "$admin_name" ]; do
    read -r -p "Admin Anzeigename: " admin_name || true
    if [ -z "$admin_name" ]; then
      echo "Der Anzeigename darf nicht leer sein."
    fi
  done

  read -r -p "Admin Bio (optional): " admin_bio || true

  (
    cd "$BACKEND_DIR"
    npm run create-admin -- \
      --email="$admin_email" \
      --password="$admin_password" \
      --name="$admin_name" \
      --bio="${admin_bio:-}"
  )
  success "Admin-Benutzer wurde angelegt oder aktualisiert."
fi

configure_startup_mode

success "Installation abgeschlossen."
