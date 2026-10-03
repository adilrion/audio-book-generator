import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@app/config';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { ProjectsService } from '../src/projects/projects.service';
import type { QueueService } from '../src/queue/queue.service';
import { ShortsService } from '../src/shorts/shorts.service';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-shorts-'));
const cfg = loadConfig({ STORAGE_DIR: tmp, TTS_ENGINE: 'kokoro', TTS_DEFAULT_VOICE: 'af_heart', LLM_ENABLED: false }, { reload: true });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Row = Record<string, unknown>;
const BOOK = '11111111-1111-4111-8111-111111111111';

function setup(opts: { enqueueFails?: boolean } = {}) {
  const rows: Row[] = [];
  let n = 0;
  const matches = (r: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'notIn' in v ? !(v.notIn as unknown[]).includes(r[k]) : r[k] === v));
  const short = {
    create: async ({ data }: { data: Row }) => {
      const r = { id: `00000000-0000-4000-8000-00000000000${++n}`, status: 'PENDING', progress: 0, snapshot: null, cancelRequested: false, durationSec: null, renderedKey: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(r);
      return r;
    },
    findUnique: async ({ where }: { where: Row }) => {
      const r = rows.find((x) => x.id === where.id);
      return r ? { ...r, project: r.projectId ? { name: 'The Postmaster', document: { author: 'Tagore, Rabindranath' } } : null } : null;
    },
    findMany: async () => rows.map((r) => ({ ...r, project: null })),
    // Like Prisma: the DbNull sentinel is stored as NULL.
    update: async ({ where, data }: { where: Row; data: Row }) =>
      Object.assign(rows.find((x) => x.id === where.id)!, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === Prisma.DbNull ? null : v]))),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    delete: async ({ where }: { where: Row }) => rows.splice(rows.findIndex((r) => r.id === where.id), 1)[0],
  };
  const book = [
    { text: 'Copyright 1918.', paragraph: { chapter: { title: 'Copyright' } } },
    { text: 'The postmaster first took up his duties in the village of Ulapur.', paragraph: { chapter: { title: 'The Postmaster' } } },
    { text: 'Though the village was a small one, there was an indigo factory near by.', paragraph: { chapter: { title: 'The Postmaster' } } },
  ];
  const sentence = {
    findMany: async ({ skip = 0 }: { skip?: number } = {}) => book.slice(skip),
    count: async () => book.length,
  };
  const queue = { enqueueShort: vi.fn(async (id: string) => (opts.enqueueFails ? Promise.reject(new Error('redis down')) : `${id}-job`)) };
  const projects = {
    get: async (id: string) => {
      if (id !== BOOK) throw Object.assign(new Error('Project not found.'), { code: 'NOT_FOUND' });
      return { id, name: 'The Postmaster', document: { author: 'Tagore, Rabindranath' } };
    },
    pageImage: async () => {
      const f = path.join(tmp, 'page-1.jpg');
      fs.writeFileSync(f, 'jpeg');
      return f;
    },
  };
  const svc = new ShortsService(cfg, { short, sentence } as unknown as PrismaService, queue as unknown as QueueService, projects as unknown as ProjectsService);
  return { svc, rows, queue };
}

const SCRIPT = 'What if one letter could change a life? This is the story of a lonely postmaster.';

describe('ShortsService', () => {
  it('creates a short with the server voice and the default look', async () => {
    const t = setup();
    const s = await t.svc.create({ title: '  ', script: `  ${SCRIPT}  ` });
    expect(s).toMatchObject({ title: 'Untitled short', script: SCRIPT, status: 'PENDING', queued: false, stale: false, outputs: [] });
    expect(s.settings.tts).toEqual({ engine: 'kokoro', voice: 'af_heart', speed: 1 });
    expect(s.settings.look).toMatchObject({ theme: 'midnight', captions: 'karaoke' });
    expect(t.queue.enqueueShort).not.toHaveBeenCalled();
  });

  it('applies the language rules of projects to the voice', async () => {
    const t = setup();
    const bn = await t.svc.create({ title: 'পোস্টমাস্টার', script: 'একটি গল্প।', settings: { language: 'bn' } });
    expect(bn.settings.tts).toMatchObject({ engine: 'piper', voice: 'bn_BD-google-medium:4811' });
    await expect(t.svc.create({ title: 'x', script: 'y', settings: { language: 'bn', tts: { engine: 'kokoro' } } })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('Bangla') });
    await expect(t.svc.create({ title: 'x', script: 'y', settings: { look: { accent: 'yellow' } } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('keeps an animated background and a motion overlay, and rejects unknown ones', async () => {
    const t = setup();
    const s = await t.svc.create({ title: 'T', script: SCRIPT, settings: { look: { theme: 'aurora', motion: 'embers' } } });
    expect(s.settings.look).toMatchObject({ theme: 'aurora', motion: 'embers', captions: 'karaoke' });
    expect((await t.svc.create({ title: 'T', script: SCRIPT })).settings.look.motion).toBeUndefined(); // older shorts keep their render key
    await expect(t.svc.create({ title: 'x', script: 'y', settings: { look: { motion: 'confetti' } } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(t.svc.create({ title: 'x', script: 'y', settings: { look: { theme: 'disco' } } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('creates a batch in order with one voice and look, each with its own background, and queues it', async () => {
    const t = setup();
    const r = await t.svc.createBatch({
      items: [
        { title: 'Part 1', script: SCRIPT, hashtags: ['Shorts', 'Tagore'] },
        { title: ' ', script: 'Second script.', look: { theme: 'aurora', motion: 'snow' } },
      ],
      settings: { look: { theme: 'cover', accent: '#22D3EE' } },
      projectId: BOOK,
      render: true,
    });
    expect(r.error).toBeUndefined();
    expect(r.shorts.map((s) => [s.title, s.theme, s.bookTitle, s.queued])).toEqual([
      ['Part 1', 'cover', undefined, true],
      ['Untitled short', 'aurora', undefined, true],
    ]);
    expect(t.queue.enqueueShort.mock.calls.map((c) => c[0])).toEqual(r.shorts.map((s) => s.id)); // rendered in the batch's order
    const second = await t.svc.detail(r.shorts[1].id);
    expect(second.settings.look).toMatchObject({ theme: 'aurora', motion: 'snow', accent: '#22D3EE' });
    expect(second.tags.length).toBeGreaterThan(0); // suggested from the book
    expect(fs.existsSync(path.join(cfg.storage.shorts, r.shorts[0].id, 'cover.jpg'))).toBe(true);
  });

  it('checks the whole batch before saving any of it', async () => {
    const t = setup();
    const long = Array(700).fill('word').join(' ');
    await expect(t.svc.createBatch({ items: [{ title: 'ok', script: SCRIPT }, { title: 'long', script: long }], render: true })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('short 2 takes about'),
    });
    await expect(t.svc.createBatch({ items: Array.from({ length: 11 }, () => ({ title: 'x', script: SCRIPT })) })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('more than 10') });
    await expect(t.svc.createBatch({ items: [] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(t.rows).toHaveLength(0);
    // as drafts, a long script is allowed (it can be shortened later)
    expect((await t.svc.createBatch({ items: [{ title: 'long', script: long }] })).shorts[0].queued).toBe(false);
  });

  it('keeps the batch as drafts when the queue is down', async () => {
    const t = setup({ enqueueFails: true });
    const r = await t.svc.createBatch({ items: [{ title: 'a', script: SCRIPT }, { title: 'b', script: SCRIPT }], render: true });
    expect(r.shorts).toHaveLength(2);
    expect(r.error).toMatchObject({ retryable: true });
    expect(t.queue.enqueueShort).toHaveBeenCalledTimes(1); // stops at the first failure
  });

  it('reads a later part of the book for a batch', async () => {
    const t = setup();
    expect(await t.svc.bookExcerpt(BOOK, 'en')).toMatch(/^The postmaster first took up/);
    expect(await t.svc.bookExcerpt(BOOK, 'en', { index: 2, of: 3 })).toBe('Though the village was a small one, there was an indigo factory near by.');
  });

  it('copies the book cover when the cover background is chosen', async () => {
    const t = setup();
    const s = await t.svc.create({ title: 'T', script: SCRIPT, projectId: BOOK, settings: { look: { theme: 'cover' } } });
    expect(s.bookTitle).toBe('The Postmaster');
    expect(fs.existsSync(path.join(cfg.storage.shorts, s.id, 'cover.jpg'))).toBe(true);
    await expect(t.svc.create({ title: 'T', script: SCRIPT, projectId: '22222222-2222-4222-8222-222222222222' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('queues a render once, and not for an empty or far too long script', async () => {
    const t = setup();
    const s = await t.svc.create({ title: 'T', script: SCRIPT, render: true });
    expect(t.queue.enqueueShort).toHaveBeenCalledWith(s.id);
    expect(s).toMatchObject({ status: 'PENDING', queued: true, message: 'Waiting for the worker…' });
    await expect(t.svc.render(s.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(t.svc.update(s.id, { script: 'changed' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const empty = await t.svc.create({ title: 'T', script: '   ' });
    await expect(t.svc.render(empty.id)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('script') });
    const long = await t.svc.create({ title: 'T', script: Array(700).fill('word').join(' ') });
    await expect(t.svc.render(long.id)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('3 minutes') });
  });

  it('marks the short failed when it cannot be queued', async () => {
    const t = setup({ enqueueFails: true });
    const s = await t.svc.create({ title: 'T', script: SCRIPT });
    await expect(t.svc.render(s.id)).rejects.toThrow();
    expect((await t.svc.detail(s.id)).status).toBe('FAILED');
  });

  it('cancels a queued short at once and asks a running one to stop', async () => {
    const t = setup();
    const a = await t.svc.create({ title: 'T', script: SCRIPT, render: true });
    await t.svc.cancel(a.id);
    expect((await t.svc.detail(a.id)).status).toBe('CANCELLED');
    const b = await t.svc.create({ title: 'T', script: SCRIPT });
    Object.assign(t.rows.find((r) => r.id === b.id)!, { status: 'RENDERING' });
    await t.svc.cancel(b.id);
    expect(t.rows.find((r) => r.id === b.id)).toMatchObject({ status: 'RENDERING', cancelRequested: true });
    await expect(t.svc.remove(b.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('serves only its own output files', async () => {
    const t = setup();
    expect(t.svc.outputPath('abc-1', 'short.mp4')).toBe(path.join(cfg.storage.shorts, 'abc-1', 'short.mp4'));
    expect(() => t.svc.outputPath('abc-1', 'cover.jpg')).toThrow();
    expect(() => t.svc.outputPath('../x', 'short.mp4')).toThrow();
  });

  it('writes scripts only with the local AI turned on', async () => {
    const t = setup();
    await expect(t.svc.generateScript({ source: { kind: 'topic', topic: 'Black holes' }, language: 'en', seconds: 60, style: 'hook' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(t.svc.generateScript({ source: { kind: 'topic', topic: 'x' }, language: 'en', seconds: 60, style: 'hook' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('suggests YouTube tags from the book when none are given, and cleans given ones', async () => {
    const t = setup();
    const s = await t.svc.create({ title: 'A lonely postmaster', script: SCRIPT, projectId: BOOK, hashtags: ['Shorts', 'TagoreStories'] });
    expect(s.tags.slice(0, 3)).toEqual(['The Postmaster', 'The Postmaster Rabindranath Tagore', 'Rabindranath Tagore']);
    expect(s.tags).toContain('Tagore Stories');
    expect(s.bookAuthor).toBe('Tagore, Rabindranath');
    const own = await t.svc.create({ title: 'T', script: SCRIPT, tags: ['one, two', '#three', 'one two'] });
    expect(own.tags).toEqual(['one two', 'three']);
  });

  it('lets the YouTube text and thumbnail change while the video renders, nothing else', async () => {
    const t = setup();
    const s = await t.svc.create({ title: 'T', script: SCRIPT, render: true });
    const d = await t.svc.update(s.id, { description: 'New text', tags: ['tag'], thumbnail: { layout: 'headline', headline: 'Hi *there*', kicker: '', accent: '#FACC15' } });
    expect(d).toMatchObject({ description: 'New text', tags: ['tag'], thumbnail: { headline: 'Hi *there*' }, queued: true });
    await expect(t.svc.update(s.id, { title: 'Other' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(t.svc.update(s.id, { settings: { look: { thumbnailIntro: true } } })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('stores only JPEG thumbnails and removes them again', async () => {
    const t = setup();
    const s = await t.svc.create({ title: 'T', script: SCRIPT });
    await expect(t.svc.saveThumbnail(s.id, Buffer.from('<svg/>'))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    const saved = await t.svc.saveThumbnail(s.id, jpeg);
    expect(saved.thumbnailVersion).toBeTruthy();
    expect(saved.outputs.map((o) => o.name)).toContain('thumbnail.jpg');
    expect(fs.readFileSync(t.svc.outputPath(s.id, 'thumbnail.jpg'))).toEqual(jpeg);
    const removed = await t.svc.deleteThumbnail(s.id);
    expect(removed.thumbnailVersion).toBeUndefined();
    expect(removed.thumbnail).toBeUndefined();
  });

  it('writes YouTube details only with the local AI turned on', async () => {
    const t = setup();
    await expect(t.svc.generateMetadata({ title: 'T', script: SCRIPT, language: 'en' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(t.svc.generateMetadata({ title: 'T', script: '  ', language: 'en' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('takes the book excerpt from its first real chapter', async () => {
    const t = setup();
    const ex = await t.svc.bookExcerpt(BOOK, 'en');
    expect(ex.startsWith('The postmaster first took up his duties')).toBe(true);
    expect(ex).not.toContain('Copyright');
  });
});
