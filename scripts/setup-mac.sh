#!/usr/bin/env bash
# One-shot macOS (Apple Silicon) setup for the PDF → read-along audiobook generator.
# Safe to re-run: every step checks what is already in place and only does what is missing.
set -euo pipefail

# shellcheck source=scripts/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-mac.sh [options]    (or: pnpm run setup [options] — plain `pnpm setup` is a pnpm built-in)

Does, in order (skipping anything already done):
  1. checks macOS / Apple Silicon, Homebrew, Node.js >= 20.11 and pnpm >= 11
  2. brew install ffmpeg python@3.12 (+ tesseract, ollama unless skipped)
  3. copies .env.example → .env (never overwrites) and links apps/api/.env → ../../.env
  4. pnpm install
  5. docker compose up -d postgres redis, waits until healthy, prisma migrate deploy
  6. Python worker venv (scripts/setup-python.sh)
  7. models: Kokoro TTS (+ Piper voice, + Ollama model) (scripts/download-models.sh)
  8. builds the TypeScript packages, CLI and API
  9. runs the doctor (dependency check)

Options:
  --no-ollama      Skip Ollama and the LLM model (the pipeline then uses rules only)
  --no-ocr         Skip Tesseract (OCR for scanned PDFs)
  --with-piper     Also install the optional Piper TTS engine + en_US-lessac-medium voice
  --skip-brew      Do not install anything with Homebrew (only report what is missing)
  --skip-infra     Do not start Docker (Postgres/Redis) or run database migrations
                   (the CLI works without them; the API and web UI need them)
  --skip-python    Skip the Python virtualenv step
  --skip-models    Skip model downloads
  --skip-build     Skip building the TypeScript packages/apps
  --skip-doctor    Skip the final dependency check
  -h, --help       Show this help

Nothing is ever deleted. If Ollama is installed but not running, it is started as a
Homebrew background service (brew services start ollama).
EOF
}

WITH_OLLAMA=1
WITH_OCR=1
WITH_PIPER=0
SKIP_BREW=0
SKIP_INFRA=0
SKIP_PYTHON=0
SKIP_MODELS=0
SKIP_BUILD=0
SKIP_DOCTOR=0

while [ $# -gt 0 ]; do
  case "$1" in
    --no-ollama) WITH_OLLAMA=0 ;;
    --no-ocr) WITH_OCR=0 ;;
    --with-piper) WITH_PIPER=1 ;;
    --skip-brew) SKIP_BREW=1 ;;
    --skip-infra) SKIP_INFRA=1 ;;
    --skip-python) SKIP_PYTHON=1 ;;
    --skip-models) SKIP_MODELS=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-doctor) SKIP_DOCTOR=1 ;;
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

cd "$ROOT"
COMPOSE_FILE="$ROOT/docker-compose.yml"
SUMMARY="" # newline-separated follow-ups printed at the end
DOCTOR_FAILED=0
note() {
  warn "$1"
  SUMMARY="${SUMMARY}  - $1"$'\n'
}

# ── 1. Platform & toolchain ──────────────────────────────────────────────────
step "Checking platform"
[ "$(uname -s)" = Darwin ] || die "This script is for macOS. On other systems follow the manual steps in README.md."
if [ "$(uname -m)" = arm64 ]; then
  ok "Apple Silicon ($(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo arm64)), macOS $(sw_vers -productVersion)"
elif [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  die "This terminal runs under Rosetta (x86_64). Open a native arm64 terminal and re-run, otherwise Intel binaries get installed."
else
  note "Intel Mac detected — everything works, but the project is tuned for Apple Silicon (TTS and rendering are slower)."
fi

# Homebrew (also make it usable if installed but not on PATH yet)
if ! have brew; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then
      eval "$("$b" shellenv)"
      break
    fi
  done
fi
if have brew; then
  ok "Homebrew $(brew --version | head -n 1 | awk '{print $2}')"
elif [ "$SKIP_BREW" = 1 ]; then
  note "Homebrew is not installed (--skip-brew given, continuing)."
else
  err "Homebrew is required. Install it (https://brew.sh), then re-run this script:"
  # shellcheck disable=SC2016 # printed verbatim for the user to copy
  info '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 1
fi

# Node.js >= 20.11 (package.json "engines")
if ! have node; then
  err "Node.js >= 20.11 is required. Install it with one of:"
  info "    brew install node@22        (then follow brew's PATH hint)"
  info "    nvm install 22              (if you use nvm)"
  exit 1
fi
node_ver="$(node -v | sed 's/^v//')"
node_major="${node_ver%%.*}"
node_rest="${node_ver#*.}"
node_minor="${node_rest%%.*}"
if [ "$node_major" -lt 20 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -lt 11 ]; }; then
  die "Node.js $node_ver is too old (need >= 20.11). Upgrade with: brew install node@22   (or nvm install 22)"
fi
ok "Node.js $node_ver"

# pnpm >= 11 (the workspace uses pnpm 11's "allowBuilds" to approve Prisma/esbuild install scripts)
if ! have pnpm; then
  err "pnpm 11 is required. Install it with one of:"
  info "    corepack enable pnpm        (Node <= 24 ships corepack; picks the version from package.json)"
  info "    npm install -g pnpm@11"
  info "    brew install pnpm"
  exit 1
fi
pnpm_ver="$(pnpm --version 2>/dev/null || echo 0)"
pnpm_major="${pnpm_ver%%.*}"
case "$pnpm_major" in '' | *[!0-9]*) pnpm_major=0 ;; esac
if [ "$pnpm_major" -lt 11 ]; then
  die "pnpm $pnpm_ver is too old (need 11.x). Upgrade with: npm install -g pnpm@11   (or: corepack enable pnpm)"
fi
ok "pnpm $pnpm_ver"

# ── 2. Homebrew packages ─────────────────────────────────────────────────────
step "System packages (Homebrew)"
brew_ensure() { # brew_ensure FORMULA COMMAND DESCRIPTION
  local formula="$1" cmd="$2" what="$3"
  if have "$cmd"; then
    ok "$what: $(command -v "$cmd")"
    return 0
  fi
  if [ "$SKIP_BREW" = 1 ] || ! have brew; then
    note "$what is missing — install it with: brew install $formula"
    return 0
  fi
  info "Installing $what (brew install $formula)…"
  if brew install "$formula"; then
    ok "$what installed"
  else
    note "brew install $formula failed — install it manually and re-run."
  fi
}

brew_ensure ffmpeg ffmpeg "FFmpeg"
if have ffmpeg; then
  if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
    ok "FFmpeg has h264_videotoolbox (hardware H.264)"
  else
    note "This FFmpeg has no h264_videotoolbox encoder — video falls back to libx264 (slower). Homebrew's ffmpeg includes it."
  fi
fi

# Python 3.10–3.12 for the worker (setup-python.sh searches Homebrew paths first).
py_found=""
for p in /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3.10 \
  /usr/local/bin/python3.12 /usr/local/bin/python3.11 /usr/local/bin/python3.10; do
  if [ -x "$p" ] && py_supported "$p"; then
    py_found="$p"
    break
  fi
done
if [ -n "$py_found" ]; then
  ok "Python $(py_version "$py_found"): $py_found"
else
  brew_ensure python@3.12 python3.12 "Python 3.12"
fi

if [ "$WITH_OCR" = 1 ]; then
  brew_ensure tesseract tesseract "Tesseract OCR (optional, scanned PDFs)"
else
  info "Skipping Tesseract (--no-ocr)"
fi

if [ "$WITH_OLLAMA" = 1 ]; then
  brew_ensure ollama ollama "Ollama (optional local LLM)"
else
  info "Skipping Ollama (--no-ollama)"
fi

# ── 3. Configuration files ───────────────────────────────────────────────────
step "Configuration"
if [ -f .env ]; then
  ok ".env exists (left untouched)"
else
  cp .env.example .env
  ok "Created .env from .env.example"
fi
# Prisma CLI runs inside apps/api and reads apps/api/.env → share the root .env via a symlink.
if [ -L apps/api/.env ]; then
  ok "apps/api/.env → $(readlink apps/api/.env)"
elif [ -e apps/api/.env ]; then
  note "apps/api/.env is a regular file, so Prisma ignores the root .env. Replace it with: ln -sf ../../.env apps/api/.env"
else
  ln -s ../../.env apps/api/.env
  ok "Linked apps/api/.env → ../../.env"
fi

# ── 4. Node dependencies ─────────────────────────────────────────────────────
step "Installing Node dependencies (pnpm install)"
pnpm install
ok "Node dependencies installed"

# ── 5. PostgreSQL + Redis (Docker) and database schema ───────────────────────
INFRA_OK=0
wait_healthy() { # wait_healthy SERVICE — up to 90 s
  local id status i=0
  id="$(docker compose -f "$COMPOSE_FILE" ps -q "$1" 2>/dev/null || true)"
  [ -n "$id" ] || return 1
  while [ "$i" -lt 90 ]; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
    [ "$status" = healthy ] && return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

if [ "$SKIP_INFRA" = 1 ]; then
  info "Skipping Docker services and migrations (--skip-infra)"
else
  step "PostgreSQL + Redis (Docker)"
  if ! have docker; then
    note "Docker is not installed — Postgres/Redis were not started. Install Docker Desktop (brew install --cask docker) or OrbStack (brew install --cask orbstack), then re-run. The CLI works without them."
  elif ! docker info >/dev/null 2>&1; then
    note "Docker is installed but not running — start Docker Desktop/OrbStack (e.g. open -a Docker) and re-run. The CLI works without it."
  elif ! docker compose version >/dev/null 2>&1; then
    note "The 'docker compose' plugin is missing — update Docker Desktop or install docker-compose."
  elif ! docker compose -f "$COMPOSE_FILE" up -d postgres redis; then
    note "docker compose up failed. If a port is taken, check: lsof -nP -iTCP:5433 -sTCP:LISTEN ; lsof -nP -iTCP:6379 -sTCP:LISTEN (see README → Troubleshooting)."
  else
    info "Waiting for the containers to become healthy…"
    if wait_healthy postgres && wait_healthy redis; then
      ok "PostgreSQL (localhost:5433) and Redis (localhost:6379) are healthy"
      INFRA_OK=1
    else
      note "Postgres/Redis did not become healthy in 90 s — inspect with: docker compose logs postgres redis"
    fi
  fi

  step "Database schema (Prisma)"
  pnpm db:generate
  if [ "$INFRA_OK" = 1 ]; then
    if pnpm --filter @app/api prisma:deploy; then
      ok "Migrations applied"
    else
      note "prisma migrate deploy failed — check DATABASE_URL in .env, then run: pnpm --filter @app/api prisma:deploy"
    fi
  else
    note "Migrations not applied (database not running). Later run: pnpm infra:up && pnpm --filter @app/api prisma:deploy"
  fi
fi

# ── 6. Python worker ─────────────────────────────────────────────────────────
if [ "$SKIP_PYTHON" = 1 ]; then
  info "Skipping the Python worker (--skip-python)"
else
  py_args=""
  [ "$WITH_PIPER" = 1 ] && py_args="--piper"
  # shellcheck disable=SC2086 # py_args is intentionally word-split (empty or one flag)
  bash "$ROOT/scripts/setup-python.sh" $py_args || note "Python setup failed — fix the error above and run: pnpm setup:python"
fi

# ── 7. Models ────────────────────────────────────────────────────────────────
if [ "$SKIP_MODELS" = 1 ]; then
  info "Skipping model downloads (--skip-models)"
else
  model_args=""
  [ "$WITH_PIPER" = 1 ] && model_args="piper"
  # shellcheck disable=SC2086
  bash "$ROOT/scripts/download-models.sh" $model_args || note "Model download incomplete — re-run: pnpm setup:models $model_args"

  if [ "$WITH_OLLAMA" = 1 ] && have ollama; then
    if ! ollama list >/dev/null 2>&1 && have brew && brew list --formula ollama >/dev/null 2>&1; then
      info "Starting Ollama as a background service (brew services start ollama)…"
      brew services start ollama >/dev/null || true
      i=0
      while [ "$i" -lt 20 ] && ! ollama list >/dev/null 2>&1; do
        i=$((i + 1))
        sleep 1
      done
    fi
    # The LLM is optional: a failure here is reported but does not stop the setup.
    bash "$ROOT/scripts/download-models.sh" ollama || note "Ollama model not installed — start Ollama (ollama serve) and run: pnpm setup:models ollama"
  fi
fi

# ── 8. Build ─────────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = 1 ]; then
  info "Skipping the build (--skip-build)"
else
  step "Building TypeScript packages, CLI and API"
  pnpm build:packages
  pnpm --filter @app/cli build
  if pnpm --filter @app/api build; then
    ok "Build complete"
  else
    note "API build failed — see the error above (the CLI is still usable)."
  fi
fi

# ── 9. Doctor ────────────────────────────────────────────────────────────────
if [ "$SKIP_DOCTOR" = 0 ]; then
  step "Dependency check (doctor)"
  if [ -f "$ROOT/apps/cli/dist/main.js" ]; then
    if ! node "$ROOT/apps/cli/dist/main.js" doctor; then
      DOCTOR_FAILED=1
      note "The doctor reported failed required checks (see above)."
    fi
  else
    note "CLI is not built, so the doctor was skipped. Run: pnpm doctor"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
step "Done"
if [ -n "$SUMMARY" ]; then
  warn "Follow-ups:"
  printf '%s' "$SUMMARY" >&2
fi
cat <<EOF

  Try it:
    pnpm audiobook ./book.pdf              # CLI only — no database/Redis needed
    pnpm dev                               # API :4000 + worker + web UI :3000
  Re-run this script at any time; completed steps are skipped.

EOF
exit "$DOCTOR_FAILED"
