import {
  type PublishAiOptions,
  type PublishContext,
  type PublishDraft,
  type PublishTone,
  type SocialDraft,
  type SocialPlatform,
  type YouTubeDraft,
  SOCIAL_PLATFORMS,
  SOCIAL_RULES,
  YOUTUBE_CATEGORIES,
  YOUTUBE_LIMITS,
  fitHashtags,
  fitTags,
  sanitizeTag,
  socialLength,
} from '@app/types';
import type { LLMProvider } from '../llm/provider';
import { camelTag, templateDraft } from './template';

/**
 * AI-written publishing metadata (local Ollama). Unlike the book-processing tasks this is creative
 * writing, so it samples with some temperature — but the answer is still structured JSON, every
 * field is cleaned and length-checked, and the rule-based template fills anything missing or unusable.
 * Timestamps, links and chapter lists are never left to the model: they come from the timeline.
 */

export interface PublishSource {
  ctx: PublishContext;
  /** The book's opening text (a few thousand characters at most). */
  excerpt: string;
}

const SYSTEM =
  'You are an expert YouTube SEO and social-media copywriter for audiobook videos. You write accurate, engaging, ' +
  'non-clickbait metadata. Never invent plot details, quotes, awards, sales figures or facts that are not in the provided ' +
  'information or widely known about this exact book; when unsure, stay general. Never include URLs, timestamps or angle ' +
  'brackets. Always answer with JSON matching the schema.';

const TONES: Record<PublishTone, string> = {
  friendly: 'warm, friendly and inviting',
  literary: 'elegant and literary, like a good book review',
  energetic: 'upbeat and energetic',
  academic: 'clear and informative, suited to students and teachers',
};

function duration(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function facts(src: PublishSource, opts: PublishAiOptions): string {
  const c = src.ctx;
  const chapters = c.chapters.slice(0, 40).map((ch) => ch.title).join('; ');
  const extra = opts.keywords
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 10);
  return [
    `VIDEO: a complete audiobook of the book below, narrated by a text-to-speech voice, with every sentence highlighted on the printed page as it is read (a "read-along" video). Runtime: ${duration(c.durationSec)}.`,
    `BOOK TITLE: ${c.title}`,
    c.author ? `AUTHOR: ${c.author}` : 'AUTHOR: unknown',
    `BOOK LANGUAGE: ${c.language === 'bn' ? 'Bangla (Bengali)' : 'English'}`,
    `LENGTH: ${c.pageCount} pages, about ${c.wordCount} words`,
    chapters ? `CHAPTERS (${c.chapters.length}): ${chapters}` : '',
    extra.length ? `SEARCH PHRASES TO WORK IN: ${extra.join(', ')}` : '',
    `TONE OF YOUR WRITING: ${TONES[opts.tone] ?? TONES.friendly}`,
    src.excerpt.trim() ? `OPENING OF THE BOOK (excerpt):\n"""\n${src.excerpt.trim()}\n"""` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const languageRule = (lang: PublishAiOptions['language']) =>
  lang === 'bn'
    ? 'Write every text field in Bangla (Bengali script). Tags may mix Bangla and English search phrases. Hashtags may be Bangla or English.'
    : 'Write everything in English.';

// ─────────────────────────────── cleaning ───────────────────────────────

/** Strip what YouTube rejects or what the model must not write (links, timestamps, hashtags, brackets). */
export function cleanText(raw: unknown, maxChars: number): string {
  if (typeof raw !== 'string') return '';
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/[<>]/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\d{1,2}:)?\d{1,2}:\d{2}\b/.test(l)) // timestamp lines
    .filter((l) => !/^\s*(#[\p{L}\p{M}\p{N}_]+\s*)+$/u.test(l)) // lines of hashtags only
    .map((l) => l.replace(/[ \t]+/g, ' ').trim());
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return clip(text, maxChars);
}

/** Cut at a word boundary with an ellipsis when longer than `max` characters. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function cleanTitle(raw: unknown): string {
  const t = cleanText(raw, 200)
    .replace(/\n+/g, ' ')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...t].length > YOUTUBE_LIMITS.title ? clip(t, YOUTUBE_LIMITS.title) : t;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Hashtags written into a post's text are moved to its hashtag list. */
function splitHashtags(text: string): { text: string; tags: string[] } {
  const tags = [...text.matchAll(/#([\p{L}\p{M}\p{N}_]+)/gu)].map((m) => m[1]);
  return { text: text.replace(/(^|\s)#[\p{L}\p{M}\p{N}_]+/gu, '$1').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim(), tags };
}

/** A wall of text becomes paragraphs of about three sentences (the model sometimes ignores "paragraphs"). */
export function paragraphize(text: string): string {
  if (text.includes('\n') || text.split(/\s+/).length < 90) return text;
  const sentences = text.match(/[^.!?।]+[.!?।]+["'’”)]*\s*|[^.!?।]+$/gu) ?? [text];
  const paras: string[] = [];
  for (let i = 0; i < sentences.length; i += 3) paras.push(sentences.slice(i, i + 3).join('').trim());
  return paras.filter(Boolean).join('\n\n');
}

/** Restore the casing of known hashtags the model wrote in lower case ("themetamorphosis" → "TheMetamorphosis"). */
function recase(tags: string[], known: string[]): string[] {
  const map = new Map(known.map((k) => [k.toLocaleLowerCase(), k]));
  return tags.map((t) => map.get(t.toLocaleLowerCase()) ?? t);
}

function knownHashtags(ctx: PublishContext): string[] {
  const words = [ctx.title, ctx.author ?? '', ...ctx.title.split(/\s+/), ...(ctx.author ?? '').split(/\s+/)].filter(Boolean);
  return [...words.map(camelTag), 'Audiobook', 'Audiobooks', 'ReadAlong', 'FullAudiobook', 'BookTok', 'Bookstagram', 'BookLovers', 'Books', 'Reading', 'Literature', 'ClassicLiterature', 'Classics', 'BookClub', 'Learning', 'BanglaAudiobook'];
}

/** Calls to action that only make sense on some platforms. */
function dropForeignCta(platform: SocialPlatform, text: string): string {
  if (platform === 'instagram' || platform === 'tiktok') return text;
  return text.replace(/\s*\(?\blink in (?:the )?bio\b\)?[.!]*/gi, '').trim();
}

/** "…no skipping! BookTok" — a trailing hashtag word written as text. */
function dropTrailingTag(text: string, tags: string[]): string {
  const m = /\s+([\p{L}\p{M}\p{N}_]+)[.!]?$/u.exec(text);
  return m && tags.some((t) => t.toLocaleLowerCase() === m[1].toLocaleLowerCase()) ? text.slice(0, m.index).trim() : text;
}

const CATEGORY_BY_LABEL = new Map(YOUTUBE_CATEGORIES.map((c) => [c.label.toLowerCase(), c.id]));

// ─────────────────────────────── YouTube ───────────────────────────────

interface YouTubeAnswer {
  titles: string[];
  description: string;
  primary_keyword: string;
  tags: string[];
  hashtags: string[];
  category: string;
  thumbnail_text: string;
  pinned_comment: string;
}

export async function generateYouTube(provider: LLMProvider, src: PublishSource, opts: PublishAiOptions, base: YouTubeDraft, signal?: AbortSignal): Promise<YouTubeDraft> {
  const word = opts.language === 'bn' ? 'অডিওবুক' : 'Audiobook';
  const prompt =
    `Write YouTube metadata for this video.\n\n${facts(src, opts)}\n\n${languageRule(opts.language)}\n` +
    'Rules:\n' +
    `- titles: 3 different YouTube titles, each 45–70 characters. Put the book title near the start, include the author's name if known and the word "${word}". No clickbait, no ALL CAPS, no emojis.\n` +
    `- description: 150–250 words in 2–4 short paragraphs separated by a blank line. The first sentence must contain the book title, the author and the word "${word.toLowerCase()}" (it is the part shown in search results). Then say what the book is about without spoilers beyond the opening, who will enjoy it, and that the text is highlighted on the page so viewers can read along. Do NOT list chapters, timestamps, hashtags or links.\n` +
    `- primary_keyword: the main search phrase, usually "<book title> ${word.toLowerCase()}".\n` +
    '- tags: 15–25 search phrases people would type: the title, the author, "<title> audiobook", genre, themes, "full audiobook", "audiobook with text", "read along". No "#".\n' +
    '- hashtags: 3–5 hashtags without "#" and without spaces (CamelCase).\n' +
    `- category: one of ${YOUTUBE_CATEGORIES.map((c) => `"${c.label}"`).join(', ')}.\n` +
    '- thumbnail_text: 2–5 strong words for the thumbnail, usually the book title.\n' +
    '- pinned_comment: one or two friendly sentences for the creator to pin, ending with a question that invites viewers to comment.';
  const r = await provider.generateJson<YouTubeAnswer>(
    {
      system: SYSTEM,
      prompt,
      schema: {
        type: 'object',
        properties: {
          titles: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
          description: { type: 'string' },
          primary_keyword: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, minItems: 10, maxItems: 30 },
          hashtags: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 6 },
          category: { type: 'string', enum: YOUTUBE_CATEGORIES.map((c) => c.label) },
          thumbnail_text: { type: 'string' },
          pinned_comment: { type: 'string' },
        },
        required: ['titles', 'description', 'primary_keyword', 'tags', 'hashtags', 'category', 'thumbnail_text', 'pinned_comment'],
      },
      maxTokens: 2048,
      temperature: 0.7,
      seed: Math.floor(Math.random() * 2 ** 31),
    },
    signal,
  );
  const titles = [...new Set(strings(r.titles).map(cleanTitle).filter((t) => [...t].length >= 10))];
  const description = paragraphize(cleanText(r.description, 3800));
  const keyword = sanitizeTag(typeof r.primary_keyword === 'string' ? r.primary_keyword : '');
  const baseTitleTags = base.tags.slice(0, 6); // title, author, "<title> audiobook"… always first
  const thumb = cleanTitle(r.thumbnail_text);
  return {
    ...base,
    title: titles[0] ?? base.title,
    titleOptions: [...new Set([...titles, base.title, ...base.titleOptions])].slice(0, 6),
    description: description.split(/\s+/).length >= 40 ? description : base.description,
    tags: fitTags([...(keyword ? [keyword] : []), ...baseTitleTags, ...strings(r.tags), ...base.tags]),
    hashtags: ensureFirstWord(recase(fitHashtags(strings(r.hashtags), 5), knownHashtags(src.ctx)), word),
    primaryKeyword: keyword || base.primaryKeyword,
    categoryId: CATEGORY_BY_LABEL.get(String(r.category).toLowerCase()) ?? base.categoryId,
    thumbnailText: thumb && [...thumb].length <= 50 ? thumb : base.thumbnailText,
    pinnedComment: cleanText(r.pinned_comment, 600) || base.pinnedComment,
    language: opts.language,
  };
}

/** Make sure the audiobook hashtag is there (people search for it), keeping at most five. */
function ensureFirstWord(tags: string[], word: string): string[] {
  if (tags.some((t) => t.toLocaleLowerCase() === word.toLocaleLowerCase())) return tags;
  return fitHashtags([word, ...tags], 5);
}

// ─────────────────────────────── social ───────────────────────────────

const PLATFORM_RULES: Record<SocialPlatform, string> = {
  facebook: '2–4 conversational sentences that make people want to watch; 2–3 hashtags.',
  instagram: 'a strong hook in the first line, then 3–5 short lines (emojis welcome), ending with "link in bio"; 5–10 hashtags.',
  tiktok: '1–2 short, punchy sentences; 3–5 hashtags including BookTok.',
  x: 'one sentence, at most 180 characters; 1–2 hashtags.',
  linkedin: '3–5 professional sentences about the value of the book and of listening while reading along; 2–4 hashtags.',
};

export async function generateSocial(
  provider: LLMProvider,
  src: PublishSource,
  opts: PublishAiOptions,
  base: Record<SocialPlatform, SocialDraft>,
  videoUrl: string,
  signal?: AbortSignal,
): Promise<Record<SocialPlatform, SocialDraft>> {
  const post = { type: 'object', properties: { text: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } } }, required: ['text', 'hashtags'] };
  const prompt =
    `Write social media posts announcing this video.\n\n${facts(src, opts)}\n\n${languageRule(opts.language)}\n` +
    'One post per platform. Do not include links (the link is added automatically) and put hashtags only in the "hashtags" list, without "#". Only the Instagram post may say "link in bio".\n' +
    SOCIAL_PLATFORMS.map((p) => `- ${p}: ${PLATFORM_RULES[p]}`).join('\n');
  const r = await provider.generateJson<Record<SocialPlatform, { text?: unknown; hashtags?: unknown }>>(
    {
      system: SYSTEM,
      prompt,
      schema: { type: 'object', properties: Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p, post])), required: [...SOCIAL_PLATFORMS] },
      maxTokens: 2048,
      temperature: 0.8,
      seed: Math.floor(Math.random() * 2 ** 31),
    },
    signal,
  );
  const out = {} as Record<SocialPlatform, SocialDraft>;
  for (const p of SOCIAL_PLATFORMS) {
    const rule = SOCIAL_RULES[p];
    const split = splitHashtags(cleanText(r?.[p]?.text, Math.min(rule.max, 2000)));
    const hashtags = recase(fitHashtags([...strings(r?.[p]?.hashtags), ...split.tags], rule.hashtags[1]), knownHashtags(src.ctx));
    let draft: SocialDraft = { text: dropTrailingTag(dropForeignCta(p, split.text), hashtags), hashtags };
    if ([...draft.text].length < 15) draft = { ...base[p], hashtags: hashtags.length ? hashtags : base[p].hashtags };
    // Leave room for the link and the hashtags within the platform's limit.
    while (socialLength(p, draft, videoUrl || 'https://youtu.be/xxxxxxxxxxx') > rule.max && draft.text.length > 20) {
      const over = socialLength(p, draft, videoUrl || 'https://youtu.be/xxxxxxxxxxx') - rule.max;
      draft = { ...draft, text: clip(draft.text, Math.max(20, [...draft.text].length - over - 1)) };
    }
    out[p] = draft;
  }
  return out;
}

// ─────────────────────────────── draft ───────────────────────────────

/**
 * Generate the requested sections into `draft`. The rule-based template is the base each AI section
 * is merged onto, so a field the model leaves empty or gets wrong falls back to a sensible value.
 */
export async function generatePublishDraft(
  provider: LLMProvider,
  src: PublishSource,
  draft: PublishDraft,
  sections: ('youtube' | 'social')[],
  opts: PublishAiOptions,
  signal?: AbortSignal,
): Promise<PublishDraft> {
  const base = templateDraft({ ...src.ctx, language: opts.language });
  const next: PublishDraft = { ...draft, ai: opts, model: `${provider.name}:${provider.model}`, generatedAt: new Date().toISOString() };
  if (sections.includes('youtube')) {
    // Keep the upload settings the user chose; only the words are regenerated.
    const keep = draft.youtube;
    const yt = await generateYouTube(provider, src, opts, { ...base.youtube, includeChapters: keep.includeChapters, visibility: keep.visibility, madeForKids: keep.madeForKids, license: keep.license, aiNarrationNote: keep.aiNarrationNote }, signal);
    next.youtube = yt;
    next.origin = { ...next.origin, youtube: 'ai' };
  }
  if (sections.includes('social')) {
    next.social = await generateSocial(provider, src, opts, base.social, draft.videoUrl, signal);
    next.origin = { ...next.origin, social: 'ai' };
  }
  return next;
}
