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
  WHOLE_BOOK_CLAIM,
  YOUTUBE_LIMITS,
  fitHashtags,
  isPartial,
  phraseIndex,
  fitTags,
  sanitizeTag,
  socialLength,
  cleanText,
  clip,
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
  const cov = c.coverage;
  const scope =
    cov && !cov.complete
      ? `THIS VIDEO COVERS ONLY: ${cov.label ?? 'part of the book'}${cov.totalChapters ? ` (${cov.narratedChapters} of ${cov.totalChapters} chapters` : ' ('}${cov.pages ? `, pages ${cov.pages[0]}–${cov.pages[1]}` : ''}). It is NOT the whole book: never call it "full", "complete", "unabridged" or "the entire book"; say which part it is, and invite viewers to come back for the next chapter.`
      : 'THIS VIDEO COVERS: the whole book, narrated from start to finish.';
  return [
    `VIDEO: an audiobook of the book below, narrated by a natural text-to-speech voice, with the book's own pages on screen and each sentence highlighted as it is spoken, so viewers can follow the text. Runtime: ${duration(c.durationSec)}.`,
    scope,
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
// Shared with the browser (scripts pasted into the Shorts batch page).
export { cleanText, clip } from '@app/types';

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
  return [...words.map(camelTag), 'Audiobook', 'Audiobooks', 'AudiobookWithText', 'FullAudiobook', 'BookTok', 'Bookstagram', 'BookLovers', 'Books', 'Reading', 'Literature', 'ClassicLiterature', 'Classics', 'BookClub', 'Learning', 'BanglaAudiobook'];
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
  const partial = isPartial(src.ctx);
  const part = src.ctx.coverage?.label;
  const english = opts.language !== 'bn';
  const prompt =
    `Write YouTube metadata that ranks in search AND makes people want to watch.\n\n${facts(src, opts)}\n\n${languageRule(opts.language)}\n` +
    'Rules:\n' +
    `- titles: 3 different titles, 45–70 characters, in Title Case, each starting with the book title and containing the word "${word}"` +
    `${partial && part ? ` and "${part}"` : ''}:\n` +
    `  1) the search format: "<book title>${partial ? ` – ${part ?? '<part>'}` : ''} by <author> | ${partial ? '' : 'Full '}${word} with Text";\n` +
    `  2) "<book title> ${word} | " followed by a short, intriguing hook from the book's premise (no spoilers beyond the opening);\n` +
    '  3) your best alternative that makes people curious. Include the author where it fits.\n' +
    '  No false promises, no ALL CAPS, no emojis.\n' +
    `- description: 170–260 words in 3–4 short paragraphs separated by a blank line.\n` +
    `  Paragraph 1 (shown in search results — make it count): one or two sentences that hook the viewer with the premise or why the book matters, containing the book title, the author and the word "${word.toLowerCase()}".\n` +
    '  Paragraph 2: what the book is about and why it is worth hearing — premise only, no spoilers beyond the opening.\n' +
    `  Paragraph 3: what the viewer gets: ${partial ? `this part of the book (${part ?? 'one part'})` : 'the complete book'} narrated, with the pages on screen and each sentence highlighted, so it is easy to follow${english ? ' (also great for improving reading and English)' : ''}.\n` +
    `  Last line: a short call to action — subscribe${partial ? ' so they do not miss the next chapter' : ' for more audiobooks'} and comment.\n` +
    '  Do NOT list chapters, timestamps, hashtags or links.\n' +
    `- primary_keyword: the main search phrase, usually "<book title> ${word.toLowerCase()}".\n` +
    `- tags: 15–25 search phrases people type: the title, the author, "<title> audiobook", "<author> audiobook", genre, themes${partial ? `, "<title> ${part ?? 'chapter 1'}"` : ', "full audiobook"'}, "audiobook with text", "audiobook with subtitles". No "#".\n` +
    '- hashtags: 3–5 real hashtags people search, without "#" or spaces, in CamelCase (e.g. the book title, the author, the genre). No invented combinations.\n' +
    `- category: one of ${YOUTUBE_CATEGORIES.map((c) => `"${c.label}"`).join(', ')}.\n` +
    '- thumbnail_text: 2–4 big words for the thumbnail, usually the short book title.\n' +
    '- pinned_comment: a friendly comment for the creator to pin: one sentence about the book’s central idea, then a question that is easy and fun to answer.\n' +
    'Never use the words "read-along" or "read along".';
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
  const fix = (t: string) => scrub(t, src.ctx, opts.language);
  const titles = [...new Set(strings(r.titles).map((t) => fix(scrubTitle(cleanTitle(t)))).filter((t) => [...t].length >= 10))];
  const description = paragraphize(fix(cleanText(r.description, 3800)));
  const keyword = sanitizeTag(typeof r.primary_keyword === 'string' ? r.primary_keyword : '');
  const baseTitleTags = base.tags.slice(0, 6); // title, author, "<title> audiobook"… always first
  const thumb = cleanTitle(r.thumbnail_text);
  // The best-ranking title wins, so a stray model answer never beats the search format.
  const ranked = rankTitles([...titles, base.title, ...base.titleOptions], src.ctx, word);
  return {
    ...base,
    title: ranked[0] ?? base.title,
    titleOptions: ranked.slice(0, 6),
    description: description.split(/\s+/).length >= 40 ? description : base.description,
    tags: fitTags([...(keyword ? [keyword] : []), ...baseTitleTags, ...strings(r.tags), ...base.tags]),
    // #Audiobook #TheBookTitle #TheAuthor first — the three YouTube shows above the title.
    hashtags: fitHashtags(
      [word, camelTag(src.ctx.title), ...(src.ctx.author ? [camelTag(src.ctx.author)] : []), ...recase(strings(r.hashtags), knownHashtags(src.ctx)).filter((h) => !/read_?along/i.test(h))],
      5,
    ),
    primaryKeyword: keyword || base.primaryKeyword,
    categoryId: CATEGORY_BY_LABEL.get(String(r.category).toLowerCase()) ?? base.categoryId,
    thumbnailText: thumb && [...thumb].length <= 50 && !(partial && WHOLE_BOOK_CLAIM[opts.language].test(thumb)) ? thumb : base.thumbnailText,
    pinnedComment: fix(cleanText(r.pinned_comment, 600)) || base.pinnedComment,
    language: opts.language,
  };
}

/**
 * How well a title works in search: the book title at the start, the author, the word "audiobook",
 * a length that is not cut off — and, for a partial narration, which part it is and no "full".
 */
export function titleScore(title: string, ctx: PublishContext, word: string): number {
  const len = [...title].length;
  if (len > YOUTUBE_LIMITS.title) return -100;
  let s = 0;
  const at = phraseIndex(title, ctx.title);
  if (at >= 0) s += at <= 8 ? 4 : 2;
  const surname = ctx.author?.trim().split(/\s+/).pop();
  if (surname && phraseIndex(title, surname) >= 0) s += 2;
  if (phraseIndex(title, word) >= 0) s += 3;
  if (len >= 45 && len <= YOUTUBE_LIMITS.titleVisible) s += 2;
  else if (len >= 30 && len <= 80) s += 1;
  if (/read[- ]?along/i.test(title)) s -= 3;
  if ((title.match(/\b[A-Z]{4,}\b/g) ?? []).length > 1) s -= 2;
  if (isPartial(ctx)) {
    if (WHOLE_BOOK_CLAIM[ctx.language].test(title)) s -= 8;
    if (ctx.coverage?.label && phraseIndex(title, ctx.coverage.label) >= 0) s += 3;
  }
  return s;
}

/** Unique titles, best first (ties keep their order, so the model's first choice wins a tie). */
export function rankTitles(titles: string[], ctx: PublishContext, word: string): string[] {
  const unique = [...new Set(titles.map((t) => t.trim()).filter(Boolean))];
  return unique
    .map((t, i) => ({ t, i, s: titleScore(t, ctx, word) }))
    .filter((x) => x.s > -100)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t);
}

/** Titles drop "read-along" rather than reword it: "…Audiobook with Read-Along Text" → "…Audiobook with Text". */
export function scrubTitle(title: string): string {
  return title
    .replace(/\bread[- ]along\s+(text|video|audiobook)\b/gi, '$1')
    .replace(/\s*[:|–-]?\s*\bread[- ]along\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[:|–-]\s*$/, '')
    .trim();
}

/**
 * Wording the copy must not use: "read-along" (people search for "with text") and, when only part
 * of the book is narrated, "full / complete audiobook".
 */
export function scrub(text: string, ctx: PublishContext, lang: PublishAiOptions['language']): string {
  let out = text.replace(/\b(r)ead([- ])along\b/gi, (_m, r: string, sep: string) => `${r === 'R' ? 'F' : 'f'}ollow${sep}along`);
  if (isPartial(ctx)) {
    out =
      lang === 'bn'
        ? out.replace(/(সম্পূর্ণ|পুরো|পূর্ণাঙ্গ)\s*/g, '')
        : out.replace(/\b(full|complete|unabridged|entire|whole)[- ](length )?(audiobook|audio book|book|novel|story)\b/gi, (_m, _f, _l, noun: string) => noun);
  }
  return out.replace(/[ \t]{2,}/g, ' ');
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
    'One post per platform. Open each post with a hook — a question or a striking line from the premise — so people stop scrolling. ' +
    'Do not include links (the link is added automatically) and put hashtags only in the "hashtags" list, without "#". Only the Instagram post may say "link in bio". Never use the words "read-along" or "read along".\n' +
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
    let draft: SocialDraft = { text: scrub(dropTrailingTag(dropForeignCta(p, split.text), hashtags), src.ctx, opts.language), hashtags: hashtags.filter((h) => !/read_?along/i.test(h)) };
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
