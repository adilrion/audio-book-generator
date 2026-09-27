export type OutputMode = 'audiobook_video' | 'audiobook_only';
export type AspectRatio = '16:9' | '9:16' | '1:1';
export type AnimationStyle = 'follow' | 'kenburns' | 'static';
/**
 * What the highlight follows: the whole sentence or paragraph being read, the word being spoken
 * (the box glides from word to word), or a reading cursor that sweeps through the sentence.
 */
export type HighlightMode = 'sentence' | 'paragraph' | 'word' | 'cursor';
export type HighlightStyle = 'marker' | 'underline' | 'box';
export type VideoTheme = 'paper' | 'light' | 'dark';
/**
 * How large the page is drawn: `auto` keeps a margin around the page (the camera style decides
 * the zoom), `width` makes the page span the whole frame width, `text` crops the page's own
 * margins so the printed text spans the frame width.
 */
export type PageFit = 'auto' | 'width' | 'text';
/** Border drawn around the video picture. The picture is inset so the border never covers text. */
export type FrameStyle = 'none' | 'solid' | 'double' | 'dashed';
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
  /** Leave out trailing back matter: licence text, index, "about the author", "also by"... */
  skipBackMatter: boolean;
  /** Pause after chapter detection so the chapter list can be reviewed before narration. */
  reviewChapters: boolean;
  /** The reviewed chapter list. Only applies to the analysis it was made for. */
  chapterEdits?: ChapterEdits;
}

export interface ChapterEdit {
  /** 0-based chapter index from the analysis */
  index: number;
  title?: string;
  exclude?: boolean;
  /** Append this chapter's text to the previous kept chapter. */
  mergeWithPrevious?: boolean;
}

export interface ChapterEdits {
  analysisKey: string;
  /** Fingerprint of the reviewed chapter list (index, title, pages). The review still applies when
   *  the analysis key changes but the chapters are the same (e.g. Ollama became unavailable). */
  chaptersSignature?: string;
  items: ChapterEdit[];
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
  /** Word and cursor highlighting: also tint the whole sentence faintly, so the eye keeps its place. */
  sentenceTint: boolean;
  theme: VideoTheme;
  pageFit: PageFit;
  frameStyle: FrameStyle;
  /** Hex color of the frame border, e.g. #1F2937 */
  frameColor: string;
  /** Border thickness in pixels at 1080p (scaled with the video size). */
  frameWidth: number;
  /** Corner radius of the picture inside the border, in pixels at 1080p. 0 = square corners. */
  frameRadius: number;
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
  text: { useLlm: true, ocr: 'auto', skipFrontMatter: false, skipBackMatter: true, reviewChapters: false },
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
    sentenceTint: true,
    theme: 'paper',
    pageFit: 'auto',
    frameStyle: 'none',
    frameColor: '#1F2937',
    frameWidth: 24,
    frameRadius: 0,
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
