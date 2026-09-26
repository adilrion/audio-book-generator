import { BadRequestException, HttpException, HttpStatus, Logger, NotFoundException, PayloadTooLargeException, type ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerCallError } from '@app/pipeline';
import { AppError } from '@app/shared';
import { loadConfig } from '@app/config';
import { UserErrorFilter } from '../src/common/error.filter';
import { badRequest, conflict, notFound } from '../src/common/errors';

interface Sent {
  status?: number;
  body?: { error: Record<string, unknown> };
}

function fakeHost() {
  const sent: Sent = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: Sent['body']) {
      sent.body = body;
      return res;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({}) }) } as unknown as ArgumentsHost;
  return { host, sent };
}

function send(exception: unknown): Sent {
  const { host, sent } = fakeHost();
  new UserErrorFilter().catch(exception, host);
  return sent;
}

describe('UserErrorFilter', () => {
  let logError: ReturnType<typeof vi.spyOn>;
  let logWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logWarn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['NOT_FOUND', 404],
    ['BAD_REQUEST', 400],
    ['CONFLICT', 409],
    ['NOT_READY', 409],
    ['PDF_MISSING', 410],
    ['PDF_PASSWORD', 422],
    ['PDF_CORRUPT', 422],
    ['PDF_UNSUPPORTED', 422],
    ['PDF_EMPTY', 422],
    ['PDF_NO_TEXT', 422],
    ['PDF_SCANNED', 422],
    ['DB_UNAVAILABLE', 503],
    ['REDIS_UNAVAILABLE', 503],
    ['PYTHON_MISSING', 503],
    ['DISK_SPACE', 507],
    ['DISK_FULL', 507],
    ['TTS_FAILED', 500],
    ['INTERNAL', 500],
    ['SOMETHING_NEW', 500],
  ])('maps code %s to HTTP %i', (code, status) => {
    expect(send(new AppError(code, 'x')).status).toBe(status);
  });

  it('maps the helper errors to 4xx', () => {
    expect(send(notFound('Project')).status).toBe(404);
    expect(send(badRequest('Nope')).status).toBe(400);
    expect(send(conflict('Busy')).status).toBe(409);
  });

  it('sends { error: { code, message, hint, retryable } } for AppErrors', () => {
    const sent = send(badRequest('This file is not a PDF.', 'Choose a .pdf file.'));
    expect(sent).toEqual({ status: 400, body: { error: { code: 'BAD_REQUEST', message: 'This file is not a PDF.', hint: 'Choose a .pdf file.', retryable: false } } });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it('maps raw worker errors (e.g. from pdf.inspect) through toUserError', () => {
    const sent = send(new WorkerCallError('PDF_PASSWORD', 'The PDF is password-protected.'));
    expect(sent.status).toBe(422);
    expect(sent.body?.error).toMatchObject({ code: 'PDF_PASSWORD', message: 'This PDF is password-protected. Remove the password and upload it again.', retryable: false });
  });

  it('maps infrastructure errors to 503 with a fix hint', () => {
    const db = send(new Prisma.PrismaClientInitializationError("Can't reach database server at `localhost:5433`", '6.19.0', 'P1001'));
    expect(db.status).toBe(503);
    expect(db.body?.error).toMatchObject({ code: 'DB_UNAVAILABLE', hint: 'Start it with: docker compose up -d postgres' });
    expect(JSON.stringify(db.body)).not.toContain('localhost:5433');

    const redis = send(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED', port: 6379 }));
    expect(redis.status).toBe(503);
    expect(redis.body?.error.code).toBe('REDIS_UNAVAILABLE');
    expect(JSON.stringify(redis.body)).not.toContain('ECONNREFUSED');
  });

  it('never leaks stack traces or raw messages of unknown errors; they go to the log instead', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'filePath')");
    const sent = send(err);
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong while processing.', retryable: true } });
    const json = JSON.stringify(sent.body);
    expect(json).not.toContain('filePath');
    expect(json).not.toContain('stack');
    expect(json).not.toContain(err.stack!.split('\n')[1].trim());
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0][0])).toContain("Cannot read properties of undefined (reading 'filePath')");
  });

  it('does not leak technical `cause` / `details` of AppErrors', () => {
    const sent = send(new AppError('TTS_FAILED', 'Speech generation failed.', { cause: new Error('onnxruntime exploded'), details: { stderr: '/Users/x/.venv/lib' } }));
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toMatch(/onnxruntime|\.venv|stderr|cause|details/);
  });

  it('keeps stepKey / chapterIndex on the payload when present', () => {
    const err = new AppError('TTS_FAILED', 'Speech generation failed.', { stepKey: 'TTS_CHAPTER_2', chapterIndex: 1 });
    expect(send(err).body?.error).toEqual({ code: 'TTS_FAILED', message: 'Speech generation failed.', stepKey: 'TTS_CHAPTER_2', chapterIndex: 1, retryable: true });
  });

  describe('HttpException passthrough', () => {
    it('keeps the status and uses code HTTP_<status>', () => {
      expect(send(new NotFoundException('Cannot GET /nope'))).toEqual({ status: 404, body: { error: { code: 'HTTP_404', message: 'Cannot GET /nope', retryable: false } } });
    });

    it('joins array messages (validation pipes)', () => {
      const sent = send(new BadRequestException(['name must be a string', 'fps must be an integer']));
      expect(sent).toEqual({ status: 400, body: { error: { code: 'HTTP_400', message: 'name must be a string, fps must be an integer', retryable: false } } });
    });

    it('handles a string response body', () => {
      expect(send(new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS))).toEqual({ status: 429, body: { error: { code: 'HTTP_429', message: 'Too many requests', retryable: false } } });
    });

    it('handles an object body without message (falls back to the exception message)', () => {
      const sent = send(new HttpException({ reason: 'x' }, HttpStatus.FORBIDDEN));
      expect(sent.status).toBe(403);
      expect(sent.body?.error.code).toBe('HTTP_403');
      expect(typeof sent.body?.error.message).toBe('string');
    });

    it('maps the multer upload-size error to 413 and names the upload limit', () => {
      const mb = loadConfig().MAX_UPLOAD_MB;
      expect(send(new PayloadTooLargeException('File too large'))).toEqual({
        status: 413,
        body: { error: { code: 'FILE_TOO_LARGE', message: `This file is larger than the ${mb} MB upload limit.`, hint: 'Split the PDF or raise MAX_UPLOAD_MB in .env.', retryable: false } },
      });
    });

    it('does not log HttpExceptions as server errors', () => {
      send(new NotFoundException());
      expect(logError).not.toHaveBeenCalled();
    });
  });

  describe('errors from Express middleware (body-parser / http-errors)', () => {
    // What body-parser throws for a JSON body over its 100 kB limit (raw-body → http-errors).
    const tooLarge = () => Object.assign(new Error('request entity too large'), { status: 413, statusCode: 413, expose: true, type: 'entity.too.large', limit: 102400, length: 200017 });

    it('keeps their 4xx status instead of answering 500 "Something went wrong"', () => {
      expect(send(tooLarge())).toEqual({ status: 413, body: { error: { code: 'HTTP_413', message: 'The request is too large.', retryable: false } } });
      expect(logError).not.toHaveBeenCalled();
    });

    it('passes other exposed 4xx messages through', () => {
      const aborted = Object.assign(new Error('request aborted'), { status: 400, statusCode: 400, expose: true, type: 'request.aborted' });
      expect(send(aborted)).toEqual({ status: 400, body: { error: { code: 'HTTP_400', message: 'request aborted', retryable: false } } });
    });

    it('does not trust a status on errors that are not meant to be exposed', () => {
      const internal = Object.assign(new Error('connect ECONNRESET 10.0.0.5:5432 password=hunter2'), { status: 400, expose: false });
      const sent = send(internal);
      expect(sent.status).toBe(500);
      expect(JSON.stringify(sent.body)).not.toMatch(/hunter2|ECONNRESET/);
    });
  });
});
