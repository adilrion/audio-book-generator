import { fitTags } from './publish';
import type { LanguageCode } from './settings';
import { SHORT_SCRIPT_MAX_CHARS, type ShortLook, type ShortScriptStyle, type ShortSettings, type ShortSummary, estimateShortSec } from './shorts';
import type { UserFacingError } from './status';
import { cleanText, clip } from './text';

/**
 * Batches of YouTube Shorts: several scripts at once — pasted from another AI tool (ChatGPT,
 * Gemini, Claude…), uploaded as a file, cut from one long script, or written by the local AI —
 * created together with one voice and look and rendered one after another.
 *
 * The reader is forgiving on purpose: AI tools wrap the same content in headings, bold labels,
 * numbered lists, JSON or a spreadsheet, and add chatter around it.
 */

/** Shorts per batch: enough for a week of posting, few enough to review one by one. */
export const SHORT_BATCH_MAX = 10;
/** A long script that is cut into parts: up to a full batch of Shorts. */
export const SHORT_SPLIT_MAX_CHARS = SHORT_SCRIPT_MAX_CHARS * SHORT_BATCH_MAX;
/** What a pasted or uploaded batch may be at most. */
export const SHORT_BATCH_TEXT_MAX_CHARS = 200_000;

/** One short of a batch, before it is created. */
export interface ShortBatchItem {
  title: string;
  script: string;
  description: string;
  hashtags: string[];
  tags: string[];
  /** This short's own background or motion, over the batch's look. */
  look?: Partial<Pick<ShortLook, 'theme' | 'motion'>>;
}

/** POST /shorts/batch */
export interface ShortBatchRequest {
  items: ShortBatchItem[];
  settings?: ShortSettings;
  /** The book the shorts are about (its cover can be the background). */
  projectId?: string | null;
  /** Queue the renders (one after another) — otherwise they are saved as drafts. */
  render?: boolean;
}

export interface ShortBatchResult {
  /** In the batch's order. */
  shorts: ShortSummary[];
  /** Saved, but the renders could not be queued (the shorts stay drafts). */
  error?: UserFacingError;
}

// ─────────────────────────────── cleaning ───────────────────────────────

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

/** Words for a target length at the voice's usual pace (a little under, so the short stays inside it). */
export function shortTargetWords(seconds: number, language: LanguageCode): number {
  return Math.max(20, Math.round(((language === 'bn' ? 115 : 165) * seconds * 0.92) / 60));
}

const cleanBatchTitle = (raw: string) =>
  clip(
    raw
      .replace(/[*_`#]+/g, '')
      .replace(/(^|\s)#[\p{L}\p{M}\p{N}_]+/gu, '$1')
      .replace(/\p{Extended_Pictographic}️?/gu, '')
      .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    100,
  );

/** The first sentence, as a title for a script that came without one. */
const titleFromScript = (script: string) => cleanBatchTitle((script.split(/(?<=[.!?।])\s|\n/)[0] ?? '').replace(/[.।]$/, '')) || 'Untitled short';

const splitList = (raw: string) =>
  raw
    .split(/[,\n;]+/)
    .map((t) => t.replace(/^[\s#*•-]+|[\s*]+$/g, '').trim())
    .filter(Boolean);

const hashtagWords = (raw: string) => [...raw.matchAll(/#?([\p{L}\p{M}\p{N}_]+)/gu)].map((m) => m[1]);

// ─────────────────────────────── reading a batch ───────────────────────────────

type Field = 'title' | 'script' | 'description' | 'hashtags' | 'tags' | 'skip';

/** Labels AI tools put in front of a short's parts (English and Bangla). Spoken parts (hook, CTA…) join the script. */
const LABELS: Record<string, Field> = {
  title: 'title', 'video title': 'title', 'short title': 'title', headline: 'title', 'শিরোনাম': 'title', 'টাইটেল': 'title',
  script: 'script', 'full script': 'script', voiceover: 'script', 'voice over': 'script', 'voice-over': 'script', vo: 'script',
  narration: 'script', 'spoken text': 'script', 'spoken script': 'script', 'স্ক্রিপ্ট': 'script', 'বর্ণনা': 'script',
  hook: 'script', intro: 'script', opening: 'script', body: 'script', 'main content': 'script', cta: 'script', 'call to action': 'script',
  outro: 'script', ending: 'script', closing: 'script', conclusion: 'script',
  description: 'description', desc: 'description', 'youtube description': 'description', caption: 'description', 'বিবরণ': 'description',
  hashtags: 'hashtags', 'hash tags': 'hashtags', 'হ্যাশট্যাগ': 'hashtags',
  tags: 'tags', 'youtube tags': 'tags', 'seo tags': 'tags', keywords: 'tags', 'ট্যাগ': 'tags',
  visual: 'skip', visuals: 'skip', 'visual idea': 'skip', 'on-screen text': 'skip', 'on screen text': 'skip', 'text overlay': 'skip',
  'b-roll': 'skip', broll: 'skip', scene: 'skip', shot: 'skip', camera: 'skip', music: 'skip', sfx: 'skip', 'sound effects': 'skip',
  thumbnail: 'skip', 'thumbnail text': 'skip', duration: 'skip', length: 'skip', runtime: 'skip', 'word count': 'skip',
  'estimated time': 'skip', notes: 'skip', note: 'skip', angle: 'skip', format: 'skip', editing: 'skip', background: 'skip',
};

const normLabel = (s: string) => s.toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

/** "**Hook (0–3 s):** Have you…" → { field: 'script', rest: 'Have you…', start: 17 } (where the text starts). */
function labelOf(line: string): { field: Field; rest: string; start: number } | null {
  const m = line.match(
    /^\s*(?:[-*•>]+\s*|\d{1,2}[.)]\s+)?(?:\p{Extended_Pictographic}️?\s*)*(?:\[[^\]]{0,20}\]\s*)?[*_]*\s*([\p{L}][\p{L}\p{M} \-]{0,24}?)\s*(?:\([^)]{0,30}\))?\s*[*_]*\s*[:：]\s*[*_]*\s*(.*)$/u,
  );
  if (!m) return null;
  const field = LABELS[normLabel(m[1])];
  return field ? { field, rest: m[2].replace(/[*_]+\s*$/, '').trim(), start: line.length - m[2].length } : null;
}

/** "## Short 3: The lonely postmaster" → { title: 'The lonely postmaster', start: 12 }; "Short 3" → { title: '' }. */
function headingOf(line: string): { title: string; start: number } | null {
  const m = line.match(
    /^\s*(#{1,6}\s*|[*_=]{2,}\s*|-{3,}\s*)?(?:\p{Extended_Pictographic}️?\s*)*[*_]*\s*(?:youtube\s+)?(?:shorts?|video|script|part|clip|episode|reel|idea|শর্টস?|ভিডিও|পর্ব|স্ক্রিপ্ট)\s*(?:#|no\.?\s*)?[0-9০-৯]{1,2}\s*[*_]*\s*([:.)|–—-]\s*)?(.*?)\s*[*_=#-]*\s*$/iu,
  );
  if (!m) return null;
  const marked = !!m[1];
  const rest = m[3].replace(/^title\s*[:：]\s*/i, '').replace(/\(\s*\d+[^)]{0,20}\)/g, '');
  // A plain line ("Episode 3 is my favourite", "Part 2: it begins.") is narration, not a heading.
  if (!marked && rest.trim() && (!m[2] || line.trim().length > 90 || /[.,;]$/.test(rest.trim()))) return null;
  return { title: cleanBatchTitle(rest), start: m[3] ? line.lastIndexOf(m[3]) : line.length };
}

/**
 * A second label further along a label or heading line: "Title: Stay hungry Script:" or
 * "**Title:** X **Script:** Y". Copying an answer from a chat page often joins its lines like that.
 * Only labels as AI tools write them (capitalised), so "the script: …" inside a sentence stays text.
 */
const INLINE_LABEL = /[\s*_]+((?:YouTube |Video |Full |Short )?(?:Title|Script|Voice[- ]?[Oo]ver|Narration|Description|Hashtags|Tags|Keywords)|TITLE|SCRIPT|VOICEOVER|DESCRIPTION|HASHTAGS|TAGS)[*_]*\s*[:：][*_\s]*/u;

/** Put each label of a joined line on its own line (label and heading lines only, never narration). */
function unjoin(lines: string[]): string[] {
  const out: string[] = [];
  for (let line of lines) {
    for (;;) {
      const own = labelOf(line) ?? headingOf(line);
      if (!own) break;
      // look after the line's own label, and only once there is some text before the next one
      const after = line.slice(own.start);
      const m = INLINE_LABEL.exec(after);
      if (!m || !after.slice(0, m.index).replace(/[*_]+/g, '').trim()) break;
      out.push(line.slice(0, own.start + m.index));
      line = `${m[1]}: ${after.slice(m.index + m[0].length)}`;
    }
    out.push(line);
  }
  return out;
}

const SEPARATOR = /^\s*([-*_=~])(?:\s*\1){2,}\s*$/;
const CHATTER = /^\s*(?:let me know if|i hope (?:this|these)|hope (?:this|these) help|feel free to|would you like me|do you want me|want me to|need more (?:scripts|ideas)|happy (?:creating|posting|filming)|if you(?:'d| would) like(?:,)? i|i can also|shall i)\b/i;
const PREAMBLE = /^\s*(?:sure|okay|ok|absolutely|certainly|of course|great|here (?:are|is)|here's|below (?:are|is))\b/i;

interface Block {
  /** Set (maybe empty) when the block starts with a "## Short 2" heading. */
  heading?: string;
  lines: string[];
  /** Starts at a heading or a separator (not the text before the first one). */
  marked: boolean;
}

function blocks(text: string): Block[] {
  const lines = unjoin(text.split('\n'));
  const headed = lines.some((l) => headingOf(l));
  const out: Block[] = [];
  let cur: Block = { lines: [], marked: false };
  const push = () => {
    if (cur.lines.some((l) => l.trim()) || cur.heading) out.push(cur);
  };
  for (const line of lines) {
    const h = headed ? headingOf(line) : null;
    if (h) {
      push();
      cur = { heading: h.title, lines: [], marked: true };
    } else if (SEPARATOR.test(line)) {
      if (headed) continue; // decoration between headed sections
      push();
      cur = { lines: [], marked: true };
    } else cur.lines.push(line);
  }
  push();
  // No headings or separators, but several "Title:" labels: each one starts a short.
  if (out.length === 1 && out[0].lines.filter((l) => labelOf(l)?.field === 'title').length > 1) {
    const split: Block[] = [];
    for (const line of out[0].lines) {
      if (labelOf(line)?.field === 'title' || !split.length) split.push({ lines: [], marked: true });
      split[split.length - 1].lines.push(line);
    }
    return split;
  }
  return out;
}

const hasLabels = (b: Block) => b.lines.some((l) => labelOf(l));

/** Drop "Sure! Here are 5 scripts:" before the first short and "Let me know…" after the last. */
function trimChatter(list: Block[]): Block[] {
  let out = list;
  const first = out[0];
  if (out.length > 1 && !first.marked && !hasLabels(first)) {
    const lines = first.lines.filter((l) => l.trim());
    const words = lines.join(' ').split(/\s+/).length;
    // Text before "## Short 1" is never a short; before a "---" it is one unless it reads like chatter.
    const headed = out.slice(1).some((b) => b.heading !== undefined);
    if (headed || (words <= 60 && (PREAMBLE.test(lines[0] ?? '') || /:\s*$/.test(lines[lines.length - 1] ?? '')))) out = out.slice(1);
  }
  const last = out[out.length - 1];
  if (last) {
    const lines = [...last.lines];
    for (;;) {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      let start = lines.length;
      while (start > 0 && lines[start - 1].trim()) start--;
      if (start < lines.length && CHATTER.test(lines[start]) && start > 0) lines.splice(start);
      else break;
    }
    out = [...out.slice(0, -1), { ...last, lines }];
  }
  return out;
}

/** One block of text → one short (null when it has no script). */
function readBlock(b: Block): ShortBatchItem | null {
  const fields: Record<Field, string[]> = { title: [], script: [], description: [], hashtags: [], tags: [], skip: [] };
  const free: string[] = [];
  let current: Field | null = null;
  for (const line of b.lines) {
    const l = labelOf(line);
    if (l) {
      current = l.field;
      if (l.rest) fields[current].push(l.rest);
      continue;
    }
    if (!line.trim()) {
      // Everything but the script ends at a blank line; the script runs to the next label.
      if (current !== 'script') current = null;
      else fields.script.push('');
      continue;
    }
    if (current === 'title' && fields.title.length) current = null; // a title is one line
    if (current) fields[current].push(line);
    else free.push(line);
  }
  const rawScript = fields.script.length ? fields.script.join('\n') : free.join('\n');
  const script = cleanScript(rawScript);
  if (!script) return null;
  const title = cleanBatchTitle(fields.title.join(' ')) || b.heading || titleFromScript(script);
  const tagsInScript = fields.hashtags.length ? [] : hashtagWords([...rawScript.matchAll(/#[\p{L}\p{M}\p{N}_]+/gu)].map((m) => m[0]).join(' '));
  return {
    title,
    script,
    description: cleanText(fields.description.join('\n').replace(/[*_`]+/g, ''), 5000),
    hashtags: cleanHashtags([...hashtagWords(fields.hashtags.join(' ')), ...tagsInScript]),
    tags: fitTags(splitList(fields.tags.join('\n'))),
  };
}

/** A JSON value an AI tool wrote → shorts (any of the usual key names). */
function fromObjects(list: unknown[]): ShortBatchItem[] {
  const out: ShortBatchItem[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      const script = cleanScript(entry);
      if (script) out.push({ title: titleFromScript(script), script, description: '', hashtags: cleanHashtags([]), tags: [] });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const lines: string[] = [];
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      const field = LABELS[normLabel(key)];
      if (!field || field === 'skip') continue;
      const text = Array.isArray(value) ? value.filter((v) => typeof v === 'string').join(field === 'script' ? '\n' : ', ') : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
      if (!text.trim()) continue;
      // Re-use the text reader: "Script:" + its lines (several spoken parts join in order).
      lines.push(`${field}:`, ...text.split('\n'));
    }
    const item = readBlock({ lines, marked: true });
    if (item) out.push(item);
  }
  return out;
}

function fromJson(text: string): ShortBatchItem[] | null {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start < 0 || end <= start) return null;
  const head = text.slice(0, start).replace(/```(?:json)?/gi, '').trim();
  if (head.length > 200) return null; // JSON somewhere inside prose: not a JSON answer
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (Array.isArray(data)) return fromObjects(data);
  if (data && typeof data === 'object') {
    const inner = Object.values(data as Record<string, unknown>).find(Array.isArray);
    return fromObjects(inner ?? [data]);
  }
  return null;
}

/** RFC 4180-ish: quoted cells may hold the delimiter, quotes ("") and newlines. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell.trim()) {
      quoted = true;
      cell = '';
    } else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** A spreadsheet export (CSV or tab-separated) with a header row that names a script column. */
function fromTable(text: string): ShortBatchItem[] | null {
  const first = text.split('\n', 1)[0];
  const delimiter = ['\t', ',', ';'].map((d) => ({ d, n: first.split(d).length })).sort((a, b) => b.n - a.n)[0];
  if (delimiter.n < 2) return null;
  const rows = parseDelimited(text, delimiter.d);
  const header = rows[0]?.map((h) => LABELS[normLabel(h.replace(/^﻿/, ''))]);
  if (!header?.includes('script')) return null;
  return fromObjects(rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h.replace(/^﻿/, ''), r[i] ?? '']))));
}

export interface ParsedShortBatch {
  items: ShortBatchItem[];
  /** How the text was read: JSON, a spreadsheet, headed sections, or one script. */
  format: 'json' | 'table' | 'sections' | 'single';
}

/**
 * Read shorts from text pasted or uploaded by the user: the format our "prompt for other AI tools"
 * asks for (## Short 1 / Title: / Script: / Description: / Hashtags: / Tags:), its common
 * variations (bold or numbered labels, Hook/Body/CTA parts, "---" between shorts), JSON, or a
 * CSV/TSV table with a "script" column. Plain text without any of that is one short.
 */
export function parseShortBatch(raw: string): ParsedShortBatch {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').slice(0, SHORT_BATCH_TEXT_MAX_CHARS).trim();
  if (!text) return { items: [], format: 'single' };
  if (/^(?:```(?:json)?\s*)?[[{]/i.test(text)) {
    const json = fromJson(text);
    if (json) return { items: json, format: 'json' };
  }
  const table = fromTable(text);
  if (table) return { items: table, format: 'table' };
  const list = trimChatter(blocks(text.replace(/```[a-z]*\n?/gi, '')));
  const items = list.map(readBlock).filter((i): i is ShortBatchItem => !!i);
  return { items, format: list.length > 1 || list[0]?.marked ? 'sections' : 'single' };
}

// ─────────────────────────────── cutting one long script ───────────────────────────────

interface Unit {
  text: string;
  words: number;
  /** Starts a new line (a longer pause) in the original. */
  line: boolean;
}

function units(text: string): Unit[] {
  const out: Unit[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const sentences = line.match(/[^.!?।…]+(?:[.!?।…]+["'”’)\]]*)?/g) ?? [];
    sentences.forEach((s, i) => {
      const t = s.trim();
      if (t) out.push({ text: t, words: t.split(/\s+/).length, line: i === 0 });
    });
  }
  return out;
}

/** How many Shorts a long script makes: parts of about 45–58 seconds. */
export function autoShortParts(script: string, language: LanguageCode, speed = 1): number {
  const sec = estimateShortSec(script, language, speed);
  return Math.min(SHORT_BATCH_MAX, Math.max(1, Math.ceil(sec / 58)));
}

/**
 * Cut a long script into `parts` scripts at sentence ends, as even in length as possible (the
 * longest part is as short as it can be), keeping the order and the line breaks.
 */
export function splitShortScript(script: string, parts: number): string[] {
  const u = units(script);
  const k = Math.max(1, Math.min(parts, u.length));
  if (!u.length) return [];
  const n = u.length;
  const pre = [0];
  for (const x of u) pre.push(pre[pre.length - 1] + x.words);
  const cost = (a: number, b: number) => pre[b] - pre[a];
  // best[j][i]: the smallest possible longest part when the first i sentences make j parts
  const best = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const cut = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(0));
  best[0][0] = 0;
  for (let j = 1; j <= k; j++) {
    for (let i = j; i <= n - (k - j); i++) {
      for (let p = j - 1; p < i; p++) {
        const v = Math.max(best[j - 1][p], cost(p, i));
        // ties: prefer cutting where the original starts a new line
        if (v < best[j][i] || (v === best[j][i] && u[p]?.line && !u[cut[j][i]]?.line)) {
          best[j][i] = v;
          cut[j][i] = p;
        }
      }
    }
  }
  const bounds: number[] = [n];
  for (let j = k, i = n; j > 0; j--) {
    i = cut[j][i];
    bounds.unshift(i);
  }
  const out: string[] = [];
  for (let j = 0; j < k; j++) {
    const part = u.slice(bounds[j], bounds[j + 1]);
    out.push(part.map((x, i) => (i > 0 && x.line ? `\n${x.text}` : (i > 0 ? ' ' : '') + x.text)).join(''));
  }
  return out;
}

// ─────────────────────────────── checks ───────────────────────────────

const wordsOf = (s: string) => s.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

function shingles(s: string): Set<string> {
  const w = wordsOf(s);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

/**
 * Pairs of shorts (0-based) that are too alike: the same title, or scripts sharing most of their
 * wording. YouTube may treat near-duplicates as repetitive content.
 */
export function similarShorts(items: Pick<ShortBatchItem, 'title' | 'script'>[]): { a: number; b: number; why: 'title' | 'script' }[] {
  const sets = items.map((i) => shingles(i.script));
  const titles = items.map((i) => wordsOf(i.title).join(' '));
  const out: { a: number; b: number; why: 'title' | 'script' }[] = [];
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      if (titles[a] && titles[a] === titles[b]) {
        out.push({ a, b, why: 'title' });
        continue;
      }
      const A = sets[a];
      const B = sets[b];
      if (A.size < 4 || B.size < 4) continue;
      let both = 0;
      for (const s of A) if (B.has(s)) both++;
      if (both / (A.size + B.size - both) >= 0.4) out.push({ a, b, why: 'script' });
    }
  }
  return out;
}

// ─────────────────────────────── writing a batch ───────────────────────────────

/**
 * A different angle for each short the local AI writes in a batch, so the shorts say different
 * things (and a book's shorts draw on different parts of it).
 */
export const SHORT_BATCH_ANGLES: Record<'book' | 'topic', string[]> = {
  book: [
    'the big question the book asks, and why it matters',
    'the most gripping moment or turning point in this part of the book',
    'one surprising idea or lesson from this part of the book',
    'the main character or central figure, in a nutshell',
    'a vivid scene or image from this part of the book',
    'who this book is for, and what they will get from it',
    'one practical takeaway viewers can use today',
    'the mood and setting — make the viewer feel it',
    'a common belief this book challenges',
    'why this book still matters today',
  ],
  topic: [
    'a hook question and its surprising answer',
    'three quick things most people do not know',
    'a short story that shows it',
    'a common myth, busted',
    'one practical tip',
    'where it began, in thirty seconds',
    'why it matters to the viewer',
    'a what-if scenario',
    'the biggest mistake people make about it',
    'the one thing to remember',
  ],
};

/** Script styles take turns through a batch. */
export const batchStyle = (i: number): ShortScriptStyle => (['hook', 'summary', 'story'] as const)[i % 3];

/**
 * A prompt for ChatGPT, Gemini, Claude or any other AI tool that asks for the format
 * parseShortBatch reads best.
 */
export function shortBatchPrompt(o: { about: string; count: number; seconds: number; language: LanguageCode }): string {
  const words = shortTargetWords(o.seconds, o.language);
  const about = o.about.trim() || '[YOUR TOPIC OR BOOK]';
  return [
    `Write ${o.count} different YouTube Shorts scripts about: ${about}`,
    '',
    'Rules:',
    `- A text-to-speech voice reads each script aloud over big captions: about ${words} words (${o.seconds} seconds). Short, vivid sentences, written for the ear.`,
    '- Open every script with a hook line that stops the scroll.',
    '- Give each short its own angle — no two may repeat the same idea, example or wording.',
    '- Script: only the words to be spoken. No emojis, hashtags, stage directions, scene notes, timings or speaker labels.',
    '- Do not invent quotes or facts.',
    `- Language: ${o.language === 'bn' ? 'Bangla (Bengali script) for the title, script and description.' : 'English.'}`,
    '',
    'Answer in exactly this format, with nothing before or after it:',
    '',
    '## Short 1',
    'Title: (under 70 characters, honest, no hashtags)',
    'Script:',
    '(the narration)',
    'Description: (two short sentences for the YouTube description)',
    'Hashtags: #Shorts and 3 to 5 more',
    'Tags: (8 to 12 YouTube search phrases, separated by commas)',
    '',
    '## Short 2',
    '…',
  ].join('\n');
}

/** A filled-in example of the batch format, to download as a template. */
export const SHORT_BATCH_EXAMPLE = `## Short 1
Title: The letter that changed a lonely life
Script:
What if one letter could change a life?
In a tiny Bengal village, a young postmaster counts the days until he can leave.
Then an orphan girl named Ratan starts to wait for him every evening.
Listen to the full story — it will stay with you.
Description: A lonely postmaster, a village girl, and a goodbye neither of them is ready for. Tagore's classic, in sixty seconds.
Hashtags: #Shorts #Tagore #Audiobook
Tags: the postmaster, rabindranath tagore, tagore short stories, bengali literature, audiobook

## Short 2
Title: Why Tagore's saddest story still hurts
Script:
Some goodbyes are said in one sentence.
Tagore wrote a whole life into a single rainy evening.
Here is why readers still cannot forget Ratan.
Description: The quiet heartbreak at the center of The Postmaster, and why it still lands a century later.
Hashtags: #Shorts #Tagore #BookTok
Tags: the postmaster summary, tagore, classic short stories, book review
`;
