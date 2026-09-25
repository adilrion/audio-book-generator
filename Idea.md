You are a senior full-stack engineer and AI systems architect.

I want you to build a **local-first PDF → Audiobook + Animated/Highlighted PDF Video Generator**.

The application should run primarily on my local MacBook and should use free/open-source/local AI models wherever possible. Do NOT design this around paid APIs.

## My Hardware

Target machine:

* MacBook with Apple M4 chip
* 16GB unified memory
* 500GB SSD
* macOS

The application must be optimized for Apple Silicon and 16GB memory.

---

# 1. Product Goal

A user uploads a PDF book.

The application should:

1. Extract text from the PDF.
2. Detect chapters/pages/paragraphs.
3. Clean PDF extraction artifacts.
4. Generate natural audiobook narration using a local TTS model.
5. Generate synchronized subtitles/timestamps.
6. Render the original PDF pages into a video.
7. Highlight the currently narrated text on the PDF page.
8. Add subtle animations such as zoom/pan.
9. Add audiobook audio.
10. Generate a YouTube-ready MP4.

The final result should feel like:

**"Read Along Audiobook Video"**

The viewer sees the actual book/PDF page while hearing the narration, with the currently spoken sentence or paragraph highlighted.

Do NOT generate AI video or AI images in V1.

Keep V1 efficient and realistic for an M4 16GB MacBook.

---

# 2. Example User Flow

The UI should work approximately like this:

### Step 1 — Upload

User uploads:

```text
book.pdf
```

Show:

* File name
* File size
* Number of pages
* Estimated word count

---

### Step 2 — Project Settings

Allow the user to choose:

### Output mode

* Audiobook + Animated PDF
* Audiobook only

For V1, the main mode is:

**Audiobook + Animated PDF**

### Voice

Provide locally available TTS voices.

Architecture should make it easy to add more voices later.

### Language

Initially prioritize:

* English

Design the architecture so Bangla can be added later.

### Video format

Default:

```text
1920x1080
16:9
```

Also keep the architecture flexible for:

* 16:9
* 9:16
* 1:1

But do not overbuild this in V1.

---

# 3. Processing Pipeline

Build the following pipeline:

```text
PDF
 ↓
PDF Text Extraction
 ↓
Text Cleaning
 ↓
Chapter Detection
 ↓
Page/Paragraph Segmentation
 ↓
Narration Preparation
 ↓
Local TTS
 ↓
Word/Sentence Timestamps
 ↓
PDF Page Rendering
 ↓
Text Highlight Overlay
 ↓
Animation
 ↓
Audio + Video Composition
 ↓
FFmpeg
 ↓
Final MP4
```

The system must process the book in chunks instead of loading the entire book into memory.

---

# 4. PDF Processing

Use:

**PyMuPDF**

for PDF extraction and rendering.

Extract:

* page number
* text blocks
* lines
* spans
* bounding boxes
* font information where useful

Preserve the relationship between:

```text
PDF page
→ paragraph
→ sentence
→ text bounding box
```

This relationship is extremely important because later we need to highlight the spoken text on the original PDF page.

If the PDF is text-based, use the actual PDF text.

Do NOT OCR normal text PDFs unnecessarily.

For scanned PDFs, design an optional OCR fallback using an open-source OCR engine, but do not make OCR the default path.

---

# 5. Text Cleaning

PDF extraction often creates bad text.

Handle things like:

* broken line wrapping
* hyphenated words across lines
* repeated headers
* repeated footers
* page numbers
* unnecessary whitespace
* duplicated text
* broken paragraphs

Example:

Bad:

```text
The Industrial Revolu-
tion changed the world.
```

Clean:

```text
The Industrial Revolution changed the world.
```

Do not modify the author's actual writing unnecessarily.

---

# 6. Chapter Detection

Detect chapters using a combination of:

1. PDF structure
2. Font size/style
3. headings
4. patterns such as:

   * Chapter 1
   * CHAPTER ONE
   * 1. Introduction
   * Part I
5. LLM fallback only when necessary

Do NOT send the entire book to an LLM just to detect chapters.

Prefer deterministic processing first.

---

# 7. Local LLM

Use:

**Ollama**

as the local model runtime.

Design the system so the model can be configured through environment variables.

Example:

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:4b
```

Use a small quantized model suitable for a 16GB Mac.

The LLM should NOT rewrite the entire book.

Its job should primarily be:

* fixing obvious extraction problems
* detecting ambiguous chapter boundaries
* improving sentence segmentation when necessary
* identifying pronunciation-sensitive words
* preparing text only when required

If the original text is already clean, pass it directly to TTS.

This is a critical optimization.

---

# 8. Local TTS

Use a local/open-source TTS solution.

Prefer:

**Kokoro**

if it performs well on Apple Silicon.

Otherwise provide an abstraction so another local TTS engine such as Piper can be plugged in.

Create a TTS interface like:

```ts
interface TTSProvider {
  synthesize(
    text: string,
    options: TTSOptions
  ): Promise<TTSResult>;
}
```

Do not tightly couple the application to one TTS engine.

The TTS layer must return:

* audio file
* duration
* sentence timestamps if available
* word timestamps if available

If the TTS engine does not provide word timestamps, implement a fallback timestamp strategy.

---

# 9. Audio Processing

Do NOT keep the entire audiobook audio in RAM.

Generate audio per chunk/chapter:

```text
audio/
  chapter-001.wav
  chapter-002.wav
  chapter-003.wav
```

Then combine them using FFmpeg.

Use efficient intermediate formats where appropriate.

Final audiobook audio should be suitable for YouTube.

---

# 10. Highlight Synchronization

This is one of the most important features.

For every sentence/phrase:

```text
sentence
start_time
end_time
page_number
bounding_box
```

Example:

```json
{
  "page": 42,
  "text": "The Industrial Revolution began in Britain.",
  "start": 132.42,
  "end": 138.91,
  "bbox": [120, 340, 780, 390]
}
```

During video rendering:

1. Display the correct PDF page.
2. Determine which sentence is currently being spoken.
3. Draw a highlight rectangle over that text.
4. Remove/change the highlight as narration progresses.

Prefer highlighting the actual sentence/line rather than manually approximating coordinates.

If sentence-level coordinates are unavailable, gracefully fall back to paragraph-level highlighting.

---

# 11. PDF Video Rendering

Render each PDF page as an image using PyMuPDF.

Use a reasonable rendering resolution.

Do NOT render every page at unnecessarily huge resolution because the target machine has 16GB unified memory.

Process pages/chunks sequentially.

The video should have:

* original PDF page
* subtle zoom
* subtle pan
* highlighted current sentence
* optional progress indicator
* optional chapter title

Keep the visual style professional and minimal.

Do not add unnecessary flashy animations.

---

# 12. Video Timeline

The video timeline should be driven by narration timestamps.

Example:

```text
00:00–00:07
Page 1
Sentence 1 highlighted

00:07–00:13
Page 1
Sentence 2 highlighted

00:13–00:22
Page 2
Sentence 3 highlighted
```

If narration moves to another page, transition naturally.

Avoid excessive transitions.

A simple fade or smooth page transition is enough.

---

# 13. FFmpeg

Use:

**FFmpeg**

for final video composition.

FFmpeg should handle:

* image/video sequence
* audio
* subtitles
* overlays
* transitions
* scaling
* H.264 encoding
* AAC audio

Default output:

```text
MP4
H.264
AAC
1920x1080
30 FPS
```

Make encoding settings configurable.

Use hardware acceleration where practical on Apple Silicon.

Investigate and use VideoToolbox where appropriate.

---

# 14. Backend Architecture

Use:

**NestJS + TypeScript**

for the main backend.

Use Python only where Python libraries are significantly better suited, especially:

* PyMuPDF
* TTS
* PDF rendering
* AI processing

Do not create an unnecessarily complicated microservice architecture.

For V1, use a modular monolith with local worker processes.

Suggested architecture:

```text
Next.js
   ↓
NestJS API
   ↓
Job Queue
   ↓
Local Processing Worker
   ├── PDF Processor
   ├── Text Processor
   ├── LLM Processor
   ├── TTS Processor
   ├── Timeline Processor
   └── Video Renderer
```

---

# 15. Queue System

Use:

**Redis + BullMQ**

for background processing.

Video generation should NEVER block an HTTP request.

Example:

```text
POST /projects
POST /projects/:id/process
GET  /projects/:id/status
GET  /projects/:id/output
```

Job statuses:

```text
PENDING
EXTRACTING
CLEANING
ANALYZING
GENERATING_AUDIO
PREPARING_VIDEO
RENDERING
COMPLETED
FAILED
```

Expose progress percentage.

Example:

```json
{
  "status": "GENERATING_AUDIO",
  "progress": 67,
  "currentChapter": 8,
  "totalChapters": 12
}
```

---

# 16. Database

Use PostgreSQL.

Design entities for:

```text
Project
Document
Page
Chapter
Paragraph
Sentence
AudioChunk
TimelineSegment
RenderJob
```

Do not over-normalize if it creates unnecessary complexity.

The database should allow the processing pipeline to resume after failure.

---

# 17. Resumable Processing

This is mandatory.

If processing stops at:

```text
Chapter 7
```

the application must not regenerate:

```text
Chapter 1–6
```

when resumed.

Every major processing step should be persisted.

Example:

```text
PDF_EXTRACTION      ✓
TEXT_CLEANING       ✓
CHAPTER_DETECTION   ✓
TTS_CHAPTER_1       ✓
TTS_CHAPTER_2       ✓
TTS_CHAPTER_3       ✓
VIDEO_RENDERING     PROCESSING
```

Allow:

```text
Resume
Retry failed step
Restart project
```

---

# 18. Caching

Implement aggressive caching.

For example:

```text
PDF hash
+
processing configuration
```

can be used to identify existing extracted/processed content.

If the user changes only:

```text
video theme
```

do NOT regenerate:

* PDF extraction
* LLM processing
* TTS

If the user changes only:

```text
voice
```

do NOT redo PDF processing or LLM processing.

Only regenerate the audio/video stages that depend on that setting.

---

# 19. Frontend

Use:

**Next.js + TypeScript + Tailwind CSS + shadcn/ui**

Create a clean modern dashboard.

Main screens:

### Dashboard

```text
Projects

+ New Audiobook
```

### Upload

Drag & drop PDF.

### Configuration

```text
Voice
Language
Output format
Animation style
Highlight style
```

### Processing

Show a live progress UI.

Example:

```text
Processing "Atomic Habits.pdf"

PDF Analysis          ✓
Text Cleaning         ✓
Chapter Detection     ✓
Audio Generation      ███████████░░ 78%
Video Preparation     ○
Rendering             ○

Chapter 8 of 12
```

### Preview

Allow the user to preview:

* PDF page
* highlighted sentence
* audio playback
* timeline

### Export

Show:

```text
audiobook.mp4
audiobook.m4a
subtitles.srt
```

---

# 20. Project Structure

Prefer a clean monorepo:

```text
pdf-audiobook/
│
├── apps/
│   ├── web/
│   │   └── Next.js
│   │
│   └── api/
│       └── NestJS
│
├── workers/
│   └── processing/
│       ├── pdf/
│       ├── llm/
│       ├── tts/
│       ├── timeline/
│       └── video/
│
├── packages/
│   ├── shared/
│   ├── types/
│   └── config/
│
├── storage/
│   ├── uploads/
│   ├── extracted/
│   ├── audio/
│   ├── renders/
│   └── output/
│
├── docker/
│
├── docker-compose.yml
├── package.json
└── README.md
```

You may improve this structure if you have a strong technical reason.

---

# 21. Apple Silicon Optimization

This project specifically targets:

**Apple M4 + 16GB unified memory.**

Optimize for:

* low memory usage
* sequential processing where necessary
* controlled concurrency
* native Apple Silicon binaries
* avoiding unnecessary Dockerization of AI workloads
* streaming files instead of loading them entirely into memory
* caching
* resumable jobs
* chunk-based processing

Do NOT assume CUDA/NVIDIA is available.

Do NOT design the architecture around CUDA.

Use native macOS/Apple Silicon acceleration where supported.

---

# 22. Resource Management

Implement a simple resource-aware worker configuration.

Example:

```env
MAX_CONCURRENT_TTS=2
MAX_CONCURRENT_PDF_RENDER=2
MAX_CONCURRENT_LLM=1
```

These should be configurable.

Avoid running too many AI processes simultaneously on 16GB unified memory.

---

# 23. CLI

Also create a CLI so the entire pipeline can be tested without the frontend.

Example:

```bash
npm run audiobook:create -- ./book.pdf
```

or:

```bash
pnpm audiobook ./book.pdf
```

It should produce:

```text
output/
  audiobook.mp4
  audiobook.m4a
  subtitles.srt
```

This is important for debugging and automation.

---

# 24. Testing

Create tests for:

### PDF

* extraction
* chapter detection
* paragraph segmentation

### Text

* hyphenation cleanup
* header/footer removal
* sentence segmentation

### Timeline

* timestamp calculation
* page transitions
* highlight coordinates

### TTS

* chunk generation
* retry handling
* caching

### Video

* correct page duration
* audio/video synchronization
* output validation

Do not attempt to test the actual AI model output deterministically.

Mock AI/TTS interfaces where appropriate.

---

# 25. Error Handling

Handle:

* corrupt PDF
* password-protected PDF
* scanned PDF
* empty PDF
* unsupported PDF structure
* TTS failure
* Ollama unavailable
* Redis unavailable
* FFmpeg failure
* insufficient disk space
* interrupted processing

Errors should be understandable to a normal user.

Example:

```text
Audio generation failed for Chapter 7.

[Retry Chapter 7]
```

Not:

```text
ECONNREFUSED 127.0.0.1:6379
```

Show technical details only in developer logs.

---

# 26. Storage Safety

Because a 280-page book can generate large intermediate files:

* check available disk space
* clean temporary files after successful processing
* provide "Clean project cache"
* allow users to delete projects
* never silently delete final outputs

---

# 27. Important Scope Restriction

This is V1.

DO NOT implement:

* AI-generated video
* AI-generated images
* cloud AI APIs
* user authentication
* payments
* multi-user SaaS
* cloud storage
* complex collaboration
* mobile app
* Kubernetes
* microservices
* unnecessary enterprise architecture

Keep it **local, fast, maintainable and functional**.

---

# 28. Copyright Notice

The application is a processing tool.

Add a small UI notice reminding users to only process and distribute books they have the legal right to use.

Do not implement DRM circumvention.

---

# 29. Development Strategy

Do NOT attempt to build everything at once.

Build incrementally.

### Phase 1

PDF upload + extraction.

### Phase 2

Text cleaning + chapter detection.

### Phase 3

Local LLM integration.

### Phase 4

Local TTS.

### Phase 5

Timestamp/timeline generation.

### Phase 6

PDF page rendering.

### Phase 7

Highlight synchronization.

### Phase 8

FFmpeg video rendering.

### Phase 9

Frontend preview.

### Phase 10

Caching + resumable processing + performance optimization.

At the end of every phase, make sure the application still runs.

---

# 30. First Implementation Requirement

Start by creating:

1. Architecture
2. Folder structure
3. Database schema
4. API design
5. Environment configuration
6. Docker configuration for PostgreSQL + Redis
7. PDF extraction module
8. Basic Next.js UI
9. CLI pipeline

Then implement the system phase by phase.

Do not generate fake AI responses or fake processing progress.

If a dependency/model is not installed, provide the exact installation command and a clear setup instruction.

---

# 31. README

Create an excellent README containing:

* Project overview
* Features
* Architecture
* Requirements
* macOS setup
* Apple Silicon setup
* Ollama installation
* Model installation
* TTS installation
* FFmpeg installation
* PostgreSQL setup
* Redis setup
* Environment variables
* Development commands
* CLI usage
* Troubleshooting
* Performance tuning for 16GB Mac
* How to add another TTS model
* How to add another LLM
* How to add another video style

---

# 32. Quality Bar

I don't want a toy demo.

Build this as a **real, maintainable V1 project**.

Prioritize:

1. Correct PDF-to-text mapping
2. Audio/video synchronization
3. Accurate highlighting
4. Low memory usage
5. Resumability
6. Caching
7. Good error handling
8. Clean architecture
9. Simple UI
10. Local/offline operation

The final application should be capable of taking a reasonably structured **~280-page English PDF book** and producing a complete audiobook + animated/highlighted PDF YouTube video on an **M4 16GB MacBook**, without requiring paid cloud APIs.

Before writing large amounts of code, first inspect the repository and existing files if any exist. Reuse existing infrastructure where appropriate.

When you make architectural decisions, explain the reason briefly and prioritize practical implementation over unnecessary complexity.
