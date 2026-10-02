import { AppError } from '@app/shared';
import { type LanguageCode, SHORT_MAX_TAGS, SHORT_SCRIPT_MAX_CHARS, type ShortScriptStyle, estimateShortSec, fitTags, suggestShortTags } from '@app/types';
import type { LLMProvider } from '../llm/provider';
import { cleanText, clip, cleanTitle } from '../publish/generate';

/**
 * A YouTube Short's narration script, written by the local AI (Ollama) from a topic or from one of
 * the user's books. Creative writing, so it samples with some temperature; the answer is still
 * structured JSON and every field is cleaned so the voice never reads markdown, emojis or stage
 * directions.
 */

export type ShortScriptSource = { kind: 'topic'; topic: string } | { kind: 'book'; title: string; author?: string; excerpt: string };

export interface ShortScriptDraft {
  title: string;
  script: string;
  description: string;
  hashtags: string[];
  tags: string[];
}

const SYSTEM =
  'You write scripts for YouTube Shorts that a text-to-speech voice reads aloud over big on-screen captions. ' +
  'You write for the ear: short, vivid sentences, no filler. Never invent quotes, plot details or facts that are not in the ' +
  'provided text or widely known; when unsure, stay general. Always answer with JSON matching the schema.';

const STYLES: Record<ShortScriptStyle, (book: boolean) => string> = {
  hook: (book) =>
    `Open with a one-line hook that stops the scroll — a question or a surprising line. Then give a gripping taste of the ${book ? 'book without spoiling the ending' : 'topic'}. ` +
    `End with one short line inviting viewers to ${book ? 'listen to the full audiobook' : 'follow for more'}.`,
  summary: (book) =>
    `Explain ${book ? 'what the book is about and its key ideas' : 'the topic'} clearly and quickly, like a smart friend. Start with a hook line, then 3 to 4 key points, then a one-line takeaway.`,
  story: (book) =>
    `Tell it as a vivid mini-story in the present tense${book ? ', in the spirit of the book' : ''}, with a hook in the first line and a satisfying last line.`,
};

/** Words for a target length at the voice's usual pace (a little under, so the short stays inside it). */
export function targetWords(seconds: number, language: LanguageCode): number {
  return Math.max(20, Math.round(((language === 'bn' ? 115 : 165) * seconds * 0.92) / 60));
}

/** Remove what a voice must not read: markdown, emojis, hashtags, stage directions, speaker labels. */
export function cleanScript(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•]+|\d+[.)])\s+/, '') // bullets, numbered lists
        .replace(/[*_`~]+/g, '') // emphasis, before labels: "**Narrator:**"
        .replace(/^\s*(?:narrator|voice ?over|vo|host|speaker)\s*:\s*/i, '')
        .replace(/^\s*#{1,6}\s+/, ''),
    )
    .filter((l) => !/^\s*[[(].*[\])]\s*$/.test(l)) // whole-line directions: "(upbeat music)", "[Pause]"
    .join('\n')
    .replace(/\[[^\]\n]{0,40}\]|\((?:music|pause|beat|sfx|sound)[^)\n]{0,30}\)/gi, '')
    .replace(/(^|\s)#[\p{L}\p{M}\p{N}_]+/gu, '$1')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clip(cleanText(text, SHORT_SCRIPT_MAX_CHARS), SHORT_SCRIPT_MAX_CHARS);
}

/** Hashtags without "#", de-duplicated, "Shorts" first. */
export function cleanHashtags(raw: unknown, extra: string[] = []): string[] {
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  const out: string[] = [];
  for (const h of ['Shorts', ...list, ...extra]) {
    const tag = h.replace(/^#+/, '').replace(/[^\p{L}\p{M}\p{N}_]/gu, '').slice(0, 40);
    if (tag && !out.some((o) => o.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out.slice(0, 8);
}

function facts(src: ShortScriptSource, language: LanguageCode, seconds: number, style: ShortScriptStyle): string {
  const book = src.kind === 'book';
  return [
    book ? `BOOK: ${src.title}${src.author ? ` by ${src.author}` : ''}` : `TOPIC: ${src.topic}`,
    `LENGTH: about ${targetWords(seconds, language)} words (${seconds} seconds when read aloud). Never more than ${targetWords(seconds, language) + 15} words.`,
    `STYLE: ${STYLES[style](book)}`,
    language === 'bn'
      ? 'LANGUAGE: write the title, script and description in Bangla (Bengali script). Hashtags may be Bangla or English.'
      : 'LANGUAGE: write everything in English.',
    'SCRIPT RULES: only the words to be spoken. No emojis, hashtags, headings, bullet points, stage directions, sound cues or speaker labels. Spell out symbols.',
    'TITLE: under 70 characters, catchy but honest, no hashtags. DESCRIPTION: two short sentences for the YouTube description. HASHTAGS: 3 to 6 relevant ones, without the # sign.',
    TAGS_RULE(language),
    book && src.excerpt.trim() ? `FROM THE BOOK (excerpt):\n"""\n${src.excerpt.trim()}\n"""` : book ? 'No text of the book is available: rely only on what is widely known about it, and stay general.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function generateShortScript(
  provider: LLMProvider,
  src: ShortScriptSource,
  opts: { language: LanguageCode; seconds: number; style: ShortScriptStyle },
  signal?: AbortSignal,
): Promise<ShortScriptDraft> {
  const r = await provider.generateJson<{ title?: unknown; script?: unknown; description?: unknown; hashtags?: unknown; tags?: unknown }>(
    {
      system: SYSTEM,
      prompt: facts(src, opts.language, opts.seconds, opts.style),
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          script: { type: 'string' },
          description: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'script', 'description', 'hashtags', 'tags'],
      },
      maxTokens: 1500,
      temperature: 0.8,
    },
    signal,
  );
  const script = cleanScript(r.script);
  if (estimateShortSec(script, opts.language) < 5)
    throw new AppError('LLM_BAD_OUTPUT', 'The local AI did not write a usable script.', { hint: 'Try again, or write the script yourself.', retryable: true });
  const fallbackTitle = src.kind === 'book' ? src.title : src.topic;
  const title = cleanTitle(r.title) || clip(fallbackTitle, 90);
  const hashtags = cleanHashtags(r.hashtags, src.kind === 'book' ? ['Audiobook'] : []);
  const book = src.kind === 'book' ? { bookTitle: src.title, author: src.author } : {};
  return {
    title,
    script,
    description: cleanText(r.description, 1000).replace(/\n+/g, ' '),
    hashtags,
    tags: cleanTags(r.tags, suggestShortTags({ title, hashtags, language: opts.language, ...book })),
  };
}

const TAGS_RULE = (language: LanguageCode) =>
  `TAGS: 8 to 12 YouTube search tags — short phrases people type into YouTube search (the book or topic, the author, the genre, the theme), most specific first, without # and without commas inside a tag${language === 'bn' ? '; mix Bangla and English phrases' : ''}.`;

/** The model's tags first (most specific), then the rule-based ones, within YouTube's 500 characters. */
export function cleanTags(raw: unknown, fallback: string[]): string[] {
  const ai = (Array.isArray(raw) ? raw : []).filter((t): t is string => typeof t === 'string').map((t) => t.replace(/^#+/, '').trim());
  return fitTags([...ai.slice(0, 12), ...fallback]).slice(0, SHORT_MAX_TAGS);
}

/**
 * YouTube description, hashtags and tags for a script the user wrote (the title and script stay
 * as they are).
 */
export async function generateShortMetadata(
  provider: LLMProvider,
  src: { title: string; script: string; language: LanguageCode; bookTitle?: string; author?: string },
  signal?: AbortSignal,
): Promise<{ description: string; hashtags: string[]; tags: string[] }> {
  const prompt = [
    `YOUTUBE SHORT TITLE: ${src.title}`,
    src.bookTitle ? `ABOUT THE BOOK: ${src.bookTitle}${src.author ? ` by ${src.author}` : ''}` : '',
    src.language === 'bn' ? 'LANGUAGE: write the description in Bangla (Bengali script).' : 'LANGUAGE: write in English.',
    'DESCRIPTION: two short sentences that make people watch, honest, no hashtags, no links. HASHTAGS: 3 to 6 relevant ones, without the # sign.',
    TAGS_RULE(src.language),
    `SCRIPT (what the voice says):\n"""\n${clip(src.script.trim(), 2500)}\n"""`,
  ]
    .filter(Boolean)
    .join('\n');
  const r = await provider.generateJson<{ description?: unknown; hashtags?: unknown; tags?: unknown }>(
    {
      system: 'You are a YouTube SEO expert for Shorts. You write accurate, non-clickbait metadata and never invent facts. Always answer with JSON matching the schema.',
      prompt,
      schema: {
        type: 'object',
        properties: { description: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['description', 'hashtags', 'tags'],
      },
      maxTokens: 800,
      temperature: 0.6,
    },
    signal,
  );
  const hashtags = cleanHashtags(r.hashtags, src.bookTitle ? ['Audiobook'] : []);
  return {
    description: cleanText(r.description, 1000).replace(/\n+/g, ' '),
    hashtags,
    tags: cleanTags(r.tags, suggestShortTags({ title: src.title, hashtags, language: src.language, bookTitle: src.bookTitle, author: src.author })),
  };
}
