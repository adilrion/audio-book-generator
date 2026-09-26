# Architecture and design notes

This document explains *how* the pipeline works and *why* it is built this way. The
[README](../README.md) covers setup and usage. Everything here describes the code as it is.
File references are given so you can check each claim.

## Contents

- [Guiding principles](#guiding-principles)
- [Processes and responsibilities](#processes-and-responsibilities)
- [Data model: page → paragraph → sentence → rectangles](#data-model-page--paragraph--sentence--rectangles)
- [Extraction](#extraction)
- [Text cleaning heuristics](#text-cleaning-heuristics)
- [Paragraphs and de-hyphenation](#paragraphs-and-de-hyphenation)
- [Sentences and narration text](#sentences-and-narration-text)
- [Chapter detection](#chapter-detection)
- [LLM guardrails](#llm-guardrails)
- [TTS and sample-exact timings](#tts-and-sample-exact-timings)
- [Timeline math](#timeline-math)
- [Compositor and camera](#compositor-and-camera)
- [Encoding, mastering and muxing](#encoding-mastering-and-muxing)
- [Cache keys](#cache-keys)
- [Resumability](#resumability)
- [Database schema](#database-schema)
- [Error handling](#error-handling)
- [Memory strategy for a 16 GB Mac](#memory-strategy-for-a-16-gb-mac)

---

## Guiding principles

1. **The printed page is the source of truth.** Every spoken sentence keeps the rectangles of
   the words it was printed with. Nothing is highlighted by guesswork.
2. **Deterministic first, LLM last.** Rules handle cleaning, paragraphs, sentences and chapters.
   The local LLM only answers small, checkable questions, and the pipeline works without it.
3. **Timing by construction, not by alignment.** Audio is built sentence by sentence, so every
   timestamp is a sample position. There is no forced aligner and no drift.
4. **Content-addressed artifacts.** Each stage writes files named by a hash of its inputs.
   Resume, retry, cross-project reuse and "change the theme, re-render video only" all come from
   this one mechanism.
5. **Stream everything.** Pages, audio and frames are written to disk as they are produced.
   Nothing book-sized sits in RAM.

## Processes and responsibilities

| Process | Code | Does |
|---|---|---|
| API | `apps/api/src/main.ts` | Uploads, settings, status, downloads, previews. Enqueues jobs; never runs the pipeline. |
| Worker | `apps/api/src/worker.ts`, `worker/processor.ts` | Consumes the BullMQ queue `audiobook`, runs `PipelineRunner` with a `PrismaStore`. |
| CLI | `apps/cli/src/main.ts` | Runs `PipelineRunner` directly with a JSON `FileStore` (no DB, no Redis). |
| Pipeline | `packages/pipeline` | Orchestration (`pipeline/runner.ts`), text processing (`text/`), LLM (`llm/`), timeline (`timeline/`), FFmpeg (`audio/ffmpeg.ts`). |
| Python workers | `workers/processing/audiobook_worker` | PyMuPDF extraction and rasterization, TTS engines, frame compositor and encoder. |

The Node side talks to Python over **JSON lines on stdin/stdout** (`python/bridge.ts` ↔
`server.py`). Each Python process handles one request at a time and keeps its models loaded.
Parallelism comes from a fixed-size `PythonPool`. A pool is created per stage and shut down when
the stage ends, which is how Kokoro's memory is returned before video rendering starts.
Cancelling a call kills its process (SIGKILL), because that is the only reliable way to stop a
CPU-bound native call.

Protocol (`server.py`): request `{"id", "method", "params"}`; zero or more
`{"id", "event": "progress", "data": {...}}`; then `{"id", "result"}` or
`{"id", "error": {"code", "message", "details", "retryable"}}`. The server duplicates the real
stdout for the protocol and redirects everything else libraries print to stderr, so a stray
`print` can never corrupt the channel.

## Data model: page → paragraph → sentence → rectangles

All coordinates are **PDF points with the origin at the top left** (PyMuPDF's convention).
`Rect = [x0, y0, x1, y1]` (`packages/types/src/pdf.ts`).

```text
ExtractedPage (pages.jsonl, one line per page)
└── blocks[] → lines[] {b, size, font, bold, italic}
                └── words[] {t, b}              every printed word with its own box

Analysis (analysis-<key>.json)
└── chapters[] {index, title, pageStart, pageEnd, source: toc|pattern|font|llm|fallback}
    └── paragraphs[] {id "c3-p12", kind heading|body, text, regions[]}
        └── sentences[] {id "c3-p12-s1", text (as printed), narration (as spoken), regions[]}

PageRegion {page, rects[], chars}              one rect per (partial) printed line on that page
```

Inside the text code a word is a `Token` with one or more `Part`s (`text/model.ts`). A word
hyphenated across a line break, or across a page break, is one token with **two parts**, each
keeping its own page and box. `regionsFor()` (`text/regions.ts`) merges the parts of a token range
into one rectangle per printed line and per page. So a sentence that starts mid-line highlights
exactly its own words, and a sentence that continues on the next page has a region on both pages.
`chars` records how many characters fall on each page; the timeline uses it to split time.

`text` and `narration` are deliberately separate. `text` is exactly what is printed (after
de-hyphenation and whitespace cleanup) and is used for subtitles and the UI. `narration` is what
the voice says, after normalization, pronunciation respellings and LLM repair.

## Extraction

`pdf/extract.py` opens the PDF with PyMuPDF and walks the pages one by one, writing each page as
one JSON line. It uses `rawdict` extraction and builds word boxes from **character boxes**, so
every word has a tight box of its own. PyMuPDF's built-in de-hyphenation is deliberately *not*
used, because it would merge the two halves of a word and lose one of the boxes.

- Rotated pages are mapped back through the page rotation matrix.
- Vertical or rotated lines (margin notes, watermarks) are skipped.
- Per line, the dominant font size, font name and bold/italic flags are kept for the heading and
  chapter heuristics.
- OCR (`ocr=auto`) runs only on pages with fewer than 20 characters of text **and** at least one
  image, at 200 dpi, via PyMuPDF's Tesseract integration (`eng`, or `ben` for Bangla).
  `ocr=force` OCRs every page; `off` never does.
- `meta.json` stores page count, page sizes, the PDF outline (TOC), title/author, and the lists of
  empty and OCR'd pages.

Errors are classified at the source: `PDF_CORRUPT`, `PDF_UNSUPPORTED`, `PDF_PASSWORD`, `PDF_EMPTY`,
`PDF_NO_TEXT`, `PDF_SCANNED` (image-only and no OCR available).

## Text cleaning heuristics

`text/clean.ts`. Everything is deterministic and position-aware.

| Rule | How |
|---|---|
| Body font size | The most common font size, weighted by characters, rounded to 0.5 pt |
| Overprinted duplicates ("fake bold") | Same word or line at the same place (IoU > 0.7) is dropped |
| Soft hyphens, zero-width characters | Normalized or removed |
| Header/footer zones | Only lines entirely within the top or bottom `max(36 pt, 9 % of page height)` are candidates |
| Running headers/footers | A line's *header key* replaces digits and roman numerals with `#` and strips punctuation, so "Chapter 3 — The Mill 47" and "Chapter 3 — The Mill 48" match. It is removed if the same key appears in the same zone on at least `max(3, 20 % of pages)` pages (2 pages for books of 4 pages or fewer), or on ≥ 3 pages when the line is short (≤ 12 words) and not larger than body text |
| Page numbers | In a margin zone: `12`, `xii`, `- 12 -`, `Page 12`, `12 of 300`, `12/300` |
| TOC leader lines | `Introduction ........ 7` anywhere on the page |

The cleaning report (counts and the first removed header texts) is kept in the analysis and shown
in the step message.

## Paragraphs and de-hyphenation

`text/paragraphs.ts` groups cleaned lines into paragraphs using geometry measured per page
(left edge at the 10th percentile, right edge at the 90th percentile, median line gap of body
lines).

- **Headings**: a line whose size is ≥ 1.18 × body, or a bold line (when the body is not bold)
  of ≤ 14 words that does not end in `,` `;` or sentence punctuation.
- **New paragraph** when the kind changes (heading/body); the vertical gap exceeds the median gap
  plus 0.45 × body size; the line is indented (0.8–8 × body size); or the previous line was short
  and ended a sentence.
- **Columns**: a line that jumps back up the page starts a new column; it continues the paragraph
  unless the previous line ended a sentence and the new one is indented or follows a short line.
- **Page breaks**: a paragraph continues onto the next page unless the previous line ended a
  sentence, the new one is indented or follows a short line, and it does not start in lowercase.

**De-hyphenation** (`dehyphenate()`): when a line ends in a hyphen and the next line continues,
the two halves are joined into one token that keeps both boxes. To decide between `Revolu-`+`tion`
→ "Revolution" and `self-`+`aware` → "self-aware":

1. A soft hyphen is always joined.
2. If the second half starts with a capital letter, the hyphen is kept ("anti-American").
3. If the joined word occurs elsewhere in the book, it is joined. If the hyphenated form occurs
   elsewhere, the hyphen is kept (the book's own vocabulary decides).
4. Known compound prefixes (`self`, `well`, `non`, `co`, `twenty`, …) keep the hyphen.
5. Otherwise the halves are joined.

## Sentences and narration text

`text/sentences.ts` uses ICU sentence segmentation (`Intl.Segmenter` with the project language,
so the Bangla danda `।` works) and then repairs its known weaknesses:

- **Abbreviations**: "strong" ones (`Mr.`, `Dr.`, `e.g.`, `No.`, `Fig.` …) never end a sentence;
  "weak" ones (`etc.`, `Inc.`, month names …) end it unless the next word is lowercase. Single
  capital initials ("J. R. R. Tolkien") never end a sentence.
- Fragments of 2 characters or fewer are merged into the neighbouring sentence.
- Sentences longer than 320 characters are split recursively at the clause boundary nearest the
  middle (`;` `:` `—` preferred over `,`, at least 40 characters on each side). This keeps TTS
  requests short and highlights readable.

Headings are one "sentence" each and get a trailing full stop in the narration so the voice uses
falling intonation.

`text/normalize.ts` changes only the narration: typographic quotes, footnote markers (`word.12`,
`[3]`), dashes → commas, URLs without the scheme, and for English `e.g.` → "for example", `i.e.`
→ "that is", `etc.` → "et cetera", `vs.`, `cf.`, `No. 5`, `pp. 12`, `p. 7`, `ch. 3`, `fig. 2`,
`&`, `%`. The optional pronunciation lexicon is applied last, on word boundaries.

## Chapter detection

`text/chapters.ts` and `text/analyze.ts`. Sources are tried in a fixed priority order and the
first one that yields at least two chapters wins:

1. **PDF outline (TOC)**, when it has ≥ 2 entries with a page. The chapter level is level 1, or
   level 2 if level 1 has fewer than 3 entries but level 2 has at least 3. Each entry is anchored
   to a short paragraph (≤ 25 words) on its page whose words overlap the title by ≥ 60 %, or else
   to the first paragraph starting on or after that page.
2. **Textual patterns** on heading-like lines (heading font, first line on a page, or bold; at
   most 16 words): `Chapter 3`, `Chap. IV`, `CHAPTER ONE`, `Part II`, `Book 2`, `Section 5`,
   `Prologue`, `Epilogue`, `Introduction`, `Preface`, `Appendix A`, `অধ্যায় ৩` …, plus numbered
   headings like `1. Introduction`. A heading right after "Chapter 1" on the same page becomes
   its subtitle ("Chapter 1: The Beginning"), not a separate chapter. Accepted when there are
   between 2 and paragraphs/3 matches.
3. **Font tiers**: the largest heading size that is used between 2 and paragraphs/4 times.
4. **Local LLM**, only when the result is *ambiguous* or has fewer than two chapters, and there
   are at least two candidate headings. Ambiguous means: the pattern count and the font-tier count
   differ by more than `max(3, pattern count)`; or, when only font tiers matched, there are more
   than 80 of them or more than three times as many heading candidates as chapters.
   The LLM chooses from a numbered list of candidate lines (see below); its choice is used only if
   it returns at least two valid ids.
5. **Fallback**: if the book spans 18 pages or more, it is cut into "Part N" sections of about 12
   pages at paragraph boundaries (small chunks keep TTS and resume granular). A shorter document
   becomes one chapter named after the book.

Content before the first chapter becomes an **"Opening Pages"** chapter, unless
`skipFrontMatter` is set, in which case it is dropped along with chapters titled like front
matter (Contents, Copyright, Dedication, …).

## LLM guardrails

`llm/helper.ts` (tasks) and `llm/ollama.ts` (transport). The LLM can never rewrite the book:

- **Only small, targeted inputs.** Chapter detection sends at most 160 short candidate lines
  (`id | page | font size | text`). Repair sends only paragraphs that `looksBroken()` flags, at
  most 300 of them. Pronunciation (opt-in, English) sends at most 150 words.
- **Only suspicious paragraphs are repaired.** `looksBroken()` looks for letter-spaced text
  (over half the tokens are single letters), replacement characters or unexpanded ligature
  glyphs, more than 8 % unusual symbols, or two or more "words" of 26+ letters (glued words).
  Clean text goes to TTS untouched.
- **Structured JSON only.** Requests go to Ollama's `/api/chat` with `format` set to a JSON
  schema, `temperature: 0`, `think: false`, `num_ctx: 8192` and `keep_alive: "10m"`, under a
  system prompt that forbids paraphrasing. Unparseable answers are errors, not text.
- **Validated answers.** Chapter ids must be among the candidates. A repair must return exactly
  as many sentences as were sent, and **each repaired sentence must be at least 80 % similar**
  to the original (Levenshtein ratio on letters and digits), or the original is kept.
  Respellings must be for words that were sent and shorter than 40 characters.
- **Narration only.** Repairs and respellings change `narration`, never `text`. Subtitles and
  the UI always show what is printed.
- **Cached.** Every answer is stored in `storage/extracted/llm-cache/<task>-<hash>.json`, keyed
  by provider and model, task name and the exact input that was sent. (The prompt template is not
  part of the key, so rename the task when you change a prompt.)
- **Never fatal.** If Ollama is not reachable or the model is not pulled (checked once per run
  via `/api/tags` with a 3 s timeout), the run continues rule-based and records a warning. Any
  failed LLM call falls back to the rule-based result. Concurrency is bounded by
  `MAX_CONCURRENT_LLM`.

## TTS and sample-exact timings

`PipelineRunner.chapterSegments()` turns a chapter into a list of `{id, text: narration, pauseMs}`
segments: 280 ms after a sentence, 650 ms after a paragraph (+250 ms after a heading), 1800 ms
after the last sentence of the chapter (defaults, configurable per project in `audio.*`).

`tts/service.py → synthesize_chapter()` writes **one FLAC per chapter**:

```text
for each segment:
    audio = engine.synthesize(text)                   # retried up to 2 times on failure
    audio = resample to TTS_SAMPLE_RATE, trim leading/trailing silence (−48 dB, 25 ms pad)
    start = pos / rate;  write(audio);  pos += len(audio);  end = pos / rate
    write(pauseMs of zeros);  pos += pause
```

The file is written incrementally with `soundfile`, so a chapter is never held in memory. Because
every start and end is a sample position in the very file that is played, the timing is exact by
construction (stored rounded to 0.1 ms). Trimming the engine's own silence means the pauses are
exactly what the pipeline asked for. Peaks above 0.99 are scaled down per sentence to avoid
clipping.

Word timings, when requested, are estimated inside the exact sentence window, proportional to
word length + 1. The pipeline does not request them yet (highlighting is sentence-level).

## Timeline math

`timeline/build.ts`:

- **Chapter offsets** are the cumulative `samples / sampleRate` of the previous chapters, computed
  from integer sample counts, not from rounded durations.
- **Global time** of a sentence = chapter offset + its in-chapter start/end.
- **Cross-page sentences** are split across their page regions in proportion to the characters
  on each page (at least 1 each). The last part always ends exactly at the sentence end, so the
  parts tile the interval. The page turns when the narration crosses the page break.
- **Paragraph mode** keeps the sentence timing but highlights the paragraph's rectangles on the
  current page.
- Each segment records `pageChange` for the renderer and the UI; `segmentAt()` finds the active
  segment by binary search.
- **Frame ranges come from absolute times.** Chapter *k* is rendered as global frames
  `[round(start·fps), round(end·fps))`. Consecutive chapters share their boundary, so the
  per-chapter frame counts add up to `round(total·fps)`, whatever the rounding in each chapter.
  Rendering "N seconds of frames per chapter" would accumulate a fraction of a frame per chapter.
- **Subtitles** (`timeline/subtitles.ts`) use the printed sentence text. Sentences longer than 84
  characters are split into cues timed by character share, wrapped to two lines of about 42.
- **chapters.txt** lists `m:ss Title` (or `h:mm:ss`) for a YouTube description.

## Compositor and camera

`workers/processing/audiobook_worker/video/`. `layout.py` is pure math (unit-tested),
`compositor.py` draws frames, `render_chapter.py` drives one chapter, `encoder.py` pipes to FFmpeg.

**Scale.** `base_scale()` gives frame pixels per PDF point. `static` and `kenburns` fit the whole
page (92 % of the frame). `follow` makes the page width 62 % of the frame width in landscape (92 %
in portrait/square), but never less than the fit, so body text is readable at 1080p and the
camera pans vertically.

**Camera path (`follow`).** For each sentence the target is the vertical center of its
rectangles; for a block taller than 60 % of the visible height, its top is placed at 30 % of the
frame instead. The camera only moves when the target leaves a **dead zone of 18 % of the visible
height** around the current position, so it does not twitch on every line. A move is a 0.9 s
**smootherstep** ease (zero velocity and acceleration at both ends) that starts 0.35 s before
the sentence, and the center is clamped so the camera never leaves the page.

**Zoom.** With `subtleZoom`, `follow` zooms in linearly by 3 % over the time a page is on screen,
and `kenburns` by 6 % with easing. `static` never moves. Pages are rasterized at base scale × 1.07
(`MAX_ZOOM`), quantized to steps of 0.05 so neighbouring chapters share rasters, so the zoom
never upsamples.

**Pages.** Consecutive segments on the same page form a *page run*. The next page appears 0.3 s
before its first sentence (but not before the previous page's last sentence ends) with a 0.45 s
smootherstep **cross-fade**. There is no other transition.

**Highlights.** The current sentence fades in over 0.12 s, stays 0.8 s into the following pause,
then fades out over 0.3 s; consecutive sentences cross-fade. Styles: `marker` (multiply blend, so
ink stays dark and paper takes the color), `underline` and `box`. Rectangles are padded slightly
relative to the line height.

**Overlays.** A chapter title card is shown from 0.3 s to 5.3 s after the chapter starts (0.4 s
fades), and a thin progress bar along the bottom shows the position in the whole book.

**Frame reuse.** A frame is fully described by its *state*: page, camera center, scale, the
highlight alphas (quantized to 1/16), the page-fade state (1/32), progress-bar pixel and title
alpha. If the state equals the previous frame's, the previous frame is sent again without any
work. Page canvases (the raster on a background with a soft shadow) are kept in an LRU of 3, and
page+highlight composites in an LRU of 4. The per-frame work is a single `cv2.warpAffine` to the
output size plus small blends. `static` therefore reuses almost every frame; `follow` with subtle
zoom changes scale every frame and composites each one.

## Encoding, mastering and muxing

- **Chapter video**: raw BGR frames are written to FFmpeg's stdin (no image sequence on disk).
  `h264_videotoolbox` uses the M4 media engine with `-b:v`, `-maxrate` and `-bufsize` all set to
  `VIDEO_BITRATE`; `libx264` uses `-preset veryfast -tune stillimage -crf VIDEO_CRF`. Both use High
  profile, a 2-second GOP, yuv420p and BT.709 tagging. Segments are video-only.
- **Audio master** (`masterAudio`): the chapter FLACs are concatenated, optionally normalized with
  `loudnorm=I=-16:TP=-1.5:LRA=11`, resampled to 48 kHz mono and encoded once to AAC (`aac_at` if
  available) with chapter markers → `audiobook.m4a`.
- **Final MP4** (`muxFinal`): the chapter segments are concatenated with `-c:v copy`, the master
  AAC is added with `-c:a copy`, plus a soft `mov_text` subtitle track (tagged `eng`/`ben`),
  chapters and `+faststart`. Encoding the audio **once** for the whole book avoids the AAC
  priming/padding gap that per-chapter audio would add at every chapter boundary.
- **Validation** (`validateOutput`): ffprobe must find both streams, video and audio durations
  must agree within 2 frames + 0.1 s, and the audio must be within 0.5 s of the expected
  narration length. Otherwise the step fails with `OUTPUT_OUT_OF_SYNC`.
- **Re-mux without re-render**: when only audio, subtitle or metadata inputs changed and the
  segments were already cleaned up, the picture is stream-copied from the existing
  `audiobook.mp4` (the manifest records which segment keys it was built from).

## Cache keys

Every key is `hashKey(...)`: the first 20 hex characters of SHA-256 over a stable, sorted-key JSON
encoding of the listed inputs (`packages/shared/src/hash.ts`). The version constants
(`EXTRACT_VERSION`, `ANALYZER_VERSION`, `TTS_VERSION`, `RENDER_VERSION`, the TTS provider's
`version`) are bumped whenever a stage's output would change for the same inputs.

| Artifact | Stored at | Key includes |
|---|---|---|
| Extraction | `extracted/<pdf>/extract-<key>/` | extractor version, PDF SHA-256, OCR mode, language |
| Analysis | `extracted/<pdf>/analysis-<key>.json` | analyzer version, extraction key, language, skip-front-matter, LLM id (`ollama:<model>` or `none` when off or unreachable), pronunciation flag, project title |
| LLM answer | `extracted/llm-cache/<task>-<key>.json` | provider:model, task, exact input |
| Chapter audio | `audio/<key>.flac` + `.json` | TTS version, engine, provider version, voice, speed, `TTS_SAMPLE_RATE`, language, the chapter's segments (sentence ids, narration text, pause lengths) |
| Audio master | `output/<project>/audiobook.m4a`, key in `manifest.json` | chapter audio keys, loudness normalization, `AUDIO_BITRATE`, `AUDIO_ENCODER`, chapter titles, book title |
| Timeline, SRT, chapters.txt | `output/<project>/`, key in `manifest.json` | analysis key, chapter audio keys, fps, highlight mode |
| Chapter video segment | `renders/video/<key>.mp4` | render version, PDF SHA-256, the chapter's audio key, width, height, fps, style (animation, subtle zoom, highlight style and color, theme, progress bar, chapter title card), encoder (`VIDEO_ENCODER`, `VIDEO_BITRATE`, `VIDEO_CRF`, `FFMPEG_BIN`), the chapter's highlight segments (times, pages, rects), chapter title, global frame range, and the book duration when the progress bar is on |
| Final MP4 | `output/<project>/audiobook.mp4`, key in `manifest.json` | all segment keys, master key, embed-subtitles flag, language |
| Page rasters | `renders/pages/<pdf>/<scale>/page-NNNN.png` | PDF SHA-256, render scale (in the path) |
| UI previews | `renders/preview/<pdf>/page-NNNN.jpg` | PDF SHA-256, page (1.6 px/pt) |

Artifacts in the shared folders (`extracted/`, `audio/`, `renders/`) are shared by every project
and every CLI run. Per-project outputs are checked against the keys in that project's
`manifest.json`.

Consequences worth knowing:

- Sentence ids are positional (`c<chapter>-p<paragraph>-s<sentence>`) and are part of the TTS
  segments, so anything that renumbers chapters (for example dropping "Opening Pages" with
  skip-front-matter) re-narrates the chapters after the change.
- Ollama going down (or coming back) changes the analysis key, so analysis re-runs. TTS is only
  redone for chapters whose narration actually changed.
- Frame ranges are absolute, so choosing a different chapter range re-renders the video of the
  chapters that moved in time; chapter audio is reused.
- With the progress bar on, the total duration is in every segment key, so any change of total
  length re-renders all chapter videos.

## Resumability

Resumability is **artifact-driven**. On every run, including resume and retry, the runner goes
through all stages from the top, and each step first checks whether its artifact exists. A hit is
marked `cached` and takes milliseconds. So if a run stopped in chapter 7, chapters 1–6 are found
in `storage/audio/` and only chapter 7 onwards is narrated. The store (Postgres or `state.json`)
is for progress display and the UI; deleting it loses no work.

- All files are written atomically: temp file next to the target, then `rename`. A half-written
  file never has the final name.
- Keys stored in `manifest.json` are cleared before their file is rewritten, so a crash in the
  middle can never leave a stale key vouching for a file made with other settings.
- **Cancel** aborts the run's `AbortSignal`; Python and FFmpeg processes are killed and the
  running step goes back to `PENDING`.
- **Restart** (`force`) ignores every cache lookup and overwrites artifacts.
- On start-up the worker marks projects left in a running state as `FAILED` with code
  `INTERRUPTED`, so the UI offers Resume.

## Database schema

`apps/api/prisma/schema.prisma`. Postgres holds structure and state; large artifacts stay on disk.

| Model | Purpose |
|---|---|
| `Document` | One uploaded PDF, unique by SHA-256 (many projects may share it): file name, path, size, page count, estimated words, title/author, scanned/TOC/encrypted flags |
| `Project` | Name, `settings` (JSON `ProjectSettings`), `status` (`JobStatus`), `progress`, `snapshot` (latest `ProgressSnapshot` incl. user-facing error), `analysisKey`, `cancelRequested`, `durationSec`, `outputs` |
| `ProcessingStep` | One row per step (`EXTRACT`, `TTS_CHAPTER_3`, `MUX`, …) with status, progress, `cached`, message and error; unique per project and key |
| `RenderJob` | One queued run (process/resume/retry/restart), linked to the BullMQ job id; used to refuse double starts |
| `Chapter` → `Paragraph` → `Sentence` | The analysis, written in bulk when it changes (`Sentence.key` is the pipeline id; `regions` are JSON rectangles) |
| `AudioChunk` | One narrated chapter: file, duration, sample rate, cache key, engine, voice |
| `TimelineSegment` | The highlight timeline: sentence key, chapter, page, start, end, rects |
| `Page` | Reserved for per-page metadata; not written yet (page sizes live in `meta.json` and the timeline) |

Child tables cascade on project deletion. `JobStatus` is `PENDING, EXTRACTING, CLEANING,
ANALYZING, GENERATING_AUDIO, PREPARING_VIDEO, RENDERING, COMPLETED, FAILED, CANCELLED`;
`StepStatus` is `PENDING, RUNNING, COMPLETED, FAILED, SKIPPED`.

## Error handling

- **One error type.** `AppError(code, message, {hint, retryable, stepKey, chapterIndex, details,
  cause})` in `packages/shared/src/errors.ts`. `message` and `hint` are written for a normal user.
  `details` and `cause` go to logs only.
- **Classified at the source.** The Python worker raises `WorkerError` with stable codes
  (`PDF_PASSWORD`, `TTS_FAILED`, `FFMPEG_FAILED`, `OUT_OF_MEMORY`, …). `toAppError()` maps them,
  and system errors such as `ENOSPC` or connection refusals on 6379/5433/11434, to friendly
  messages with a next step.
- **Step context.** A failure inside a step carries that step's key and chapter:
  "Audio generation failed for Chapter 7. Retry to continue from Chapter 7 — finished chapters are
  kept." The step row keeps the error so the UI can show it next to the right item.
- **HTTP.** A global filter answers `{ "error": { code, message, hint, retryable, … } }` with a
  status derived from the code (400, 404, 409, 410, 413, 422, 503, 507, else 500). Stack traces and
  FFmpeg stderr only reach the server log.
- **CLI.** Prints the message and the hint; `--verbose` adds the technical chain.
- **Degrade instead of fail.** Missing Ollama, OCR or VideoToolbox produce a warning and a
  slower or rule-based path, not an error. Disk space is checked before extraction, TTS and
  rendering, instead of failing halfway.
- **Failure never discards work.** A failed chapter leaves all finished chapters in the cache;
  retry continues from it.

## Memory strategy for a 16 GB Mac

| Where | How memory stays bounded |
|---|---|
| Upload | Multer streams to `storage/uploads/.incoming/`; hashing is streamed |
| Extraction | One page at a time, written to `pages.jsonl` immediately |
| Analysis | The one stage that holds the whole book's text: compact line and word records in the Node process, read back from `pages.jsonl`. No images or audio are involved |
| TTS | Sentence by sentence into a FLAC on disk. Each TTS process holds one Kokoro model; measured peak RSS ≈ 0.7 GB per process. `MAX_CONCURRENT_TTS` (default 2) bounds the number of processes, and threads are split between them (`KOKORO_THREADS`) |
| Between stages | The TTS pool is shut down before video starts, so the models are gone when the compositors start |
| Video | Pages are rasterized on demand, capped at 12 MP, and at most 3 page canvases plus 4 composites are cached per compositor. Frames are streamed to FFmpeg. `MAX_CONCURRENT_PDF_RENDER` (default 2) bounds compositor+encoder pairs; each uses 2 threads |
| Audio master / mux | FFmpeg streams; the book is never decoded into memory |
| LLM | Ollama runs natively; `qwen3:4b` is 2.5 GB on disk and stays loaded for 10 min after the last request (`keep_alive`). `MAX_CONCURRENT_LLM=1` |
| Infrastructure | Docker limits Postgres to 512 MB and Redis to 320 MB (`maxmemory 256mb`) |
| Projects | `MAX_CONCURRENT_PROJECTS=1`: one book at a time |
