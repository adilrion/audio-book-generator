# PDF Audiobook — read-along audiobook videos from PDF books, fully local

Turn a PDF book into a **YouTube-ready read-along video**: the original PDF pages on screen, a natural
local voice reading the book, and the sentence being spoken highlighted on the page as the narration
moves. Everything runs on your own Mac, with no cloud APIs and no paid services. It is tuned for an
**Apple M4 with 16 GB of unified memory**.

```text
book.pdf  ──►  audiobook.mp4   1920×1080 H.264 + AAC, highlighted pages, chapter markers, soft subtitles
               audiobook.m4a   loudness-normalized narration with chapter markers
               subtitles.srt   sentence-level subtitles
               chapters.txt    "0:00 Chapter 1 …" lines for a YouTube description
```

> Only process and distribute books you have the legal right to use. See [Copyright](#copyright).

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Why it is built this way](#why-it-is-built-this-way)
- [Requirements](#requirements)
- [Setup on macOS (Apple Silicon)](#setup-on-macos-apple-silicon)
  - [One-shot setup](#one-shot-setup)
  - [Manual setup](#manual-setup)
  - [Apple Silicon notes](#apple-silicon-notes)
  - [Ollama (local LLM)](#ollama-local-llm)
  - [Models](#models)
  - [TTS engines](#tts-engines)
  - [FFmpeg](#ffmpeg)
  - [PostgreSQL and Redis](#postgresql-and-redis)
- [Configuration (environment variables)](#configuration-environment-variables)
- [Development commands](#development-commands)
- [Web UI](#web-ui)
- [CLI](#cli)
- [HTTP API](#http-api)
- [Processing pipeline](#processing-pipeline)
- [Storage layout](#storage-layout)
- [Troubleshooting](#troubleshooting)
- [Performance tuning for a 16 GB Mac](#performance-tuning-for-a-16-gb-mac)
- [Extending](#extending)
- [Testing](#testing)
- [Copyright](#copyright)
- [Scope of V1](#scope-of-v1)
- [Repository layout](#repository-layout)

Deeper design notes are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Features

- **Accurate PDF-to-text mapping.** PyMuPDF extracts every word with its bounding box. Each sentence
  keeps the exact rectangles of the words it is printed with, including words hyphenated across lines
  or pages, so the highlight lands on the real text instead of an approximation.
- **Careful text cleaning.** Running headers and footers, page numbers, table-of-contents leader lines,
  overprinted duplicates and line-break hyphenation are removed with deterministic, position-aware
  rules. The printed text is never rewritten. Only what the voice *says* is normalized
  (`e.g.` → "for example", footnote markers are dropped, and so on).
- **Chapter detection in a fixed order:** PDF outline, then textual patterns (`Chapter 3`, `PART ONE`,
  `Prologue`), then heading font sizes, then the local LLM (only for ambiguous structure), then about
  12-page sections as a fallback.
- **Local LLM used sparingly.** [Ollama](https://ollama.com) (`qwen3:4b` by default) is only asked
  small structured-JSON questions: which heading candidates start chapters, how to repair visibly
  damaged sentences, and (opt-in) how to pronounce names. It never sees the whole book, and nothing
  depends on it being there.
- **Local TTS:** Kokoro-82M (default), Piper (optional), or the built-in macOS `say` voices. Engines
  sit behind a `TTSProvider` interface.
- **Sample-exact sync.** Each chapter is synthesized sentence by sentence into one FLAC file, so every
  sentence's start and end time comes from sample counts. No forced alignment is needed and there is
  no drift.
- **Read-along video:** a camera that follows the narration with eased pans and a dead zone, a subtle
  zoom, a page cross-fade, marker/underline/box highlights, an optional progress bar and chapter title
  cards, 16:9, 9:16 or 1:1, encoded with the Apple VideoToolbox hardware encoder.
- **Resumable and cached.** Every chapter's audio and video is a content-addressed artifact. An
  interrupted 10-hour book resumes at the chapter where it stopped. Changing the video theme re-renders
  video only, and changing the voice never redoes PDF or LLM work.
- **Resource-aware on 16 GB.** You set the number of TTS, render, LLM and project jobs that may run
  at once. Python model processes are shut down between stages to give memory back. Audio and video
  are streamed to disk and never held in RAM.
- **Understandable errors.** Users see "Audio generation failed for Chapter 7. Retry to continue from
  Chapter 7" instead of `ECONNREFUSED 127.0.0.1:6379`. Technical details go to the logs.
- **Three ways to use it:** a Next.js dashboard, a NestJS HTTP API with a BullMQ job queue, and a CLI
  that needs no database or Redis.

---

## Quick start

On an Apple Silicon Mac with [Homebrew](https://brew.sh), Node.js 20.11 or newer and Docker (Docker
Desktop or OrbStack) installed:

```bash
bash scripts/setup-mac.sh   # one-shot setup: brew deps, .env, Postgres/Redis, Python venv, models, build, doctor
                            # (same as `pnpm run setup`)

pnpm audiobook ./book.pdf   # CLI: writes ./output/audiobook.mp4, audiobook.m4a, subtitles.srt, chapters.txt
pnpm dev                    # API :4000 + worker + web UI on http://localhost:3000
```

If you don't have a book at hand, the CLI can generate a small sample:
`node apps/cli/dist/main.js sample ./sample-book.pdf`.

A narrated 280-page book is roughly 10 hours of audio; with the default settings expect a few
hours of processing on an M4 (see the [estimates](#performance-tuning-for-a-16-gb-mac)). Try
`--chapters 1-2` first.

---

## Architecture

A modular monolith with local worker processes. Only Postgres and Redis run in Docker. Everything
compute-heavy runs natively on macOS so it can use the CPU cores and the hardware media encoder.

```text
 Browser
   │
   ▼
┌──────────────────────┐  HTTP (JSON, multipart upload, Range downloads)
│ Next.js web UI       │─────────────────────────────┐
│ apps/web  :3000      │                             │
└──────────────────────┘                             ▼
                                        ┌──────────────────────────────┐      ┌───────────────────┐
  pnpm audiobook ./book.pdf             │ NestJS API  apps/api  :4000  │─────►│ PostgreSQL :5433  │
  (CLI, apps/cli: no DB,                │ projects, settings, status,  │ Prisma│ (Docker)          │
   no Redis, JSON FileStore)            │ outputs, page previews       │      │ projects, steps,  │
          │                             └──────────────┬───────────────┘      │ chapters, timeline│
          │                                            │ BullMQ enqueue       └─────────▲─────────┘
          │                                            ▼                                │
          │                             ┌──────────────────────────────┐                │ PrismaStore
          │                             │ Redis :6379 (Docker)         │                │ (progress,
          │                             │ queue "audiobook"            │                │  entities)
          │                             └──────────────┬───────────────┘                │
          │                                            │ 1 job = 1 project run          │
          │                                            ▼                                │
          │                             ┌──────────────────────────────┐                │
          │                             │ Worker process               │────────────────┘
          │                             │ apps/api/dist/worker.js      │
          │                             │ concurrency = MAX_CONCURRENT_PROJECTS
          │                             └──────────────┬───────────────┘
          ▼                                            ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ PipelineRunner  (packages/pipeline, TypeScript)                                              │
│  EXTRACT → CLEAN → ANALYZE → TTS_CHAPTER_n → AUDIO_MERGE → TIMELINE → VIDEO_CHAPTER_n → MUX  │
│  text cleaning · paragraphs · sentences (ICU) · chapters · timeline · SRT · FFmpeg mastering │
│  content-addressed cache ──► storage/  (uploads, extracted, audio, renders, output)          │
│         │                                  │                                  │              │
│         │ JSON lines over stdin/stdout     │ HTTP /api/chat (structured JSON) │ spawn        │
│         ▼                                  ▼                                  ▼              │
│  PythonPool (1 process per concurrent   Ollama :11434 (native)          ffmpeg / ffprobe     │
│  unit; models stay loaded)              qwen3:4b, optional               concat, loudnorm,   │
│   ├─ pdf.*   PyMuPDF extract / render                                    AAC, final mux      │
│   ├─ tts.*   Kokoro ONNX · Piper · say  → chapter FLAC + sentence timings                    │
│   └─ video.* OpenCV compositor ──raw BGR frames──► ffmpeg h264_videotoolbox → chapter .mp4   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Part | Location | Role |
|---|---|---|
| Web UI | `apps/web` | Next.js 15, Tailwind 4, shadcn/ui dashboard: upload, settings, progress, preview, downloads |
| API | `apps/api/src/main.ts` | NestJS 11 HTTP API on `127.0.0.1:${API_PORT}`. Never does heavy work inside a request |
| Worker | `apps/api/src/worker.ts` | Separate Node process consuming the BullMQ queue and running `PipelineRunner` |
| CLI | `apps/cli` | Runs the same `PipelineRunner` directly with a JSON `FileStore` |
| Pipeline | `packages/pipeline` | Orchestration, text processing, LLM helper, TTS registry, timeline, FFmpeg, health checks |
| Domain types | `packages/types` | `ProjectSettings`, `StepRecord`, `Timeline`, `Analysis` … shared by every app |
| Config | `packages/config` | Loads and validates `.env` with zod and resolves storage paths |
| Shared | `packages/shared` | `AppError`, hashing, atomic file writes, semaphore, logger |
| Python worker | `workers/processing` | JSON-lines RPC server: PyMuPDF, TTS engines, frame compositor and encoder |
| Infra | `docker-compose.yml` | Postgres 17 and Redis 7 only |

---

## Why it is built this way

| Decision | Reason |
|---|---|
| **Python only for PyMuPDF, TTS and frame rendering** | Those libraries (PyMuPDF, onnxruntime/Kokoro, Piper, OpenCV) are much better in Python. Everything else (cleaning, chapters, sentences, timeline, caching, orchestration, API) is TypeScript, so it can be tested and shared with the UI and API. |
| **One long-lived Python process per concurrent unit** | Each process handles one request at a time over JSON lines and keeps its model loaded between chapters. Parallelism comes from a bounded `PythonPool` (`MAX_CONCURRENT_TTS`, `MAX_CONCURRENT_PDF_RENDER`). Pools are **shut down between stages**, so the Kokoro sessions are released before video rendering starts. Cancelling kills the process, which is the only reliable way to stop a CPU-bound call. |
| **Per-chapter FLAC with sample-exact sentence timings, not forced alignment** | Sentences are synthesized one by one and appended to a chapter FLAC with controlled pauses. A sentence's start and end are sample positions, so the timing is exact by construction, with no aligner model, no memory cost and no drift. Word timings, when requested, are estimated from word lengths inside the exact sentence window. |
| **Frames composited with OpenCV and piped to FFmpeg `h264_videotoolbox`** | A frame is one `warpAffine` of a pre-rendered page plus small highlight blends. Unchanged frames are reused. Raw BGR frames go straight to FFmpeg's stdin, and the M4 media engine encodes them with little CPU, so there are no PNG sequences on disk. |
| **Chapter video segments joined with stream copy, plus one AAC track** | Each chapter segment has exactly `round(end·fps) − round(start·fps)` frames, derived from absolute times, so the segments add up to the audio length. The final MP4 concatenates them without re-encoding (`-c:v copy`) and adds the single mastered AAC track (`-c:a copy`). Muxing audio per chapter would build up AAC priming and padding drift. The output is then validated with ffprobe (A/V drift ≤ 2 frames + 0.1 s). |
| **Docker only for Postgres and Redis** | Docker on macOS runs a Linux VM with no Metal, Neural Engine or VideoToolbox access and a memory cap. TTS, LLM and rendering have to run natively to be fast. |
| **Postgres mapped to host port 5433** | Avoids a clash with a local Postgres.app or Homebrew Postgres on 5432. |
| **Content-addressed cache** | Every stage's output is keyed by a hash of exactly the inputs that matter to it. That gives resume, retry, cross-project reuse and "theme change re-renders video only" without any bookkeeping. |
| **Kokoro on CPU, not CoreML** | Measured on the M4: the CoreML execution provider was slower (RTF 0.23) than plain CPU (RTF 0.21). |

---

## Requirements

| Requirement | Version / notes |
|---|---|
| macOS on Apple Silicon | Developed on an M4 with 16 GB and macOS 15. Intel Macs work but are slower. |
| Homebrew | Installs to `/opt/homebrew`. Use a native arm64 terminal, not Rosetta. |
| Node.js | ≥ 20.11 (`engines` in `package.json`; developed with Node 24) |
| pnpm | **11.x**. The workspace relies on pnpm 11's `allowBuilds` to run Prisma/esbuild install scripts. |
| Python | 3.10–3.12 (3.12 recommended: `brew install python@3.12`) |
| FFmpeg | Homebrew build (includes `h264_videotoolbox` and `aac_at`) |
| Docker | Docker Desktop, OrbStack or colima. Only needed for the API/UI (Postgres + Redis); the CLI does not need it. |
| Ollama | Optional. Local LLM for ambiguous chapters and damaged text. |
| Tesseract | Optional. OCR for scanned pages. |
| Disk | ~355 MB for Kokoro, a few GB for `qwen3:4b`, plus working space per book (see [disk space](#not-enough-disk-space)) |

---

## Setup on macOS (Apple Silicon)

### One-shot setup

```bash
bash scripts/setup-mac.sh     # or: pnpm run setup
```

`scripts/setup-mac.sh` is idempotent: re-running it skips everything that is already in place, and it
never deletes anything. It runs in bash strict mode (`set -euo pipefail`) and stops at the first
hard failure; optional parts (Ollama, OCR, Docker services, models) are reported as follow-ups at
the end instead. In order, it:

1. checks macOS, Apple Silicon (and refuses to run under Rosetta), Homebrew, Node ≥ 20.11 and pnpm ≥ 11;
2. runs `brew install` for whatever is missing: `ffmpeg`, `python@3.12` (unless a Homebrew Python
   3.10–3.12 is already installed), and optionally `tesseract` and `ollama`;
3. copies `.env.example` → `.env` if there is no `.env` yet, and links `apps/api/.env → ../../.env`
   (the Prisma CLI runs inside `apps/api`);
4. `pnpm install`;
5. `docker compose up -d postgres redis`, waits up to 90 s until both report healthy, then
   `pnpm db:generate` and `pnpm --filter @app/api prisma:deploy` (`prisma migrate deploy`). If
   Docker is missing or not running, this is reported and skipped;
6. `scripts/setup-python.sh` (Python venv + requirements);
7. `scripts/download-models.sh` (Kokoro, plus the Piper voice with `--with-piper`), then the Ollama
   model. If Ollama was installed with Homebrew but is not running, it is started with
   `brew services start ollama`;
8. builds the TypeScript packages, the CLI and the API;
9. runs the doctor.

| Flag | Effect |
|---|---|
| `--no-ollama` | Skip Ollama and its model (the pipeline then uses rules only) |
| `--no-ocr` | Skip Tesseract |
| `--with-piper` | Also install the Piper engine and the `en_US-lessac-medium` voice |
| `--skip-brew` | Install nothing with Homebrew; only report what is missing |
| `--skip-infra` | Don't start Docker or run migrations (CLI-only setups) |
| `--skip-python`, `--skip-models`, `--skip-build`, `--skip-doctor` | Skip that step |

With pnpm, write `pnpm run setup --no-ollama --with-piper`: no `--` (pnpm 11 would pass it on
and the script rejects it), and not the short form `pnpm setup --no-ollama`, which pnpm hands to
its own built-in `setup` command. The exit code is non-zero if the final doctor reports a failed
required check.

### Manual setup

```bash
# 1. Toolchain
brew install node@22 ffmpeg python@3.12       # Node 20.11+ also works, e.g. via nvm
npm install -g pnpm@11                         # or: corepack enable pnpm / brew install pnpm
brew install tesseract ollama                  # optional: OCR and local LLM

# 2. Configuration
cp .env.example .env                           # all values have working defaults
ln -s ../../.env apps/api/.env                 # Prisma CLI reads apps/api/.env

# 3. Node dependencies + infrastructure
pnpm install
pnpm infra:up                                  # docker compose up -d postgres redis
pnpm db:generate                               # prisma generate
pnpm --filter @app/api prisma:deploy           # apply migrations (prisma migrate deploy)

# 4. Python worker + models
pnpm setup:python                              # workers/processing/.venv (add --piper for Piper)
pnpm setup:models                              # Kokoro v1.0 → storage/models/kokoro/

# 5. Build + check
pnpm build:packages && pnpm --filter @app/cli build
pnpm doctor
```

`scripts/setup-python.sh` options: `--piper` (also install `piper-tts`), `--python <path>` (use this
interpreter), `--recreate` (delete and rebuild the venv) and `--check` (report only, change
nothing; exits 1 if work is needed). A healthy venv is reused and pip only installs what is
missing.

### Apple Silicon notes

- **Everything native arm64.** Use a native terminal (not Rosetta): `uname -m` prints `arm64`,
  Homebrew lives in `/opt/homebrew`, and
  `workers/processing/.venv/bin/python -c 'import platform; print(platform.machine())'` prints
  `arm64`. An x86_64 Python runs under Rosetta and makes TTS and rendering much slower;
  `setup-python.sh` warns about it and `setup-mac.sh` refuses to run under Rosetta.
- **AI work stays out of Docker.** Docker on macOS runs a Linux VM without Metal, the Neural
  Engine or VideoToolbox, so only Postgres and Redis run there.
- **Hardware video encoding.** Homebrew's FFmpeg includes `h264_videotoolbox`, which encodes on the
  M4 media engine with little CPU (see [FFmpeg](#ffmpeg)).
- **Kokoro on the CPU.** `KOKORO_PROVIDER=cpu` is the default because the CoreML execution
  provider measured slower on the M4. Threads are split between TTS processes automatically.
- **No CUDA anywhere.** Nothing assumes an NVIDIA GPU.

`pnpm doctor` output on a working machine:

```text
  ✓ Python worker                      Python 3.12.14, PyMuPDF 1.28.2
  ✓ TTS engine (kokoro)                ready
  ! TTS engine (piper)                 piper-tts is not installed. Run: workers/processing/.venv/bin/pip install piper-tts
  ✓ TTS engine (say)                   ready
  ✓ OCR (Tesseract)                    available for scanned PDFs
  ✓ FFmpeg                             ffmpeg version 9.0.1
  ✓ VideoToolbox (hardware H.264)      available — fast, low-CPU encoding
  ✓ Local LLM (Ollama qwen3:4b)        ready
  ✓ Disk space                         36.2 GB free

All required checks passed.
```

`✗` marks a required check that failed and `!` an optional one. Each failure prints the exact fix
command.

### Ollama (local LLM)

The LLM is **optional**. Without it the pipeline runs rule-based only and adds a warning to the project.

```bash
brew install ollama
brew services start ollama           # or run `ollama serve` in a terminal
ollama pull qwen3:4b                 # or: pnpm setup:models ollama   (uses $OLLAMA_MODEL)
```

The pipeline calls Ollama's `/api/chat` with a JSON schema (`format`), `temperature: 0`,
`think: false` and `keep_alive: "10m"`. It uses the model for three things only:

1. picking chapter headings from a short list of candidate lines, only when the deterministic
   detection is ambiguous or found fewer than two chapters;
2. repairing sentences in paragraphs that *look* damaged (letter-spaced text, glued words, broken
   ligatures), at most 300 paragraphs. A repair is rejected if it is less than 80 % similar to the
   original;
3. optionally (`LLM_PRONUNCIATION=true`), respellings for names a TTS voice would likely mispronounce.

Repairs and respellings only change what the voice *says*. The highlighted text, subtitles and UI
always show what is printed. Clean paragraphs are never sent for repair; they go to TTS as they are.

Every answer is cached on disk, keyed by model, task and the exact input sent
(`storage/extracted/llm-cache/`). Any other Ollama model with structured-output support works: set
`OLLAMA_MODEL`, then `ollama pull` it. The guardrails are described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#llm-guardrails).

### Models

`scripts/download-models.sh` (`pnpm setup:models`) fetches the model files. Files that are already
complete are skipped (so re-running is instant), interrupted downloads resume from a `.part` file,
the size is checked against the server's `Content-Length`, free disk space is checked first, and a
file is only moved into place once it is complete. It exits non-zero if anything failed.

| Model | Size | Saved to | Command |
|---|---|---|---|
| Kokoro-82M v1.0 ONNX (`kokoro-v1.0.onnx`) | 325.5 MB | `KOKORO_MODEL_PATH` (`storage/models/kokoro/`) | `pnpm setup:models` |
| Kokoro voice pack (`voices-v1.0.bin`, 54 voices) | 28.2 MB | `KOKORO_VOICES_PATH` | (same) |
| Piper voice `en_US-lessac-medium` (`.onnx` + `.onnx.json`) | ~63 MB | `PIPER_MODEL_DIR` (`storage/models/piper/`) | `pnpm setup:models piper` |
| Ollama `qwen3:4b` (or `$OLLAMA_MODEL`) | 2.5 GB | Ollama's own model store | `pnpm setup:models ollama` |

`pnpm setup:models all` fetches everything. Kokoro comes from the
[kokoro-onnx `model-files-v1.0` release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0),
Piper voices from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices).

### TTS engines

| Engine | Install | Voices | Notes |
|---|---|---|---|
| `kokoro` (default) | `pnpm setup:python` + `pnpm setup:models` | 54 voices, 28 English: `af_*`/`am_*` American, `bf_*`/`bm_*` British (`af_heart`, `am_michael`, `bf_emma`, …) | Kokoro-82M v1.0 via `kokoro-onnx` and onnxruntime on CPU. About 5× realtime per process on an M4. |
| `piper` (optional) | `pnpm setup:python --piper` + `pnpm setup:models piper` | Every `<voice>.onnx` + `.onnx.json` in `PIPER_MODEL_DIR`; the id is the file stem (`en_US-lessac-medium`) | Very fast and lightweight. Add more voices from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) by dropping both files into `storage/models/piper/`. |
| `say` (fallback) | nothing, it is built into macOS | System voices (`say -v '?'`), e.g. `Samantha` | Zero-install fallback. Better voices can be downloaded in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices. |

Choose the default with `TTS_ENGINE` and `TTS_DEFAULT_VOICE`, or per project in the UI, the API
(`settings.tts`) or the CLI (`--engine`, `--voice`). List installed voices with
`node apps/cli/dist/main.js voices --engine kokoro` or `GET /system/voices?engine=kokoro`.

### FFmpeg

```bash
brew install ffmpeg
ffmpeg -hide_banner -encoders | grep -E 'h264_videotoolbox|aac_at'
```

With `VIDEO_ENCODER=auto` the worker uses `h264_videotoolbox` (the hardware media engine,
bitrate-controlled by `VIDEO_BITRATE`) and falls back to `libx264 -preset veryfast -tune stillimage
-crf $VIDEO_CRF`. With `AUDIO_ENCODER=auto` the audio master uses Apple's `aac_at` if available,
otherwise FFmpeg's `aac`. Output is BT.709, yuv420p, High profile, `+faststart`.

### PostgreSQL and Redis

`docker compose up -d postgres redis` (`pnpm infra:up`) starts:

| Service | Image | Host port | Details |
|---|---|---|---|
| postgres | `postgres:17-alpine` | **5433** → 5432 | user/password/db `audiobook`; volume `pgdata`; `pgcrypto` enabled by `docker/postgres/init.sql`; 512 MB memory limit |
| redis | `redis:7-alpine` | 6379 | AOF persistence, `maxmemory 256mb`, `maxmemory-policy noeviction` (BullMQ requires it); volume `redisdata`; 320 MB memory limit |

Both have Docker health checks (`pg_isready`, `redis-cli ping`) and `restart: unless-stopped`. To
use your own servers instead, point `DATABASE_URL` or `REDIS_URL` at them. Redis must use
`maxmemory-policy noeviction`. Then run `pnpm --filter @app/api prisma:deploy`. `pnpm infra:down`
(`docker compose down`) removes the containers but keeps the volumes, so no data is lost.

---

## Configuration (environment variables)

Everything is read from the root `.env` (copy it from `.env.example`) by `packages/config`, and
values set in the process environment take precedence. Relative paths resolve from the repository
root. Invalid values (for example `TTS_ENGINE=foo`) stop the app at startup with `Invalid
configuration: …`. Booleans accept `1`, `true`, `yes` and `on`.

| Variable | Default | Meaning |
|---|---|---|
| **Storage & infrastructure** | | |
| `STORAGE_DIR` | `./storage` | Root for uploads, caches, renders, outputs and models (see [Storage layout](#storage-layout)) |
| `DATABASE_URL` | `postgresql://audiobook:audiobook@localhost:5433/audiobook?schema=public` | PostgreSQL for the API/worker (Prisma). Not used by the CLI. |
| `REDIS_URL` | `redis://localhost:6379` | Redis for the BullMQ job queue. Not used by the CLI. |
| `API_PORT` | `4000` | API port. The API binds to `127.0.0.1` only; CORS allows `http://localhost:*` and `http://127.0.0.1:*`. |
| `MAX_UPLOAD_MB` | `500` | Maximum PDF upload size (larger uploads get HTTP 413). Uploads are streamed to disk, not buffered. |
| `PYTHON_BIN` | `./workers/processing/.venv/bin/python` | Interpreter for the Python worker processes |
| **Local LLM** | | |
| `LLM_ENABLED` | `true` | Master switch for Ollama (a project can also turn it off with `text.useLlm=false` or `--no-llm`) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server |
| `OLLAMA_MODEL` | `qwen3:4b` | Model name. It is part of the analysis cache key, so changing it re-runs chapter/text analysis. |
| `LLM_TIMEOUT_MS` | `120000` | Timeout per LLM request |
| `LLM_PRONUNCIATION` | `false` | Opt-in: ask the LLM for respellings of up to 150 capitalized or non-ASCII words that occur at least twice (English only). The respellings are applied to narration, never to displayed text. |
| **TTS** | | |
| `TTS_ENGINE` | `kokoro` | Default engine: `kokoro`, `piper` or `say`. Also decides which engine the doctor treats as required. |
| `TTS_DEFAULT_VOICE` | `af_heart` | Default voice for `TTS_ENGINE`. The web UI pre-fills engine and voice from these (via `GET /system/config`) and the CLI uses them; an API client that omits `settings.tts` gets `kokoro`/`af_heart`. |
| `KOKORO_MODEL_PATH` | `./storage/models/kokoro/kokoro-v1.0.onnx` | Kokoro ONNX model |
| `KOKORO_VOICES_PATH` | `./storage/models/kokoro/voices-v1.0.bin` | Kokoro voice pack |
| `KOKORO_PROVIDER` | `cpu` | onnxruntime execution provider: `cpu` or `coreml`. `coreml` measured slower on the M4. Not in `.env.example`; add it only to experiment. |
| `PIPER_MODEL_DIR` | `./storage/models/piper` | Folder of Piper voices (`*.onnx` + `*.onnx.json`) |
| `TTS_SAMPLE_RATE` | `24000` | Sample rate of the chapter FLACs (Kokoro's native rate). The final `.m4a` is resampled to 48 kHz mono. |
| **Video & audio encoding** | | |
| `VIDEO_ENCODER` | `auto` | `auto` (VideoToolbox, else libx264), `h264_videotoolbox` or `libx264`. An explicit encoder that FFmpeg lacks is an error, not a fallback. |
| `VIDEO_BITRATE` | `6M` | VideoToolbox target/max bitrate. Also sizes the disk-space pre-check before rendering. |
| `VIDEO_CRF` | `20` | Quality when encoding with libx264. The encoder settings are part of the video cache key. |
| `VIDEO_FPS` | `30` | Default `--fps` for the **CLI**. API/UI projects use the project setting `video.fps` (default 30). |
| `AUDIO_ENCODER` | `auto` | `auto` (`aac_at` if available, else `aac`) or any FFmpeg AAC encoder name |
| `AUDIO_BITRATE` | `192k` | AAC bitrate of `audiobook.m4a` (copied unchanged into the MP4) |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | FFmpeg binaries |
| **Resource limits (16 GB defaults)** | | |
| `MAX_CONCURRENT_TTS` | `2` | Chapters narrated in parallel (one Python process each, each with its own model copy, ≈ 0.7 GB peak RSS measured) |
| `MAX_CONCURRENT_PDF_RENDER` | `2` | Chapters rendered to video in parallel (one compositor process + one FFmpeg encoder each) |
| `MAX_CONCURRENT_LLM` | `1` | Concurrent Ollama requests |
| `MAX_CONCURRENT_PROJECTS` | `1` | Projects the worker processes at the same time (BullMQ concurrency) |
| `DISK_RESERVE_GB` | `3` | Free space always kept in reserve. Extraction, TTS and rendering check free space before they start. |
| `KEEP_INTERMEDIATE` | `false` | `false`: after a successful video run, delete the chapter video segments and page rasters. Chapter audio and text caches are always kept. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` for the pipeline logs in the worker (`debug` includes the Python workers' stderr). NestJS's own request/startup logging is fixed at log/warn/error. The CLI logs warnings only, or everything with `--verbose`. |
| **Web UI** | | |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | API base URL used by the browser. It is read by `apps/web`, so put it in `apps/web/.env.local` (template: `apps/web/.env.example`) or export it; Next.js does not read the root `.env`. |
| `WEB_PORT` | `3000` | Informational. `apps/web` currently starts with `next dev -p 3000`. |

Set automatically, not in `.env`: the pipeline starts each TTS process with
`KOKORO_THREADS = OMP_NUM_THREADS = floor(logical CPUs / MAX_CONCURRENT_TTS)` (5 on a 10-core M4 with
the default of 2), and each render process with `OMP_NUM_THREADS = OPENCV_NUM_THREADS = 2`. Values
you set yourself are overridden for those processes.

---

## Development commands

| Command | What it does |
|---|---|
| `pnpm dev` | Builds the packages, then runs `tsc -w` for the pipeline, the API (`:4000`), the worker and the web UI (`:3000`) together |
| `pnpm dev:api` | API only (rebuilds on change, restarts via `node --watch-path=dist`). Needs `pnpm build:packages` first. |
| `pnpm dev:worker` | Processing worker only. Without it, jobs stay at "Waiting for the worker…". |
| `pnpm dev:web` | Next.js dev server |
| `pnpm build:packages` | `tsc -b` for `packages/{types,config,shared,pipeline}` |
| `pnpm build` | Packages + API + CLI + web |
| `pnpm typecheck` | Type-check every workspace package |
| `pnpm test` | `test:ts` then `test:py` |
| `pnpm test:ts` | vitest for `packages/*/test` and `apps/api/test` |
| `pnpm test:py` | pytest in `workers/processing` |
| `pnpm --filter @app/web test` | vitest for the web UI helpers (`apps/web/test`; not part of `pnpm test`) |
| `pnpm doctor` | Builds the packages, then runs the CLI's dependency check with fix commands (needs the CLI built once: `pnpm --filter @app/cli build`) |
| `pnpm infra:up` / `pnpm infra:down` | Start / remove the Postgres + Redis containers (volumes are kept) |
| `pnpm db:migrate` | `prisma migrate dev` (development: creates and applies migrations) |
| `pnpm --filter @app/api prisma:deploy` | `prisma migrate deploy` (apply existing migrations only) |
| `pnpm db:generate` | `prisma generate` |
| `pnpm run setup` | One-shot macOS setup (`scripts/setup-mac.sh`) |
| `pnpm setup:python` | Python venv + requirements (`scripts/setup-python.sh [--piper] [--python <path>] [--recreate] [--check]`) |
| `pnpm setup:models` | Model downloads (`scripts/download-models.sh [piper] [ollama] [all]`) |
| `pnpm audiobook <pdf> [flags]` | Build the packages and the CLI, then run `create` (alias: `pnpm audiobook:create`) |
| `pnpm --filter @app/api start` / `start:worker` | Run the built API / worker without watch mode |
| `pnpm --filter @app/web start` | Serve a production build of the web UI (`pnpm build` first) on `:3000` |
| `pnpm clean` | Remove build output (`dist/`, `.next/`, tsbuildinfo) |

---

## Web UI

Run `pnpm dev` (or `pnpm dev:web` while the API and the worker are running) and open
<http://localhost:3000>.

- **Dashboard** (`/`): every project with its status and progress, plus a banner when a required
  dependency is missing (from `GET /system/health`).
- **New audiobook** (`/new`): drag and drop a PDF. The page shows the file name, size, page
  count, estimated word count and narration length, and warns about scanned PDFs. The settings
  are pre-filled with the server defaults: output (video or audio only), voice engine, voice,
  language and speed, video format (16:9, 9:16, 1:1), animation, highlight unit, style and colour,
  background theme, progress bar, chapter title, embedded subtitles, and the text options (local
  AI, skip front matter, chapter range, OCR).
- **Project page** (`/projects/<id>`): live progress per stage and per chapter; plain-language
  errors with the matching retry action; Resume, Retry, Cancel, Restart, Clean project cache and
  Delete project; the settings, which list the stages a change will redo before you save; a
  **preview** with a read-along player (the PDF page with the spoken sentence highlighted,
  synced to the audio) that works as soon as the narration is ready, then the final video; the
  detected chapters and the downloads.

The web UI offers the three aspect-ratio presets and does not expose the frame rate (30 fps by
default). A custom resolution or frame rate can be set through the API
(`PATCH /projects/:id/settings` with `video.width`, `video.height`, `video.fps`).

---

## CLI

The CLI runs the whole pipeline without the web UI, the database or Redis. It is useful for
debugging, batch jobs and automation.

```bash
pnpm audiobook ./book.pdf                                   # default: 1080p read-along video + audio + SRT
pnpm audiobook ./book.pdf --voice am_michael --chapters 1-2 --out ./output
pnpm audiobook ./book.pdf --mode audio                      # audiobook only (skips video)
pnpm audiobook ./book.pdf --animation static --fps 24       # fastest video
pnpm audiobook ./book.pdf --engine say --voice Samantha --no-llm
pnpm audiobook ./scan.pdf --ocr force                       # OCR every page (needs tesseract)
npm run audiobook:create -- ./book.pdf                      # npm needs the `--`

node apps/cli/dist/main.js inspect ./book.pdf               # page count, word estimate, scan detection (JSON)
node apps/cli/dist/main.js voices --engine kokoro           # installed voices
node apps/cli/dist/main.js doctor                           # dependency check
node apps/cli/dist/main.js sample ./sample-book.pdf --chapters 3 --paras 7 [--no-toc]
```

> With **pnpm, do not put `--` before the arguments.** pnpm 11 forwards it literally, and the CLI's
> argument parser then treats everything after it as plain positional arguments: the PDF is still
> found, but every option after the `--` is silently ignored. (`npm run` strips the `--`, so npm
> needs it.) Relative paths resolve from the directory you run the command in.

| `create` flag | Values (default) | Meaning |
|---|---|---|
| `--out <dir>` | `./output` | Where the final files are written (hard-linked from storage, copied if that fails) |
| `--mode` | `video` \| `audio` (`video`) | Audiobook + animated PDF, or audiobook only |
| `--engine` | `kokoro` \| `piper` \| `say` (`$TTS_ENGINE`) | TTS engine |
| `--voice <id>` | `$TTS_DEFAULT_VOICE`, or the engine's default voice | e.g. `af_heart`, `am_michael`, `bf_emma`, `en_US-lessac-medium`, `Samantha` |
| `--speed <n>` | 0.5–2.0 (`1`) | Speaking rate (the API enforces the range; the CLI passes the number through) |
| `--aspect` | `16:9` \| `9:16` \| `1:1` (`16:9`) | 1920×1080, 1080×1920 or 1080×1080 |
| `--fps <n>` | `$VIDEO_FPS` (30) | Frame rate |
| `--animation` | `follow` \| `kenburns` \| `static` (`follow`) | Camera style (see [video styles](#how-to-add-another-video-style)) |
| `--highlight` | `sentence` \| `paragraph` (`sentence`) | Highlight granularity |
| `--highlight-style` | `marker` \| `underline` \| `box` (`marker`) | Highlight look |
| `--theme` | `paper` \| `light` \| `dark` (`paper`) | Background and title-card colors |
| `--chapters <a-b>` | e.g. `3` or `1-4` | Narrate only these chapters (1-based, as numbered after detection, including "Opening Pages") |
| `--skip-front-matter` | off | Skip content before the first chapter (copyright page, table of contents, …) |
| `--no-llm` | off | Don't use Ollama for this run |
| `--ocr` | `auto` \| `off` \| `force` (`auto`) | `auto` OCRs pages that have images but fewer than 20 characters of text |
| `--password <pw>` | | Password for an encrypted PDF (CLI only, see [troubleshooting](#password-protected-pdf)) |
| `--force` | off | Ignore every cache and recompute everything |
| `--verbose` | off | Developer logs and technical error details |

Settings without a CLI flag (highlight colour, subtle zoom, progress bar, chapter title cards,
embedded subtitles, pause lengths, loudness normalization, a custom resolution, language) keep
their defaults in the CLI; change them through the web UI or the API.

How CLI runs are stored: the project id is `cli-<first 16 hex chars of the PDF's SHA-256>`, and its
state lives in `storage/output/cli-…/state.json`. Running the same PDF again **resumes**, reusing
every cached stage. Only settings that changed cause recomputation. Ctrl-C stops cleanly; run the
same command again to continue. `timeline.json` and `manifest.json` stay in `storage/output/cli-…/`.

Example: real output for the generated sample book (`sample ./sample-book.pdf`, 4 pages) at the
default 1920×1080 @ 30 fps. `tts chapter 1` (the title page) was already in the shared audio cache
from an earlier run. This run shared the Mac with other heavy jobs, so its render speed is well
below the 90–110 fps an otherwise idle M4 reaches (see [performance](#performance-tuning-for-a-16-gb-mac)).

```text
📖  sample-book.pdf  (110 KB)
    voice kokoro/af_heart · 1920x1080@30 follow

  ✓ PDF Analysis           4 pages, 738 words
  ✓ Text Cleaning          1 running headers/footers, 4 page numbers removed
  ✓ Chapter Detection      4 chapters (toc), 59 sentences
  ✓ tts chapter 1          (cached)
  ✓ tts chapter 2          1:32
  ✓ tts chapter 3          1:34
  ✓ tts chapter 4          1:36
  ✓ Audio Mastering
  ✓ Video Preparation      59 highlight segments
  ✓ video chapter 1        45.4 fps (h264_videotoolbox)
  ✓ video chapter 2        34 fps (h264_videotoolbox)
  ✓ video chapter 3        35.6 fps (h264_videotoolbox)
  ✓ video chapter 4        162.6 fps (h264_videotoolbox)
  ✓ Final Export           A/V drift 68 ms

✅  Done in 4:33 — narration length 4:48
    …/output/
      audiobook.mp4    53 MB
      audiobook.m4a    7 MB
      subtitles.srt    7 KB
      chapters.txt     112 B
```

`chapters.txt` from that run, ready for a YouTube description:

```text
0:00 Opening Pages
0:05 Chapter 1: The Beginning
1:37 Chapter 2: Steam and Iron
3:12 Chapter 3: The Railway Age
```

While a stage runs, a live line shows `█████░░░  47.3%  GENERATING_AUDIO · chapter 6/14  Narrating …`.
Running the same command again reuses every step and finishes in well under a second (each step is
recorded with `cached: true` in `state.json`).

---

## HTTP API

Base URL `http://localhost:4000`. Heavy work never runs inside a request: `POST /process` only
enqueues a job.

| Method & path | Body / query | Returns |
|---|---|---|
| `POST /projects` | multipart: `file` (PDF), `settings` (JSON string of partial `ProjectSettings`), `name` (default: the PDF's title or file name) | `ProjectDetail`. Checks the PDF header, deduplicates by SHA-256 and inspects pages, words and scan status. Does not start processing. `400` for a non-PDF, invalid settings or a scan with OCR off; `422` for an encrypted or unreadable PDF; `413` above `MAX_UPLOAD_MB`. |
| `GET /projects` | | `ProjectSummary[]` (newest first, up to 200) |
| `GET /projects/:id` | | `ProjectDetail`: settings, document, snapshot, steps, outputs, chapters |
| `PATCH /projects/:id/settings` | partial `ProjectSettings` JSON (`text.chapterRange: null` clears the range) | `ProjectDetail`. `409` while processing. |
| `POST /projects/:id/process` | | `{ jobId }`: start or resume. `409` if the project is already queued or processing, `410` if the uploaded PDF is gone. |
| `POST /projects/:id/retry` | | `{ jobId }`: same as resume, since finished steps are cached |
| `POST /projects/:id/restart` | | `{ jobId }`: ignore caches and redo everything |
| `POST /projects/:id/cancel` | | `{ ok: true }`. A queued job is cancelled at once; a running one stops within ~1.5 s and finished chapters are kept. |
| `GET /projects/:id/status` | | `ProgressSnapshot` `{status, progress, stage, message, currentChapter, totalChapters, warnings, error}` |
| `GET /projects/:id/steps` | | `StepRecord[]` (`EXTRACT`, `CLEAN`, `ANALYZE`, `TTS_CHAPTER_n`, `AUDIO_MERGE`, `TIMELINE`, `VIDEO_CHAPTER_n`, `MUX`) |
| `GET /projects/:id/output` | | `OutputFile[]` `{name, kind, size, url}` |
| `GET /projects/:id/output/:name` | `?inline=1` to stream inline (for `<audio>`/`<video>`) | File download with HTTP Range support |
| `GET /projects/:id/timeline` | | `Timeline` JSON (`409 NOT_READY` until audio is done) |
| `GET /projects/:id/pages/:page/image` | | JPEG render of a PDF page (1.6 px/pt, cached) |
| `DELETE /projects/:id/cache` | | `{ freedBytes }`: clean the project cache (never deletes final outputs). `409` while processing. |
| `DELETE /projects/:id` | `?deleteOutputs=true` (default `false`) | `{ ok: true, outputsKept }`. Outputs are kept unless requested. The upload is removed only if no other project uses the same PDF. `409` while processing. |
| `GET /system/health` | `?fresh=1` bypasses the 15 s cache | `HealthReport` `{ok, checks[{name, ok, required, message, fix?}]}`: the doctor's checks plus DB and Redis |
| `GET /system/voices` | `?engine=kokoro\|piper\|say` (default `TTS_ENGINE`) | `{engine, available, message, voices: VoiceInfo[]}`; `400` for an unknown engine |
| `GET /system/config` | | `{defaults: ProjectSettings, engines, defaultVoices, llm: {enabled, model}, maxUploadMb}` |

Timeline JSON (used by the UI preview): `{version, duration, fps, pageSizes: {"<page>": [w, h]},
chapters[{index, title, start, end, pageStart, pageEnd}], segments[{i, sentenceId, paragraphId,
chapterIndex, page, start, end, text, rects: [[x0, y0, x1, y1], …], pageChange}]}`. Times are global
seconds, and rects are in PDF points with the origin at the top left.

Errors always have this shape, with a user-friendly `message` and technical details only in the
server log:

```json
{ "error": { "code": "TTS_FAILED", "message": "Audio generation failed for Chapter 7.",
             "hint": "Retry to continue from Chapter 7 — finished chapters are kept.",
             "retryable": true, "stepKey": "TTS_CHAPTER_7", "chapterIndex": 6 } }
```

Status codes: `400` bad input, `404` not found, `409` conflict or not ready, `410` uploaded PDF
missing, `413` upload too large, `422` unreadable/encrypted/empty/scanned PDF, `503` database,
Redis or Python unavailable, `507` not enough disk space, `500` other.

```bash
# A complete session with curl
ID=$(curl -s -F file=@book.pdf -F name="My Book" \
       -F 'settings={"tts":{"voice":"am_michael"},"video":{"theme":"dark"},"text":{"chapterRange":{"from":1,"to":2}}}' \
       http://localhost:4000/projects | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s -X POST http://localhost:4000/projects/$ID/process
curl -s http://localhost:4000/projects/$ID/status
curl -s -o audiobook.mp4 http://localhost:4000/projects/$ID/output/audiobook.mp4
```

---

## Processing pipeline

### Stages and statuses

| # | Stage | Status shown | Persisted step(s) | What happens |
|---|---|---|---|---|
| 1 | `EXTRACT` | `EXTRACTING` | `EXTRACT` | PyMuPDF streams every page into `pages.jsonl` (words + boxes + font info). OCR runs for pages that have images but almost no text, if Tesseract is available. |
| 2 | `CLEAN` | `CLEANING` | `CLEAN` | Removes headers/footers, page numbers, TOC leaders and duplicates |
| 3 | `ANALYZE` | `ANALYZING` | `ANALYZE` | Paragraphs, de-hyphenation, chapters, sentences, highlight regions, narration text; the LLM when needed |
| 4 | `TTS` | `GENERATING_AUDIO` | `TTS_CHAPTER_1…n` | One FLAC per chapter with exact sentence timings (parallel up to `MAX_CONCURRENT_TTS`) |
| 5 | `AUDIO_MERGE` | `GENERATING_AUDIO` | `AUDIO_MERGE` | Concatenate, `loudnorm` to −16 LUFS (optional), 48 kHz mono AAC with chapter markers → `audiobook.m4a` |
| 6 | `TIMELINE` | `PREPARING_VIDEO` | `TIMELINE` | Global timeline, cross-page splits → `timeline.json`, `subtitles.srt`, `chapters.txt` |
| 7 | `VIDEO` | `RENDERING` | `VIDEO_CHAPTER_1…n` | Rasterize pages at the needed scale, composite frames, VideoToolbox → one video-only MP4 per chapter |
| 8 | `MUX` | `RENDERING` | `MUX` | Stream-copy concat + AAC + soft `mov_text` subtitles + chapters → `audiobook.mp4`, then an A/V sync check |

Other project statuses: `PENDING` (queued), `COMPLETED`, `FAILED` (with a user-facing `error`) and
`CANCELLED`. Step statuses: `PENDING`, `RUNNING`, `COMPLETED` (with `cached: true` when reused),
`FAILED` and `SKIPPED`. "Audiobook only" mode has no `VIDEO` and `MUX` steps. The overall
percentage is weighted by typical cost (TTS 55 %, video 28 %, the rest 2–4 % each) and rescaled to
the stages that actually run. Stage internals (heuristics, timing math, camera) are described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Resume, retry, restart, cancel

- **Resume** and **Retry** are the same operation. The run starts again from the top, every step
  looks up its content-addressed artifact, and whatever exists is marked `cached` in milliseconds.
  If processing stopped during chapter 7, chapters 1–6 are not narrated again.
- **Restart** (`POST /restart`, CLI `--force`) ignores all caches and recomputes and overwrites
  every artifact.
- **Cancel**: the worker polls the cancel flag every 1.5 s and kills the running Python and FFmpeg
  processes. The chapter in progress returns to `PENDING` and is redone on resume.
- **Crash or reboot**: when the worker starts, it marks projects that were left "running" as
  `FAILED` with `INTERRUPTED` ("Processing was interrupted before it finished. Click Resume…").
  Nothing is lost except the chapter that was in progress.
- Artifacts are written atomically (temp file + rename), so a half-written file is never mistaken
  for a finished one.

### Caching rules (what invalidates what)

Each stage's cache key is a hash of exactly the inputs that affect its output:

| You change… | What is recomputed |
|---|---|
| Video **theme**, highlight style/colour, animation, subtle zoom, resolution/aspect, progress bar, chapter title cards, `VIDEO_ENCODER` / `VIDEO_BITRATE` / `VIDEO_CRF` | `VIDEO_CHAPTER_n` + `MUX` only |
| **fps** or **highlight mode** (sentence ↔ paragraph) | `TIMELINE` + video + mux |
| **Voice**, engine, speed or pause lengths | `TTS_CHAPTER_n` (all chapters) + audio master + timeline + video + mux. **Extraction and LLM/analysis are reused.** |
| Loudness normalization, `AUDIO_BITRATE`, `AUDIO_ENCODER` | `AUDIO_MERGE` + `MUX`. The picture is not re-rendered: the chapter segments are used if they are still on disk, otherwise the video track is stream-copied from the existing `audiobook.mp4`. |
| Embedded subtitles on/off | `MUX` only (same picture reuse) |
| LLM on/off (including Ollama becoming unreachable or reachable again), `OLLAMA_MODEL`, skip front matter, `LLM_PRONUNCIATION` | `CLEAN` + `ANALYZE`, then TTS only for chapters whose narration changed. Sentence ids are positional (`c3-p12-s1`), so a change that shifts chapter numbering, such as dropping the "Opening Pages" chapter, re-narrates the chapters after it. |
| Book title (the project name in the API, the PDF file name in the CLI) | `CLEAN` + `ANALYZE` (seconds), audio master, timeline and a re-mux; chapter audio and the picture are reused |
| Chapter range | Already-narrated chapters are reused; audio master, timeline and video are rebuilt because chapter start times shift |
| OCR mode or language | `EXTRACT` and everything after it |
| Nothing (a new project from the same PDF) | Extraction and chapter audio are shared through the content-addressed cache, and so is the analysis when the project has the same name |

Extraction depends only on the PDF bytes, OCR mode and language. Theme and voice changes never
touch it. The full key table is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#cache-keys).

---

## Storage layout

```text
storage/                                      (STORAGE_DIR)
├── uploads/
│   ├── <sha256>.pdf                          uploaded PDFs, deduplicated by content
│   └── .incoming/                            uploads in flight (streamed from multer)
├── extracted/
│   ├── <sha256>/extract-<key>/pages.jsonl    one JSON line per page: blocks → lines → words + boxes
│   ├── <sha256>/extract-<key>/meta.json      page count, sizes, outline (TOC), empty/OCR pages
│   ├── <sha256>/analysis-<key>.json          chapters → paragraphs → sentences → highlight regions
│   └── llm-cache/<task>-<hash>.json          every LLM answer (keyed by model, task and input)
├── audio/
│   ├── <key>.flac                            one narrated chapter (shared by all projects)
│   └── <key>.json                            its sample count + per-sentence timings
├── renders/
│   ├── pages/<sha256>/<scale>/page-NNNN.png  page rasters for video (removed after success*)
│   ├── preview/<sha256>/page-NNNN.jpg        UI page previews (1.6 px/pt)
│   └── video/<key>.mp4                       per-chapter video-only segments (removed after success*)
├── output/<projectId>/                       FINAL OUTPUTS (never removed by "clean cache");
│   │                                         <projectId> is the UUID, or cli-<hash> for CLI runs
│   ├── audiobook.mp4  audiobook.m4a  subtitles.srt  chapters.txt  timeline.json
│   ├── manifest.json                         which cache keys this project's outputs were built from
│   ├── state.json                            CLI projects only (steps + progress)
│   └── .work/                                concat lists / metadata during a run
└── models/
    ├── kokoro/kokoro-v1.0.onnx, voices-v1.0.bin
    └── piper/<voice>.onnx, <voice>.onnx.json

* unless KEEP_INTERMEDIATE=true
```

**Clean project cache** (`DELETE /projects/:id/cache`) removes the PDF's extraction and analysis,
page rasters and previews, the chapter audio and video segments listed in the project's manifest, and
`.work/`, and resets the project's step list. It never removes the final outputs. Caches are shared
by content, so another project built from the same PDF (or with the same chapter narration) will
recompute what was removed. The LLM answer cache is kept. **Delete project** runs the same clean-up,
keeps the outputs unless `deleteOutputs=true`, and removes the uploaded PDF only when no other
project uses it.

---

## Troubleshooting

Start with `pnpm doctor` (or `GET /system/health?fresh=1`). Every failed check prints its fix.

#### "The background job service (Redis) is not running."
Run `pnpm infra:up` (or `docker compose up -d redis`) and check with `docker compose ps`. If port 6379
is already taken, for example by a Homebrew Redis (`brew services list`), either stop that Redis or
use it: set `REDIS_URL` and make sure it uses `maxmemory-policy noeviction`.

#### "The database (PostgreSQL) is not running."
Run `pnpm infra:up`, then `pnpm --filter @app/api prisma:deploy` on the first start. If Docker itself
isn't running, start Docker Desktop or OrbStack (`open -a Docker`).

#### Port 5432 / 5433 clash
The container is published on **5433** on purpose, so a Postgres.app or Homebrew Postgres on 5432
does not conflict. If 5433 is also taken (`lsof -nP -iTCP:5433 -sTCP:LISTEN`), change the host port in
`docker-compose.yml` (`"5434:5432"`) and in `DATABASE_URL`.

#### "Local AI (Ollama) not used: …" / Ollama unreachable / model missing
This is a warning, not an error: processing continues rule-based. To enable the LLM, start Ollama
(`brew services start ollama` or `ollama serve`) and pull the model (`ollama pull qwen3:4b`, or
`pnpm setup:models ollama`). To silence the warning, set `LLM_ENABLED=false`.

#### "The "kokoro" voice engine is not ready." / "Kokoro model files are missing"
Run `pnpm setup:models`. It checks the files in `storage/models/kokoro/`, resumes partial downloads
and skips files that are already complete. If `kokoro-onnx` is missing, run `pnpm setup:python`.

#### "The voice "…" is not installed"
Voice ids are engine-specific. List them with `node apps/cli/dist/main.js voices --engine <engine>`.

#### Scanned PDF ("This PDF is a scan (images only)…")
Install Tesseract (`brew install tesseract`) and keep OCR at `auto` (or use `force`). For Bangla OCR,
also run `brew install tesseract-lang`. OCR runs at 200 dpi and is slow compared to text extraction.
The API refuses an obviously scanned PDF if `text.ocr` is `off`.

#### Password-protected PDF
The API rejects encrypted PDFs (`PDF_PASSWORD`, "Remove the password and upload it again"). Either
use the CLI with `--password <pw>`, or remove the password from a PDF you own, for example with qpdf:
`brew install qpdf && qpdf --decrypt --password='…' locked.pdf unlocked.pdf`. DRM circumvention is
not supported.

#### Not enough disk space
Extraction, TTS and rendering each check free space before they start (`DISK_SPACE` error) and keep
`DISK_RESERVE_GB` free. The video check is conservative: it reserves about
`2.2 × duration × VIDEO_BITRATE / 8 + 400 MB` for the chapters still to render, which is about
60 GB for a 10-hour book at `6M`. Real page video encodes far below the bitrate cap: the 1080p
`follow` sample above measured 1.36 Mbit/s of video, which would be about 6 GB for 10 hours. If the
check refuses to start, free space (**Clean project cache** on finished projects, delete old
projects), lower `VIDEO_BITRATE` (`3M` halves the requirement), or render a chapter range first.
Then resume; nothing already finished is lost.

#### VideoToolbox not available
The doctor shows `! VideoToolbox (hardware H.264) not available, will use libx264 (slower)`. Use
Homebrew's FFmpeg on a native arm64 shell (`ffmpeg -hide_banner -encoders | grep videotoolbox`) and
keep `VIDEO_ENCODER=auto`. Setting `VIDEO_ENCODER=h264_videotoolbox` explicitly makes a missing encoder
a clear error instead of a silent fallback.

#### Processing was interrupted (crash, reboot, closed terminal)
In the UI, click **Resume** (`POST /projects/:id/process`). With the CLI, run the same command again.
Finished chapters are reused, and only the chapter in progress is redone.

#### The project stays at "Waiting for the worker…"
The API only queues jobs; a separate worker process runs them. Start it with `pnpm dev:worker` (it
is included in `pnpm dev`) or `pnpm --filter @app/api start:worker`, and look for
`Worker ready (concurrency 1, TTS 2, render 2)` in its log. Redis must be running for the job to
reach the worker.

#### `pnpm audiobook` ignores my options
Remove the `--` after the script name (see the note in [CLI](#cli)): `pnpm audiobook ./book.pdf
--mode audio`, not `pnpm audiobook -- ./book.pdf --mode audio`.

#### Port 4000 or 3000 is already in use
The API logs `API failed to start: … EADDRINUSE`. Set `API_PORT` in `.env` and the matching
`NEXT_PUBLIC_API_URL` in `apps/web/.env.local`. The web UI's port is set in the `dev`/`start` scripts
of `apps/web/package.json` (`-p 3000`).

#### "The Python processing worker could not be started."
Run `pnpm setup:python`. If Homebrew upgraded Python and broke the venv, run
`pnpm setup:python --recreate`. `PYTHON_BIN` must point to the venv's interpreter.

#### "The computer ran out of memory." / the Mac swaps heavily
Lower `MAX_CONCURRENT_TTS` and/or `MAX_CONCURRENT_PDF_RENDER` to `1`, keep
`MAX_CONCURRENT_PROJECTS=1`, and close other large apps (browsers with many tabs, other LLMs).

#### "The final video failed the audio/video sync check."
This should not happen. Resume once; if it repeats, run with `--verbose` or `LOG_LEVEL=debug` and
open an issue with the log. Restart the project to rebuild every artifact.

---

## Performance tuning for a 16 GB Mac

**Measured on the development machine (M4, 16 GB, macOS 15):**

| Workload | Measured |
|---|---|
| Kokoro-82M ONNX TTS, onnxruntime **CPU** provider | RTF ≈ **0.21** (≈ 5× realtime) per process |
| Kokoro-82M ONNX TTS, **CoreML** provider | RTF ≈ 0.23, slower, so `cpu` is the default |
| Kokoro TTS process memory | ≈ 0.7 GB peak RSS (model loaded, one sentence synthesized) |
| Video, 1920×1080 @ 30 fps, `follow` animation, VideoToolbox | ≈ **90–110 frames/s** per render worker (≈ 3× realtime) |
| Video, 640×360 @ 15 fps | ≈ 600 frames/s |
| Encoded 1080p `follow` page video (sample book, 6M cap) | ≈ 1.36 Mbit/s |

**Estimates for a ~280-page book (~10 h of narration).** These are derived from the numbers above,
not measured end-to-end:

| Stage | 1 process | 2 processes (default) |
|---|---|---|
| TTS: 10 h × 0.21 | ≈ 2 h | ≈ 1.2–1.5 h (both processes share the same cores, so less than 2× faster) |
| Video: 10 h × 30 fps = 1.08 M frames ÷ ~100 fps | ≈ 3 h | ≈ 1.5–2 h |
| Extraction, analysis, audio mastering, mux | minutes | minutes |
| **Total with defaults (estimate)** | | **≈ 3–4 h** |

Knobs, from most to least effect:

- **`animation=static`** is the fastest style. There is no camera motion or zoom, so consecutive
  frames are identical between highlight changes and the compositor reuses them instead of
  recompositing. `follow` with subtle zoom (the default) and `kenburns` composite every frame;
  `follow` with `subtleZoom: false` reuses frames between camera moves.
- **fps 24 instead of 30** gives 20 % fewer frames, so roughly 20 % less render time. Use
  `--fps 24` in the CLI or `video.fps` through the API; `VIDEO_FPS` only sets the CLI default.
- **Resolution.** Render cost grows with pixel count. Set `video.width`/`video.height` through the
  API (`PATCH /projects/:id/settings`), for example 1280×720.
- **`MAX_CONCURRENT_TTS`** (default 2). Each process loads its own Kokoro model (the fp32 ONNX file
  is 325 MB; ≈ 0.7 GB per process in RAM). 1 uses the least memory; 3 or more is unlikely to help on
  a 10-core M4, because the cores are split between the processes.
- **`KOKORO_THREADS`** is not a setting. The runner sets it per TTS process to
  `floor(logical CPUs / MAX_CONCURRENT_TTS)`, so each process gets its share of the cores: 5 each on
  a 10-core M4 with 2 processes. Keep `KOKORO_PROVIDER=cpu`.
- **`MAX_CONCURRENT_PDF_RENDER`** (default 2). Each worker is a compositor process holding at most 3
  page canvases, plus an FFmpeg encoder. Use 1 if the Mac gets hot or memory is tight.
- **Audio only** (`--mode audio` / `outputMode: "audiobook_only"`) skips video entirely.
- **`--chapters 1-2`** for trial runs. Later full runs reuse those chapters.
- **`KEEP_INTERMEDIATE=true`** keeps chapter video segments and page rasters, so switching back to
  a look you rendered before only needs a re-mux. It costs disk space. The default `false` frees it
  after success (audio-only changes still don't re-render: the picture is copied from the existing
  MP4).
- **Ollama** keeps its model loaded for 10 minutes after the last request (`keep_alive`). That overlaps
  the start of TTS. `ollama ps` shows loaded models, and `ollama stop <model>` frees the memory
  immediately. Keep `MAX_CONCURRENT_LLM=1`.
- **`MAX_CONCURRENT_PROJECTS=1`**. Run books one after another. Two books at once compete for the
  same cores and memory.

Memory design: pages are extracted one at a time to JSON lines; audio is synthesized sentence by
sentence and streamed to FLAC; frames are streamed to FFmpeg; page rasters are capped at 12 MP; Python
pools are shut down between stages. Details per stage are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#memory-strategy-for-a-16-gb-mac).

---

## Extending

### How to add another TTS model

1. **Python engine:** create `workers/processing/audiobook_worker/tts/<name>_engine.py` with a
   subclass of `TTSEngine` (`tts/base.py`):
   - `available()` (classmethod) returns `(ok, message)`. The message must say exactly how to install
     the engine; it is shown in the doctor and in the UI.
   - `voices()` returns a list of `Voice(id, name, language, gender)`.
   - `synthesize(text, voice, speed, language)` returns mono float32 samples and their sample rate.
     Resampling, silence trimming, retries, pauses, FLAC writing and sentence timings are handled
     by `tts/service.py`. Load models in `__init__`, which runs once per process.
2. Register it in `workers/processing/audiobook_worker/tts/registry.py` (`ENGINES`).
3. **TypeScript:** add the name to `TTSEngineName` (`packages/types/src/settings.ts`), the `TTS_ENGINE`
   enum (`packages/config/src/index.ts`), the `tts.engine` enum in
   `apps/api/src/projects/settings.schema.ts` and the engine union in
   `packages/pipeline/src/tts/python-provider.ts`. Register a factory in
   `packages/pipeline/src/tts/registry.ts`, and add a default voice to `DEFAULT_VOICES`. Add a
   label to `ENGINE_LABELS` in `apps/web/lib/voices.ts` (the type checker insists) and the name to
   the `--engine` line of the CLI help in `apps/cli/src/main.ts`.
4. Model files: add a download step to `scripts/download-models.sh`. If the engine needs a path
   setting, add it to `packages/config` and pass it to Python in `packages/pipeline/src/python/bridge.ts`
   (see `PIPER_MODEL_DIR`).
5. The UI then lists the engine and its voices from `GET /system/config` and `GET /system/voices`.
   If you change an engine's output for the same input, bump the provider's `version`, which is
   part of the TTS cache key.
6. Test it with `node apps/cli/dist/main.js voices --engine <name>`, `pnpm doctor`, and a short
   run: `pnpm audiobook ./sample-book.pdf --engine <name> --voice <id> --chapters 1-2`.

For an engine that is not in Python (for example a local HTTP TTS server), implement the
`TTSProvider` interface (`packages/pipeline/src/tts/types.ts`) in TypeScript and call
`registerTTSEngine(name, factory)`. `synthesizeSegments()` must return **sample-exact sentence
timings**, because the highlight sync depends on them.

### How to add another LLM

- **Different Ollama model:** set `OLLAMA_MODEL` (e.g. `qwen3:8b`, `gemma3:4b`, `llama3.2:3b`), run
  `ollama pull` for it, and that's it. On a 16 GB Mac, stay around 4B parameters or below: the model
  is resident next to the TTS processes for 10 minutes after the last request. The model name is
  part of the analysis cache key, so only cleaning and analysis re-run. Extraction is reused, and
  TTS is reused for every chapter whose narration and chapter numbering didn't change.
- **Different runtime** (llama.cpp server, LM Studio, MLX, …): implement `LLMProvider`
  (`packages/pipeline/src/llm/provider.ts`). You need `name`, `model`, `isAvailable()` and
  `generateJson(req)`, which must return JSON that satisfies `req.schema`. Use it in
  `PipelineRunner.makeLlm()` (`packages/pipeline/src/pipeline/runner.ts`, which currently constructs
  `OllamaProvider`), or inject it via `new PipelineRunner(cfg, store, log, { llm })`, and add its
  settings to `packages/config`. `LLMHelper` keeps doing the caching, concurrency limits and the
  rewrite guard.

### How to add another video style

1. **Camera math** (`workers/processing/audiobook_worker/video/layout.py`): decide the base scale in
   `base_scale()` and, if the style moves, the camera path (see `build_camera_path()` for how `follow`
   pans with a dead zone).
2. **Compositor** (`video/compositor.py` → `ChapterCompositor._run_state()`): add a branch that
   returns the `(page, center_y, scale, highlights)` state for time `t`. Anything returned in that
   tuple enables frame reuse automatically. If the style zooms beyond 7 %, raise `MAX_ZOOM` in
   `video/render_chapter.py` so pages are rasterized sharp enough.
3. **Types and validation:** add the name to `AnimationStyle` (`packages/types/src/settings.ts`), the
   `animation` enum in `apps/api/src/projects/settings.schema.ts` and the CLI help
   (`apps/cli/src/main.ts`).
4. **UI:** add an entry to `ANIMATIONS` in `apps/web/components/settings-form.tsx`.
5. Add a unit test in `workers/processing/tests/test_layout.py`, then render a sample:
   `pnpm audiobook ./sample-book.pdf --animation <name> --chapters 1-2`. The style is part of the
   render cache key, so switching styles re-renders video only.

New highlight looks go in `ChapterCompositor._draw_highlight()`, the `HighlightStyle` type and
schema, the CLI help, the web form, and the browser preview's CSS approximation
(`apps/web/lib/highlight.ts`, `components/read-along-player.tsx`). New themes go in the
compositor's `THEMES`, the `VideoTheme` type and schema, and `THEMES` in
`apps/web/components/settings-form.tsx`.

### Bangla roadmap

What is already language-aware:

- Sentence segmentation uses ICU (`Intl.Segmenter`) with the project language and handles the
  dari `।`.
- Chapter patterns include `অধ্যায়` with Bengali digits.
- OCR requests Tesseract's `ben` model when `language: "bn"`.
- The subtitle track is tagged `ben`.
- The API refuses `bn` with Kokoro and points here.

What is missing:

1. **A Bangla TTS engine** (the main gap): for example Meta's MMS-TTS Bengali VITS model (check its
   license: the MMS weights are CC-BY-NC 4.0), or a Bangla VITS voice exported to Piper's ONNX format,
   which would work with the existing Piper engine as-is. Add it as described above.
2. **Narration normalization for Bangla** (numbers, abbreviations). `normalizeNarration()` currently
   applies English rules only.
3. `brew install tesseract-lang` for the `ben` OCR model.
4. **A Bangla-capable font** for chapter title cards. The compositor's `FONT_CANDIDATES` are
   Latin-only; macOS ships Kohinoor Bangla and Bangla MN.

---

## Testing

```bash
pnpm test        # everything
pnpm test:ts     # vitest: packages/*/test and apps/api/test
pnpm test:py     # pytest: workers/processing/tests
```

- **Text** (`packages/pipeline/test/text.test.ts`): de-hyphenation (including compounds and keeping
  both boxes), header/footer and page-number removal, overprint duplicates, sentence segmentation
  (abbreviations, initials, long sentences), paragraph segmentation, chapter detection (outline,
  patterns, fonts, LLM only when ambiguous, with a mocked LLM), highlight regions, narration
  normalization.
- **Timeline** (`timeline.test.ts`): sample-exact chapter offsets, cross-page splits, paragraph mode,
  binary search, contiguous frame ranges (no drift), SRT.
- **Pipeline integration** (`pipeline.integration.test.ts`, real Python + FFmpeg, fake deterministic
  TTS): produces a synced MP4/M4A/SRT, resumes without redoing work, theme change re-renders video
  only, a failed chapter keeps finished chapters and retry continues. It is skipped automatically
  when the venv or FFmpeg is missing.
- **API** (`apps/api/test`): error mapping and filter, settings schema, queue behaviour when Redis
  is down, Prisma store, project service, system controller.
- **Python** (`workers/processing/tests`): PDF inspect/extract with boxes, corrupt/empty/password/
  image-only PDFs, page rendering, sample-accurate chapter TTS timings, TTS retry, silence trimming,
  camera dead zone and pans, page runs, highlight fades, frame counts, on-demand page rasterization.

AI output is never asserted deterministically. The LLM and TTS are mocked or faked behind their
interfaces.

---

## Copyright

This application is a processing tool. **Only process and distribute books you have the legal right
to use**: your own works, public-domain books, or books whose license allows it. The web UI shows this
reminder. Nothing here removes DRM or copy protection, and encrypted PDFs need their password.

---

## Scope of V1

Intentionally **not** included: AI-generated video or images, cloud AI APIs, user accounts or
authentication, payments, multi-user SaaS, cloud storage, collaboration, a mobile app, Kubernetes or
microservices.

Also deliberately limited in V1:

- Highlighting is sentence- or paragraph-level, not word-by-word. The TTS layer can estimate word
  timings, but the pipeline does not use them yet.
- English is the tuned language; Bangla is on the [roadmap](#bangla-roadmap).
- 9:16 and 1:1 work, but the layout is tuned for 16:9.
- Encrypted PDFs are supported through the CLI only.
- One machine, local processes, local storage.

---

## Repository layout

```text
apps/
  api/                 NestJS API (src/main.ts) + BullMQ worker (src/worker.ts), Prisma schema & migrations
  cli/                 `audiobook` CLI (create | inspect | voices | doctor | sample)
  web/                 Next.js dashboard
packages/
  types/               domain model shared by all apps (settings, status, pdf, analysis, audio, timeline, api)
  config/              .env loading + validation (zod), storage paths
  shared/              AppError, hashing, atomic fs, semaphore, logger, formatting
  pipeline/            PipelineRunner, text/, llm/, tts/, audio/, timeline/, python/ bridge, health, maintenance
workers/processing/    Python worker: audiobook_worker/{pdf,tts,video}, tests/, requirements.txt
scripts/               setup-mac.sh, setup-python.sh, download-models.sh, lib.sh
docker/, docker-compose.yml   Postgres + Redis only
docs/ARCHITECTURE.md   design notes
storage/               all data (git-ignored)
```
