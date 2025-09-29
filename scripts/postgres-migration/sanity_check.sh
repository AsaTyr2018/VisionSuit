#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<USAGE
Usage: $SCRIPT_NAME --prisma-project <path> [options]

Validate local Prisma tooling and remote PostgreSQL compatibility before running migration helpers.

Required arguments:
  --prisma-project <path>   Path to the Prisma project (e.g. ./backend).

Remote validation options:
  --postgres-url <url>      PostgreSQL connection string reachable from the SSH target.
  --ssh-target <user@host>  SSH destination used to run remote PostgreSQL checks.
  --ssh-port <port>         SSH port (default: 22).
  --ssh-identity <path>     Identity file passed to ssh -i.
  --skip-remote             Skip remote validation (not recommended).

Additional checks:
  --require-extensions <list>   Comma-separated list of extensions that must be available on the target.
  --min-postgres-major <major>  Minimum supported PostgreSQL major version (default: 14).
  --min-prisma-major <major>    Minimum supported Prisma major version (default: 6).
  -h, --help                    Show this help text.
USAGE
}

PRISMA_PROJECT=""
POSTGRES_URL=""
SSH_TARGET=""
SSH_PORT="22"
SSH_IDENTITY=""
REQUIRED_EXTENSIONS=""
MIN_POSTGRES_MAJOR="14"
MIN_PRISMA_MAJOR="6"
SKIP_REMOTE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prisma-project)
      [[ $# -lt 2 ]] && { echo "[sanity-check] --prisma-project requires an argument." >&2; usage; exit 1; }
      PRISMA_PROJECT="$2"
      shift 2
      ;;
    --postgres-url)
      [[ $# -lt 2 ]] && { echo "[sanity-check] --postgres-url requires an argument." >&2; usage; exit 1; }
      POSTGRES_URL="$2"
      shift 2
      ;;
    --ssh-target)
      [[ $# -lt 2 ]] && { echo "[sanity-check] --ssh-target requires an argument." >&2; usage; exit 1; }
      SSH_TARGET="$2"
      shift 2
      ;;
    --ssh-port)
      [[ $# -lt 2 ]] && { echo "[sanity-check] --ssh-port requires an argument." >&2; usage; exit 1; }
      SSH_PORT="$2"
      shift 2
      ;;
    --ssh-identity)
      [[ $# -lt 2 ]] && { echo "[sanity-check] --ssh-identity requires an argument." >&2; usage; exit 1; }
      SSH_IDENTITY="$2"
      shift 2
      ;;
    --require-extensions)
      [[ $# -lt 2 ]] && { echo "[sanity-check] --require-extensions requires an argument." >&2; usage; exit 1; }
      REQUIRED_EXTENSIONS="$2"
      shift 2
      ;;
    --min-postgres-major)
      [[ $# -lt 2 ]] && { echo "[sanity-check] --min-postgres-major requires an argument." >&2; usage; exit 1; }
      MIN_POSTGRES_MAJOR="$2"
      shift 2
      ;;
    --min-prisma-major)
      [[ $# -lt 2 ]] && { echo "[sanity-check] --min-prisma-major requires an argument." >&2; usage; exit 1; }
      MIN_PRISMA_MAJOR="$2"
      shift 2
      ;;
    --skip-remote)
      SKIP_REMOTE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "[sanity-check] Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      echo "[sanity-check] Unexpected argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$PRISMA_PROJECT" ]]; then
  echo "[sanity-check] --prisma-project is required." >&2
  usage
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[sanity-check] python3 is required for JSON parsing." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[sanity-check] node is required but not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[sanity-check] npm is required but not found in PATH." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "[sanity-check] npx is required but not found in PATH." >&2
  exit 1
fi

project_abs=$(python3 - <<'PY'
import pathlib, sys
print(pathlib.Path(sys.argv[1]).resolve())
PY
"$PRISMA_PROJECT")

package_json="${project_abs}/package.json"
if [[ ! -f "$package_json" ]]; then
  echo "[sanity-check] package.json not found at ${package_json}." >&2
  exit 1
fi

node_modules_dir="${project_abs}/node_modules"
prisma_pkg_json="${node_modules_dir}/prisma/package.json"
client_pkg_json="${node_modules_dir}/@prisma/client/package.json"

if [[ ! -f "$prisma_pkg_json" || ! -f "$client_pkg_json" ]]; then
  echo "[sanity-check] Prisma dependencies are not installed. Run 'npm install' in ${project_abs}." >&2
  exit 1
fi

readarray -t prisma_info < <(python3 - <<'PY'
import json, pathlib, sys
pkg_path = pathlib.Path(sys.argv[1])
prisma_pkg = pathlib.Path(sys.argv[2])
client_pkg = pathlib.Path(sys.argv[3])
min_prisma_major = int(sys.argv[4])
with pkg_path.open() as f:
    manifest = json.load(f)
expected_prisma = None
expected_client = None
for section in ("devDependencies", "dependencies"):
    section_data = manifest.get(section, {})
    if "prisma" in section_data and expected_prisma is None:
        expected_prisma = section_data["prisma"]
    if "@prisma/client" in section_data and expected_client is None:
        expected_client = section_data["@prisma/client"]
with prisma_pkg.open() as f:
    installed_prisma = json.load(f)["version"]
with client_pkg.open() as f:
    installed_client = json.load(f)["version"]
if expected_prisma is None or expected_client is None:
    raise SystemExit("missing prisma dependencies in package.json")
if installed_prisma.split('.')[0].isdigit() and int(installed_prisma.split('.')[0]) < min_prisma_major:
    raise SystemExit(f"installed Prisma CLI major version {installed_prisma} is below required {min_prisma_major}")
if installed_client.split('.')[0].isdigit() and int(installed_client.split('.')[0]) < min_prisma_major:
    raise SystemExit(f"installed @prisma/client major version {installed_client} is below required {min_prisma_major}")
print(expected_prisma)
print(expected_client)
print(installed_prisma)
print(installed_client)
PY
"$package_json" "$prisma_pkg_json" "$client_pkg_json" "$MIN_PRISMA_MAJOR" 2>"/tmp/${SCRIPT_NAME}_prisma.err")

if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
  cat "/tmp/${SCRIPT_NAME}_prisma.err" >&2 || true
  exit 1
fi

EXPECTED_PRISMA_VERSION="${prisma_info[0]}"
EXPECTED_CLIENT_VERSION="${prisma_info[1]}"
INSTALLED_PRISMA_VERSION="${prisma_info[2]}"
INSTALLED_CLIENT_VERSION="${prisma_info[3]}"

printf '[sanity-check] package.json prisma version: %s\n' "$EXPECTED_PRISMA_VERSION"
printf '[sanity-check] package.json @prisma/client version: %s\n' "$EXPECTED_CLIENT_VERSION"
printf '[sanity-check] installed Prisma CLI version: %s\n' "$INSTALLED_PRISMA_VERSION"
printf '[sanity-check] installed @prisma/client version: %s\n' "$INSTALLED_CLIENT_VERSION"

if ! prisma_cli_output=$(npx --yes prisma --version 2>&1); then
  echo "[sanity-check] Failed to run 'npx prisma --version'." >&2
  echo "$prisma_cli_output" >&2
  exit 1
fi

prisma_cli_version=$(python3 - <<'PY'
import re, sys
output = sys.argv[1]
for line in output.splitlines():
    line = line.strip()
    if not line:
        continue
    if line.lower().startswith('prisma'):
        parts = re.split(r"\s+", line)
        for part in parts:
            if re.match(r"^\d+\.\d+\.\d+", part):
                print(part)
                raise SystemExit
        if ':' in line:
            value = line.split(':', 1)[1].strip()
            if value:
                print(value)
                raise SystemExit
print('unknown')
PY
"$prisma_cli_output")

printf '[sanity-check] Prisma CLI runtime version: %s\n' "$prisma_cli_version"

if [[ "$SKIP_REMOTE" == false ]]; then
  if [[ -z "$POSTGRES_URL" ]]; then
    echo "[sanity-check] --postgres-url is required when remote validation is enabled." >&2
    exit 1
  fi
  if [[ -z "$SSH_TARGET" ]]; then
    echo "[sanity-check] --ssh-target is required when remote validation is enabled." >&2
    exit 1
  fi
  if ! command -v ssh >/dev/null 2>&1; then
    echo "[sanity-check] ssh command not found in PATH." >&2
    exit 1
  fi
  declare -a SSH_ARGS
  SSH_ARGS=(-p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
  if [[ -n "$SSH_IDENTITY" ]]; then
    SSH_ARGS+=(-i "$SSH_IDENTITY")
  fi

  if ! ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "true" >/dev/null 2>&1; then
    echo "[sanity-check] Unable to reach SSH target ${SSH_TARGET}." >&2
    exit 1
  fi

  if ! ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "command -v psql >/dev/null 2>&1"; then
    echo "[sanity-check] Remote host ${SSH_TARGET} is missing the psql client." >&2
    exit 1
  fi

  escaped_url=$(printf '%q' "$POSTGRES_URL")

  remote_version_num=$(ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "psql ${escaped_url} -Atqc 'SHOW server_version_num;'" 2>/tmp/${SCRIPT_NAME}_remote.err || true)
  if [[ -z "$remote_version_num" ]]; then
    cat "/tmp/${SCRIPT_NAME}_remote.err" >&2 || true
    echo "[sanity-check] Failed to read PostgreSQL server_version_num from target." >&2
    exit 1
  fi

  remote_major=$((remote_version_num / 10000))
  printf '[sanity-check] Remote PostgreSQL server version: %s (major %s)\n' "$remote_version_num" "$remote_major"

  if (( remote_major < MIN_POSTGRES_MAJOR )); then
    echo "[sanity-check] PostgreSQL major version ${remote_major} is below required ${MIN_POSTGRES_MAJOR}." >&2
    exit 1
  fi

  if [[ -n "${REQUIRED_EXTENSIONS// }" ]]; then
    IFS=',' read -r -a EXT_ARRAY <<<"$REQUIRED_EXTENSIONS"
    for ext in "${EXT_ARRAY[@]}"; do
      ext_trimmed="${ext//[[:space:]]/}"
      if [[ -z "$ext_trimmed" ]]; then
        continue
      fi
      printf '[sanity-check] Verifying extension availability: %s\n' "$ext_trimmed"
      ext_query="SELECT 1 FROM pg_available_extensions WHERE name='${ext_trimmed}';"
      ext_result=$(ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "psql ${escaped_url} -Atqc $(printf '%q' "$ext_query")" 2>/tmp/${SCRIPT_NAME}_remote_ext.err || true)
      if [[ "$ext_result" != "1" ]]; then
        cat "/tmp/${SCRIPT_NAME}_remote_ext.err" >&2 || true
        echo "[sanity-check] Extension '${ext_trimmed}' is not available on the target host." >&2
        exit 1
      fi
    done
  fi
fi

printf '[sanity-check] Compatibility checks completed successfully.\n'
