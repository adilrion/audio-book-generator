import { z } from 'zod';
import { SHORT_BATCH_MAX, SHORT_SCRIPT_MAX_CHARS } from '@app/types';

/** Any text field: bounded, and without NUL characters. */
const text = (max: number) => z.string().max(max).transform((s) => s.replace(/\u0000/g, ''));

const theme = z.enum(['midnight', 'sunset', 'ocean', 'forest', 'paper', 'cover', 'aurora', 'liquid', 'galaxy', 'synthwave', 'waves', 'rays']);
const motion = z.enum(['none', 'bokeh', 'snow', 'rain', 'embers', 'sparkles']);

export const lookSchema = z
  .object({
    theme,
    captions: z.enum(['karaoke', 'box', 'word', 'plain']),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i),
    motion,
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
    voiceFx: z.enum(['natural', 'deep', 'powerful']),
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

/** POST /shorts/delete */
export const deleteSchema = z.object({ ids: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/i)).min(1, 'is empty').max(200) });

/** POST /shorts/batch: several shorts with one voice and look (each may change its background). */
export const batchSchema = z.object({
  items: z
    .array(
      z.object({
        title: text(200),
        script: text(SHORT_SCRIPT_MAX_CHARS),
        description: text(5000).optional(),
        hashtags: z.array(text(60)).max(30).optional(),
        tags: z.array(text(100)).max(60).optional(),
        look: z.object({ theme, motion }).partial().optional(),
      }),
    )
    .min(1, 'has no shorts')
    .max(SHORT_BATCH_MAX, `has more than ${SHORT_BATCH_MAX} shorts`),
  settings: shortSettingsSchema.optional(),
  projectId: z.string().uuid().nullable().optional(),
  render: z.boolean().optional(),
});

export const scriptRequestSchema = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('topic'), topic: text(500).refine((t) => t.trim().length >= 3, 'is too short') }),
    z.object({ kind: z.literal('book'), projectId: z.string().uuid() }),
  ]),
  language: z.enum(['en', 'bn']),
  seconds: z.number().int().min(15).max(180),
  style: z.enum(['hook', 'summary', 'story']),
  /** In a batch: this short's angle, the titles already written, and which part of the book to read. */
  angle: text(200).optional(),
  avoid: z.array(text(200)).max(SHORT_BATCH_MAX).optional(),
  part: z
    .object({ index: z.number().int().min(0), of: z.number().int().min(1).max(SHORT_BATCH_MAX) })
    .refine((p) => p.index < p.of, 'index must be below of')
    .optional(),
});

export const metadataSchema = z.object({
  title: text(200),
  script: text(SHORT_SCRIPT_MAX_CHARS).refine((s) => s.trim().length > 0, 'is empty'),
  language: z.enum(['en', 'bn']),
  projectId: z.string().uuid().optional(),
});

export const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');
