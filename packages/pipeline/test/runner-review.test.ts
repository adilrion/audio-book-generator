import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import { resolveSettings, type Timeline } from '@app/types';
import { MemoryStore, PipelineRunner, type PipelineJob } from '../src';
import { FakeTTS, hasFfmpeg, samplePdf } from './runner-fakes';

const base = loadConfig();
const hasPython = fs.existsSync(base.PYTHON_BIN);

describe.skipIf(!hasPython || !hasFfmpeg)('runner: chapter review pause', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-review-'));
  const cfg = loadConfig({ STORAGE_DIR: tmp, LLM_ENABLED: false as never, KEEP_INTERMEDIATE: false as never }, { reload: true });
  const pdf = path.join(tmp, 'book.pdf');
  const settings = resolveSettings({ outputMode: 'audiobook_only', text: { useLlm: false, reviewChapters: true } });
  const job: PipelineJob = { projectId: 'review', pdfPath: pdf, pdfHash: 'reviewhash', title: 'Review', settings };

  beforeAll(() => {
    samplePdf(cfg, pdf, 3, 2); // Opening Pages + 3 chapters
  });

  it('stops after chapter detection without narrating anything', async () => {
    const tts = new FakeTTS();
    const store = new MemoryStore();
    const r = await new PipelineRunner(cfg, store, undefined, { tts: () => tts }).run(job);
    expect(r.awaitingReview).toBe(true);
    expect(r.analysisKey).toBeTruthy();
    expect(r.analysis.chapters.map((c) => c.title)).toEqual(['Opening Pages', 'Chapter 1: The Beginning', 'Chapter 2: Steam and Iron', 'Chapter 3: The Railway Age']);
    expect(tts.calls).toBe(0);
    expect(store.snapshots[store.snapshots.length - 1].status).toBe('AWAITING_REVIEW');
    expect(store.steps.some((s) => s.stage === 'TTS')).toBe(false);
  });

  it('continues with the reviewed list: excluded, renamed and merged chapters', async () => {
    const tts = new FakeTTS();
    const first = await new PipelineRunner(cfg, new MemoryStore(), undefined, { tts: () => tts }).run(job);
    const reviewed: PipelineJob = {
      ...job,
      settings: {
        ...settings,
        text: {
          ...settings.text,
          chapterEdits: {
            analysisKey: first.analysisKey!,
            items: [
              { index: 0, exclude: true },
              { index: 1, title: 'The Beginning' },
              { index: 3, mergeWithPrevious: true },
            ],
          },
        },
      },
    };
    const store = new MemoryStore();
    const r = await new PipelineRunner(cfg, store, undefined, { tts: () => tts }).run(reviewed);
    expect(r.awaitingReview).toBeUndefined();
    expect(store.snapshots[store.snapshots.length - 1].status).toBe('COMPLETED');
    const tl = r.timeline as Timeline;
    expect(tl.chapters.map((c) => [c.index, c.title])).toEqual([
      [1, 'The Beginning'],
      [2, 'Chapter 2: Steam and Iron'],
    ]);
    // chapter 3's sentences are narrated inside chapter 2 (merged), chapter 0 not at all
    expect(new Set(tl.segments.map((s) => s.chapterIndex))).toEqual(new Set([1, 2]));
    expect(tl.segments.some((s) => s.sentenceId.startsWith('c3-'))).toBe(true);
    expect(tl.segments.some((s) => s.sentenceId.startsWith('c0-'))).toBe(false);
    expect(store.steps.filter((s) => s.stage === 'TTS').map((s) => s.key)).toEqual(['TTS_CHAPTER_2', 'TTS_CHAPTER_3']);
    const srt = fs.readFileSync(path.join(cfg.storage.output, 'review', 'chapters.txt'), 'utf8');
    expect(srt).toContain('The Beginning');
  });
});
