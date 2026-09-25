#!/usr/bin/env bash
# Download the local models into storage/models/. Files that are already present are skipped,
# interrupted downloads resume, and nothing is replaced until a verified new copy exists.
set -euo pipefail

# shellcheck source=scripts/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/download-models.sh [piper] [ollama] [all]     (or: pnpm setup:models [...])

  (no argument)   Kokoro-82M v1.0 ONNX model + voices (default TTS engine, ~355 MB)
  piper           also the Piper voice en_US-lessac-medium (~63 MB; needs: pnpm setup:python --piper)
  ollama          also `ollama pull $OLLAMA_MODEL` (default qwen3:4b; needs a running Ollama)
  all             everything above

Target paths follow .env: KOKORO_MODEL_PATH, KOKORO_VOICES_PATH, PIPER_MODEL_DIR, OLLAMA_MODEL.
EOF
}

WANT_PIPER=0
WANT_OLLAMA=0
while [ $# -gt 0 ]; do
  case "$1" in
    kokoro) ;; # always included
    piper) WANT_PIPER=1 ;;
    ollama) WANT_OLLAMA=1 ;;
    all)
      WANT_PIPER=1
      WANT_OLLAMA=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      usage >&2
      exit 2
      ;;
  esac
  shift
done

KOKORO_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
PIPER_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium"
PIPER_VOICE="en_US-lessac-medium"

KOKORO_MODEL="$(abs_path "$(env_get KOKORO_MODEL_PATH ./storage/models/kokoro/kokoro-v1.0.onnx)")"
KOKORO_VOICES="$(abs_path "$(env_get KOKORO_VOICES_PATH ./storage/models/kokoro/voices-v1.0.bin)")"
PIPER_DIR="$(abs_path "$(env_get PIPER_MODEL_DIR ./storage/models/piper)")"
OLLAMA_MODEL="$(env_get OLLAMA_MODEL qwen3:4b)"

# Minimum plausible sizes. The real files are 325.5 MB / 28.2 MB / ~63 MB; anything much
# smaller is a truncated download or an HTML error page.
MIN_KOKORO_MODEL=300000000
MIN_KOKORO_VOICES=25000000
MIN_PIPER_ONNX=40000000
MIN_PIPER_JSON=1000
# A custom KOKORO_*_PATH may point to another variant (e.g. an int8 model) — only check presence.
MIN_CUSTOM=1000000

have curl || die "curl is required (it ships with macOS)."

# remote_size URL — Content-Length of the final response after redirects (empty if unknown).
remote_size() {
  curl -sIL --connect-timeout 20 --max-time 60 "$1" 2>/dev/null |
    awk 'tolower($1) == "content-length:" { v = $2 } END { gsub("\r", "", v); if (v + 0 > 0) print v }' || true
}

# fetch URL DEST MIN_BYTES LABEL
fetch() {
  local url="$1" dest="$2" min="$3" label="$4"
  local size part expected have_part need free
  if [ -f "$dest" ]; then
    size="$(file_size "$dest")"
    if [ "$size" -ge "$min" ]; then
      ok "$label already present ($(human "$size")) — skipped"
      return 0
    fi
    warn "$label at $dest is only $(human "$size") (expected ≥ $(human "$min")); fetching a fresh copy"
  fi

  # Called as `fetch … || FAILED=1`, so `set -e` is off in here: check every step explicitly.
  if ! mkdir -p "$(dirname "$dest")"; then
    err "Cannot create $(dirname "$dest")"
    return 1
  fi
  part="$dest.part"
  expected="$(remote_size "$url")"
  have_part="$(file_size "$part")"
  if [ -n "$expected" ] && [ "$have_part" -gt "$expected" ]; then
    warn "$label: discarding a partial download larger than the real file"
    rm -f "$part"
    have_part=0
  fi

  need="${expected:-$min}"
  free="$(free_bytes "$(dirname "$dest")")"
  if [ -n "$free" ] && [ "$free" -lt $((need - have_part + 200000000)) ]; then
    err "Not enough disk space for $label: needs $(human "$need"), $(human "$free") free."
    return 1
  fi

  if [ -n "$expected" ] && [ "$have_part" = "$expected" ]; then
    info "$label: a complete earlier download was found"
  else
    [ "$have_part" -gt 0 ] && info "$label: resuming at $(human "$have_part")"
    info "Downloading $label${expected:+ ($(human "$expected"))}"
    hint "$url"
    if ! curl -fL --retry 3 --retry-delay 3 --connect-timeout 20 -C - --progress-bar -o "$part" "$url"; then
      err "Download failed: $label"
      if [ -f "$part" ]; then
        hint "The partial file is kept at $part — re-run this script to resume."
      fi
      return 1
    fi
  fi

  size="$(file_size "$part")"
  if [ -n "$expected" ] && [ "$size" != "$expected" ]; then
    err "$label: downloaded $size bytes but the server announced $expected — re-run to resume."
    return 1
  fi
  if [ "$size" -lt "$min" ]; then
    err "$label: the download is only $(human "$size") — probably an error page, not the model. Removed it."
    rm -f "$part"
    return 1
  fi
  if ! mv -f "$part" "$dest"; then
    err "Could not move $part into place"
    return 1
  fi
  ok "$label downloaded ($(human "$size")) → $dest"
}

min_for() { # min_for PATH DEFAULT_BASENAME MIN
  if [ "$(basename "$1")" = "$2" ]; then printf '%s' "$3"; else printf '%s' "$MIN_CUSTOM"; fi
}

FAILED=0

# ── Kokoro (default TTS) ─────────────────────────────────────────────────────
step "Kokoro-82M v1.0 (default TTS engine)"
fetch "$KOKORO_BASE/kokoro-v1.0.onnx" "$KOKORO_MODEL" \
  "$(min_for "$KOKORO_MODEL" kokoro-v1.0.onnx "$MIN_KOKORO_MODEL")" "Kokoro model (kokoro-v1.0.onnx)" || FAILED=1
fetch "$KOKORO_BASE/voices-v1.0.bin" "$KOKORO_VOICES" \
  "$(min_for "$KOKORO_VOICES" voices-v1.0.bin "$MIN_KOKORO_VOICES")" "Kokoro voices (voices-v1.0.bin)" || FAILED=1

# ── Piper (optional TTS) ─────────────────────────────────────────────────────
if [ "$WANT_PIPER" = 1 ]; then
  step "Piper voice $PIPER_VOICE (optional TTS engine)"
  fetch "$PIPER_BASE/$PIPER_VOICE.onnx" "$PIPER_DIR/$PIPER_VOICE.onnx" "$MIN_PIPER_ONNX" "Piper voice ($PIPER_VOICE.onnx)" || FAILED=1
  if fetch "$PIPER_BASE/$PIPER_VOICE.onnx.json" "$PIPER_DIR/$PIPER_VOICE.onnx.json" "$MIN_PIPER_JSON" "Piper voice config ($PIPER_VOICE.onnx.json)"; then
    if ! grep -q '"phoneme_id_map"' "$PIPER_DIR/$PIPER_VOICE.onnx.json"; then
      err "$PIPER_DIR/$PIPER_VOICE.onnx.json is not a Piper voice config. Delete it and re-run."
      FAILED=1
    fi
  else
    FAILED=1
  fi
  VPY="$(abs_path "$(env_get PYTHON_BIN ./workers/processing/.venv/bin/python)")"
  if [ -x "$VPY" ] && ! "$VPY" -c 'import piper' >/dev/null 2>&1; then
    warn "The piper-tts Python package is not installed yet. Run: pnpm setup:python --piper"
  fi
fi

# ── Ollama model (optional LLM) ──────────────────────────────────────────────
if [ "$WANT_OLLAMA" = 1 ]; then
  step "Ollama model $OLLAMA_MODEL (optional local LLM)"
  if ! have ollama; then
    err "Ollama is not installed. Install it with: brew install ollama"
    hint "The pipeline works without it (rule-based cleaning/chapters only)."
    FAILED=1
  elif ! models="$(ollama list 2>/dev/null)"; then
    err "Ollama is installed but not running. Start it with: brew services start ollama   (or: ollama serve)"
    hint "Then re-run: bash scripts/download-models.sh ollama"
    FAILED=1
  else
    want="$OLLAMA_MODEL"
    case "$want" in *:*) ;; *) want="$want:latest" ;; esac
    installed="$(printf '%s\n' "$models" | awk 'NR > 1 { print $1 }')"
    if grep -qxF -e "$OLLAMA_MODEL" -e "$want" <<<"$installed"; then
      ok "Ollama model $OLLAMA_MODEL already installed — skipped"
    else
      info "Pulling $OLLAMA_MODEL (a few GB; Ollama resumes if interrupted)…"
      if ollama pull "$OLLAMA_MODEL"; then
        ok "Ollama model $OLLAMA_MODEL installed"
      else
        err "ollama pull $OLLAMA_MODEL failed"
        FAILED=1
      fi
    fi
  fi
fi

echo
if [ "$FAILED" = 1 ]; then
  err "Some downloads did not complete (see above). Re-running this script is safe."
  exit 1
fi
ok "Models ready. Check everything with: pnpm doctor"
