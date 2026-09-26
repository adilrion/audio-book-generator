import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sweepIncoming } from '../src/projects/incoming';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-incoming-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('sweepIncoming', () => {
  it('removes partial uploads left behind by a crashed API and keeps uploads still being written', async () => {
    const old = path.join(dir, '1790441921716-xxbsqbgvzwc.pdf');
    const fresh = path.join(dir, `${Date.now()}-abc.pdf`);
    fs.writeFileSync(old, 'partial');
    fs.writeFileSync(fresh, 'streaming right now');
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(old, hourAgo, hourAgo);
    fs.mkdirSync(path.join(dir, 'keep-dir'));

    const removed = await sweepIncoming(dir, 15 * 60_000);
    expect(removed).toEqual([old]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'keep-dir'))).toBe(true);
  });

  it('does nothing when the folder does not exist', async () => {
    await expect(sweepIncoming(path.join(dir, 'missing'))).resolves.toEqual([]);
  });
});
