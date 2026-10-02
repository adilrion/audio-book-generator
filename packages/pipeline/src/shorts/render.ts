import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '@app/config';
import { AppError, atomicWrite, atomicWriteJson, ensureDir, exists, formatDuration, hashKey, readJsonIfExists } from '@app/shared';
import { SHORT_FPS, SHORT_MAX_SEC, SHORT_SIZE, type ShortSettings } from '@app/types';
import { masterAudio, muxFinal, validateOutput } from '../audio/ffmpeg';
import { CachePaths } from '../pipeline/paths';
import type { PythonPool } from '../python/bridge';
import { isSpeakable, normalizeNarration } from '../text/normalize';
import { splitSentences } from '../text/sentences';
import { createTTSProvider } from '../tts/registry';
import { printedWordTimes, type TimedWord } from '../timeline/words';
import type { TTSSegment } from '../tts/types';
import { captionGroups, captionsSrt, groupLimits } from './captions';

/**
 * Render a YouTube Short: narrate the script sentence by sentence (word times from sample counts),
 * master the audio, draw the vertical video with word-by-word captions in the Python worker, and
 * mux both. The narration is cached by script + voice, so changing only the look re-renders the
 * video without narrating again.
 */

export interface ShortRenderInput {
  id: string;
  title: string;
  script: string;
  settings: ShortSettings;
}

export type ShortStage = 'narration' | 'audio' | 'video' | 'finishing';

export interface ShortRenderOptions {
  pool: PythonPool;
  signal?: AbortSignal;
  /** `fraction` is 0–1 within the stage. */
  onProgress?: (stage: ShortStage, fraction: number) => void;
}

interface Narration {
  duration: number;
  words: TimedWord[];
}

/** Pause after a sentence; longer at a paragraph break (a blank or new line in the script). */
const PAUSE_MS = { sentence: 220, paragraph: 420 };

/**
 * Script → one TTS segment per sentence: `text` is what the voice says (abbreviations spelled out,
 * …), `printed` what the captions show (the script as written).
 */
export function shortSegments(script: string, language: string): (TTSSegment & { printed: string })[] {
  const spans = splitSentences(script, language);
  const segments: (TTSSegment & { printed: string })[] = [];
  spans.forEach((s, i) => {
    const printed = script.slice(s.start, s.end).replace(/\s+/g, ' ').trim();
    const text = normalizeNarration(printed, language);
    if (!isSpeakable(text)) return;
    const next = spans[i + 1];
    const between = next ? script.slice(s.end, next.start) : '';
    segments.push({ id: `s${i}`, text, printed, pauseMs: !next ? 0 : between.includes('\n') ? PAUSE_MS.paragraph : PAUSE_MS.sentence });
  });
  if (segments.length) segments[segments.length - 1].pauseMs = 0;
  return segments;
}

/** Caption words: the printed words of each sentence, timed against what the voice said in it. */
export function captionWords(segments: { id: string; text: string; printed: string }[], timings: { id: string; start: number; end: number }[]): TimedWord[] {
  const at = new Map(timings.map((t) => [t.id, t]));
  return segments.flatMap((s) => {
    const t = at.get(s.id);
    if (!t) return [];
    const printed = s.printed.split(/\s+/).filter(Boolean);
    return printedWordTimes(printed, s.text, t.start, t.end).map((w, i) => ({ t: printed[i], start: w.start, end: w.end }));
  });
}

/** What the narration depends on. */
export const narrationKey = (input: ShortRenderInput, ttsVersion: string) =>
  hashKey('short-narration-v1', input.script, input.settings.language, input.settings.tts, ttsVersion);

/** What the finished video depends on (to tell when it is out of date). */
export const shortRenderKey = (input: Pick<ShortRenderInput, 'title' | 'script' | 'settings'>, hasCover: boolean) =>
  hashKey('short-video-v1', input.title, input.script, input.settings, hasCover);

export async function renderShort(cfg: AppConfig, input: ShortRenderInput, o: ShortRenderOptions): Promise<{ durationSec: number; key: string }> {
  const paths = new CachePaths(cfg);
  const dir = paths.short(input.id);
  const work = paths.shortWork(input.id);
  await ensureDir(work);
  const { language, tts, look } = input.settings;
  const progress = o.onProgress ?? (() => undefined);

  // ── narration (cached) ──
  const provider = createTTSProvider(tts.engine, o.pool);
  const nKey = narrationKey(input, provider.version);
  const flac = path.join(work, `narration-${nKey}.flac`);
  const meta = path.join(work, `narration-${nKey}.json`);
  let narration = (await exists(flac)) ? await readJsonIfExists<Narration>(meta) : undefined;
  if (!narration) {
    const segments = shortSegments(input.script, language);
    if (!segments.length) throw new AppError('SHORT_EMPTY', 'The script has nothing to read aloud.', { hint: 'Write or generate a script first.', retryable: false });
    const r = await provider.synthesizeSegments(
      segments.map(({ id, text, pauseMs }) => ({ id, text, pauseMs })),
      {
        voice: tts.voice,
        speed: tts.speed,
        language,
        sampleRate: cfg.TTS_SAMPLE_RATE,
        outPath: flac,
        signal: o.signal,
        onProgress: (p) => progress('narration', p.total ? p.done / p.total : 0),
      },
    );
    narration = { duration: r.durationSec, words: captionWords(segments, r.sentences ?? []) };
    await atomicWriteJson(meta, narration);
    await removeOtherNarrations(work, nKey);
  }
  progress('narration', 1);
  if (narration.duration > SHORT_MAX_SEC)
    throw new AppError('SHORT_TOO_LONG', `The narration is ${formatDuration(narration.duration)} long — a YouTube Short can be at most 3 minutes.`, {
      hint: 'Shorten the script, or make the voice a little faster.',
      retryable: false,
    });

  // ── audio ──
  const audio = path.join(work, 'audio.m4a');
  await masterAudio(cfg, [flac], audio, { normalize: true, title: input.title, chapters: [], workDir: work, language, signal: o.signal });
  progress('audio', 1);

  // ── captions + video ──
  const duration = narration.duration;
  const groups = captionGroups(narration.words, { ...groupLimits(look.captions), duration });
  await atomicWrite(path.join(dir, 'short.srt'), captionsSrt(groups));
  const cover = path.join(dir, 'cover.jpg');
  const hasCover = look.theme === 'cover' && (await exists(cover));
  const video = path.join(work, 'video.mp4');
  await o.pool.call(
    'shorts.render',
    {
      ...SHORT_SIZE,
      fps: SHORT_FPS,
      duration,
      title: look.showTitle ? input.title : '',
      language,
      look: { ...look, theme: look.theme === 'cover' && !hasCover ? 'midnight' : look.theme },
      coverPath: hasCover ? cover : undefined,
      groups,
      outPath: video,
      encoder: { codec: cfg.VIDEO_ENCODER, bitrate: cfg.VIDEO_BITRATE, crf: cfg.VIDEO_CRF, ffmpeg: cfg.FFMPEG_BIN },
    },
    { signal: o.signal, onProgress: (p) => progress('video', p.total ? p.done / p.total : 0) },
  );

  // ── finishing ──
  const out = path.join(dir, 'short.mp4');
  await muxFinal(cfg, [video], audio, out, { title: input.title, chapters: [], workDir: work, language, signal: o.signal });
  await validateOutput(cfg, out, duration, SHORT_FPS);
  await fsp.rm(video, { force: true }).catch(() => undefined);
  progress('finishing', 1);
  return { durationSec: duration, key: shortRenderKey(input, hasCover) };
}

/** Keep only the current narration: an edited script makes the old one useless. */
async function removeOtherNarrations(work: string, keep: string) {
  for (const f of await fsp.readdir(work).catch(() => [])) {
    if (/^narration-[0-9a-f]+\.(flac|json)$/.test(f) && !f.includes(keep)) await fsp.rm(path.join(work, f), { force: true }).catch(() => undefined);
  }
}
