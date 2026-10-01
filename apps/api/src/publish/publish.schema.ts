import { z } from 'zod';
import { SOCIAL_PLATFORMS } from '@app/types';

/** Any text field: bounded, and without NUL characters (they cannot be passed to ffmpeg). */
const text = (max: number) => z.string().max(max).transform((s) => s.replace(/\u0000/g, ''));
const language = z.enum(['en', 'bn']);
const origin = z.enum(['template', 'ai']);

const social = z.object({ text: text(10_000), hashtags: z.array(text(100)).max(60) });

const aiOptions = z.object({
  language,
  tone: z.enum(['friendly', 'literary', 'energetic', 'academic']),
  keywords: text(500),
});

/** Limits are generous on purpose: YouTube's own limits are shown as warnings in the editor, not enforced here. */
export const publishDraftSchema = z.object({
  version: z.literal(1),
  youtube: z.object({
    title: text(300),
    titleOptions: z.array(text(300)).max(12),
    description: text(20_000),
    includeChapters: z.boolean(),
    tags: z.array(text(200)).max(100),
    hashtags: z.array(text(100)).max(100),
    primaryKeyword: text(200),
    categoryId: z.string().regex(/^\d{1,3}$/),
    language,
    visibility: z.enum(['public', 'unlisted', 'private']),
    madeForKids: z.boolean(),
    license: z.enum(['youtube', 'creativeCommon']),
    aiNarrationNote: z.boolean(),
    pinnedComment: text(10_000),
    thumbnailText: text(200),
  }),
  social: z.object(Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p, social])) as Record<(typeof SOCIAL_PLATFORMS)[number], typeof social>),
  file: z.object({
    title: text(500),
    artist: text(500),
    album: text(500),
    genre: text(200),
    year: text(20),
    copyright: text(500),
    comment: text(2000),
    embedCover: z.boolean(),
  }),
  thumbnail: z
    .object({
      layout: z.enum(['cover', 'bold', 'minimal', 'photo', 'quote', 'player', 'split', 'cinematic', 'ribbon']),
      kicker: text(80),
      accent: z.string().regex(/^#[0-9a-f]{6}$/i),
      showAuthor: z.boolean(),
      showBadge: z.boolean(),
    })
    .optional(),
  videoUrl: z.union([z.literal(''), z.string().max(500).url().refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) link')]),
  ai: aiOptions,
  origin: z.object({ youtube: origin, social: origin }),
  model: text(200).optional(),
  generatedAt: z.string().max(40).optional(),
  updatedAt: z.string().max(40).optional(),
});

export const generateSchema = z.object({
  sections: z.array(z.enum(['youtube', 'social'])).min(1).max(2),
  draft: publishDraftSchema.optional(),
  options: aiOptions.partial().optional(),
});

export const saveSchema = z.object({ draft: publishDraftSchema, label: z.string().max(80).optional() });

export function issues(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.')} ${i.message}`)
    .join('; ');
}
