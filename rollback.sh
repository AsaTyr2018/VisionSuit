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
restore_tracked_file "backend/prisma/.env"
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

if ! $DRY_RUN; then
  log INFO 'Rollback abgeschlossen. Installationen wurden entfernt.'
else
  log INFO 'Dry-Run abgeschlossen. Es wurden keine Änderungen vorgenommen.'
fi
