import { type JobStatus, type LanguageCode, SHORT_IDEAL_SEC, SHORT_MAX_SEC, type ShortCaptionStyle, type ShortScriptStyle, type ShortTheme, estimateShortSec } from '@app/types';

/** The renderer's gradients (workers/processing/audiobook_worker/shorts/render.py), for the preview. */
export const SHORT_THEMES: Record<ShortTheme, { label: string; top: string; bottom: string; light?: boolean }> = {
  midnight: { label: 'Midnight', top: 'rgb(15 23 42)', bottom: 'rgb(76 29 149)' },
  sunset: { label: 'Sunset', top: 'rgb(157 23 77)', bottom: 'rgb(234 88 12)' },
  ocean: { label: 'Ocean', top: 'rgb(8 47 73)', bottom: 'rgb(13 148 136)' },
  forest: { label: 'Forest', top: 'rgb(6 44 34)', bottom: 'rgb(63 98 18)' },
  paper: { label: 'Paper', top: 'rgb(250 246 238)', bottom: 'rgb(232 220 196)', light: true },
  cover: { label: 'Book cover', top: 'rgb(40 40 46)', bottom: 'rgb(12 12 16)' },
};

export const CAPTION_STYLES: { value: ShortCaptionStyle; label: string; hint: string }[] = [
  { value: 'karaoke', label: 'Karaoke', hint: 'A few words, the spoken one in colour' },
  { value: 'box', label: 'Highlight box', hint: 'The spoken word on a coloured pill' },
  { value: 'word', label: 'One word', hint: 'One big word at a time' },
  { value: 'plain', label: 'Plain', hint: 'A few words, no highlight' },
];

export const SCRIPT_STYLES: { value: ShortScriptStyle; label: string; hint: string }[] = [
  { value: 'hook', label: 'Hook & teaser', hint: 'Stops the scroll, ends with “listen to the full audiobook”' },
  { value: 'summary', label: 'Key ideas', hint: 'What it is about, in a few clear points' },
  { value: 'story', label: 'Mini story', hint: 'Told as a vivid little story' },
];

export const SCRIPT_LENGTHS = [30, 45, 60, 90] as const;

/** The caption style the renderer really uses: an accent-coloured word is unreadable on paper, so it gets a box. */
export const effectiveCaptions = (style: ShortCaptionStyle, theme: ShortTheme): ShortCaptionStyle => (style === 'karaoke' && SHORT_THEMES[theme].light ? 'box' : style);

export const isShortBusy = (status: JobStatus, queued: boolean) => status === 'GENERATING_AUDIO' || status === 'RENDERING' || (status === 'PENDING' && queued);

export type LengthVerdict = { tone: 'ok' | 'warning' | 'error' | 'muted'; text: string };

/** "~48 s · fits a Short", "~1:12 · over a minute", "~3:20 · too long". */
export function lengthVerdict(script: string, language: LanguageCode, speed: number): LengthVerdict {
  const sec = estimateShortSec(script, language, speed);
  if (!sec) return { tone: 'muted', text: 'Write a few sentences — about 150 words make a one-minute short.' };
  const len = sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} min`;
  if (sec > SHORT_MAX_SEC) return { tone: 'error', text: `~${len} — too long: a YouTube Short can be at most 3 minutes.` };
  if (sec > SHORT_IDEAL_SEC) return { tone: 'warning', text: `~${len} — allowed, but Shorts under a minute usually do better.` };
  return { tone: 'ok', text: `~${len} of narration` };
}

/** "#Shorts #Tagore" ⇄ ["Shorts", "Tagore"] for the hashtag field. */
export const parseHashtags = (raw: string) =>
  [...new Set(raw.split(/[\s,]+/).map((h) => h.replace(/^#+/, '').replace(/[^\p{L}\p{M}\p{N}_]/gu, '')).filter(Boolean))].slice(0, 30);
export const formatHashtags = (tags: string[]) => tags.map((t) => `#${t}`).join(' ');

/** What to paste into YouTube's description box. */
export const youtubeDescription = (description: string, hashtags: string[]) => [description.trim(), formatHashtags(hashtags)].filter(Boolean).join('\n\n');
