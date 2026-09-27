import { describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { chaptersSignature } from '@app/pipeline';
import { AppError } from '@app/shared';
import { DEFAULT_SETTINGS, type ProjectSettings } from '@app/types';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ProjectsService } from '../src/projects/projects.service';
import type { QueueService } from '../src/queue/queue.service';
import type { PythonService } from '../src/system/python.service';

const TITLES = ['Opening Pages', 'CHAPTER I.', 'CHAPTER II.', 'Section 1. General Terms of Use and Redistributing Project Gutenberg electronic works'];

function setup(status = 'AWAITING_REVIEW', analysisKey: string | null = 'AK1') {
  let settings: ProjectSettings = { ...DEFAULT_SETTINGS, text: { ...DEFAULT_SETTINGS.text, reviewChapters: true } };
  const project = () => ({
    id: 'p1',
    name: 'Book',
    status,
    progress: 10,
    settings,
    snapshot: null,
    analysisKey,
    durationSec: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    document: { hash: 'h', fileName: 'b.pdf', filePath: '/x.pdf', pageCount: 280, estimatedWords: 1, encrypted: false, likelyScanned: false, hasToc: false, fileSize: BigInt(1) },
  });
  const chapters = TITLES.map((title, index) => ({
    index,
    title,
    pageStart: index + 1,
    pageEnd: index + 1,
    paragraphs: [
      { kind: 'heading', text: title },
      { kind: 'body', text: `${'word '.repeat(60).trim()} of ${title}` },
    ],
  }));
  const prisma = {
    project: {
      findUnique: async () => project(),
      update: async (a: { data: { settings: ProjectSettings } }) => {
        settings = a.data.settings;
        return project();
      },
    },
    chapter: { findMany: async () => chapters },
    audioChunk: { findMany: async () => [{ chapterIndex: 1, durationSec: 289.4 }] },
    processingStep: { findMany: async () => [] },
  };
  const svc = new ProjectsService(loadConfig(), prisma as unknown as PrismaService, {} as QueueService, {} as PythonService);
  let processed = 0;
  svc.process = async () => {
    processed++;
    return { jobId: 'job-1' };
  };
  return { svc, getSettings: () => settings, processed: () => processed };
}

describe('chapter review', () => {
  it('lists chapters with previews, word counts and front/back-matter flags', async () => {
    const { svc } = setup();
    const list = await svc.chapters('p1');
    expect(list.map((c) => c.matter)).toEqual(['front', undefined, undefined, 'back']);
    expect(list[1].wordCount).toBe(2 + 63); // heading "CHAPTER I." + 60 words + "of CHAPTER I."
    expect(list[1].durationSec).toBe(289.4);
    expect(list[1].preview!.length).toBeLessThanOrEqual(180);
    expect(list[1].preview).toMatch(/^word word/);
  });

  it('saves the edits bound to the current analysis and starts narration', async () => {
    const { svc, getSettings, processed } = setup();
    const r = await svc.reviewChapters('p1', { items: [{ index: 0, exclude: true }, { index: 2, title: 'Chapter Two' }, { index: 3, exclude: false }] });
    expect(r).toEqual({ jobId: 'job-1' });
    expect(processed()).toBe(1);
    expect(getSettings().text.chapterEdits).toEqual({
      analysisKey: 'AK1',
      chaptersSignature: chaptersSignature(TITLES.map((title, index) => ({ index, title, pageStart: index + 1, pageEnd: index + 1 }))),
      items: [{ index: 0, exclude: true }, { index: 2, title: 'Chapter Two' }, { index: 3, exclude: false }],
    });
    expect(getSettings().text.reviewChapters).toBe(true);
  });

  it('can save without starting', async () => {
    const { svc, processed } = setup();
    expect(await svc.reviewChapters('p1', { items: [], start: false })).toEqual({});
    expect(processed()).toBe(0);
  });

  it('rejects unknown chapters, excluding everything, and bad input with friendly errors', async () => {
    const { svc } = setup();
    await expect(svc.reviewChapters('p1', { items: [{ index: 9, exclude: true }] })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Unknown chapter number(s): 10.' });
    await expect(svc.reviewChapters('p1', { items: TITLES.map((_, index) => ({ index, exclude: true })) })).rejects.toMatchObject({ message: 'Keep at least one chapter to narrate.' });
    await expect(svc.reviewChapters('p1', { items: [{ index: -1 }] })).rejects.toBeInstanceOf(AppError);
    await expect(svc.reviewChapters('p1', { items: [{ index: 1, title: '' }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses while processing or before chapters exist', async () => {
    await expect(setup('GENERATING_AUDIO').svc.reviewChapters('p1', { items: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(setup('PENDING', null).svc.reviewChapters('p1', { items: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
