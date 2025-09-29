#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${ROOT_DIR}/backend"
FRONTEND_DIR="${ROOT_DIR}/frontend"

DRY_RUN=false
ASSUME_YES=false

usage() {
  cat <<'USAGE'
Usage: rollback.sh [options]

Resets the local VisionSuit installation by removing dependencies,
build artifacts, configuration files, and caches for the backend and
frontend.

Options:
  -y, --yes       Proceed without confirmation.
  -n, --dry-run   Show which steps would run without making changes.
  -h, --help      Show this help message.
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
      log INFO "Would remove ${path#${ROOT_DIR}/}"
    else
      rm -rf "$path"
      log INFO "Removed ${path#${ROOT_DIR}/}"
    fi
  fi
}

reset_from_example() {
  local example="$1"
  local target="$2"
  if [ ! -f "$example" ]; then
    log WARN "No example configuration found at ${example#${ROOT_DIR}/}"
    return
  fi
  if $DRY_RUN; then
    log INFO "Would restore ${target#${ROOT_DIR}/} from ${example#${ROOT_DIR}/}"
  else
    mkdir -p "$(dirname "$target")"
    cp "$example" "$target"
    log INFO "${target#${ROOT_DIR}/} reset from example"
  fi
}

restore_tracked_file() {
  local relative="$1"
  if git -C "$ROOT_DIR" ls-files --error-unmatch "$relative" >/dev/null 2>&1; then
    if $DRY_RUN; then
      log INFO "Would restore Git version of ${relative}"
    else
      git -C "$ROOT_DIR" checkout -- "$relative"
      log INFO "Restored Git version of ${relative}"
    fi
  fi
}

run_npm_cache_clean() {
  if ! command -v npm >/dev/null 2>&1; then
    log INFO 'npm not found, skipping cache cleanup'
    return
  fi

  if $DRY_RUN; then
    log INFO "Would run 'npm cache clean --force'"
    return
  fi

  if npm cache clean --force >/dev/null 2>&1; then
    log INFO 'npm cache cleared'
  else
    log WARN 'Unable to clear npm cache'
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
    log WARN 'npm global prefix matches the home directory and will not be removed for safety'
    return
  fi

  if [[ "$prefix" == /* ]] && [[ "$prefix" != "$HOME"* ]]; then
    log INFO "npm global prefix ($prefix) is outside the home directory and will not be removed"
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
  echo "This action removes installed dependencies and local configuration." >&2
  read -r -p "Continue? [y/N] " answer
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *)
      log INFO "Rollback cancelled"
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

log INFO 'Starting backend rollback'
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

log INFO 'Starting frontend rollback'
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

log INFO 'Cleaning general temporary files'
remove_path "$ROOT_DIR/.turbo"
remove_path "$ROOT_DIR/.cache"
remove_path "$ROOT_DIR/.eslintcache"

log INFO 'Cleaning Node.js toolchains and global artifacts'
run_npm_cache_clean
purge_npm_global_prefix
purge_node_caches
purge_node_versions

if ! $DRY_RUN; then
  log INFO 'Rollback complete. Installations were removed.'
else
  log INFO 'Dry run complete. No changes were made.'
fi
