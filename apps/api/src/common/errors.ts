import { AppError, toAppError } from '@app/shared';

export const redisUnavailable = (cause?: unknown) =>
  new AppError('REDIS_UNAVAILABLE', 'The background job service (Redis) is not running.', { hint: 'Start it with: docker compose up -d redis', cause });

/** Prisma / Redis / worker errors → AppError with a message a normal user understands. */
export function toUserError(err: unknown): AppError {
  const e = err as { code?: string; name?: string; message?: string; errorCode?: string };
  const prismaCode = e?.errorCode ?? e?.code;
  if (e?.name === 'PrismaClientInitializationError' || prismaCode === 'P1001' || prismaCode === 'P1000')
    return new AppError('DB_UNAVAILABLE', 'The database (PostgreSQL) is not running.', { hint: 'Start it with: docker compose up -d postgres', cause: err });
  if (prismaCode === 'P2025') return new AppError('NOT_FOUND', 'That item no longer exists.', { retryable: false, cause: err });
  if (/Connection is closed|ECONNREFUSED.*6379|Stream isn't writeable/.test(e?.message ?? '')) return redisUnavailable(err);
  return toAppError(err);
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found.`, { retryable: false });
export const badRequest = (msg: string, hint?: string) => new AppError('BAD_REQUEST', msg, { retryable: false, hint });
export const conflict = (msg: string) => new AppError('CONFLICT', msg, { retryable: false });
