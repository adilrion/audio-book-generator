import fsp from 'node:fs/promises';
import path from 'node:path';

/** Temp folder for uploads and library downloads until they are moved into storage/uploads by hash. */
export const incomingDir = (uploads: string) => path.join(uploads, '.incoming');

/** A fresh, unique temp file name in that folder. */
export const incomingFileName = () => `${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;

/**
 * Multer removes a partial upload when the client aborts or a limit is hit, but a crashed or
 * killed API leaves it in storage/uploads/.incoming forever (up to MAX_UPLOAD_MB each). An upload
 * in progress keeps touching its file, so anything not modified for `maxAgeMs` is dead.
 */
export async function sweepIncoming(dir: string, maxAgeMs = 15 * 60_000): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  const cutoff = Date.now() - maxAgeMs;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const file = path.join(dir, e.name);
    const st = await fsp.stat(file).catch(() => null);
    if (st && st.mtimeMs < cutoff) {
      await fsp.rm(file, { force: true }).catch(() => undefined);
      removed.push(file);
    }
  }
  return removed;
}
