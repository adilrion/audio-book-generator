import { z } from 'zod';
import { SHORT_SCRIPT_MAX_CHARS } from '@app/types';

/** Any text field: bounded, and without NUL characters. */
const text = (max: number) => z.string().max(max).transform((s) => s.replace(/\u0000/g, ''));

export const lookSchema = z
  .object({
    theme: z.enum(['midnight', 'sunset', 'ocean', 'forest', 'paper', 'cover']),
    captions: z.enum(['karaoke', 'box', 'word', 'plain']),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i),
    position: z.enum(['center', 'lower']),
    uppercase: z.boolean(),
    showTitle: z.boolean(),
    showProgress: z.boolean(),
    thumbnailIntro: z.boolean(),
  })
  .partial();

export const thumbnailSchema = z.object({
  layout: z.enum(['headline', 'cover', 'quote']),
  headline: text(120),
  kicker: text(40),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i),
});

export const shortSettingsSchema = z
  .object({
    language: z.enum(['en', 'bn']),
    tts: z.object({ engine: z.enum(['kokoro', 'piper', 'say']), voice: z.string().min(1).max(200), speed: z.number().min(0.5).max(2) }).partial(),
    look: lookSchema,
  })
  .partial();

export const shortInputSchema = z.object({
  title: text(200),
  script: text(SHORT_SCRIPT_MAX_CHARS),
  description: text(5000).optional(),
  hashtags: z.array(text(60)).max(30).optional(),
  /** YouTube tags; empty or left out: suggested from the title, book and hashtags. */
  tags: z.array(text(100)).max(60).optional(),
  /** The thumbnail design (null removes it); the JPEG itself is PUT to /shorts/:id/thumbnail. */
  thumbnail: thumbnailSchema.nullable().optional(),
  settings: shortSettingsSchema.optional(),
  /** The book the script was written from (its cover can be the background). */
  projectId: z.string().uuid().nullable().optional(),
  /** Start rendering right away. */
  render: z.boolean().optional(),
});

export const shortUpdateSchema = shortInputSchema.partial();

export const scriptRequestSchema = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('topic'), topic: text(500).refine((t) => t.trim().length >= 3, 'is too short') }),
    z.object({ kind: z.literal('book'), projectId: z.string().uuid() }),
  ]),
  language: z.enum(['en', 'bn']),
  seconds: z.number().int().min(15).max(180),
  style: z.enum(['hook', 'summary', 'story']),
});

export const metadataSchema = z.object({
  title: text(200),
  script: text(SHORT_SCRIPT_MAX_CHARS).refine((s) => s.trim().length > 0, 'is empty'),
  language: z.enum(['en', 'bn']),
  projectId: z.string().uuid().optional(),
});

export const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');
