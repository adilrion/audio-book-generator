import crypto from 'node:crypto';
import fs from 'node:fs';

/** Streamed SHA-256 of a file (never loads it fully into memory). */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Deterministic JSON (sorted keys) for cache keys. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function hashKey(...parts: unknown[]): string {
  return crypto.createHash('sha256').update(stableStringify(parts)).digest('hex').slice(0, 20);
}
