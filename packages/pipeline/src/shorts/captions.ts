import { srtTime } from '@app/shared';
import type { ShortCaptionStyle } from '@app/types';
import type { TimedWord } from '../timeline/words';

/** One caption card: the words on screen together, shown from `start` to `end`. */
export interface CaptionGroup {
  start: number;
  end: number;
  words: TimedWord[];
}

/** Card sizes per caption style: a big single word, or a short line of a few words. */
export function groupLimits(style: ShortCaptionStyle): { maxWords: number; maxChars: number } {
  return style === 'word' ? { maxWords: 1, maxChars: 40 } : { maxWords: 4, maxChars: 24 };
}

const SENTENCE_END = /[.!?।…:;]["'”’)\]]*$/u;
const CLAUSE_END = /[,—–]["'”’)\]]*$/u;

/**
 * Narration words (with times) → caption cards. A card holds up to `maxWords` words / `maxChars`
 * characters (one more word when that ends the sentence) and ends at a sentence end or (once it has two words) at a comma, so a card never
 * spans two sentences. Each card stays up until the next one starts, so captions do not flicker
 * off between words; across a long pause (> `gap` s) it lingers only briefly. The last card stays
 * until the end of the video.
 */
export function captionGroups(words: TimedWord[], o: { maxWords: number; maxChars: number; duration: number; gap?: number }): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (cur.length) groups.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  for (const w of words) {
    const t = w.t.trim();
    if (!t) continue;
    const chars = cur.reduce((n, x) => n + [...x.t].length + 1, 0) + [...t].length;
    // A sentence's last word joins a full card when it still fits, instead of standing alone ("love?").
    const lastWord = o.maxWords > 1 && SENTENCE_END.test(t) && cur.length === o.maxWords && chars <= o.maxChars;
    if (cur.length && !lastWord && (cur.length >= o.maxWords || chars > o.maxChars)) flush();
    cur.push({ t, start: w.start, end: w.end });
    if (SENTENCE_END.test(t) || (CLAUSE_END.test(t) && cur.length >= 2)) flush();
  }
  flush();
  // Still a sentence's last word alone ("থাকেন।" after a long card)? Take the word before it along.
  if (o.maxWords > 1)
    for (let i = 1; i < groups.length; i++) {
      const g = groups[i];
      const prev = groups[i - 1];
      if (g.words.length !== 1 || prev.words.length < 3 || !SENTENCE_END.test(g.words[0].t) || SENTENCE_END.test(prev.words[prev.words.length - 1].t)) continue;
      g.words.unshift(prev.words.pop()!);
      g.start = g.words[0].start;
      prev.end = prev.words[prev.words.length - 1].end;
    }
  const gap = o.gap ?? 0.6;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const next = groups[i + 1];
    if (!next) g.end = Math.max(g.end, o.duration);
    else g.end = next.start - g.end > gap ? Math.min(next.start, g.end + 0.3) : next.start;
  }
  return groups;
}

/** Subtitles for the upload: one cue per caption card. */
export function captionsSrt(groups: CaptionGroup[]): string {
  return groups.map((g, i) => `${i + 1}\n${srtTime(g.start)} --> ${srtTime(g.end)}\n${g.words.map((w) => w.t).join(' ')}\n`).join('\n');
}
