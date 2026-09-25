import type { UserFacingError } from '@app/types';

export interface AppErrorOptions {
  hint?: string;
  retryable?: boolean;
  stepKey?: string;
  chapterIndex?: number;
  details?: unknown;
  cause?: unknown;
}

/**
 * An error with a message a normal user can understand.
 * Technical details stay in `details`/`cause` and only go to developer logs.
 */
export class AppError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly retryable: boolean;
  stepKey?: string;
  chapterIndex?: number;
  readonly details?: unknown;

  constructor(code: string, message: string, opts: AppErrorOptions = {}) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.hint = opts.hint;
    this.retryable = opts.retryable ?? true;
    this.stepKey = opts.stepKey;
    this.chapterIndex = opts.chapterIndex;
    this.details = opts.details;
  }

  toUser(): UserFacingError {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      stepKey: this.stepKey,
      chapterIndex: this.chapterIndex,
      retryable: this.retryable,
    };
  }
}

export class CancelledError extends AppError {
  constructor() {
    super('CANCELLED', 'Processing was cancelled.', { retryable: true });
  }
}

/** Codes coming from the Python worker → friendly messages. */
const WORKER_MESSAGES: Record<string, { message: string; hint?: string; retryable?: boolean }> = {
  PDF_CORRUPT: { message: 'This PDF could not be opened. It may be damaged or not a real PDF.', retryable: false },
  PDF_UNSUPPORTED: { message: 'This file is not a supported PDF document.', retryable: false },
  PDF_PASSWORD: { message: 'This PDF is password-protected. Remove the password and upload it again.', retryable: false },
  PDF_EMPTY: { message: 'This PDF is empty — it has no pages.', retryable: false },
  PDF_NO_TEXT: { message: 'No readable text was found in this PDF.', retryable: false },
  PDF_SCANNED: {
    message: 'This PDF is a scan (images only). Text recognition (OCR) is needed but not installed.',
    hint: 'Install Tesseract with: brew install tesseract — then retry.',
    retryable: true,
  },
  TTS_ENGINE_UNAVAILABLE: { message: 'The selected voice engine is not installed.', retryable: true },
  TTS_VOICE_NOT_FOUND: { message: 'The selected voice is not installed.', retryable: false },
  TTS_FAILED: { message: 'Speech generation failed.', retryable: true },
  FFMPEG_MISSING: { message: 'FFmpeg is not installed.', hint: 'Install it with: brew install ffmpeg', retryable: true },
  FFMPEG_FAILED: { message: 'Video encoding failed.', retryable: true },
  FFMPEG_ENCODER_MISSING: { message: 'The configured video encoder is not available in FFmpeg.', hint: 'Set VIDEO_ENCODER=auto', retryable: true },
  OUT_OF_MEMORY: {
    message: 'The computer ran out of memory.',
    hint: 'Close other apps or lower MAX_CONCURRENT_TTS / MAX_CONCURRENT_PDF_RENDER in .env.',
    retryable: true,
  },
};

/** Convert anything thrown into an AppError with a user-safe message. */
export function toAppError(err: unknown, fallback = 'Something went wrong while processing.'): AppError {
  if (err instanceof AppError) return err;
  const e = err as { code?: string; message?: string; address?: string; port?: number; errno?: number };
  const code = e?.code;
  if (code && WORKER_MESSAGES[code]) {
    const m = WORKER_MESSAGES[code];
    const hint = m.hint ?? (e as { details?: { hint?: string } }).details?.hint;
    const extra = code === 'TTS_ENGINE_UNAVAILABLE' && e.message ? ` ${e.message}` : '';
    return new AppError(code, m.message + extra, { hint, retryable: m.retryable, cause: err, details: e });
  }
  if (code === 'ENOSPC') {
    return new AppError('DISK_FULL', 'Your disk is full.', { hint: 'Free some space or clean project caches, then resume.', cause: err });
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    const port = e.port;
    if (port === 6379)
      return new AppError('REDIS_UNAVAILABLE', 'The background job service (Redis) is not running.', {
        hint: 'Start it with: docker compose up -d redis',
        cause: err,
      });
    if (port === 5432 || port === 5433)
      return new AppError('DB_UNAVAILABLE', 'The database (PostgreSQL) is not running.', {
        hint: 'Start it with: docker compose up -d postgres',
        cause: err,
      });
    if (port === 11434)
      return new AppError('OLLAMA_UNAVAILABLE', 'The local AI model service (Ollama) is not running.', {
        hint: 'Start it with: ollama serve',
        cause: err,
      });
  }
  if (code === 'ENOENT' && /spawn/.test(e.message ?? '')) {
    return new AppError('BINARY_MISSING', 'A required program is not installed.', { hint: e.message, cause: err });
  }
  return new AppError('INTERNAL', fallback, { cause: err, details: e?.message });
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return `${err.name}: ${err.message}${cause ? `\n  caused by: ${describeError(cause)}` : ''}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
