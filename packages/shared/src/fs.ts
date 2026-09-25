import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<string> {
  await fsp.mkdir(p, { recursive: true });
  return p;
}

/** Write to a temp file then rename, so readers never see partial files. */
export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

export async function atomicWriteJson(file: string, value: unknown, pretty = false): Promise<void> {
  await atomicWrite(file, JSON.stringify(value, null, pretty ? 2 : undefined));
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
}

export async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  try {
    return await readJson<T>(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export async function fileSize(p: string): Promise<number> {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

/** Recursive directory size in bytes. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fsp.stat(p)).size;
  }
  return total;
}

export async function rmrf(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

/** Async line reader for JSONL files — streams, constant memory. */
export async function* readJsonLines<T>(file: string): AsyncGenerator<T> {
  const rl = (await import('node:readline')).createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line) as T;
  }
}
