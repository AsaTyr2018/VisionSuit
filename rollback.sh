#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${ROOT_DIR}/backend"
FRONTEND_DIR="${ROOT_DIR}/frontend"

DRY_RUN=false
ASSUME_YES=false

usage() {
  cat <<'USAGE'
Nutzung: rollback.sh [Optionen]

Setzt die lokale VisionSuit-Installation zurück, indem Abhängigkeiten,
Build-Artefakte, Konfigurationsdateien und Cache-Dateien für Backend und
Frontend entfernt bzw. zurückgesetzt werden.

Optionen:
  -y, --yes       Durchführung ohne Rückfrage.
  -n, --dry-run   Zeigt nur an, welche Schritte ausgeführt würden.
  -h, --help      Zeigt diese Hilfe an.
USAGE
}

log() {
  local level="$1"; shift
  printf '[%s] %s\n' "$level" "$*"
}

remove_path() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    if $DRY_RUN; then
      log INFO "Würde ${path#${ROOT_DIR}/} entfernen"
    else
      rm -rf "$path"
      log INFO "Entfernt ${path#${ROOT_DIR}/}"
    fi
  fi
}

reset_from_example() {
  local example="$1"
  local target="$2"
  if [ ! -f "$example" ]; then
    log WARN "Keine Beispielkonfiguration unter ${example#${ROOT_DIR}/} gefunden"
    return
  fi
  if $DRY_RUN; then
    log INFO "Würde ${target#${ROOT_DIR}/} aus ${example#${ROOT_DIR}/} wiederherstellen"
  else
    mkdir -p "$(dirname "$target")"
    cp "$example" "$target"
    log INFO "${target#${ROOT_DIR}/} aus Beispiel zurückgesetzt"
  fi
}

restore_tracked_file() {
  local relative="$1"
  if git -C "$ROOT_DIR" ls-files --error-unmatch "$relative" >/dev/null 2>&1; then
    if $DRY_RUN; then
      log INFO "Würde Git-Version von ${relative} wiederherstellen"
    else
      git -C "$ROOT_DIR" checkout -- "$relative"
      log INFO "Git-Version von ${relative} wiederhergestellt"
    fi
  fi
}

run_npm_cache_clean() {
  if ! command -v npm >/dev/null 2>&1; then
    log INFO 'npm nicht gefunden, überspringe Cache-Leerung'
    return
  fi

  if $DRY_RUN; then
    log INFO "Würde 'npm cache clean --force' ausführen"
    return
  fi

  if npm cache clean --force >/dev/null 2>&1; then
    log INFO 'npm Cache geleert'
  else
    log WARN 'npm Cache konnte nicht geleert werden'
  fi
}

purge_npm_global_prefix() {
  if ! command -v npm >/dev/null 2>&1; then
    return
  fi

  local prefix
  prefix="$(npm config get prefix 2>/dev/null || true)"
  prefix="${prefix%%$'\r'}"

  if [ -z "$prefix" ] || [ "$prefix" = "null" ]; then
    return
  fi

  if [[ "$prefix" == "$HOME" ]]; then
    log WARN 'npm global Prefix entspricht dem Home-Verzeichnis und wird aus Sicherheitsgründen nicht entfernt'
    return
  fi

  if [[ "$prefix" == /* ]] && [[ "$prefix" != "$HOME"* ]]; then
    log INFO "npm global Prefix ($prefix) liegt außerhalb des Home-Verzeichnisses und wird nicht entfernt"
    return
  fi

  remove_path "$prefix/lib/node_modules"
  remove_path "$prefix/bin"
  remove_path "$prefix/include/node"
  remove_path "$prefix/share/man/man1/node.1"
  remove_path "$prefix/share/doc/node"
  remove_path "$prefix"
}

purge_node_caches() {
  local cache_paths=(
    "$HOME/.npm"
    "$HOME/.npmrc"
    "$HOME/.config/npm"
    "$HOME/.config/node"
    "$HOME/.cache/npm"
    "$HOME/.cache/node-gyp"
    "$HOME/.local/share/npm"
    "$HOME/.local/state/npm"
    "$HOME/.pnpm-store"
    "$HOME/.local/share/pnpm"
    "$HOME/.cache/pnpm"
    "$HOME/.yarn"
    "$HOME/.cache/yarn"
    "$HOME/.local/share/yarn"
    "$HOME/.corepack"
    "$HOME/.cache/corepack"
    "$ROOT_DIR/.npm"
    "$ROOT_DIR/.cache/npm"
    "$ROOT_DIR/.cache/node-gyp"
    "$ROOT_DIR/.pnpm-store"
  )

  for cache_path in "${cache_paths[@]}"; do
    remove_path "$cache_path"
  done
}

purge_node_versions() {
  local node_path
  if command -v node >/dev/null 2>&1; then
    node_path="$(command -v node)"
    if [[ "$node_path" == "$HOME/"* ]]; then
      local version_dir
      version_dir="$(dirname "$(dirname "$node_path")")"
      remove_path "$version_dir"
    fi
  fi

  local version_dirs=(
    "$HOME/.nvm/versions/node"
    "$HOME/.fnm/installs"
    "$HOME/.asdf/installs/nodejs"
    "$HOME/.asdf/installs/node"
    "$HOME/.local/share/node"
    "$HOME/.local/share/nodejs"
    "$HOME/.local/share/corepack"
    "$HOME/.nodebrew/node"
    "$HOME/.nodenv/versions"
    "$HOME/.nvs/node"
    "$HOME/.volta/tools/image/node"
    "$HOME/.volta/tools/image/packages"
    "$HOME/.volta/tools/inventory/node"
    "$ROOT_DIR/.toolchains"
    "$ROOT_DIR/.node"
    "$ROOT_DIR/.volta"
  )

  for dir in "${version_dirs[@]}"; do
    remove_path "$dir"
  done
}

confirm() {
  if $ASSUME_YES; then
    return
  fi
  echo "Diese Aktion löscht installierte Abhängigkeiten und lokale Konfigurationen." >&2
  read -r -p "Fortfahren? [y/N] " answer
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *)
      log INFO "Rollback abgebrochen"
      exit 0
      ;;
  esac
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

confirm

log INFO 'Rollback für Backend starten'
remove_path "$BACKEND_DIR/node_modules"
remove_path "$BACKEND_DIR/dist"
remove_path "$BACKEND_DIR/.ts-node"
remove_path "$BACKEND_DIR/.turbo"
remove_path "$BACKEND_DIR/.cache"
remove_path "$BACKEND_DIR/.eslintcache"
remove_path "$BACKEND_DIR/tsconfig.tsbuildinfo"
remove_path "$BACKEND_DIR/prisma/dev.db"
remove_path "$BACKEND_DIR/prisma/test.db"
remove_path "$BACKEND_DIR/.env.local"

reset_from_example "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
restore_tracked_file "backend/package-lock.json"

log INFO 'Rollback für Frontend starten'
remove_path "$FRONTEND_DIR/node_modules"
remove_path "$FRONTEND_DIR/dist"
remove_path "$FRONTEND_DIR/.turbo"
remove_path "$FRONTEND_DIR/.vite"
remove_path "$FRONTEND_DIR/.cache"
remove_path "$FRONTEND_DIR/.eslintcache"
remove_path "$FRONTEND_DIR/tsconfig.tsbuildinfo"

reset_from_example "$FRONTEND_DIR/.env.example" "$FRONTEND_DIR/.env"
remove_path "$FRONTEND_DIR/.env.local"
restore_tracked_file "frontend/package-lock.json"

log INFO 'Allgemeine temporäre Dateien bereinigen'
remove_path "$ROOT_DIR/.turbo"
remove_path "$ROOT_DIR/.cache"
remove_path "$ROOT_DIR/.eslintcache"

log INFO 'Node.js-Toolchains und globale Artefakte bereinigen'
run_npm_cache_clean
purge_npm_global_prefix
purge_node_caches
purge_node_versions

if ! $DRY_RUN; then
  log INFO 'Rollback abgeschlossen. Installationen wurden entfernt.'
else
  log INFO 'Dry-Run abgeschlossen. Es wurden keine Änderungen vorgenommen.'
fi
