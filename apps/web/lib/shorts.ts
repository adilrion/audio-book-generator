import { type JobStatus, type LanguageCode, SHORT_IDEAL_SEC, SHORT_MAX_SEC, type ShortCaptionStyle, type ShortMotion, type ShortScriptStyle, type ShortTheme, type ShortVoiceFx, estimateShortSec, fitTags } from '@app/types';

/**
 * The renderer's backgrounds (workers/processing/audiobook_worker/shorts/render.py and scenes.py),
 * for the preview. Animated ones are drawn by lib/short-scenes.ts; `top`/`bottom` are their main
 * colours, for places that only show a gradient.
 */
export const SHORT_THEMES: Record<ShortTheme, { label: string; top: string; bottom: string; light?: boolean; animated?: boolean }> = {
  midnight: { label: 'Midnight', top: 'rgb(15 23 42)', bottom: 'rgb(76 29 149)' },
  sunset: { label: 'Sunset', top: 'rgb(157 23 77)', bottom: 'rgb(234 88 12)' },
  ocean: { label: 'Ocean', top: 'rgb(8 47 73)', bottom: 'rgb(13 148 136)' },
  forest: { label: 'Forest', top: 'rgb(6 44 34)', bottom: 'rgb(63 98 18)' },
  paper: { label: 'Paper', top: 'rgb(250 246 238)', bottom: 'rgb(232 220 196)', light: true },
  cover: { label: 'Book cover', top: 'rgb(40 40 46)', bottom: 'rgb(12 12 16)' },
  aurora: { label: 'Aurora', top: 'rgb(2 6 23)', bottom: 'rgb(4 30 34)', animated: true },
  liquid: { label: 'Liquid', top: 'rgb(91 33 182)', bottom: 'rgb(219 39 119)', animated: true },
  galaxy: { label: 'Galaxy', top: 'rgb(3 4 16)', bottom: 'rgb(46 16 101)', animated: true },
  synthwave: { label: 'Synthwave', top: 'rgb(16 5 38)', bottom: 'rgb(150 30 110)', animated: true },
  waves: { label: 'Waves', top: 'rgb(14 16 56)', bottom: 'rgb(252 160 92)', animated: true },
  rays: { label: 'Rays', top: 'rgb(22 20 64)', bottom: 'rgb(70 58 196)', animated: true },
};

export const SHORT_MOTIONS: { value: ShortMotion; label: string; hint: string }[] = [
  { value: 'none', label: 'None', hint: 'Just the background' },
  { value: 'bokeh', label: 'Bokeh', hint: 'Soft orbs of light floating up' },
  { value: 'sparkles', label: 'Sparkles', hint: 'Twinkling stars in your highlight colour' },
  { value: 'embers', label: 'Embers', hint: 'Glowing sparks rising' },
  { value: 'snow', label: 'Snow', hint: 'Flakes drifting down' },
  { value: 'rain', label: 'Rain', hint: 'Slanted streaks, moody' },
];

/** How the narrator sounds and paces itself (applied when the audio is mastered; captions stay in sync). */
export const SHORT_VOICE_FX: { value: ShortVoiceFx; label: string; hint: string }[] = [
  { value: 'natural', label: 'Natural', hint: 'The voice just as it is' },
  { value: 'deep', label: 'Warm storyteller', hint: 'A little deeper and warmer, unhurried — for stories and calm lessons' },
  { value: 'powerful', label: 'Motivational speaker', hint: 'Deep, close and confident, with pauses that let each line land' },
];

/** The motivational speaker preset: Coach (deep and expressive, English), unhurried, in that style. */
export const DEEP_VOICE = { engine: 'kokoro', voice: 'am_coach', speed: 0.95, fx: 'powerful' } as const;

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

export const SHORT_ACCENTS = [
  { value: '#FACC15', label: 'Yellow' },
  { value: '#A3E635', label: 'Lime' },
  { value: '#22D3EE', label: 'Cyan' },
  { value: '#F472B6', label: 'Pink' },
  { value: '#FB923C', label: 'Orange' },
  { value: '#FFFFFF', label: 'White' },
];

/** The tags field: "Tagore, the postmaster, audiobook" ⇄ ["Tagore", "the postmaster", "audiobook"] (cleaned, ≤ 500 characters). */
export const parseTags = (raw: string) => fitTags(raw.split(/[,\n]+/));
export const formatTags = (tags: string[]) => tags.join(', ');
