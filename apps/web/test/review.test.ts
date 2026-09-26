import { DEFAULT_SETTINGS, type ProjectDetail, type StepRecord, type Timeline } from '@app/types';
import { describe, expect, it } from 'vitest';
import { cloneSettings } from '@/lib/settings';
import { currentRunSteps, deriveStages, projectError, retryLabel } from '@/lib/stages';
import { pageSizeOf, parseTimeParam, rectToPercent, segmentIndexAt } from '@/lib/timeline';
import { groupVoices, languageName } from '@/lib/voices';

// Steps as the worker persists them (runner.ts): every run re-runs EXTRACT first, steps of an
// earlier run keep their old status/finishedAt until this run reaches them, and steps that are
// not part of this run's plan (other chapter range / output mode) are never touched again.
const RUN1 = '2026-01-01T00:00:00.000Z';
const RUN2 = '2026-01-01T01:00:00.000Z';
const at = (base: string, sec: number) => new Date(Date.parse(base) + sec * 1000).toISOString();

type Status = StepRecord['status'];
function s(key: string, stage: StepRecord['stage'], status: Status, run: string, extra: Partial<StepRecord> = {}): StepRecord {
  const m = key.match(/_CHAPTER_(\d+)$/);
  return {
    key,
    stage,
    status,
    progress: status === 'COMPLETED' ? 100 : 0,
    chapterIndex: m ? Number(m[1]) - 1 : undefined,
    startedAt: status === 'PENDING' ? undefined : at(run, 1),
    finishedAt: status === 'COMPLETED' || status === 'FAILED' ? at(run, 5) : undefined,
    ...extra,
  };
}

function proj(status: ProjectDetail['status'], steps: StepRecord[], outputMode: 'audiobook_video' | 'audiobook_only' = 'audiobook_video', snapshot: Partial<ProjectDetail['snapshot']> = {}) {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.outputMode = outputMode;
  return { status, steps, settings, snapshot: { status, progress: 0, updatedAt: RUN2, ...snapshot } } as Pick<ProjectDetail, 'status' | 'steps' | 'snapshot' | 'settings'>;
}

const stateOf = (p: ReturnType<typeof proj>, stage: StepRecord['stage']) => deriveStages(p).find((r) => r.stage === stage)!;

describe('stage rows ignore steps left over from earlier runs', () => {
  it('a completed run does not show a chapter that failed in an earlier run (outside the new chapter range)', () => {
    // Run 1 narrated chapters 1-3 and failed on chapter 3; run 2 used range 1-2 and completed.
    const p = proj('COMPLETED', [
      s('EXTRACT', 'EXTRACT', 'COMPLETED', RUN2),
      s('CLEAN', 'CLEAN', 'COMPLETED', RUN2),
      s('ANALYZE', 'ANALYZE', 'COMPLETED', RUN2),
      s('TTS_CHAPTER_1', 'TTS', 'COMPLETED', RUN2, { cached: true }),
      s('TTS_CHAPTER_2', 'TTS', 'COMPLETED', RUN2, { cached: true }),
      s('TTS_CHAPTER_3', 'TTS', 'FAILED', RUN1, { error: { code: 'TTS_FAILED', message: 'Audio generation failed for Chapter 3.', retryable: true, chapterIndex: 2 } }),
      s('AUDIO_MERGE', 'AUDIO_MERGE', 'COMPLETED', RUN2),
      s('TIMELINE', 'TIMELINE', 'COMPLETED', RUN2),
      s('VIDEO_CHAPTER_1', 'VIDEO', 'COMPLETED', RUN2),
      s('VIDEO_CHAPTER_2', 'VIDEO', 'COMPLETED', RUN2),
      s('VIDEO_CHAPTER_3', 'VIDEO', 'PENDING', RUN1),
      s('MUX', 'MUX', 'COMPLETED', RUN2),
    ]);
    const tts = stateOf(p, 'TTS');
    expect(tts.state).toBe('done');
    expect(tts.error).toBeUndefined();
    expect(tts.steps.map((x) => x.key)).toEqual(['TTS_CHAPTER_1', 'TTS_CHAPTER_2']);
    expect(stateOf(p, 'VIDEO').state).toBe('done'); // not "partial" because of the never-run chapter 3
    expect(deriveStages(p).every((r) => r.state === 'done')).toBe(true);
  });

  it('a failed re-run shows the stages it never reached as pending, not as done by the previous run', () => {
    // Run 1 completed everything; run 2 (new voice) failed on chapter 2.
    const p = proj('FAILED', [
      s('EXTRACT', 'EXTRACT', 'COMPLETED', RUN2, { cached: true }),
      s('CLEAN', 'CLEAN', 'COMPLETED', RUN2, { cached: true }),
      s('ANALYZE', 'ANALYZE', 'COMPLETED', RUN2, { cached: true }),
      s('TTS_CHAPTER_1', 'TTS', 'COMPLETED', RUN2),
      s('TTS_CHAPTER_2', 'TTS', 'FAILED', RUN2, { error: { code: 'TTS_FAILED', message: 'Audio generation failed for Chapter 2.', retryable: true, chapterIndex: 1 } }),
      s('TTS_CHAPTER_3', 'TTS', 'COMPLETED', RUN1),
      s('AUDIO_MERGE', 'AUDIO_MERGE', 'COMPLETED', RUN1),
      s('TIMELINE', 'TIMELINE', 'COMPLETED', RUN1),
      s('VIDEO_CHAPTER_1', 'VIDEO', 'COMPLETED', RUN1),
      s('MUX', 'MUX', 'COMPLETED', RUN1),
    ]);
    expect(stateOf(p, 'TTS').state).toBe('failed');
    expect(stateOf(p, 'AUDIO_MERGE').state).toBe('pending');
    expect(stateOf(p, 'TIMELINE').state).toBe('pending');
    expect(stateOf(p, 'VIDEO').state).toBe('pending');
    expect(stateOf(p, 'MUX').state).toBe('pending');
    expect(currentRunSteps(p).find((x) => x.key === 'TTS_CHAPTER_3')?.status).toBe('PENDING');
  });

  it('a cancelled re-run does the same', () => {
    const p = proj('CANCELLED', [
      s('EXTRACT', 'EXTRACT', 'COMPLETED', RUN2),
      s('TTS_CHAPTER_1', 'TTS', 'PENDING', RUN2, { startedAt: at(RUN2, 2) }),
      s('MUX', 'MUX', 'COMPLETED', RUN1),
    ]);
    expect(stateOf(p, 'MUX').state).toBe('pending');
  });

  it('an audiobook-only run after a video run shows the video stages as skipped', () => {
    const p = proj(
      'COMPLETED',
      [
        s('EXTRACT', 'EXTRACT', 'COMPLETED', RUN2),
        s('TTS_CHAPTER_1', 'TTS', 'COMPLETED', RUN2),
        s('AUDIO_MERGE', 'AUDIO_MERGE', 'COMPLETED', RUN2),
        s('TIMELINE', 'TIMELINE', 'COMPLETED', RUN2),
        s('VIDEO_CHAPTER_1', 'VIDEO', 'COMPLETED', RUN1),
        s('MUX', 'MUX', 'COMPLETED', RUN1),
      ],
      'audiobook_only',
    );
    expect(stateOf(p, 'VIDEO').state).toBe('skipped');
    expect(stateOf(p, 'MUX').state).toBe('skipped');
  });

  it('keeps the existing behaviour for a single run and for a cleaned cache', () => {
    const one = proj('COMPLETED', [s('EXTRACT', 'EXTRACT', 'COMPLETED', RUN1), s('MUX', 'MUX', 'COMPLETED', RUN1)]);
    expect(currentRunSteps(one)).toHaveLength(2);
    expect(deriveStages(proj('COMPLETED', [])).every((r) => r.state === 'done')).toBe(true);
  });

  it('the failure shown for a failed project comes from this run', () => {
    const p = proj('FAILED', [
      s('EXTRACT', 'EXTRACT', 'COMPLETED', RUN2),
      s('TTS_CHAPTER_3', 'TTS', 'FAILED', RUN1, { error: { code: 'OLD', message: 'old', retryable: true } }),
      s('MUX', 'MUX', 'FAILED', RUN2, { error: { code: 'FFMPEG_FAILED', message: 'new', retryable: true, stepKey: 'MUX' } }),
    ]);
    expect(projectError(p)?.code).toBe('FFMPEG_FAILED');
  });
});

describe('retry label', () => {
  it('says Resume for an interrupted run (the API hint says "Click Resume")', () => {
    // Written by the worker's recoverInterrupted() after a crash / reboot.
    const err = { code: 'INTERRUPTED', message: 'Processing was interrupted before it finished.', hint: 'Click Resume — finished steps are kept and will not be redone.', retryable: true };
    expect(retryLabel(err)).toBe('Resume');
  });
});

describe('?t= deep link', () => {
  it('parses seconds, clock and unit forms', () => {
    expect(parseTimeParam('83.5')).toBe(83.5);
    expect(parseTimeParam('1:23')).toBe(83);
    expect(parseTimeParam('1:02:03')).toBe(3723);
    expect(parseTimeParam('1m23s')).toBe(83);
    expect(parseTimeParam('1h2m3s')).toBe(3723);
    expect(parseTimeParam('90s')).toBe(90);
    expect(parseTimeParam(['12', '40'])).toBe(12);
  });
  it('rejects anything else', () => {
    for (const bad of [undefined, '', 'abc', '-3', '1:99', '1::2', 'NaN', 'Infinity', '1e999', '5m5m']) expect(parseTimeParam(bad)).toBeUndefined();
  });
  it('lands on the segment being narrated at that time, as the player does', () => {
    const segs = [
      { start: 0, end: 1.63 },
      { start: 2.53, end: 3.87 },
      { start: 5.67, end: 7.05 },
    ];
    expect(segmentIndexAt(segs, parseTimeParam('6')!)).toBe(2);
    expect(segmentIndexAt(segs, parseTimeParam('0:03')!)).toBe(1);
  });
});

describe('highlight geometry on the rendered page image', () => {
  // The API renders previews at scale 1.6 (projects.service pageImage); the overlay is in % of a box
  // with the page's aspect ratio, so % × displayed size must equal PDF points × display scale.
  const timeline = { pageSizes: { '1': [432, 648], '2': [612, 792] } } as unknown as Timeline;
  it('scales a real timeline rect to the displayed page at any size', () => {
    const rect: [number, number, number, number] = [54, 163.42, 375.35, 178.09];
    const size = pageSizeOf(timeline, 1);
    const box = rectToPercent(rect, size, 0);
    for (const displayedWidth of [360, 691.2, 1200]) {
      const k = displayedWidth / size[0];
      expect((box.left / 100) * displayedWidth).toBeCloseTo(rect[0] * k, 6);
      expect((box.top / 100) * (displayedWidth * (size[1] / size[0]))).toBeCloseTo(rect[1] * k, 6);
      expect((box.width / 100) * displayedWidth).toBeCloseTo((rect[2] - rect[0]) * k, 6);
    }
  });
  it('uses each page’s own size (mixed page sizes)', () => {
    expect(pageSizeOf(timeline, 2)).toEqual([612, 792]);
    expect(pageSizeOf(timeline, 7)).toEqual([432, 648]);
  });
});

describe('voice language labels', () => {
  it('names every language code the local engines report (macOS `say` has ta, sl, …)', () => {
    expect(languageName('ta')).toBe('Tamil');
    expect(languageName('sl')).toBe('Slovenian');
    expect(languageName('en-GB')).toBe('English');
    expect(languageName('zz')).toBe('ZZ');
  });
  it('sorts groups by their readable label, project language first', () => {
    const v = (id: string, language: string) => ({ id, name: id, engine: 'say', language, installed: true });
    const g = groupVoices([v('Vani', 'ta'), v('Tina', 'sl'), v('Alex', 'en'), v('Anna', 'de')], 'en');
    expect(g.map((x) => x.label)).toEqual(['English', 'German', 'Slovenian', 'Tamil']);
  });
});
