import type { OutputFile } from './api';
import { displayAuthor } from './library';
import { fitTags } from './publish';
import type { LanguageCode, TTSSettings } from './settings';
import type { JobStatus, UserFacingError } from './status';

/**
 * YouTube Shorts: a short script (pasted, or written by the local AI from a topic or one of the
 * user's books) narrated by a local voice and rendered as a vertical 1080×1920 video with big
 * word-by-word captions.
 */

/**
 * Background: a still gradient, the book's cover (blurred behind a sharp cover card), or an
 * animated scene drawn by the renderer (workers/processing/audiobook_worker/shorts/scenes.py).
 */
export type ShortTheme =
  | 'midnight'
  | 'sunset'
  | 'ocean'
  | 'forest'
  | 'paper'
  | 'cover'
  | 'aurora'
  | 'liquid'
  | 'galaxy'
  | 'synthwave'
  | 'waves'
  | 'rays';

/**
 * The narrator's tone, applied to the voice when the audio is mastered: `deep` lowers it about two
 * semitones; `powerful` lowers it further, with a strong low end, compression and a short echo — the
 * "deep motivation" sound. The length does not change, so captions stay in sync.
 */
export type ShortVoiceFx = 'natural' | 'deep' | 'powerful';

/** Particles drawn over any background (the cover too), under the title and captions. */
export type ShortMotion = 'none' | 'bokeh' | 'snow' | 'rain' | 'embers' | 'sparkles';

/**
 * `karaoke`: a few words at a time, the spoken one in the accent colour. `box`: the spoken word on
 * an accent-coloured pill. `word`: one big word at a time. `plain`: a few words, no highlight.
 */
export type ShortCaptionStyle = 'karaoke' | 'box' | 'word' | 'plain';

export interface ShortLook {
  theme: ShortTheme;
  captions: ShortCaptionStyle;
  /** #RRGGBB */
  accent: string;
  /** Particles over the background (left out: none, so older shorts keep their render key). */
  motion?: ShortMotion;
  /** `center` sits mid-screen; `lower` sits above YouTube's title and buttons. */
  position: 'center' | 'lower';
  /** English captions in capitals (the usual Shorts look). Ignored for Bangla. */
  uppercase: boolean;
  /** The short's title at the top of the frame. */
  showTitle: boolean;
  /** A thin progress bar along the top edge. */
  showProgress: boolean;
  /**
   * Open the video with the thumbnail for a quarter of a second, so it can be picked as the cover
   * frame in the YouTube app. Needs a saved thumbnail.
   */
  thumbnailIntro?: boolean;
}

/**
 * `headline`: a huge hook on the short's background. `cover`: the book cover with the hook under it.
 * `quote`: the script's first line in quotes.
 */
export type ShortThumbLayout = 'headline' | 'cover' | 'quote';

/** How the vertical thumbnail (1080×1920) is drawn; it is rendered in the browser and saved as thumbnail.jpg. */
export interface ShortThumbnail {
  layout: ShortThumbLayout;
  /** The big text. Words in *asterisks* are drawn in the accent colour. Empty: the title. */
  headline: string;
  /** Small pill above the headline, e.g. "60-second audiobook". */
  kicker: string;
  accent: string;
}

export const SHORT_THUMB_SIZE = { width: 1080, height: 1920 } as const;

export interface ShortSettings {
  language: LanguageCode;
  tts: TTSSettings;
  /** Left out: natural (so older shorts keep their render key). */
  voiceFx?: ShortVoiceFx;
  look: ShortLook;
}

export const SHORT_SIZE = { width: 1080, height: 1920 } as const;
export const SHORT_FPS = 30;
/** YouTube accepts Shorts up to 3 minutes. */
export const SHORT_MAX_SEC = 180;
/** What usually performs best. */
export const SHORT_IDEAL_SEC = 60;
export const SHORT_SCRIPT_MAX_CHARS = 4000;

export const DEFAULT_SHORT_LOOK: ShortLook = {
  theme: 'midnight',
  captions: 'karaoke',
  accent: '#FACC15',
  position: 'center',
  uppercase: true,
  showTitle: true,
  showProgress: true,
};

/** Narration words per minute at speed 1.0 (measured with Kokoro / Piper; Bangla words are longer). */
const WPM: Record<LanguageCode, number> = { en: 165, bn: 115 };

/** Estimated narration length of a script, in seconds. */
export function estimateShortSec(script: string, language: LanguageCode, speed = 1): number {
  const words = script.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return words === 0 ? 0 : Math.round((words / (WPM[language] * Math.max(0.5, speed))) * 60);
}

export interface ShortSummary {
  id: string;
  title: string;
  status: JobStatus;
  /** Waiting in the queue for the worker (status PENDING). */
  queued: boolean;
  progress: number;
  durationSec?: number;
  language: LanguageCode;
  theme: ShortTheme;
  /** The book the short was written from. */
  projectId?: string;
  bookTitle?: string;
  createdAt: string;
  updatedAt: string;
  /** Changes whenever a new video is rendered (cache-busting for the player). */
  version?: string;
  /** Set when a thumbnail is saved; changes with every save. */
  thumbnailVersion?: string;
}

export interface ShortDetail extends ShortSummary {
  script: string;
  /** YouTube description (editable; the AI writes one with the script). */
  description: string;
  hashtags: string[];
  /** YouTube tags (the Studio "Tags" field), within YouTube's 500-character budget. */
  tags: string[];
  /** The saved thumbnail design (the image itself is thumbnail.jpg). */
  thumbnail?: ShortThumbnail;
  /** The book's author, when the short was made from a book. */
  bookAuthor?: string;
  settings: ShortSettings;
  /** What the worker is doing now, or why it failed. */
  message?: string;
  error?: UserFacingError;
  outputs: OutputFile[];
  /** The script or settings changed since the video was rendered. */
  stale: boolean;
}

/** POST /shorts/delete: what was removed (with all its files), and what was kept. */
export interface ShortsDeleteResult {
  deleted: string[];
  /** Shorts that were still rendering and did not stop in time. */
  skipped: { id: string; title: string; reason: string }[];
  /** Disk space given back: videos, thumbnails and cached narration. */
  freedBytes: number;
}

/** How the local AI should write the script. */
export type ShortScriptStyle = 'hook' | 'summary' | 'story';

export interface ShortScriptRequest {
  source: { kind: 'topic'; topic: string } | { kind: 'book'; projectId: string };
  language: LanguageCode;
  /** Target narration length. */
  seconds: number;
  style: ShortScriptStyle;
  /** In a batch: what this short focuses on (SHORT_BATCH_ANGLES). */
  angle?: string;
  /** In a batch: titles already written, so this one says something new. */
  avoid?: string[];
  /** In a batch from a book: read part `index` of `of` equal parts of the book, not its opening. */
  part?: { index: number; of: number };
}

export interface ShortScriptResult {
  title: string;
  script: string;
  description: string;
  hashtags: string[];
  tags: string[];
  model: string;
}

/** POST /shorts/metadata: YouTube text for a script the user wrote. */
export interface ShortMetadataRequest {
  title: string;
  script: string;
  language: LanguageCode;
  projectId?: string;
}

export interface ShortMetadataResult {
  description: string;
  hashtags: string[];
  tags: string[];
  model: string;
}

/** "TheAlchemist" → "The Alchemist"; "followyourheart" stays as it is. */
const unCamel = (s: string) => s.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2');

/**
 * YouTube tags without the AI: the book, its author and the audiobook/Shorts phrases people search,
 * plus the hashtags as words. Earlier tags count most, so the most specific ones come first; the
 * list fits YouTube's 500-character budget.
 */
export function suggestShortTags(o: { title: string; hashtags?: string[]; bookTitle?: string; author?: string; language: LanguageCode }): string[] {
  const book = o.bookTitle?.split(/\s+:\s+/)[0].trim();
  const author = displayAuthor(o.author);
  const bn = o.language === 'bn';
  const tags: (string | false | undefined)[] = [
    book,
    book && author && `${book} ${author}`,
    author,
    book && (bn ? `${book} অডিওবুক` : `${book} audiobook`),
    book && !bn && `${book} summary`,
    author && !bn && `${author} books`,
    [...o.title].length <= 60 ? o.title.replace(/[*#]/g, '').trim() : undefined,
    // Hashtags make tags only when they read as words: "TheAlchemist" → "The Alchemist", Bangla as is (not "paulocoelho").
    ...(o.hashtags ?? []).filter((h) => !/^shorts$/i.test(h) && (/\p{Lu}/u.test(h) || /[^\p{Script=Latin}\p{N}_]/u.test(h))).map(unCamel),
    ...(bn ? ['বাংলা অডিওবুক', 'bangla audiobook', 'বাংলা গল্প', 'bangla golpo'] : book ? ['audiobook', 'book summary', 'booktok', 'books'] : []),
    'shorts',
    'youtube shorts',
  ];
  return fitTags(tags.filter((t): t is string => !!t)).slice(0, SHORT_MAX_TAGS);
}

/** YouTube suggests a handful of tags; past ~15 they add nothing. */
export const SHORT_MAX_TAGS = 15;
