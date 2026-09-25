import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { WorkerCallError } from '@app/pipeline';
import { AppError } from '@app/shared';
import { badRequest, conflict, notFound, toUserError } from '../src/common/errors';

const CLIENT_VERSION = '6.19.0';
const sysError = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);

/** Everything a user sees must be free of stack traces, file paths and library jargon. */
function expectFriendly(e: AppError) {
  const shown = JSON.stringify(e.toUser());
  expect(shown).not.toMatch(/\bat \S+ \(|\.ts:\d+|\.js:\d+|node_modules|Invalid `|prisma\.|ECONNREFUSED|TypeError|undefined \(reading/);
}

describe('toUserError', () => {
  it('maps a Prisma initialization error (DB down at startup) to DB_UNAVAILABLE', () => {
    const err = new Prisma.PrismaClientInitializationError(
      "Can't reach database server at `localhost:5433`\n\nPlease make sure your database server is running at `localhost:5433`.",
      CLIENT_VERSION,
      'P1001',
    );
    const e = toUserError(err);
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('DB_UNAVAILABLE');
    expect(e.message).toBe('The database (PostgreSQL) is not running.');
    expect(e.hint).toContain('docker compose up -d postgres');
    expect(e.cause).toBe(err);
    expectFriendly(e);
  });

  it('maps an initialization error without an errorCode (seen when credentials/host are wrong) by name', () => {
    const e = toUserError(new Prisma.PrismaClientInitializationError('Authentication failed against database server', CLIENT_VERSION));
    expect(e.code).toBe('DB_UNAVAILABLE');
  });

  it.each(['P1001', 'P1000'])('maps Prisma %s on a request error to DB_UNAVAILABLE', (code) => {
    const e = toUserError(new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code, clientVersion: CLIENT_VERSION }));
    expect(e.code).toBe('DB_UNAVAILABLE');
  });

  it('maps Prisma P2025 (record not found) to NOT_FOUND, not retryable', () => {
    const err = new Prisma.PrismaClientKnownRequestError('An operation failed because it depends on one or more records that were required but not found. No record was found for an update.', {
      code: 'P2025',
      clientVersion: CLIENT_VERSION,
    });
    const e = toUserError(err);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toBe('That item no longer exists.');
    expect(e.retryable).toBe(false);
    expectFriendly(e);
  });

  it.each(['Connection is closed.', "Stream isn't writeable and enableOfflineQueue options is false"])('maps the ioredis message "%s" to REDIS_UNAVAILABLE', (msg) => {
    const e = toUserError(new Error(msg));
    expect(e.code).toBe('REDIS_UNAVAILABLE');
    expect(e.message).toBe('The background job service (Redis) is not running.');
    expect(e.hint).toContain('docker compose up -d redis');
    expectFriendly(e);
  });

  it('maps ECONNREFUSED on port 6379 to REDIS_UNAVAILABLE via toAppError (code + port, no port in message)', () => {
    const e = toUserError(sysError('connect ECONNREFUSED', { code: 'ECONNREFUSED', errno: -61, address: '127.0.0.1', port: 6379 }));
    expect(e.code).toBe('REDIS_UNAVAILABLE');
    expect(e.hint).toContain('redis');
    expectFriendly(e);
  });

  it('maps ECONNREFUSED 127.0.0.1:6379 by message too', () => {
    expect(toUserError(new Error('connect ECONNREFUSED 127.0.0.1:6379')).code).toBe('REDIS_UNAVAILABLE');
  });

  it('maps ECONNREFUSED on the Postgres / Ollama ports via toAppError', () => {
    expect(toUserError(sysError('connect ECONNREFUSED', { code: 'ECONNREFUSED', port: 5433 })).code).toBe('DB_UNAVAILABLE');
    expect(toUserError(sysError('connect ECONNREFUSED', { code: 'ECONNREFUSED', port: 11434 })).code).toBe('OLLAMA_UNAVAILABLE');
  });

  it('maps ENOSPC to DISK_FULL', () => {
    const e = toUserError(sysError("ENOSPC: no space left on device, write '/Users/x/storage/uploads/a.pdf'", { code: 'ENOSPC' }));
    expect(e.code).toBe('DISK_FULL');
    expect(e.message).toBe('Your disk is full.');
    expectFriendly(e);
  });

  it.each([
    ['PDF_PASSWORD', 'This PDF is password-protected. Remove the password and upload it again.', false],
    ['PDF_CORRUPT', 'This PDF could not be opened. It may be damaged or not a real PDF.', false],
    ['PDF_EMPTY', 'This PDF is empty — it has no pages.', false],
    ['PDF_UNSUPPORTED', 'This file is not a supported PDF document.', false],
    ['TTS_FAILED', 'Speech generation failed.', true],
    ['TTS_VOICE_NOT_FOUND', 'The selected voice is not installed.', false],
    ['FFMPEG_FAILED', 'Video encoding failed.', true],
    ['OUT_OF_MEMORY', 'The computer ran out of memory.', true],
  ])('keeps the friendly message for worker code %s', (code, message, retryable) => {
    const raw = new WorkerCallError(code, `Traceback (most recent call last): fitz.FileDataError ${code.toLowerCase()} at /x/y.py:12`, { reason: 'internal detail' });
    const e = toUserError(raw);
    expect(e.code).toBe(code);
    expect(e.message).toBe(message);
    expect(e.retryable).toBe(retryable);
    expect(e.message).not.toContain('Traceback');
    expect(JSON.stringify(e.toUser())).not.toContain('internal detail');
  });

  it('passes an existing AppError through unchanged', () => {
    const err = badRequest('This file is not a PDF.', 'Choose a .pdf file.');
    expect(toUserError(err)).toBe(err);
  });

  it.each([
    ['TypeError', new TypeError("Cannot read properties of undefined (reading 'document')")],
    ['plain Error', new Error('Invalid `prisma.project.findUnique()` invocation in /Users/x/apps/api/src/projects/projects.service.ts:42:7')],
    ['string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['object', { weird: true }],
    ['unknown worker code', new WorkerCallError('UNKNOWN_METHOD', 'Unknown method: pdf.explode')],
  ])('maps an unknown %s to INTERNAL with a generic message', (_label, err) => {
    const e = toUserError(err);
    expect(e.code).toBe('INTERNAL');
    expect(e.message).toBe('Something went wrong while processing.');
    expect(e.hint).toBeUndefined();
    expectFriendly(e);
  });

  it('keeps technical details off the user payload', () => {
    const e = toUserError(new Error('secret stack detail'));
    expect(e.toUser()).toEqual({ code: 'INTERNAL', message: 'Something went wrong while processing.', hint: undefined, stepKey: undefined, chapterIndex: undefined, retryable: true });
    expect(e.details).toBe('secret stack detail'); // still available for logs
  });
});

describe('error helpers', () => {
  it('build non-retryable user errors', () => {
    expect(notFound('Project').toUser()).toMatchObject({ code: 'NOT_FOUND', message: 'Project not found.', retryable: false });
    expect(badRequest('Bad', 'Try again').toUser()).toMatchObject({ code: 'BAD_REQUEST', message: 'Bad', hint: 'Try again', retryable: false });
    expect(conflict('Busy').toUser()).toMatchObject({ code: 'CONFLICT', message: 'Busy', retryable: false });
  });
});
