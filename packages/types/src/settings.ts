export type OutputMode = 'audiobook_video' | 'audiobook_only';
export type AspectRatio = '16:9' | '9:16' | '1:1';
export type AnimationStyle = 'follow' | 'kenburns' | 'static';
export type HighlightMode = 'sentence' | 'paragraph';
export type HighlightStyle = 'marker' | 'underline' | 'box';
export type VideoTheme = 'paper' | 'light' | 'dark';
export type LanguageCode = 'en' | 'bn';
export type TTSEngineName = 'kokoro' | 'piper' | 'say';
export type OcrMode = 'auto' | 'off' | 'force';

export interface TTSSettings {
  engine: TTSEngineName;
  voice: string;
  /** 0.5 .. 2.0 */
  speed: number;
}

export interface TextSettings {
  /** Use local LLM (Ollama) for ambiguous chapters / broken text. Deterministic rules always run first. */
  useLlm: boolean;
  /** Only narrate chapters in this 1-based inclusive range (handy for testing). */
  chapterRange?: { from: number; to: number };
  /** OCR fallback for scanned pages. */
  ocr: OcrMode;
  /** Drop content before the first detected chapter (copyright page, TOC...). */
  skipFrontMatter: boolean;
}

export interface AudioSettings {
  sentencePauseMs: number;
  paragraphPauseMs: number;
  chapterPauseMs: number;
  /** EBU R128 loudness normalization to -16 LUFS (YouTube friendly). */
  normalize: boolean;
}

export interface VideoSettings {
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  fps: number;
  animation: AnimationStyle;
  subtleZoom: boolean;
  highlightMode: HighlightMode;
  highlightStyle: HighlightStyle;
  /** Hex color, e.g. #FFD54F */
  highlightColor: string;
  theme: VideoTheme;
  showProgress: boolean;
  showChapterTitle: boolean;
  /** Add a soft (toggleable) subtitle track to the MP4. */
  embedSubtitles: boolean;
}

export interface ProjectSettings {
  outputMode: OutputMode;
  language: LanguageCode;
  tts: TTSSettings;
  text: TextSettings;
  audio: AudioSettings;
  video: VideoSettings;
}

export const ASPECT_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

export const DEFAULT_SETTINGS: ProjectSettings = {
  outputMode: 'audiobook_video',
  language: 'en',
  tts: { engine: 'kokoro', voice: 'af_heart', speed: 1.0 },
  text: { useLlm: true, ocr: 'auto', skipFrontMatter: false },
  audio: { sentencePauseMs: 280, paragraphPauseMs: 650, chapterPauseMs: 1800, normalize: true },
  video: {
    aspectRatio: '16:9',
    width: 1920,
    height: 1080,
    fps: 30,
    animation: 'follow',
    subtleZoom: true,
    highlightMode: 'sentence',
    highlightStyle: 'marker',
    highlightColor: '#FFD54F',
    theme: 'paper',
    showProgress: true,
    showChapterTitle: true,
    embedSubtitles: true,
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Merge user-provided partial settings over defaults. */
export function resolveSettings(partial?: DeepPartial<ProjectSettings>, base: ProjectSettings = DEFAULT_SETTINGS): ProjectSettings {
  const p = partial ?? {};
  const video = { ...base.video, ...(p.video ?? {}) } as VideoSettings;
  if (p.video?.aspectRatio && (p.video.width === undefined || p.video.height === undefined)) {
    Object.assign(video, ASPECT_SIZES[video.aspectRatio]);
  }
  return {
    outputMode: (p.outputMode ?? base.outputMode) as OutputMode,
    language: (p.language ?? base.language) as LanguageCode,
    tts: { ...base.tts, ...(p.tts ?? {}) } as TTSSettings,
    text: { ...base.text, ...(p.text ?? {}) } as TextSettings,
    audio: { ...base.audio, ...(p.audio ?? {}) } as AudioSettings,
    video,
  };
}
