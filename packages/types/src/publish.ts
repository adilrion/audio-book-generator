import type { AspectRatio, LanguageCode } from './settings';

/**
 * Publishing: everything needed to upload the finished audiobook to YouTube and share it on
 * social media — the metadata draft, the platform rules it is checked against, and the pure
 * helpers the web app (live preview, SEO checks) and the API (apply to files) both use.
 */

export type SocialPlatform = 'facebook' | 'instagram' | 'tiktok' | 'x' | 'linkedin';
export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = ['facebook', 'instagram', 'tiktok', 'x', 'linkedin'];

export const SOCIAL_RULES: Record<SocialPlatform, { label: string; max: number; hashtags: [number, number]; note: string }> = {
  facebook: { label: 'Facebook', max: 63206, hashtags: [1, 3], note: 'Posts under ~250 characters get the most engagement.' },
  instagram: { label: 'Instagram', max: 2200, hashtags: [3, 10], note: 'Only the first ~125 characters show before “more”. Links in captions are not clickable.' },
  tiktok: { label: 'TikTok', max: 4000, hashtags: [3, 5], note: 'Short and punchy; hashtags help discovery.' },
  x: { label: 'X', max: 280, hashtags: [1, 2], note: 'Links always count as 23 characters.' },
  linkedin: { label: 'LinkedIn', max: 3000, hashtags: [2, 4], note: 'The first ~210 characters show before “see more”.' },
};

export const YOUTUBE_LIMITS = {
  title: 100,
  /** Characters shown in search results / on mobile before truncation. */
  titleVisible: 70,
  description: 5000,
  /** First characters of the description shown in search results. */
  descriptionSnippet: 150,
  tagsChars: 500,
  hashtagsRecommended: 15,
  /** With more than this many hashtags YouTube ignores all of them. */
  hashtagsIgnored: 60,
  chaptersMin: 3,
  chapterMinSec: 10,
  thumbnailBytes: 2 * 1024 * 1024,
  thumbnail: { width: 1280, height: 720 },
} as const;

/** YouTube video categories that fit an audiobook (ids are YouTube's). */
export const YOUTUBE_CATEGORIES: { id: string; label: string }[] = [
  { id: '27', label: 'Education' },
  { id: '24', label: 'Entertainment' },
  { id: '22', label: 'People & Blogs' },
  { id: '1', label: 'Film & Animation' },
  { id: '26', label: 'Howto & Style' },
  { id: '28', label: 'Science & Technology' },
  { id: '25', label: 'News & Politics' },
  { id: '29', label: 'Nonprofits & Activism' },
];

export type Visibility = 'public' | 'unlisted' | 'private';
export type DraftOrigin = 'template' | 'ai';
export type PublishTone = 'friendly' | 'literary' | 'energetic' | 'academic';

export interface YouTubeDraft {
  title: string;
  /** Alternatives to choose from (AI suggestions plus the rule-based title). */
  titleOptions: string[];
  /** The description body, without chapters, disclosure and hashtags — `composeDescription` adds those. */
  description: string;
  includeChapters: boolean;
  tags: string[];
  /** Without the leading `#`. */
  hashtags: string[];
  /** The main search phrase the title, description and tags are checked against. */
  primaryKeyword: string;
  categoryId: string;
  language: LanguageCode;
  visibility: Visibility;
  madeForKids: boolean;
  license: 'youtube' | 'creativeCommon';
  /** Add a line to the description saying the narration is a synthetic (text-to-speech) voice. */
  aiNarrationNote: boolean;
  pinnedComment: string;
  /** Big text on the thumbnail. */
  thumbnailText: string;
}

export interface SocialDraft {
  text: string;
  hashtags: string[];
}

/** Tags written into audiobook.mp4 / audiobook.m4a ("Apply to files"). */
export interface FileTagsDraft {
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: string;
  copyright: string;
  comment: string;
  /** Embed the thumbnail (video) and the book cover (audio) as cover art. */
  embedCover: boolean;
}

export interface PublishAiOptions {
  /** Language the metadata is written in (defaults to the book's). */
  language: LanguageCode;
  tone: PublishTone;
  /** Extra search phrases to work in, comma-separated. */
  keywords: string;
}

export type ThumbnailLayout = 'cover' | 'bold' | 'minimal' | 'photo' | 'quote' | 'player' | 'split' | 'cinematic' | 'ribbon';

/** How the thumbnail is drawn (it is rendered in the browser and saved as thumbnail.jpg). */
export interface ThumbnailDesign {
  layout: ThumbnailLayout;
  /** Small line above the title, e.g. "Full audiobook". */
  kicker: string;
  accent: string;
  showAuthor: boolean;
  /** Runtime badge. */
  showBadge: boolean;
  /** The line the "Opening line" layout shows (default: the book's first sentence). */
  quote?: string;
}

export interface PublishDraft {
  version: 1;
  youtube: YouTubeDraft;
  social: Record<SocialPlatform, SocialDraft>;
  file: FileTagsDraft;
  thumbnail?: ThumbnailDesign;
  /** The video's public link, once uploaded — added to social posts. */
  videoUrl: string;
  ai: PublishAiOptions;
  /** Whether each section was last written by the rules or by the local AI. */
  origin: { youtube: DraftOrigin; social: DraftOrigin };
  /** `provider:model` that wrote the AI sections. */
  model?: string;
  generatedAt?: string;
  updatedAt?: string;
}

export interface PublishChapter {
  title: string;
  /** seconds */
  start: number;
  end: number;
}

/** Facts about the finished book the metadata is built from. */
export interface PublishContext {
  title: string;
  author?: string;
  language: LanguageCode;
  durationSec: number;
  pageCount: number;
  wordCount: number;
  chapters: PublishChapter[];
  aspectRatio: AspectRatio;
  hasVideo: boolean;
  hasAudio: boolean;
  /** How much of the book the video narrates (absent = assume the whole book). */
  coverage?: PublishCoverage;
  /** The book's first real sentence (a hook for the thumbnail and the AI). */
  openingLine?: string;
}

export interface PublishCoverage {
  /** False when only part of the book was narrated (a chapter range, or chapters left out). */
  complete: boolean;
  /** Which part, e.g. "Chapter I" or "Chapters 1–3" (set when incomplete). */
  label?: string;
  narratedChapters: number;
  /** Body chapters of the book (front and back matter not counted). */
  totalChapters: number;
  /** First and last narrated page. */
  pages?: [number, number];
  narratedWords: number;
  totalWords: number;
}

export const isPartial = (ctx: PublishContext) => !!ctx.coverage && !ctx.coverage.complete;

/** Words that promise the whole book. */
export const WHOLE_BOOK_CLAIM: Record<LanguageCode, RegExp> = {
  en: /\b(full|complete|unabridged|entire|whole)\b/i,
  bn: /সম্পূর্ণ|পুরো|পূর্ণাঙ্গ/,
};

const NUMERAL = /^([ivxlcdm]+|\d+)\.?$/i;
const NAMED_PART = /^(chapter|part|book|section|volume|অধ্যায়|পর্ব|খণ্ড)(\s|$)/i;

/** "I" → "Chapter I", "Part One" stays; several → "Chapters 1–3" / "Part One – Part Two". */
export function partLabel(titles: string[], lang: LanguageCode): string {
  const word = lang === 'bn' ? 'অধ্যায়' : 'Chapter';
  const one = (t: string) => (NAMED_PART.test(t) ? t : NUMERAL.test(t) ? `${word} ${t.replace(/\.$/, '')}` : t);
  if (titles.length <= 1) return one(titles[0] ?? '');
  const first = titles[0];
  const last = titles[titles.length - 1];
  if (NUMERAL.test(first) && NUMERAL.test(last)) return `${lang === 'bn' ? 'অধ্যায়' : 'Chapters'} ${first.replace(/\.$/, '')}–${last.replace(/\.$/, '')}`;
  return `${one(first)} – ${one(last)}`;
}

export interface AppliedFile {
  name: string;
  size: number;
  mtimeMs: number;
}

/** What is embedded in an output file right now (read back with ffprobe). */
export interface EmbeddedTags {
  name: string;
  size: number;
  tags: Record<string, string>;
  hasCover: boolean;
  chapters: number;
}

/** A saved version of the draft (kept so it can be compared with and restored). */
export interface PublishVersion {
  at: string;
  /** How it was made, e.g. "Rules", "AI · qwen3:4b", "Edited". */
  label: string;
  draft: PublishDraft;
}

/** POST …/publish/generate: the AI's version of the draft — not saved until accepted. */
export interface GeneratePublishResult {
  proposal: PublishDraft;
  model: string;
}

export interface PublishState {
  draft: PublishDraft;
  /** How the current draft was made ("Rules", "AI · qwen3:4b", "Edited"…). */
  label: string;
  /** Earlier saved versions, newest first. */
  history: PublishVersion[];
  /** The rule-based draft for this book (to start over or compare with). */
  template: PublishDraft;
  /** False while the draft is the rule-based starting point nobody has saved yet. */
  saved: boolean;
  context: PublishContext;
  thumbnail?: { url: string; size: number; updatedAt: string };
  applied?: {
    at: string;
    cover: boolean;
    files: string[];
    /** Why the files no longer match: re-rendered by a later run, or the draft changed since. */
    stale: ('files' | 'draft')[];
  };
  embedded: EmbeddedTags[];
  llm: { enabled: boolean; available: boolean; model: string; message: string };
}

export interface GeneratePublishRequest {
  sections: ('youtube' | 'social')[];
  /** The editor's current draft (unsaved edits are kept in the sections that are not generated). */
  draft?: PublishDraft;
  options?: Partial<PublishAiOptions>;
}

// ─────────────────────────────── helpers ───────────────────────────────

/** YouTube chapter timestamp: 00:00 under an hour, 0:00:00 from an hour on. */
export function ytTimestamp(sec: number, long = sec >= 3600): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return long ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Will YouTube turn the description timestamps into chapters? (≥3, first at 0:00, each ≥10 s) */
export function chaptersProblem(chapters: PublishChapter[]): string | undefined {
  if (chapters.length < YOUTUBE_LIMITS.chaptersMin) return `YouTube shows chapters only for ${YOUTUBE_LIMITS.chaptersMin} or more (this book has ${chapters.length}).`;
  if (Math.floor(chapters[0].start) !== 0) return 'The first chapter must start at 00:00.';
  const short = chapters.filter((c) => c.end - c.start < YOUTUBE_LIMITS.chapterMinSec);
  if (short.length) return `${short.length} chapter(s) are shorter than ${YOUTUBE_LIMITS.chapterMinSec} seconds.`;
  return undefined;
}

export function chapterLines(chapters: PublishChapter[]): string[] {
  const long = chapters.some((c) => c.start >= 3600);
  return chapters.map((c) => `${ytTimestamp(c.start, long)} ${c.title}`);
}

const LABELS: Record<LanguageCode, { chapters: string; aiNote: string }> = {
  en: { chapters: 'Chapters', aiNote: 'Narrated with a synthetic (text-to-speech) voice. Each sentence is highlighted on the page as it is read.' },
  bn: { chapters: 'অধ্যায়সমূহ', aiNote: 'কৃত্রিম (টেক্সট-টু-স্পিচ) কণ্ঠে পাঠ। পড়ার সময় প্রতিটি বাক্য পাতায় হাইলাইট করা হয়।' },
};

export const hashtagText = (tags: string[]) => tags.map((t) => `#${t}`).join(' ');

/** The full YouTube description: body, chapter timestamps, disclosure, hashtags. */
export function composeDescription(yt: YouTubeDraft, chapters: PublishChapter[]): string {
  const l = LABELS[yt.language] ?? LABELS.en;
  const parts = [yt.description.trim()];
  if (yt.includeChapters && chapters.length) parts.push(`${l.chapters}:\n${chapterLines(chapters).join('\n')}`);
  if (yt.aiNarrationNote) parts.push(l.aiNote);
  if (yt.hashtags.length) parts.push(hashtagText(yt.hashtags));
  return parts.filter(Boolean).join('\n\n');
}

/** A social post as it would be pasted: text, link, hashtags. */
export function composeSocial(post: SocialDraft, url?: string): string {
  return [post.text.trim(), url?.trim(), post.hashtags.length ? hashtagText(post.hashtags) : ''].filter(Boolean).join('\n\n');
}

/** Length as the platform counts it (X counts every link as 23 characters). */
export function socialLength(platform: SocialPlatform, post: SocialDraft, url?: string): number {
  const text = composeSocial(post, platform === 'x' ? undefined : url);
  const chars = [...text].length;
  return platform === 'x' && url?.trim() ? chars + (text ? 2 : 0) + 23 : chars;
}

/** Characters YouTube counts for a tag list: commas between tags, quotes around tags with spaces. */
export function youtubeTagChars(tags: string[]): number {
  if (!tags.length) return 0;
  return tags.reduce((n, t) => n + [...t].length + (/\s/.test(t) ? 2 : 0), 0) + tags.length - 1;
}

/** One YouTube tag: no commas, quotes, angle brackets or `#`; single spaces; at most 60 characters. */
export function sanitizeTag(raw: string): string {
  return raw
    .replace(/[<>,"#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

/** Cleaned, de-duplicated tags that fit YouTube's 500-character budget (earlier tags win). */
export function fitTags(tags: string[], budget: number = YOUTUBE_LIMITS.tagsChars): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = sanitizeTag(raw);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    if (youtubeTagChars([...out, t]) > budget) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** A hashtag: letters (any script, incl. combining marks), digits and `_` only. */
export function sanitizeHashtag(raw: string): string {
  return raw.replace(/^#+/, '').replace(/[^\p{L}\p{M}\p{N}_]/gu, '').slice(0, 50);
}

export function fitHashtags(tags: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = sanitizeHashtag(raw);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const ISO_639_2: Record<LanguageCode, string> = { en: 'eng', bn: 'ben' };

/**
 * The tags "Apply to files" writes (ffmpeg `-metadata` keys of the MP4/M4A muxer). Empty values
 * clear a tag. `media_type=2` marks the M4A as an audiobook in Apple's players.
 */
export function fileTagsFor(draft: PublishDraft, ctx: PublishContext, kind: 'video' | 'audio'): Record<string, string> {
  const f = draft.file;
  const full = composeDescription(draft.youtube, ctx.chapters).slice(0, YOUTUBE_LIMITS.description);
  const body = draft.youtube.description.trim().replace(/\s+/g, ' ');
  const tags: Record<string, string> = {
    title: f.title.trim(),
    artist: f.artist.trim(),
    album_artist: f.artist.trim(),
    album: f.album.trim(),
    genre: f.genre.trim(),
    date: f.year.trim(),
    copyright: f.copyright.trim(),
    comment: f.comment.trim(),
    description: [...body].length > 255 ? `${[...body].slice(0, 254).join('').trimEnd()}…` : body,
    synopsis: full,
    keywords: draft.youtube.tags.join(','),
  };
  if (kind === 'audio') tags.media_type = '2';
  return tags;
}

export const languageTag = (lang: LanguageCode) => ISO_639_2[lang] ?? 'eng';

// ─────────────────────────────── SEO report ───────────────────────────────

export type SeoArea = 'title' | 'description' | 'tags' | 'hashtags' | 'chapters' | 'thumbnail' | 'file' | 'engagement';
export type SeoStatus = 'pass' | 'warn' | 'fail';

export interface SeoCheck {
  id: string;
  area: SeoArea;
  status: SeoStatus;
  label: string;
  detail: string;
  weight: number;
}

export interface SeoReport {
  /** 0–100 */
  score: number;
  checks: SeoCheck[];
  /** Problems that make YouTube reject the upload or the field. */
  blocking: number;
}

const norm = (s: string) => s.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const tokens = (s: string) => s.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*/gu) ?? [];
const words = (s: string) => tokens(s).length;

/**
 * Where a search phrase appears in `text` (character index of its first word), or -1. Search matches
 * words, not exact strings: "The Metamorphosis by Franz Kafka – Full Audiobook" contains
 * "the metamorphosis audiobook".
 */
export function phraseIndex(text: string, phrase: string): number {
  const want = tokens(phrase);
  if (!want.length) return -1;
  const have = new Set(tokens(text));
  if (!want.every((w) => have.has(w))) return -1;
  // Measured at the phrase's most distinctive (longest) word: "the" can match anywhere.
  const key = want.reduce((a, b) => (b.length > a.length ? b : a));
  return text.toLocaleLowerCase().indexOf(key);
}

/** How well the draft follows YouTube's rules and common SEO practice. */
export function seoReport(draft: PublishDraft, ctx: PublishContext, extra: { thumbnail: boolean; applied: 'current' | 'stale' | 'none' }): SeoReport {
  const yt = draft.youtube;
  const checks: SeoCheck[] = [];
  const add = (c: SeoCheck) => checks.push(c);
  const kw = norm(yt.primaryKeyword);
  const title = yt.title.trim();
  const tlen = [...title].length;
  const desc = composeDescription(yt, ctx.chapters);
  const dlen = [...desc].length;

  // Title
  if (!tlen) add({ id: 'title-length', area: 'title', status: 'fail', label: 'Add a title', detail: 'A video cannot be published without a title.', weight: 3 });
  else if (tlen > YOUTUBE_LIMITS.title)
    add({ id: 'title-length', area: 'title', status: 'fail', label: 'Title is too long', detail: `${tlen}/${YOUTUBE_LIMITS.title} characters — YouTube rejects longer titles.`, weight: 3 });
  else if (tlen > YOUTUBE_LIMITS.titleVisible)
    add({ id: 'title-length', area: 'title', status: 'warn', label: 'Title may be cut off', detail: `${tlen} characters — search results show about ${YOUTUBE_LIMITS.titleVisible}.`, weight: 3 });
  else if (tlen < 30) add({ id: 'title-length', area: 'title', status: 'warn', label: 'Title is short', detail: `${tlen} characters — 40–70 leaves room for the author and “audiobook”.`, weight: 3 });
  else add({ id: 'title-length', area: 'title', status: 'pass', label: 'Title length', detail: `${tlen} characters — fully visible in search.`, weight: 3 });

  if (!kw) add({ id: 'keyword', area: 'title', status: 'warn', label: 'Set a main search phrase', detail: 'The phrase people would type to find this book, e.g. “<title> audiobook”.', weight: 2 });
  else {
    const at = phraseIndex(title, kw);
    if (at < 0) add({ id: 'title-keyword', area: 'title', status: 'warn', label: 'Main phrase is not in the title', detail: `Work “${yt.primaryKeyword.trim()}” into the title.`, weight: 3 });
    else if (at > 40) add({ id: 'title-keyword', area: 'title', status: 'warn', label: 'Main phrase is late in the title', detail: 'Put it near the start — the end may be cut off.', weight: 3 });
    else add({ id: 'title-keyword', area: 'title', status: 'pass', label: 'Main phrase leads the title', detail: `“${yt.primaryKeyword.trim()}” is near the start.`, weight: 3 });
  }

  // Say what it is: people search "<title> audiobook" and the author's name.
  const word = yt.language === 'bn' ? 'অডিওবুক' : 'audiobook';
  const surname = ctx.author?.trim().split(/\s+/).pop();
  const missing = [phraseIndex(title, word) < 0 ? `“${word}”` : '', surname && phraseIndex(title, surname) < 0 ? 'the author' : ''].filter(Boolean);
  if (tlen)
    add(
      missing.length
        ? { id: 'title-format', area: 'title', status: 'warn', label: `Add ${missing.join(' and ')} to the title`, detail: 'People search for the book with “audiobook” and the author’s name.', weight: 2 }
        : { id: 'title-format', area: 'title', status: 'pass', label: 'Title says what it is', detail: 'Book, author and “audiobook” are all in the title.', weight: 2 },
    );

  // A partial narration must not promise the whole book.
  if (isPartial(ctx)) {
    const claim = WHOLE_BOOK_CLAIM[yt.language] ?? WHOLE_BOOK_CLAIM.en;
    const part = ctx.coverage!.label ?? 'part of the book';
    const where = [
      claim.test(title) ? 'title' : '',
      claim.test(yt.description) ? 'description' : '',
      claim.test(`${yt.thumbnailText} ${draft.thumbnail?.kicker ?? ''}`) ? 'thumbnail' : '',
      claim.test(draft.file.comment) ? 'file comment' : '',
    ].filter(Boolean);
    if (where.length)
      add({
        id: 'scope',
        area: where[0] === 'thumbnail' ? 'thumbnail' : where[0] === 'file comment' ? 'file' : where[0] === 'description' ? 'description' : 'title',
        status: 'fail',
        label: `Says “full”, but only ${part} is narrated`,
        detail: `Remove “full/complete” from the ${where.join(', ')}. Viewers who expect the whole book leave early, and YouTube treats misleading titles as spam.`,
        weight: 3,
      });
    else if (phraseIndex(title, part) < 0)
      add({ id: 'scope', area: 'title', status: 'warn', label: 'Say which part this is', detail: `Add “${part}” to the title, so viewers know what they get.`, weight: 3 });
    else add({ id: 'scope', area: 'title', status: 'pass', label: 'Honest about the part', detail: `The title says this is ${part}.`, weight: 3 });
  }

  const brackets = /[<>]/.test(title) || /[<>]/.test(desc);
  if (brackets) add({ id: 'brackets', area: 'description', status: 'fail', label: 'Remove < and >', detail: 'YouTube rejects titles and descriptions that contain angle brackets.', weight: 2 });

  // Description
  const bodyWords = words(yt.description);
  if (dlen > YOUTUBE_LIMITS.description)
    add({ id: 'desc-length', area: 'description', status: 'fail', label: 'Description is too long', detail: `${dlen}/${YOUTUBE_LIMITS.description} characters.`, weight: 2 });
  else if (bodyWords < 80)
    add({ id: 'desc-length', area: 'description', status: 'warn', label: 'Description is thin', detail: `${bodyWords} words — 150–300 words give search more to work with.`, weight: 2 });
  else add({ id: 'desc-length', area: 'description', status: 'pass', label: 'Description length', detail: `${bodyWords} words, ${dlen} characters in total.`, weight: 2 });

  if (kw) {
    const snippet = [...yt.description.trim()].slice(0, YOUTUBE_LIMITS.descriptionSnippet).join('');
    if (phraseIndex(snippet, kw) >= 0) add({ id: 'desc-hook', area: 'description', status: 'pass', label: 'Strong opening line', detail: 'The main phrase appears in the part shown in search results.', weight: 2 });
    else add({ id: 'desc-hook', area: 'description', status: 'warn', label: 'Opening line misses the main phrase', detail: `Only the first ~${YOUTUBE_LIMITS.descriptionSnippet} characters show in search — mention “${yt.primaryKeyword.trim()}” there.`, weight: 2 });
  }

  if (/subscribe|comment|সাবস্ক্রাইব|কমেন্ট|মন্তব্য/i.test(yt.description))
    add({ id: 'desc-cta', area: 'description', status: 'pass', label: 'Call to action', detail: 'The description asks viewers to subscribe and comment.', weight: 1 });
  else add({ id: 'desc-cta', area: 'description', status: 'warn', label: 'Ask viewers to act', detail: 'End the description by asking viewers to subscribe and comment — engagement helps ranking.', weight: 1 });

  // Chapters
  const chProblem = chaptersProblem(ctx.chapters);
  if (!yt.includeChapters)
    add({ id: 'chapters', area: 'chapters', status: chProblem ? 'pass' : 'warn', label: chProblem ? 'Chapters not needed' : 'Add chapter timestamps', detail: chProblem ?? 'Timestamps become clickable chapters and can appear in Google search.', weight: 2 });
  else if (chProblem) add({ id: 'chapters', area: 'chapters', status: 'warn', label: 'Chapters will not show', detail: chProblem, weight: 2 });
  else add({ id: 'chapters', area: 'chapters', status: 'pass', label: 'Chapters', detail: `${ctx.chapters.length} timestamps — YouTube turns them into chapters.`, weight: 2 });

  // Tags
  const tagChars = youtubeTagChars(yt.tags);
  if (tagChars > YOUTUBE_LIMITS.tagsChars)
    add({ id: 'tags', area: 'tags', status: 'fail', label: 'Too many tags', detail: `${tagChars}/${YOUTUBE_LIMITS.tagsChars} characters — YouTube rejects the list.`, weight: 1 });
  else if (yt.tags.length < 5) add({ id: 'tags', area: 'tags', status: 'warn', label: 'Add more tags', detail: `${yt.tags.length} tags — 10–25 help with misspellings and related searches.`, weight: 1 });
  else add({ id: 'tags', area: 'tags', status: 'pass', label: 'Tags', detail: `${yt.tags.length} tags, ${tagChars}/${YOUTUBE_LIMITS.tagsChars} characters.`, weight: 1 });
  if (kw && yt.tags.length && !yt.tags.some((t) => norm(t) === kw))
    add({ id: 'tags-keyword', area: 'tags', status: 'warn', label: 'Main phrase is not a tag', detail: `Add “${yt.primaryKeyword.trim()}” as a tag.`, weight: 1 });

  // Hashtags
  const bad = yt.hashtags.filter((h) => sanitizeHashtag(h) !== h);
  if (bad.length) add({ id: 'hashtags', area: 'hashtags', status: 'fail', label: 'Invalid hashtags', detail: `No spaces or punctuation: ${bad.slice(0, 3).map((h) => `#${h}`).join(', ')}.`, weight: 1 });
  else if (yt.hashtags.length > YOUTUBE_LIMITS.hashtagsIgnored)
    add({ id: 'hashtags', area: 'hashtags', status: 'fail', label: 'Far too many hashtags', detail: `YouTube ignores all hashtags when there are more than ${YOUTUBE_LIMITS.hashtagsIgnored}.`, weight: 1 });
  else if (yt.hashtags.length > YOUTUBE_LIMITS.hashtagsRecommended)
    add({ id: 'hashtags', area: 'hashtags', status: 'warn', label: 'Too many hashtags', detail: `${yt.hashtags.length} — more than ${YOUTUBE_LIMITS.hashtagsRecommended} can count as tag spam.`, weight: 1 });
  else if (!yt.hashtags.length) add({ id: 'hashtags', area: 'hashtags', status: 'warn', label: 'Add hashtags', detail: '3–5 hashtags; the first three show above the title.', weight: 1 });
  else add({ id: 'hashtags', area: 'hashtags', status: 'pass', label: 'Hashtags', detail: `${yt.hashtags.length} hashtags — the first three show above the title.`, weight: 1 });

  // Thumbnail, engagement, file
  add(
    extra.thumbnail
      ? { id: 'thumbnail', area: 'thumbnail', status: 'pass', label: 'Custom thumbnail', detail: '1280×720 JPEG, ready to upload.', weight: 2 }
      : { id: 'thumbnail', area: 'thumbnail', status: 'warn', label: 'Create a thumbnail', detail: 'Custom thumbnails get far more clicks than auto-picked frames.', weight: 2 },
  );
  add(
    yt.pinnedComment.trim()
      ? { id: 'pinned', area: 'engagement', status: 'pass', label: 'Pinned comment', detail: 'Ready to post and pin after upload.', weight: 1 }
      : { id: 'pinned', area: 'engagement', status: 'warn', label: 'Write a pinned comment', detail: 'A question invites comments, which helps ranking.', weight: 1 },
  );
  add(
    extra.applied === 'current'
      ? { id: 'file-tags', area: 'file', status: 'pass', label: 'File metadata applied', detail: 'Title, author, tags and cover art are embedded in the files.', weight: 1 }
      : extra.applied === 'stale'
        ? { id: 'file-tags', area: 'file', status: 'warn', label: 'File metadata is out of date', detail: 'Apply again so the files carry the current metadata.', weight: 1 }
        : { id: 'file-tags', area: 'file', status: 'warn', label: 'Apply metadata to the files', detail: 'Embeds title, author, tags and cover art in the MP4 and M4A.', weight: 1 },
  );

  const total = checks.reduce((n, c) => n + c.weight, 0);
  const got = checks.reduce((n, c) => n + c.weight * (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  return { score: Math.round((got / total) * 100), checks, blocking: checks.filter((c) => c.status === 'fail').length };
}

/** A filesystem- and URL-safe file name for the upload ("the-metamorphosis-franz-kafka-audiobook.mp4"). */
export function uploadFileName(parts: (string | undefined)[], ext: string): string {
  const base = parts
    .filter(Boolean)
    .join(' ')
    .normalize('NFC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/, '');
  return `${base || 'audiobook'}.${ext}`;
}
