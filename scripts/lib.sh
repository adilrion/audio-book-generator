#!/usr/bin/env bash
# Shared helpers for scripts/*.sh. Sourced, never executed directly.
# Written for the bash 3.2 that ships with macOS: no associative arrays, no ${var,,},
# and no iteration over possibly-empty arrays under `set -u`.

# Repository root = parent of the scripts/ directory.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
hint() { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok() { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err() { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die() {
  err "$*"
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# env_get NAME DEFAULT
# Value of NAME from the environment, else from the repo's .env, else DEFAULT.
# Mirrors how packages/config resolves settings (process env wins over .env).
env_get() {
  local name="$1" def="${2:-}" val="" line=""
  val="$(printenv "$name" 2>/dev/null || true)"
  if [ -z "$val" ] && [ -f "$ROOT/.env" ]; then
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=" "$ROOT/.env" | tail -n 1 || true)"
    if [ -n "$line" ]; then
      val="${line#*=}"
      val="$(printf '%s' "$val" | sed -E 's/^[[:space:]]+//')"
      case "$val" in
        \"*)
          val="${val#\"}"
          val="${val%%\"*}"
          ;;
        \'*)
          val="${val#\'}"
          val="${val%%\'*}"
          ;;
        *) val="$(printf '%s' "$val" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//')" ;;
      esac
    fi
  fi
  printf '%s' "${val:-$def}"
}

# abs_path PATH — relative paths resolve from the repo root (same rule as packages/config).
abs_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$ROOT" "${1#./}" ;;
  esac
}

# file_size FILE — bytes (0 if missing).
file_size() {
  if [ -f "$1" ]; then
    stat -f %z "$1" 2>/dev/null || stat -c %s "$1" 2>/dev/null || wc -c <"$1" | tr -d ' '
  else
    printf '0'
  fi
}

# human BYTES — "325.5 MB"
human() {
  awk -v b="$1" 'BEGIN {
    split("B KB MB GB TB", u, " "); i = 1
    while (b >= 1000 && i < 5) { b /= 1000; i++ }
    if (i == 1) printf "%d %s", b, u[i]; else printf "%.1f %s", b, u[i]
  }'
}

# free_bytes DIR — free space on the volume holding DIR (DIR's nearest existing parent).
free_bytes() {
  local d="$1"
  while [ ! -d "$d" ] && [ "$d" != "/" ]; do d="$(dirname "$d")"; done
  df -Pk "$d" | awk 'NR == 2 { printf "%.0f", $4 * 1024 }'
}

# py_version PYTHON — "3.12" (empty if the interpreter does not run).
py_version() {
  "$1" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true
}

# py_supported PYTHON — true for Python 3.10–3.12 (the versions the worker is tested with).
py_supported() {
  case "$(py_version "$1")" in
    3.10 | 3.11 | 3.12) return 0 ;;
    *) return 1 ;;
  esac
}
