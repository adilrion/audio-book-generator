import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { OutputRecord, PipelineStore } from '@app/pipeline';
import type { Analysis, ChapterAudio, ProgressSnapshot, StepRecord, Timeline } from '@app/types';
import type { PrismaService } from '../prisma/prisma.service';

const json = (v: unknown) => v as Prisma.InputJsonValue;
const date = (s?: string) => (s ? new Date(s) : null);

/**
 * Applies writes one at a time, in call order. The runner fires progress writes without awaiting
 * them, and on a connection pool an older write can otherwise finish after a newer one (e.g. a
 * "Rendering 97%" landing after COMPLETED). A write still waiting for its turn is replaced by a
 * newer one with the same key, so a slow database gets the latest state instead of a backlog.
 */
class OrderedWrites {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly waiting = new Map<string, { run: () => Promise<unknown>; done: Promise<void> }>();

  push(key: string | undefined, run: () => Promise<unknown>): Promise<void> {
    const queued = key === undefined ? undefined : this.waiting.get(key);
    if (queued) {
      queued.run = run;
      return queued.done;
    }
    const entry = { run } as { run: () => Promise<unknown>; done: Promise<void> };
    entry.done = this.tail.then(() => {
      if (key !== undefined) this.waiting.delete(key);
      return entry.run();
    }) as Promise<void>;
    entry.done = entry.done.then(() => undefined);
    if (key !== undefined) this.waiting.set(key, entry);
    this.tail = entry.done.catch(() => undefined);
    return entry.done;
  }
}

/** PipelineStore backed by PostgreSQL — gives the UI live steps/progress and the entities. */
export class PrismaStore implements PipelineStore {
  private readonly snapshots = new OrderedWrites();
  private readonly stepWrites = new OrderedWrites();

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectId: string,
  ) {}

  async loadSteps(): Promise<StepRecord[]> {
    const rows = await this.prisma.processingStep.findMany({ where: { projectId: this.projectId }, orderBy: { order: 'asc' } });
    return rows.map((r) => ({
      key: r.key,
      stage: r.stage as StepRecord['stage'],
      status: r.status,
      progress: r.progress,
      cached: r.cached,
      chapterIndex: r.chapterIndex ?? undefined,
      message: r.message ?? undefined,
      error: (r.error as unknown as StepRecord['error']) ?? undefined,
      startedAt: r.startedAt?.toISOString(),
      finishedAt: r.finishedAt?.toISOString(),
    }));
  }

  private data(s: StepRecord, order?: number) {
    return {
      stage: s.stage,
      status: s.status,
      progress: s.progress,
      cached: !!s.cached,
      chapterIndex: s.chapterIndex ?? null,
      message: s.message ?? null,
      error: s.error ? json(s.error) : undefined,
      startedAt: date(s.startedAt),
      finishedAt: date(s.finishedAt),
      ...(order !== undefined ? { order } : {}),
    };
  }

  saveSteps(steps: StepRecord[]): Promise<void> {
    const rows = steps.map((s, i) => ({ key: s.key, data: this.data(s, i) }));
    return this.stepWrites.push(undefined, () =>
      this.prisma.$transaction(
        rows.map(({ key, data }) =>
          this.prisma.processingStep.upsert({
            where: { projectId_key: { projectId: this.projectId, key } },
            create: { projectId: this.projectId, key, ...data },
            update: data,
          }),
        ),
      ),
    );
  }

  updateStep(s: StepRecord): Promise<void> {
    // Captured now: the runner keeps mutating the step object (progress) after this call.
    const d = this.data(s);
    const args = {
      where: { projectId_key: { projectId: this.projectId, key: s.key } },
      create: { projectId: this.projectId, key: s.key, ...d, order: 999 },
      update: { ...d, error: s.error ? json(s.error) : (null as unknown as Prisma.InputJsonValue) },
    };
    return this.stepWrites.push(s.key, () => this.prisma.processingStep.upsert(args));
  }

  updateSnapshot(snap: ProgressSnapshot): Promise<void> {
    const data = { status: snap.status, progress: snap.progress, snapshot: json(snap) };
    return this.snapshots.push('snapshot', () => this.prisma.project.update({ where: { id: this.projectId }, data }));
  }

  async saveAnalysis(a: Analysis, analysisKey: string): Promise<void> {
    const p = await this.prisma.project.findUnique({ where: { id: this.projectId }, select: { analysisKey: true } });
    if (p?.analysisKey === analysisKey) return;
    const chapters: Prisma.ChapterCreateManyInput[] = [];
    const paragraphs: Prisma.ParagraphCreateManyInput[] = [];
    const sentences: Prisma.SentenceCreateManyInput[] = [];
    for (const c of a.chapters) {
      const cid = randomUUID();
      chapters.push({ id: cid, projectId: this.projectId, index: c.index, title: c.title, pageStart: c.pageStart, pageEnd: c.pageEnd, source: c.source });
      for (const para of c.paragraphs) {
        const pid = randomUUID();
        paragraphs.push({ id: pid, chapterId: cid, index: para.index, kind: para.kind, text: para.text, pageStart: para.pageStart, pageEnd: para.pageEnd, regions: json(para.regions) });
        for (const s of para.sentences) sentences.push({ paragraphId: pid, key: s.id, index: s.index, text: s.text, narration: s.narration, regions: json(s.regions) });
      }
    }
    await this.prisma.$transaction(
      async (tx) => {
        await tx.chapter.deleteMany({ where: { projectId: this.projectId } });
        await tx.chapter.createMany({ data: chapters });
        for (let i = 0; i < paragraphs.length; i += 2000) await tx.paragraph.createMany({ data: paragraphs.slice(i, i + 2000) });
        for (let i = 0; i < sentences.length; i += 2000) await tx.sentence.createMany({ data: sentences.slice(i, i + 2000) });
        await tx.project.update({ where: { id: this.projectId }, data: { analysisKey } });
      },
      { timeout: 120_000 },
    );
  }

  async saveChapterAudio(a: ChapterAudio): Promise<void> {
    const data = { file: a.file, durationSec: a.durationSec, sampleRate: a.sampleRate, cacheKey: a.cacheKey, engine: a.engine, voice: a.voice };
    await this.prisma.audioChunk.upsert({
      where: { projectId_chapterIndex: { projectId: this.projectId, chapterIndex: a.chapterIndex } },
      create: { projectId: this.projectId, chapterIndex: a.chapterIndex, ...data },
      update: data,
    });
  }

  async saveTimeline(t: Timeline): Promise<void> {
    const rows: Prisma.TimelineSegmentCreateManyInput[] = t.segments.map((s) => ({
      projectId: this.projectId,
      idx: s.i,
      sentenceKey: s.sentenceId,
      chapterIndex: s.chapterIndex,
      page: s.page,
      start: s.start,
      end: s.end,
      rects: json(s.rects),
    }));
    await this.prisma.$transaction(
      async (tx) => {
        await tx.timelineSegment.deleteMany({ where: { projectId: this.projectId } });
        for (let i = 0; i < rows.length; i += 2000) await tx.timelineSegment.createMany({ data: rows.slice(i, i + 2000) });
        await tx.project.update({ where: { id: this.projectId }, data: { durationSec: t.duration } });
      },
      { timeout: 120_000 },
    );
  }

  async saveOutputs(outputs: OutputRecord[]): Promise<void> {
    await this.prisma.project.update({
      where: { id: this.projectId },
      data: { outputs: json(outputs.map(({ name, kind, size }) => ({ name, kind, size }))) },
    });
  }
}
