import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { loadConfig } from '@app/config';
import { describeError } from '@app/shared';
import { toUserError } from './errors';

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CONFLICT: 409,
  NOT_READY: 409, // e.g. timeline requested before audio generation finished
  PDF_MISSING: 410, // uploaded file was removed from storage — user must upload again
  PDF_CORRUPT: 422,
  PDF_UNSUPPORTED: 422,
  PDF_PASSWORD: 422,
  PDF_EMPTY: 422,
  PDF_NO_TEXT: 422,
  PDF_SCANNED: 422,
  DB_UNAVAILABLE: 503,
  REDIS_UNAVAILABLE: 503,
  PYTHON_MISSING: 503,
  DISK_SPACE: 507,
  DISK_FULL: 507, // ENOSPC mapped by toAppError()
};

/** Errors from Express middleware (body-parser via http-errors) carry a safe 4xx status + message. */
function exposedClientError(e: unknown): { status: number; message: string } | undefined {
  const h = e as { status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown };
  const status = Number(h?.status ?? h?.statusCode);
  if (!(e instanceof Error) || h.expose !== true || !(status >= 400 && status < 500)) return undefined;
  return { status, message: status === 413 ? 'The request is too large.' : String(h.message) };
}

// Nest turns multer's LIMIT_FILE_SIZE into PayloadTooLargeException('File too large').
const MULTER_FILE_TOO_LARGE = 'File too large';

/** Users get { error: { code, message, hint } }; technical details only go to the log. */
@Catch()
export class UserErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : ((body as { message?: string | string[] }).message ?? exception.message);
      if (status === 413 && message === MULTER_FILE_TOO_LARGE) {
        const mb = loadConfig().MAX_UPLOAD_MB;
        const hint = 'Split the PDF or raise MAX_UPLOAD_MB in .env.';
        res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: `This file is larger than the ${mb} MB upload limit.`, hint, retryable: false } });
        return;
      }
      res.status(status).json({ error: { code: `HTTP_${status}`, message: Array.isArray(message) ? message.join(', ') : message, retryable: false } });
      return;
    }
    const client = exposedClientError(exception);
    if (client) {
      this.log.warn(`HTTP_${client.status}: ${describeError(exception)}`);
      res.status(client.status).json({ error: { code: `HTTP_${client.status}`, message: client.message, retryable: false } });
      return;
    }
    const e = toUserError(exception);
    const status = STATUS[e.code] ?? 500;
    if (status >= 500) this.log.error(`${e.code}: ${describeError(exception)}`);
    else this.log.warn(`${e.code}: ${e.message}`);
    res.status(status).json({ error: e.toUser() });
  }
}
