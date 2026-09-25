#!/usr/bin/env bash
# Create the Python worker's virtualenv (workers/processing/.venv) and install its dependencies.
# Idempotent: a healthy venv is reused and pip only installs what is missing.
set -euo pipefail

# shellcheck source=scripts/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-python.sh [options]        (or: pnpm setup:python [options])

Creates workers/processing/.venv with Python 3.12, 3.11 or 3.10 and installs
workers/processing/requirements.txt (PyMuPDF, OpenCV, Kokoro ONNX, pytest, ...).

Options:
  --piper           Also install the optional Piper TTS engine (piper-tts)
  --python <path>   Create the venv with this interpreter instead of searching
                    (add --recreate to switch an existing venv to it)
  --recreate        Delete and recreate the virtualenv
  --check           Report what would be done; change nothing (exit 1 if work is needed)
  -h, --help        Show this help
EOF
}

WORKER_DIR="$ROOT/workers/processing"
VENV="$WORKER_DIR/.venv"
VPY="$VENV/bin/python"
REQ="$WORKER_DIR/requirements.txt"
PIPER_SPEC='piper-tts>=1.2'

WITH_PIPER=0
RECREATE=0
CHECK=0
PY_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --piper) WITH_PIPER=1 ;;
    --recreate) RECREATE=1 ;;
    --check) CHECK=1 ;;
    --python)
      [ $# -ge 2 ] || die "--python needs a path, e.g. --python /opt/homebrew/bin/python3.12"
      PY_OVERRIDE="$2"
      shift
      ;;
    --python=*) PY_OVERRIDE="${1#*=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      usage >&2
      exit 2
      ;;
  esac
  shift
done

[ -f "$REQ" ] || die "Missing $REQ — run this script from a complete checkout."

# Homebrew (Apple Silicon: /opt/homebrew, Intel: /usr/local) first, then PATH.
# /usr/bin/python3 is skipped on purpose: it is Apple's 3.9 stub and may pop up an Xcode dialog.
find_python() {
  local c p n
  for c in \
    /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3.10 \
    /opt/homebrew/opt/python@3.12/bin/python3.12 /opt/homebrew/opt/python@3.11/bin/python3.11 \
    /opt/homebrew/opt/python@3.10/bin/python3.10 \
    /usr/local/bin/python3.12 /usr/local/bin/python3.11 /usr/local/bin/python3.10; do
    if [ -x "$c" ] && py_supported "$c"; then
      printf '%s' "$c"
      return 0
    fi
  done
  for n in python3.12 python3.11 python3.10 python3; do
    p="$(command -v "$n" 2>/dev/null || true)"
    [ -n "$p" ] && [ "$p" != /usr/bin/python3 ] || continue
    if py_supported "$p"; then
      printf '%s' "$p"
      return 0
    fi
  done
  return 1
}

missing_python() {
  err "Python 3.10–3.12 was not found (searched /opt/homebrew, /usr/local and your PATH)."
  info "Install it with Homebrew:"
  info "    brew install python@3.12"
  if ! have brew; then
    info "Homebrew itself is not installed. Install it first (see https://brew.sh):"
    # shellcheck disable=SC2016 # printed verbatim for the user to copy
    info '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  fi
  info "Then re-run: pnpm setup:python"
  exit 1
}

# pip_pending — the "Would install …" line for requirements.txt ("" when everything is
# satisfied, "unknown" when pip cannot tell, e.g. a pip older than 22.2 without --dry-run).
pip_pending() {
  local out
  if out="$("$VPY" -m pip install --dry-run --disable-pip-version-check -r "$REQ" 2>&1)"; then
    printf '%s\n' "$out" | grep -E '^Would install' || true
  else
    printf 'unknown'
  fi
}

check_arch() {
  local arch
  arch="$("$1" -c 'import platform; print(platform.machine())' 2>/dev/null || true)"
  if [ "$(uname -m)" = arm64 ] && [ "$arch" = x86_64 ]; then
    warn "$1 is an Intel (x86_64) build running under Rosetta — TTS and rendering will be much slower."
    hint "Use the native Apple Silicon Homebrew Python instead: brew install python@3.12 (installs to /opt/homebrew)"
  fi
}

step "Python worker environment"

# ── 1. Pick the interpreter used to create the venv ─────────────────────────
BASE_PY=""
if [ -n "$PY_OVERRIDE" ]; then
  [ -x "$PY_OVERRIDE" ] || PY_OVERRIDE="$(command -v "$PY_OVERRIDE" 2>/dev/null || true)"
  [ -n "$PY_OVERRIDE" ] && [ -x "$PY_OVERRIDE" ] || die "--python: interpreter not found or not executable"
  ver="$(py_version "$PY_OVERRIDE")"
  [ -n "$ver" ] || die "--python: $PY_OVERRIDE does not run"
  py_supported "$PY_OVERRIDE" || warn "Python $ver is outside the tested range (3.10–3.12); continuing because --python was given."
  BASE_PY="$PY_OVERRIDE"
fi

# ── 2. Decide whether the existing venv can be reused ───────────────────────
VENV_STATE="missing"
if [ -e "$VENV" ]; then
  if [ -x "$VPY" ] && py_supported "$VPY" && "$VPY" -m pip --version >/dev/null 2>&1; then
    VENV_STATE="healthy"
  else
    VENV_STATE="broken"
  fi
fi
[ "$RECREATE" = 1 ] && [ "$VENV_STATE" != missing ] && VENV_STATE="recreate"

if [ "$VENV_STATE" != healthy ] && [ -z "$BASE_PY" ]; then
  BASE_PY="$(find_python)" || missing_python
fi

case "$VENV_STATE" in
  healthy) ok "Existing virtualenv: $VENV (Python $(py_version "$VPY"))" ;;
  missing) info "No virtualenv yet — will create $VENV with $BASE_PY (Python $(py_version "$BASE_PY"))" ;;
  broken) warn "Virtualenv at $VENV is broken or uses an unsupported Python (e.g. after a Homebrew upgrade) — will recreate it with $BASE_PY" ;;
  recreate) info "--recreate: will rebuild $VENV with $BASE_PY (Python $(py_version "$BASE_PY"))" ;;
esac
[ -n "$BASE_PY" ] && check_arch "$BASE_PY"

# ── --check: report only ─────────────────────────────────────────────────────
if [ "$CHECK" = 1 ]; then
  if [ "$VENV_STATE" != healthy ]; then
    info "(check mode: nothing was changed)"
    exit 1
  fi
  check_arch "$VPY"
  pending="$(pip_pending)"
  status=0
  if [ "$pending" = unknown ]; then
    warn "Could not check requirements.txt (pip --dry-run failed); a normal run will install/repair it"
    status=1
  elif [ -n "$pending" ]; then
    warn "requirements.txt is not fully installed: ${pending#Would install }"
    status=1
  else
    ok "All packages from requirements.txt are installed"
  fi
  if "$VPY" -c 'import piper' >/dev/null 2>&1; then
    ok "Piper TTS (optional) is installed"
  elif [ "$WITH_PIPER" = 1 ]; then
    warn "Piper TTS is not installed (would install $PIPER_SPEC)"
    status=1
  else
    hint "Piper TTS (optional) is not installed — add --piper to install it"
  fi
  info "(check mode: nothing was changed)"
  exit "$status"
fi

# ── 3. Create / recreate ─────────────────────────────────────────────────────
if [ "$VENV_STATE" = broken ] || [ "$VENV_STATE" = recreate ]; then
  rm -rf "$VENV"
fi
if [ "$VENV_STATE" != healthy ]; then
  info "Creating virtualenv…"
  "$BASE_PY" -m venv "$VENV"
  "$VPY" -m pip install --disable-pip-version-check --quiet --upgrade pip
  ok "Created $VENV (Python $(py_version "$VPY"))"
fi

# ── 4. Install requirements (skipped when already satisfied) ────────────────
if [ -z "$(pip_pending)" ]; then
  ok "All packages from requirements.txt are already installed"
else
  info "Installing workers/processing/requirements.txt (the first run downloads the wheels)…"
  "$VPY" -m pip install --disable-pip-version-check -r "$REQ"
fi

if [ "$WITH_PIPER" = 1 ]; then
  if "$VPY" -c 'import piper' >/dev/null 2>&1; then
    ok "Piper TTS already installed"
  else
    info "Installing Piper TTS ($PIPER_SPEC)…"
    "$VPY" -m pip install --disable-pip-version-check "$PIPER_SPEC"
  fi
fi

# ── 5. Verify the worker imports cleanly ─────────────────────────────────────
PYTHONPATH="$WORKER_DIR" "$VPY" - <<'PY'
import importlib

mods = [("pymupdf", "PyMuPDF"), ("numpy", "numpy"), ("cv2", "OpenCV"), ("PIL", "Pillow"),
        ("soundfile", "soundfile"), ("soxr", "soxr"), ("onnxruntime", "onnxruntime"),
        ("kokoro_onnx", "kokoro-onnx"), ("pytest", "pytest")]
for mod, label in mods:
    m = importlib.import_module(mod)
    ver = getattr(m, "__version__", None) or getattr(m, "VersionBind", "") or ""
    print(f"    {label:<12} {ver}")
# The RPC server and every handler module must import (handlers are loaded lazily at runtime).
for mod in ("audiobook_worker.server", "audiobook_worker.pdf.extract", "audiobook_worker.pdf.render",
            "audiobook_worker.tts.registry", "audiobook_worker.video.render_chapter"):
    importlib.import_module(mod)
PY
ok "Python worker imports cleanly"

if "$VPY" -c 'import piper' >/dev/null 2>&1; then
  ok "Piper TTS installed (voices: bash scripts/download-models.sh piper)"
else
  hint "Piper TTS (optional) not installed — re-run with --piper to add it"
fi

# The app runs whatever PYTHON_BIN points to; warn if that is not this venv.
configured="$(abs_path "$(env_get PYTHON_BIN ./workers/processing/.venv/bin/python)")"
if [ "$configured" != "$VPY" ]; then
  warn "PYTHON_BIN in .env points to $configured — the app will use that interpreter, not $VPY"
fi

ok "Python setup complete. Next: pnpm setup:models"
