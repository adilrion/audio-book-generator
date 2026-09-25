import type { Analysis, ChapterAudio, SubtitleCue } from '@app/types';
import { formatDuration, srtTime } from '@app/shared';
import { chapterOffsets, indexSentences } from './build';

const MAX_CUE_CHARS = 84; // two lines of ~42 chars — YouTube/broadcast convention

function chunkText(text: string): string[] {
  if (text.length <= MAX_CUE_CHARS) return [text];
  const words = text.split(/\s+/);
  const parts: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > MAX_CUE_CHARS) {
      parts.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) parts.push(cur);
  return parts;
}

function wrapTwoLines(text: string): string {
  if (text.length <= 42) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best > 0 ? `${text.slice(0, best)}\n${text.slice(best + 1)}` : text;
}

/** Sentence-level cues (display text), long sentences split and timed by character share. */
export function buildCues(analysis: Analysis, audios: ChapterAudio[]): SubtitleCue[] {
  const refs = indexSentences(analysis);
  const offsets = chapterOffsets(audios);
  const cues: SubtitleCue[] = [];
  audios.forEach((a, ai) => {
    for (const t of a.timings) {
      const ref = refs.get(t.id);
      if (!ref) continue;
      const chunks = chunkText(ref.sentence.text);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      let s = offsets[ai] + t.start;
      const dur = t.end - t.start;
      for (const c of chunks) {
        const d = (dur * c.length) / total;
        cues.push({ index: cues.length + 1, start: s, end: s + d, text: wrapTwoLines(c) });
        s += d;
      }
    }
  });
  return cues;
}

export function toSrt(cues: SubtitleCue[]): string {
  return cues.map((c) => `${c.index}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

/** "00:00 Chapter 1" lines for a YouTube description. */
export function youtubeChapters(chapters: { title: string; start: number }[]): string {
  return chapters.map((c) => `${formatDuration(c.start).padStart(c.start >= 3600 ? 7 : 4, '0')} ${c.title}`).join('\n') + '\n';
}
