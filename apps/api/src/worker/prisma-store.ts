import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { OutputRecord, PipelineStore } from '@app/pipeline';
import type { Analysis, ChapterAudio, ProgressSnapshot, StepRecord, Timeline } from '@app/types';
import type { PrismaService } from '../prisma/prisma.service';

const json = (v: unknown) => v as Prisma.InputJsonValue;
const date = (s?: string) => (s ? new Date(s) : null);

/** PipelineStore backed by PostgreSQL — gives the UI live steps/progress and the entities. */
export class PrismaStore implements PipelineStore {
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

  async saveSteps(steps: StepRecord[]): Promise<void> {
    await this.prisma.$transaction(
      steps.map((s, i) =>
        this.prisma.processingStep.upsert({
          where: { projectId_key: { projectId: this.projectId, key: s.key } },
          create: { projectId: this.projectId, key: s.key, ...this.data(s, i) },
          update: this.data(s, i),
        }),
      ),
    );
  }

  async updateStep(s: StepRecord): Promise<void> {
    const d = this.data(s);
    await this.prisma.processingStep.upsert({
      where: { projectId_key: { projectId: this.projectId, key: s.key } },
      create: { projectId: this.projectId, key: s.key, ...d, order: 999 },
      update: { ...d, error: s.error ? json(s.error) : (null as unknown as Prisma.InputJsonValue) },
    });
  }

  async updateSnapshot(snap: ProgressSnapshot): Promise<void> {
    await this.prisma.project.update({
      where: { id: this.projectId },
      data: { status: snap.status, progress: snap.progress, snapshot: json(snap) },
    });
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
