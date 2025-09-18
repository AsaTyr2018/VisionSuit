#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Fehler: Benötigtes Kommando '$1' wurde nicht gefunden." >&2
    echo "Bitte installiere es und führe das Skript anschließend erneut aus." >&2
    exit 1
  fi
}

info() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$1"
}

success() {
  printf '\033[1;32m✔\033[0m %s\n' "$1"
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

require_command node
require_command npm
require_command python3

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

backend_host_default="$(read_env_value "$BACKEND_DIR/.env" HOST || printf '0.0.0.0')"
backend_port_default="$(read_env_value "$BACKEND_DIR/.env" PORT || printf '4000')"
frontend_api_default="$(read_env_value "$FRONTEND_DIR/.env" VITE_API_URL || printf 'http://localhost:%s' "$backend_port_default")"

info "Backend-Konfiguration"
backend_host="$(prompt_default "Backend Host" "$backend_host_default")"
backend_port="$(prompt_default "Backend Port" "$backend_port_default")"
update_env_value "$BACKEND_DIR/.env" HOST "$backend_host"
update_env_value "$BACKEND_DIR/.env" PORT "$backend_port"
success "Backend-Umgebung aktualisiert."

info "Frontend-Konfiguration"
api_default_fallback="http://localhost:$backend_port"
if [ -z "$frontend_api_default" ]; then
  frontend_api_default="$api_default_fallback"
fi
frontend_api_url="$(prompt_default "Basis-URL der Backend-API für das Frontend" "$frontend_api_default")"
if [ -z "$frontend_api_url" ]; then
  frontend_api_url="$api_default_fallback"
fi
update_env_value "$FRONTEND_DIR/.env" VITE_API_URL "$frontend_api_url"
success "Frontend-Umgebung aktualisiert."

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

success "Installation abgeschlossen."
