import fsp from 'node:fs/promises';
import { AppError } from './errors';
import { formatBytes } from './format';

export async function freeDiskBytes(dir: string): Promise<number> {
  const s = await fsp.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** Throw a friendly error if `needBytes` (+reserve) is not available. */
export async function assertDiskSpace(dir: string, needBytes: number, reserveBytes: number, what: string): Promise<void> {
  const free = await freeDiskBytes(dir);
  if (free < needBytes + reserveBytes) {
    throw new AppError(
      'DISK_SPACE',
      `Not enough free disk space for ${what}. Needs about ${formatBytes(needBytes)}, ${formatBytes(Math.max(0, free - reserveBytes))} available.`,
      { hint: 'Free up disk space or use "Clean project cache" on old projects, then resume.', retryable: true },
    );
  }
}
