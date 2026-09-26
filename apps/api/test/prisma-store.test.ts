import { describe, expect, it } from 'vitest';
import type { OutputRecord } from '@app/pipeline';
import type { Analysis, ChapterAudio, StepRecord, Timeline, UserFacingError } from '@app/types';
import type { PrismaService } from '../src/prisma/prisma.service';
import { PrismaStore } from '../src/worker/prisma-store';

type Call = { model: string; op: string; args: Record<string, unknown> };

/**
 * Minimal stand-in for PrismaClient: records every model call in order and supports both
 * `$transaction([...])` and `$transaction(async (tx) => ...)`. No database involved.
 */
function fakePrisma(project: { analysisKey?: string | null } = {}) {
  const calls: Call[] = [];
  const txOptions: unknown[] = [];
  const results: Record<string, unknown> = { 'project.findUnique': { analysisKey: project.analysisKey ?? null }, 'processingStep.findMany': [] };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => async (args: Record<string, unknown>) => {
          calls.push({ model: name, op, args });
          return results[`${name}.${op}`] ?? { count: 0 };
        },
      },
    );
  const models = Object.fromEntries(['project', 'chapter', 'paragraph', 'sentence', 'processingStep', 'audioChunk', 'timelineSegment'].map((m) => [m, model(m)]));
  const prisma = {
    ...models,
    async $transaction(arg: unknown, options?: unknown) {
      txOptions.push(options);
      calls.push({ model: '$', op: 'transaction', args: {} });
      if (typeof arg === 'function') return arg(models);
      return Promise.all(arg as Promise<unknown>[]);
    },
  };
  const of = (m: string, op?: string) => calls.filter((c) => c.model === m && (!op || c.op === op));
  return { prisma: prisma as unknown as PrismaService, calls, of, txOptions, results };
}

const region = (page: number) => [{ page, rects: [[10, 20, 30, 40]] as [number, number, number, number][], chars: 12 }];

function makeAnalysis(paragraphs: number, sentencesPerParagraph: number): Analysis {
  return {
    version: 'test',
    language: 'en',
    title: 'Test',
    chapters: [
      {
        index: 0,
        title: 'Intro',
        pageStart: 1,
        pageEnd: 1,
        source: 'toc',
        paragraphs: [{ id: 'c0-p0', index: 0, kind: 'heading', text: 'Intro', pageStart: 1, pageEnd: 1, regions: region(1), sentences: [{ id: 'c0-p0-s0', index: 0, text: 'Intro', narration: 'Intro', regions: region(1) }] }],
      },
      {
        index: 1,
        title: 'Big chapter',
        pageStart: 2,
        pageEnd: 9,
        source: 'pattern',
        paragraphs: Array.from({ length: paragraphs }, (_, p) => ({
          id: `c1-p${p}`,
          index: p,
          kind: 'body' as const,
          text: `Paragraph ${p}`,
          pageStart: 2,
          pageEnd: 2,
          regions: region(2),
          sentences: Array.from({ length: sentencesPerParagraph }, (_, s) => ({ id: `c1-p${p}-s${s}`, index: p * sentencesPerParagraph + s, text: `S ${p}.${s}`, narration: `Sentence ${p}.${s}`, regions: region(2) })),
        })),
      },
    ],
    stats: { chapters: 2, paragraphs: paragraphs + 1, sentences: paragraphs * sentencesPerParagraph + 1, words: 0, llmUsed: false, llmRepairs: 0, chapterSource: 'toc' },
    cleaning: { removedHeaders: [], removedFooters: [], removedPageNumbers: 0, dehyphenated: 0, removedDuplicates: 0, removedTocLines: 0, bodyFontSize: 11 },
    lexicon: {},
    warnings: [],
  };
}

const rows = (c: Call) => (c.args.data as Record<string, unknown>[]) ?? [];

describe('PrismaStore.saveAnalysis', () => {
  it('skips all writes when the stored analysisKey is unchanged', async () => {
    const f = fakePrisma({ analysisKey: 'key-1' });
    await new PrismaStore(f.prisma, 'proj-1').saveAnalysis(makeAnalysis(3, 2), 'key-1');
    expect(f.calls.map((c) => `${c.model}.${c.op}`)).toEqual(['project.findUnique']);
    expect(f.calls[0].args).toEqual({ where: { id: 'proj-1' }, select: { analysisKey: true } });
  });

  it('replaces chapters and chunks paragraph / sentence createMany in batches of 2000', async () => {
    const f = fakePrisma({ analysisKey: 'old-key' });
    // 2500 paragraphs × 2 sentences (+1 heading paragraph with 1 sentence) = 2501 paragraphs, 5001 sentences
    await new PrismaStore(f.prisma, 'proj-1').saveAnalysis(makeAnalysis(2500, 2), 'new-key');

    const writeOps = f.calls.filter((c) => c.op !== 'findUnique').map((c) => `${c.model}.${c.op}`);
    expect(writeOps).toEqual([
      '$.transaction',
      'chapter.deleteMany',
      'chapter.createMany',
      'paragraph.createMany',
      'paragraph.createMany',
      'sentence.createMany',
      'sentence.createMany',
      'sentence.createMany',
      'project.update',
    ]);
    expect(f.of('chapter', 'deleteMany')[0].args).toEqual({ where: { projectId: 'proj-1' } });
    expect(f.of('paragraph', 'createMany').map((c) => rows(c).length)).toEqual([2000, 501]);
    expect(f.of('sentence', 'createMany').map((c) => rows(c).length)).toEqual([2000, 2000, 1001]);
    expect(f.of('project', 'update')[0].args).toEqual({ where: { id: 'proj-1' }, data: { analysisKey: 'new-key' } });
    expect(f.txOptions[0]).toEqual({ timeout: 120_000 });
  });

  it('links sentences → paragraphs → chapters with generated ids and keeps the pipeline keys', async () => {
    const f = fakePrisma();
    await new PrismaStore(f.prisma, 'proj-1').saveAnalysis(makeAnalysis(3, 2), 'k');

    const chapters = rows(f.of('chapter', 'createMany')[0]);
    const paragraphs = f.of('paragraph', 'createMany').flatMap(rows);
    const sentences = f.of('sentence', 'createMany').flatMap(rows);
    expect(chapters).toHaveLength(2);
    expect(paragraphs).toHaveLength(4);
    expect(sentences).toHaveLength(7);
    expect(chapters[1]).toMatchObject({ projectId: 'proj-1', index: 1, title: 'Big chapter', pageStart: 2, pageEnd: 9, source: 'pattern' });

    const chapterIds = new Set(chapters.map((c) => c.id));
    expect(chapterIds.size).toBe(2);
    for (const p of paragraphs) expect(chapterIds.has(p.chapterId)).toBe(true);
    const paragraphIds = new Set(paragraphs.map((p) => p.id));
    expect(paragraphIds.size).toBe(4);
    for (const s of sentences) expect(paragraphIds.has(s.paragraphId)).toBe(true);

    const s = sentences.find((x) => x.key === 'c1-p2-s1');
    expect(s).toMatchObject({ index: 5, text: 'S 2.1', narration: 'Sentence 2.1', regions: region(2) });
    const para = paragraphs.find((p) => p.text === 'Paragraph 2')!;
    expect(s!.paragraphId).toBe(para.id);
    expect(para.chapterId).toBe(chapters[1].id);
    expect(para).toMatchObject({ index: 2, kind: 'body', regions: region(2) });
  });

  it('still writes when there is no previous analysis (analysisKey null)', async () => {
    const f = fakePrisma({ analysisKey: null });
    await new PrismaStore(f.prisma, 'p').saveAnalysis(makeAnalysis(1, 1), 'k');
    expect(f.of('chapter', 'createMany')).toHaveLength(1);
  });
});

describe('PrismaStore steps', () => {
  const error: UserFacingError = { code: 'TTS_FAILED', message: 'Speech generation failed.', retryable: true, stepKey: 'TTS_CHAPTER_2', chapterIndex: 1 };

  it('updateStep upserts by (projectId, key) with order 999 on create', async () => {
    const f = fakePrisma();
    const step: StepRecord = { key: 'TTS_CHAPTER_2', stage: 'TTS', status: 'RUNNING', progress: 40, chapterIndex: 1, message: 'Chapter 2', startedAt: '2026-01-02T03:04:05.000Z' };
    await new PrismaStore(f.prisma, 'proj-1').updateStep(step);

    const [call] = f.of('processingStep', 'upsert');
    const base = { stage: 'TTS', status: 'RUNNING', progress: 40, cached: false, chapterIndex: 1, message: 'Chapter 2', startedAt: new Date('2026-01-02T03:04:05.000Z'), finishedAt: null };
    expect(call.args).toEqual({
      where: { projectId_key: { projectId: 'proj-1', key: 'TTS_CHAPTER_2' } },
      create: { projectId: 'proj-1', key: 'TTS_CHAPTER_2', ...base, error: undefined, order: 999 },
      // error must be explicitly cleared (null) when a retried step no longer has one
      update: { ...base, error: null },
    });
    expect((call.args.update as { order?: number }).order).toBeUndefined();
  });

  it('updateStep stores the user-facing error and normalizes optional fields', async () => {
    const f = fakePrisma();
    await new PrismaStore(f.prisma, 'proj-1').updateStep({ key: 'MUX', stage: 'MUX', status: 'FAILED', progress: 10, cached: true, error, finishedAt: '2026-01-02T03:04:06.000Z' });
    const [call] = f.of('processingStep', 'upsert');
    const create = call.args.create as Record<string, unknown>;
    const update = call.args.update as Record<string, unknown>;
    expect(update).toMatchObject({ status: 'FAILED', cached: true, chapterIndex: null, message: null, startedAt: null, finishedAt: new Date('2026-01-02T03:04:06.000Z'), error });
    expect(create.error).toEqual(error);
  });

  it('saveSteps upserts every step in one transaction with its plan order', async () => {
    const f = fakePrisma();
    const steps: StepRecord[] = [
      { key: 'EXTRACT', stage: 'EXTRACT', status: 'COMPLETED', progress: 100, cached: true },
      { key: 'CLEAN', stage: 'CLEAN', status: 'PENDING', progress: 0 },
      { key: 'TTS_CHAPTER_1', stage: 'TTS', status: 'PENDING', progress: 0, chapterIndex: 0 },
    ];
    await new PrismaStore(f.prisma, 'proj-1').saveSteps(steps);
    const upserts = f.of('processingStep', 'upsert');
    expect(f.of('$', 'transaction')).toHaveLength(1);
    expect(upserts.map((u) => (u.args.update as { order: number }).order)).toEqual([0, 1, 2]);
    expect(upserts.map((u) => (u.args.create as { key: string }).key)).toEqual(['EXTRACT', 'CLEAN', 'TTS_CHAPTER_1']);
    expect(upserts[2].args.create).toMatchObject({ projectId: 'proj-1', chapterIndex: 0, order: 2 });
  });

  it('loadSteps maps rows back to StepRecords (null → undefined, dates → ISO)', async () => {
    const f = fakePrisma();
    f.results['processingStep.findMany'] = [
      { key: 'EXTRACT', stage: 'EXTRACT', status: 'COMPLETED', progress: 100, cached: true, chapterIndex: null, message: null, error: null, startedAt: new Date('2026-01-02T03:04:05.000Z'), finishedAt: null },
      { key: 'TTS_CHAPTER_1', stage: 'TTS', status: 'FAILED', progress: 5, cached: false, chapterIndex: 0, message: 'x', error, startedAt: null, finishedAt: null },
    ];
    const out = await new PrismaStore(f.prisma, 'proj-1').loadSteps();
    expect(f.of('processingStep', 'findMany')[0].args).toEqual({ where: { projectId: 'proj-1' }, orderBy: { order: 'asc' } });
    expect(out).toEqual([
      { key: 'EXTRACT', stage: 'EXTRACT', status: 'COMPLETED', progress: 100, cached: true, startedAt: '2026-01-02T03:04:05.000Z' },
      { key: 'TTS_CHAPTER_1', stage: 'TTS', status: 'FAILED', progress: 5, cached: false, chapterIndex: 0, message: 'x', error },
    ]);
  });
});

describe('PrismaStore other writes', () => {
  it('saveOutputs stores only name / kind / size (no absolute paths in the DB/UI)', async () => {
    const f = fakePrisma();
    const outputs: OutputRecord[] = [
      { name: 'audiobook.m4a', kind: 'audio', size: 1234, path: '/Users/me/storage/output/p/audiobook.m4a' },
      { name: 'subtitles.srt', kind: 'subtitles', size: 56, path: '/Users/me/storage/output/p/subtitles.srt' },
    ];
    await new PrismaStore(f.prisma, 'proj-1').saveOutputs(outputs);
    const [call] = f.of('project', 'update');
    expect(call.args).toEqual({
      where: { id: 'proj-1' },
      data: {
        outputs: [
          { name: 'audiobook.m4a', kind: 'audio', size: 1234 },
          { name: 'subtitles.srt', kind: 'subtitles', size: 56 },
        ],
      },
    });
    expect(JSON.stringify(call.args)).not.toContain('/Users/me');
  });

  it('updateSnapshot writes status, progress and the full snapshot', async () => {
    const f = fakePrisma();
    const snap = { status: 'GENERATING_AUDIO' as const, progress: 42.5, stage: 'TTS' as const, message: 'Chapter 2 of 3', updatedAt: '2026-01-02T03:04:05.000Z' };
    await new PrismaStore(f.prisma, 'proj-1').updateSnapshot(snap);
    expect(f.of('project', 'update')[0].args).toEqual({ where: { id: 'proj-1' }, data: { status: 'GENERATING_AUDIO', progress: 42.5, snapshot: snap } });
  });

  it('saveChapterAudio upserts by (projectId, chapterIndex) without timings', async () => {
    const f = fakePrisma();
    const a: ChapterAudio = { chapterIndex: 1, file: '/s/audio/k.flac', sampleRate: 24000, samples: 48000, durationSec: 2, timings: [{ id: 'c1-p0-s0', start: 0, end: 1 }], cacheKey: 'k', engine: 'kokoro', voice: 'af_sky' };
    await new PrismaStore(f.prisma, 'proj-1').saveChapterAudio(a);
    const data = { file: '/s/audio/k.flac', durationSec: 2, sampleRate: 24000, cacheKey: 'k', engine: 'kokoro', voice: 'af_sky' };
    expect(f.of('audioChunk', 'upsert')[0].args).toEqual({
      where: { projectId_chapterIndex: { projectId: 'proj-1', chapterIndex: 1 } },
      create: { projectId: 'proj-1', chapterIndex: 1, ...data },
      update: data,
    });
  });

  it('saveTimeline replaces segments in chunks of 2000 and stores the duration', async () => {
    const f = fakePrisma();
    const segments = Array.from({ length: 4001 }, (_, i) => ({
      i,
      sentenceId: `c1-p${i}-s0`,
      paragraphId: `c1-p${i}`,
      chapterIndex: 1,
      page: 2,
      start: i,
      end: i + 0.5,
      text: `S${i}`,
      rects: [[1, 2, 3, 4]] as [number, number, number, number][],
      pageChange: i === 0,
    }));
    const t: Timeline = { version: 't', duration: 4001.5, fps: 30, pageSizes: { 2: [612, 792] }, chapters: [], segments };
    await new PrismaStore(f.prisma, 'proj-1').saveTimeline(t);
    expect(f.of('timelineSegment', 'deleteMany')[0].args).toEqual({ where: { projectId: 'proj-1' } });
    expect(f.of('timelineSegment', 'createMany').map((c) => rows(c).length)).toEqual([2000, 2000, 1]);
    expect(rows(f.of('timelineSegment', 'createMany')[2])[0]).toEqual({ projectId: 'proj-1', idx: 4000, sentenceKey: 'c1-p4000-s0', chapterIndex: 1, page: 2, start: 4000, end: 4000.5, rects: [[1, 2, 3, 4]] });
    expect(f.of('project', 'update')[0].args).toEqual({ where: { id: 'proj-1' }, data: { durationSec: 4001.5 } });
  });
});

/**
 * The runner fires progress writes without awaiting them (throttled snapshots, step progress
 * every 2 s). Queries can run on different pool connections, so an older write that is slow to
 * get a connection can finish after a newer one. The store must apply them in call order.
 */
describe('PrismaStore write ordering', () => {
  function slowFirstWrite() {
    const state: { project: Record<string, unknown>; steps: Map<string, Record<string, unknown>> } = { project: {}, steps: new Map() };
    let n = 0;
    const delay = () => new Promise((r) => setTimeout(r, n++ === 0 ? 40 : 1)); // the first write is slow
    const prisma = {
      project: {
        async update({ data }: { data: Record<string, unknown> }) {
          await delay();
          Object.assign(state.project, data);
        },
      },
      processingStep: {
        async upsert({ where, update }: { where: { projectId_key: { key: string } }; update: Record<string, unknown> }) {
          await delay();
          state.steps.set(where.projectId_key.key, { ...update });
        },
      },
    };
    return { prisma: prisma as unknown as PrismaService, state };
  }
  const settle = () => new Promise((r) => setTimeout(r, 80));

  it('a late progress snapshot never overwrites the final COMPLETED', async () => {
    const f = slowFirstWrite();
    const store = new PrismaStore(f.prisma, 'proj-1');
    void store.updateSnapshot({ status: 'RENDERING', progress: 97, message: 'Rendering', updatedAt: '2026-01-01T00:00:00.000Z' });
    await store.updateSnapshot({ status: 'COMPLETED', progress: 100, message: 'Done', updatedAt: '2026-01-01T00:00:01.000Z' });
    await settle();
    expect(f.state.project).toMatchObject({ status: 'COMPLETED', progress: 100 });
  });

  it('a late progress snapshot never overwrites FAILED', async () => {
    const f = slowFirstWrite();
    const store = new PrismaStore(f.prisma, 'proj-1');
    void store.updateSnapshot({ status: 'GENERATING_AUDIO', progress: 30, updatedAt: '2026-01-01T00:00:00.000Z' });
    await store.updateSnapshot({ status: 'FAILED', progress: 30, error: { code: 'TTS_FAILED', message: 'Speech generation failed.', retryable: true }, updatedAt: '2026-01-01T00:00:01.000Z' });
    await settle();
    expect(f.state.project.status).toBe('FAILED');
  });

  it('coalesces queued snapshots: only the newest waiting one is written', async () => {
    const f = slowFirstWrite();
    const writes: unknown[] = [];
    const orig = (f.prisma as unknown as { project: { update: (a: { data: { snapshot: unknown } }) => Promise<void> } }).project;
    const update = orig.update;
    orig.update = async (a) => {
      writes.push((a.data.snapshot as { progress: number }).progress);
      return update(a);
    };
    const store = new PrismaStore(f.prisma, 'proj-1');
    const all = [1, 2, 3, 4].map((progress) => store.updateSnapshot({ status: 'RENDERING', progress, updatedAt: 'x' }));
    await Promise.all(all);
    expect(writes.at(-1)).toBe(4);
    expect(writes.length).toBeLessThanOrEqual(2); // 2 and 3 were superseded while waiting
    expect(f.state.project.progress).toBe(4);
  });

  it('a late step progress write never overwrites the step COMPLETED', async () => {
    const f = slowFirstWrite();
    const store = new PrismaStore(f.prisma, 'proj-1');
    const startedAt = '2026-01-01T00:00:00.000Z';
    void store.updateStep({ key: 'TTS_CHAPTER_1', stage: 'TTS', status: 'RUNNING', progress: 87, startedAt });
    await store.updateStep({ key: 'TTS_CHAPTER_1', stage: 'TTS', status: 'COMPLETED', progress: 100, startedAt, finishedAt: '2026-01-01T00:01:00.000Z' });
    await settle();
    expect(f.state.steps.get('TTS_CHAPTER_1')).toMatchObject({ status: 'COMPLETED', progress: 100 });
  });

  it('one failed write does not block the ones after it', async () => {
    let calls = 0;
    const prisma = {
      project: {
        async update() {
          if (calls++ === 0) throw new Error('connection reset');
        },
      },
    } as unknown as PrismaService;
    const store = new PrismaStore(prisma, 'proj-1');
    await expect(store.updateSnapshot({ status: 'RENDERING', progress: 1, updatedAt: 'x' })).rejects.toThrow('connection reset');
    await expect(store.updateSnapshot({ status: 'COMPLETED', progress: 100, updatedAt: 'y' })).resolves.toBeUndefined();
  });
});
