import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { describeError } from '@app/shared';
import { toUserError } from './errors';

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CONFLICT: 409,
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
};

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
      res.status(status).json({ error: { code: `HTTP_${status}`, message: Array.isArray(message) ? message.join(', ') : message, retryable: false } });
      return;
    }
    const e = toUserError(exception);
    const status = STATUS[e.code] ?? 500;
    if (status >= 500) this.log.error(`${e.code}: ${describeError(exception)}`);
    else this.log.warn(`${e.code}: ${e.message}`);
    res.status(status).json({ error: e.toUser() });
  }
}
