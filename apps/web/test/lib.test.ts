import { DEFAULT_SETTINGS, type ProjectDetail, type StepRecord, type TimelineSegment } from '@app/types';
import { describe, expect, it } from 'vitest';
import { errorFromResponse, toApiError } from '@/lib/api';
import { formatBytes, formatClock, formatDuration } from '@/lib/format';
import { splitHint } from '@/lib/hint';
import { affectedStages, cloneSettings, diffSettings } from '@/lib/settings';
import { currentRunSteps, deriveStages, projectPhase, retryLabel } from '@/lib/stages';
import { hitTest, rectToPercent, segmentIndexAt, segmentsByPage } from '@/lib/timeline';
import { groupVoices, pickVoice, voiceMeta } from '@/lib/voices';

const step = (key: string, stage: StepRecord['stage'], status: StepRecord['status'], extra: Partial<StepRecord> = {}): StepRecord => ({ key, stage, status, progress: status === 'COMPLETED' ? 100 : 0, ...extra });

function project(status: ProjectDetail['status'], steps: StepRecord[], snapshot: Partial<ProjectDetail['snapshot']> = {}): Pick<ProjectDetail, 'status' | 'steps' | 'snapshot' | 'settings'> {
  return { status, steps, settings: cloneSettings(DEFAULT_SETTINGS), snapshot: { status, progress: 0, updatedAt: '2026-01-01T00:00:00.000Z', ...snapshot } };
}

describe('segmentIndexAt (binary search)', () => {
  const segs = [{ start: 0 }, { start: 2.5 }, { start: 5 }, { start: 9 }];
  it('finds the last segment that has started', () => {
    expect(segmentIndexAt(segs, -1)).toBe(-1);
    expect(segmentIndexAt(segs, 0)).toBe(0);
    expect(segmentIndexAt(segs, 2.49)).toBe(0);
    expect(segmentIndexAt(segs, 2.5)).toBe(1);
    expect(segmentIndexAt(segs, 7)).toBe(2);
    expect(segmentIndexAt(segs, 1e6)).toBe(3);
    expect(segmentIndexAt([], 3)).toBe(-1);
  });
  it('agrees with a linear scan on a large timeline', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => ({ start: i * 1.7 }));
    for (const t of [0, 1.69, 1.7, 5000.3, 33_998.3, 40_000]) {
      const linear = big.reduce((ans, s, i) => (s.start <= t ? i : ans), -1);
      expect(segmentIndexAt(big, t)).toBe(linear);
    }
  });
});

describe('highlight geometry', () => {
  it('maps PDF points to page percentages', () => {
    const r = rectToPercent([54, 177, 331.5, 207.5], [432, 648], 0);
    expect(r.left).toBeCloseTo(12.5);
    expect(r.top).toBeCloseTo(27.31, 1);
    expect(r.width).toBeCloseTo(64.24, 1);
    expect(r.height).toBeCloseTo(4.71, 1);
  });
  it('clamps padding to the page', () => {
    const r = rectToPercent([0, 0, 10, 10], [100, 100], 5);
    expect(r.left).toBe(0);
    expect(r.top).toBe(0);
  });
  it('hit-tests clicks against segment rects on a page', () => {
    const segs = [
      { page: 1, rects: [[10, 10, 100, 20]] },
      { page: 2, rects: [[10, 10, 100, 20]] },
      { page: 2, rects: [[10, 30, 100, 40], [10, 45, 60, 55]] },
    ] as unknown as TimelineSegment[];
    const byPage = segmentsByPage(segs);
    expect(byPage.get(2)).toEqual([1, 2]);
    expect(hitTest(segs, byPage.get(2), 50, 50)).toBe(2);
    expect(hitTest(segs, byPage.get(2), 50, 15)).toBe(1);
    expect(hitTest(segs, byPage.get(2), 300, 300)).toBe(-1);
    expect(hitTest(segs, byPage.get(9), 50, 15)).toBe(-1);
  });
});

describe('settings diff', () => {
  it('sends only changed leaves', () => {
    const base = cloneSettings(DEFAULT_SETTINGS);
    const next = cloneSettings(base);
    next.video.theme = 'dark';
    next.tts.voice = 'bm_george';
    expect(diffSettings(base, next)).toEqual({ video: { theme: 'dark' }, tts: { voice: 'bm_george' } });
    expect(diffSettings(base, cloneSettings(base))).toEqual({});
  });
  it('clears a removed chapter range with null', () => {
    const base = cloneSettings(DEFAULT_SETTINGS);
    base.text.chapterRange = { from: 1, to: 3 };
    const next = cloneSettings(base);
    delete next.text.chapterRange;
    expect(diffSettings(base, next)).toEqual({ text: { chapterRange: null } });
    const changed = cloneSettings(base);
    changed.text.chapterRange = { from: 2, to: 3 };
    expect(diffSettings(base, changed)).toEqual({ text: { chapterRange: { from: 2, to: 3 } } });
  });
  it('predicts which stages recompute (mirrors the pipeline cache keys)', () => {
    const s = cloneSettings(DEFAULT_SETTINGS);
    expect(affectedStages({ video: { theme: 'dark' } }, s)).toEqual(['VIDEO', 'MUX']);
    expect(affectedStages({ tts: { voice: 'x' } }, s)).toEqual(['TTS', 'AUDIO_MERGE', 'TIMELINE', 'VIDEO', 'MUX']);
    expect(affectedStages({ video: { highlightMode: 'paragraph' } }, s)).toEqual(['TIMELINE', 'VIDEO', 'MUX']);
    expect(affectedStages({ video: { embedSubtitles: false } }, s)).toEqual(['MUX']);
    expect(affectedStages({ text: { ocr: 'force' } }, s)).toHaveLength(8);
    const audioOnly = cloneSettings(s);
    audioOnly.outputMode = 'audiobook_only';
    expect(affectedStages({ tts: { speed: 1.2 } }, audioOnly)).toEqual(['TTS', 'AUDIO_MERGE', 'TIMELINE']);
  });
});

describe('stage rows', () => {
  it('aggregates per-chapter TTS steps and marks the running stage', () => {
    const p = project(
      'GENERATING_AUDIO',
      [
        step('EXTRACT', 'EXTRACT', 'COMPLETED', { cached: true, startedAt: '2026-01-01T00:00:01.000Z', finishedAt: '2026-01-01T00:00:02.000Z' }),
        step('CLEAN', 'CLEAN', 'COMPLETED', { startedAt: '2026-01-01T00:00:02.000Z', finishedAt: '2026-01-01T00:00:03.000Z' }),
        step('ANALYZE', 'ANALYZE', 'COMPLETED', { startedAt: '2026-01-01T00:00:03.000Z', finishedAt: '2026-01-01T00:00:04.000Z' }),
        step('TTS_CHAPTER_1', 'TTS', 'COMPLETED', { chapterIndex: 0, startedAt: '2026-01-01T00:00:05.000Z', finishedAt: '2026-01-01T00:00:09.000Z' }),
        step('TTS_CHAPTER_2', 'TTS', 'RUNNING', { chapterIndex: 1, progress: 50, startedAt: '2026-01-01T00:00:06.000Z' }),
        step('TTS_CHAPTER_3', 'TTS', 'PENDING', { chapterIndex: 2 }),
        step('AUDIO_MERGE', 'AUDIO_MERGE', 'PENDING'),
      ],
      { stage: 'TTS', currentChapter: 2, totalChapters: 3 },
    );
    const rows = deriveStages(p);
    expect(rows.map((r) => r.label)).toEqual(['PDF Analysis', 'Text Cleaning', 'Chapter Detection', 'Audio Generation', 'Audio Mastering', 'Video Preparation', 'Rendering', 'Final Export']);
    expect(rows[0]).toMatchObject({ state: 'done', cached: true });
    expect(rows[3]).toMatchObject({ state: 'running', progress: 50, message: '1 of 3 chapters' });
    expect(rows[4].state).toBe('pending');
    expect(rows[6].state).toBe('pending');
  });

  it('treats steps finished by an earlier run as pending while re-running', () => {
    const p = project(
      'EXTRACTING',
      [
        step('EXTRACT', 'EXTRACT', 'RUNNING', { startedAt: '2026-02-01T00:00:00.000Z' }),
        step('MUX', 'MUX', 'COMPLETED', { startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z' }),
      ],
      { stage: 'EXTRACT' },
    );
    expect(currentRunSteps(p).find((s) => s.key === 'MUX')?.status).toBe('PENDING');
    expect(deriveStages(p).find((r) => r.stage === 'MUX')?.state).toBe('pending');
  });

  it('marks video stages as skipped for audiobook-only output', () => {
    const p = project('COMPLETED', [step('EXTRACT', 'EXTRACT', 'COMPLETED')]);
    p.settings.outputMode = 'audiobook_only';
    const rows = deriveStages(p);
    expect(rows.find((r) => r.stage === 'VIDEO')?.state).toBe('skipped');
    expect(rows.find((r) => r.stage === 'MUX')?.state).toBe('skipped');
  });

  it('distinguishes a fresh project from a queued one', () => {
    expect(projectPhase(project('PENDING', []))).toBe('idle');
    expect(projectPhase(project('PENDING', [], { message: 'Waiting for the worker…' }))).toBe('queued');
    expect(projectPhase(project('RENDERING', []))).toBe('active');
  });

  it('labels the retry button from the failed step', () => {
    expect(retryLabel({ code: 'TTS_FAILED', message: 'x', retryable: true, stepKey: 'TTS_CHAPTER_7', chapterIndex: 6 })).toBe('Retry Chapter 7');
    expect(retryLabel({ code: 'X', message: 'x', retryable: true, stepKey: 'VIDEO_CHAPTER_3' })).toBe('Retry Chapter 3');
    expect(retryLabel({ code: 'X', message: 'x', retryable: true, stepKey: 'MUX' }, [step('MUX', 'MUX', 'FAILED')])).toBe('Retry Final Export');
    expect(retryLabel(undefined)).toBe('Retry');
  });
});

describe('API errors', () => {
  it('uses the friendly message and hint from the API body', () => {
    const e = errorFromResponse(503, JSON.stringify({ error: { code: 'REDIS_UNAVAILABLE', message: 'The background job service (Redis) is not running.', hint: 'Start it with: docker compose up -d redis', retryable: true } }));
    expect(e).toMatchObject({ code: 'REDIS_UNAVAILABLE', status: 503, retryable: true, hint: 'Start it with: docker compose up -d redis' });
    expect(e.message).toBe('The background job service (Redis) is not running.');
  });
  it('never surfaces raw bodies (e.g. HTML error pages or stack traces)', () => {
    const e = errorFromResponse(500, '<html>Error: connect ECONNREFUSED 127.0.0.1:6379\n at TCPConnectWrap</html>');
    expect(e.message).not.toMatch(/ECONNREFUSED|TCPConnectWrap/);
    expect(e.code).toBe('HTTP_500');
  });
  it('maps network failures to the "start the API" message', () => {
    const e = toApiError(new TypeError('Failed to fetch'));
    expect(e.unreachable).toBe(true);
    expect(e.message).toBe('Cannot reach the local API — start it with pnpm dev');
  });
});

describe('hints', () => {
  it('extracts copyable commands', () => {
    expect(splitHint('Start it with: docker compose up -d redis')).toEqual({ text: 'Start it with:', command: 'docker compose up -d redis', after: undefined });
    expect(splitHint('Install Tesseract with: brew install tesseract — then retry.')).toEqual({ text: 'Install Tesseract with:', command: 'brew install tesseract', after: 'then retry.' });
    expect(splitHint('piper-tts is not installed. Run: workers/processing/.venv/bin/pip install piper-tts').command).toBe('workers/processing/.venv/bin/pip install piper-tts');
    expect(splitHint('pnpm setup:models')).toEqual({ command: 'pnpm setup:models', after: undefined });
    expect(splitHint('Set VIDEO_ENCODER=auto')).toEqual({ text: 'Set VIDEO_ENCODER=auto' });
    expect(splitHint(undefined)).toEqual({});
  });
});

describe('voices & formatting', () => {
  const voices = [
    { id: 'bf_emma', name: 'Emma', engine: 'kokoro', language: 'en', gender: 'female' as const, installed: true },
    { id: 'ef_dora', name: 'Dora', engine: 'kokoro', language: 'es', gender: 'female' as const, installed: true },
    { id: 'af_heart', name: 'Heart', engine: 'kokoro', language: 'en', gender: 'female' as const, installed: true },
    { id: 'am_adam', name: 'Adam', engine: 'kokoro', language: 'en', gender: 'male' as const, installed: true },
  ];
  it('groups by language with the project language first', () => {
    const g = groupVoices(voices, 'en');
    expect(g.map((x) => x.label)).toEqual(['English', 'Spanish']);
    expect(g[0].voices.map((v) => v.id)).toEqual(['bf_emma', 'af_heart', 'am_adam']);
    expect(voiceMeta(voices[2])).toBe('Female · US');
  });
  it('keeps an installed preferred voice, else falls back to the language', () => {
    expect(pickVoice(voices, 'am_adam', 'en')).toBe('am_adam');
    expect(pickVoice(voices, 'missing', 'es')).toBe('ef_dora');
  });
  it('formats sizes and durations', () => {
    expect(formatBytes(7_375_656)).toBe('7.0 MB');
    expect(formatBytes(80)).toBe('80 B');
    expect(formatClock(3725.4)).toBe('1:02:05');
    expect(formatDuration(111.665)).toBe('1 min 52 s');
    expect(formatDuration(3725)).toBe('1 h 2 min');
  });
});
