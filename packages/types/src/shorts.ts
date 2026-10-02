import type { OutputFile } from './api';
import type { LanguageCode, TTSSettings } from './settings';
import type { JobStatus, UserFacingError } from './status';

/**
 * YouTube Shorts: a short script (pasted, or written by the local AI from a topic or one of the
 * user's books) narrated by a local voice and rendered as a vertical 1080×1920 video with big
 * word-by-word captions.
 */

/** Background: a gradient, or the book's cover (blurred behind a sharp cover card). */
export type ShortTheme = 'midnight' | 'sunset' | 'ocean' | 'forest' | 'paper' | 'cover';

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
  /** `center` sits mid-screen; `lower` sits above YouTube's title and buttons. */
  position: 'center' | 'lower';
  /** English captions in capitals (the usual Shorts look). Ignored for Bangla. */
  uppercase: boolean;
  /** The short's title at the top of the frame. */
  showTitle: boolean;
  /** A thin progress bar along the top edge. */
  showProgress: boolean;
}

export interface ShortSettings {
  language: LanguageCode;
  tts: TTSSettings;
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
}

export interface ShortDetail extends ShortSummary {
  script: string;
  /** YouTube description (editable; the AI writes one with the script). */
  description: string;
  hashtags: string[];
  settings: ShortSettings;
  /** What the worker is doing now, or why it failed. */
  message?: string;
  error?: UserFacingError;
  outputs: OutputFile[];
  /** The script or settings changed since the video was rendered. */
  stale: boolean;
}

/** How the local AI should write the script. */
export type ShortScriptStyle = 'hook' | 'summary' | 'story';

export interface ShortScriptRequest {
  source: { kind: 'topic'; topic: string } | { kind: 'book'; projectId: string };
  language: LanguageCode;
  /** Target narration length. */
  seconds: number;
  style: ShortScriptStyle;
}

export interface ShortScriptResult {
  title: string;
  script: string;
  description: string;
  hashtags: string[];
  model: string;
}
