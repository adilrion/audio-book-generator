export interface SentenceTiming {
  id: string;
  /** seconds, relative to chapter start */
  start: number;
  end: number;
  /** optional estimated word timings (seconds, relative to chapter start) */
  words?: { t: string; start: number; end: number }[];
}

export interface ChapterAudio {
  chapterIndex: number;
  /** absolute path of the chapter audio file (FLAC) */
  file: string;
  sampleRate: number;
  samples: number;
  durationSec: number;
  timings: SentenceTiming[];
  cacheKey: string;
  engine: string;
  voice: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
  engine: string;
  language: string;
  gender?: 'female' | 'male' | 'neutral';
  installed: boolean;
}
