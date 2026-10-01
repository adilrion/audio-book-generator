import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { templateDraft } from '@app/pipeline';
import { DEFAULT_SETTINGS, type OutputFile, type Timeline } from '@app/types';
import type { PrismaService } from '../src/prisma/prisma.service';
import { downloadName } from '../src/projects/projects.controller';
import type { ProjectsService } from '../src/projects/projects.service';
import { publishDraftSchema } from '../src/publish/publish.schema';
import { PublishService, excerptOf } from '../src/publish/publish.service';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-api-publish-'));
const cfg = loadConfig({ STORAGE_DIR: tmp, DISK_RESERVE_GB: 0, LLM_ENABLED: false }, { reload: true });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const out = path.join(cfg.storage.output, ID);

const timeline: Timeline = {
  version: '1',
  duration: 2,
  fps: 10,
  pageSizes: {},
  chapters: [{ index: 0, title: 'One', start: 0, end: 2, pageStart: 1, pageEnd: 1 }],
  segments: [
    { i: 0, sentenceId: 'c1-p1-s1', paragraphId: 'c1-p1', chapterIndex: 0, page: 1, start: 0, end: 1, text: 'One morning Gregor woke.', rects: [], pageChange: true },
    { i: 1, sentenceId: 'c1-p1-s2', paragraphId: 'c1-p1', chapterIndex: 0, page: 1, start: 1, end: 2, text: 'He was a bug.', rects: [], pageChange: false },
  ],
};

function setup(status = 'COMPLETED', queued = 0) {
  const outputs = async (): Promise<OutputFile[]> =>
    ['audiobook.mp4', 'audiobook.m4a']
      .filter((n) => fs.existsSync(path.join(out, n)))
      .map((name) => ({ name, kind: name.endsWith('mp4') ? 'video' : 'audio', size: fs.statSync(path.join(out, name)).size, url: `/projects/${ID}/output/${name}` }));
  const projects = {
    get: async () => ({ id: ID, name: 'The Metamorphosis', status, settings: DEFAULT_SETTINGS, durationSec: 2, document: { author: 'Franz Kafka', pageCount: 3, estimatedWords: 300 } }),
    outputs,
    pageImage: async () => {
      throw new Error('no renderer in tests');
    },
  };
  const prisma = { renderJob: { count: async () => queued } };
  return new PublishService(cfg, prisma as unknown as PrismaService, projects as unknown as ProjectsService);
}

describe('download names', () => {
  it('keeps a plain file name with the original extension', () => {
    expect(downloadName(undefined, 'audiobook.mp4')).toBe('audiobook.mp4');
    expect(downloadName('the-metamorphosis-audiobook', 'audiobook.mp4')).toBe('the-metamorphosis-audiobook.mp4');
    expect(downloadName('../../etc/passwd', 'audiobook.mp4')).toBe('etcpasswd.mp4');
    expect(downloadName('a\nb"<>.mp4', 'audiobook.mp4')).toBe('ab.mp4');
    expect(downloadName('...', 'thumbnail.jpg')).toBe('thumbnail.jpg');
  });
});

describe('publish draft schema', () => {
  const ctx = { title: 'T', author: 'A', language: 'en' as const, durationSec: 60, pageCount: 1, wordCount: 10, chapters: [], aspectRatio: '16:9' as const, hasVideo: true, hasAudio: true };
  it('accepts the rule-based draft and strips NUL characters', () => {
    const d = templateDraft(ctx);
    d.youtube.title = 'Hello\u0000';
    const r = publishDraftSchema.safeParse(d);
    expect(r.success && r.data.youtube.title).toBe('Hello');
  });
  it('refuses links that are not http(s)', () => {
    expect(publishDraftSchema.safeParse({ ...templateDraft(ctx), videoUrl: 'javascript:alert(1)' }).success).toBe(false);
  });
});

describe('excerpt', () => {
  it('takes the narrated opening, whole sentences only', () => {
    expect(excerptOf(timeline, 'en')).toBe('One morning Gregor woke. He was a bug.');
    expect(excerptOf({ ...timeline, segments: [{ ...timeline.segments[0], text: 'x'.repeat(4000) }] }, 'en')).toBe('');
    expect(excerptOf(undefined, 'en')).toBe('');
  });
});

describe.skipIf(!hasFfmpeg)('PublishService', () => {
  beforeEach(() => {
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'timeline.json'), JSON.stringify(timeline));
    execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(out, 'audiobook.mp4')]);
  });

  it('starts from the rule-based draft and reports the AI as off', async () => {
    const s = await setup().state(ID);
    expect(s.saved).toBe(false);
    expect(s.draft.youtube.title).toContain('The Metamorphosis');
    expect(s.context).toMatchObject({ title: 'The Metamorphosis', author: 'Franz Kafka', durationSec: 2, hasVideo: true, hasAudio: false });
    expect(s.llm).toMatchObject({ enabled: false, available: false });
    expect(s.embedded.map((e) => e.name)).toEqual(['audiobook.mp4']);
    await expect(setup().generate(ID, { sections: ['youtube'] })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('saves edits, applies them to the file, and notices when the file or the draft changes', async () => {
    const svc = setup();
    const first = await svc.state(ID);
    const draft = { ...first.draft, file: { ...first.draft.file, title: 'Embedded title', copyright: 'Public domain' } };
    expect((await svc.save(ID, { draft })).saved).toBe(true);

    const applied = await svc.apply(ID);
    expect(applied.applied).toMatchObject({ files: ['audiobook.mp4'], stale: [] });
    expect(applied.embedded[0].tags).toMatchObject({ title: 'Embedded title', copyright: 'Public domain', artist: 'Franz Kafka' });

    await svc.save(ID, { draft: { ...draft, file: { ...draft.file, title: 'Changed' } } });
    expect((await svc.state(ID)).applied?.stale).toEqual(['draft']);

    // A later run re-creates the video: the embedded tags are gone.
    execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(out, 'audiobook.mp4')]);
    expect((await svc.state(ID)).applied?.stale).toEqual(['files', 'draft']);
  });

  it('refuses to apply while the project is processing or queued', async () => {
    await expect(setup('RENDERING').apply(ID)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(setup('COMPLETED', 1).apply(ID)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('accepts only JPEG thumbnails up to 2 MB', async () => {
    const svc = setup();
    await expect(svc.saveThumbnail(ID, Buffer.from('not a jpeg'))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(svc.saveThumbnail(ID, Buffer.alloc(2 * 1024 * 1024 + 1, 0xff))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const s = await svc.saveThumbnail(ID, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    expect(s.thumbnail).toMatchObject({ url: `/projects/${ID}/output/thumbnail.jpg`, size: 6 });
    expect((await svc.deleteThumbnail(ID)).thumbnail).toBeUndefined();
  });
});
