import { z } from 'zod';

/** Partial settings accepted from the UI; merged over defaults by resolveSettings(). */
export const settingsSchema = z
  .object({
    outputMode: z.enum(['audiobook_video', 'audiobook_only']),
    language: z.enum(['en', 'bn']),
    tts: z.object({ engine: z.enum(['kokoro', 'piper', 'say']), voice: z.string().min(1).max(80), speed: z.number().min(0.5).max(2) }).partial(),
    text: z
      .object({
        useLlm: z.boolean(),
        ocr: z.enum(['auto', 'off', 'force']),
        skipFrontMatter: z.boolean(),
        chapterRange: z.object({ from: z.number().int().min(1), to: z.number().int().min(1) }).nullable(),
      })
      .partial(),
    audio: z
      .object({
        sentencePauseMs: z.number().int().min(0).max(3000),
        paragraphPauseMs: z.number().int().min(0).max(5000),
        chapterPauseMs: z.number().int().min(0).max(10000),
        normalize: z.boolean(),
      })
      .partial(),
    video: z
      .object({
        aspectRatio: z.enum(['16:9', '9:16', '1:1']),
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(320).max(3840),
        fps: z.number().int().min(10).max(60),
        animation: z.enum(['follow', 'kenburns', 'static']),
        subtleZoom: z.boolean(),
        highlightMode: z.enum(['sentence', 'paragraph']),
        highlightStyle: z.enum(['marker', 'underline', 'box']),
        highlightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        theme: z.enum(['paper', 'light', 'dark']),
        showProgress: z.boolean(),
        showChapterTitle: z.boolean(),
        embedSubtitles: z.boolean(),
      })
      .partial(),
  })
  .partial();

export type SettingsInput = z.infer<typeof settingsSchema>;
