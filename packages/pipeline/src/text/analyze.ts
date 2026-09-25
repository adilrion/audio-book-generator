import type { Analysis, Chapter, ChapterSource, CleaningReport, ExtractedPage, ExtractionMeta, Paragraph, Sentence } from '@app/types';
import { mapLimit, type Logger, silentLogger } from '@app/shared';
import type { LLMHelper } from '../llm/helper';
import { detectChapters, fallbackSections, isFrontMatterTitle, paraText, type ChapterStart } from './chapters';
import { cleanPages } from './clean';
import type { CleanPage, Token } from './model';
import { headingNarration, isSpeakable, normalizeNarration } from './normalize';
import { buildParagraphs, buildVocabulary, type RawParagraph } from './paragraphs';
import { regionsFor } from './regions';
import { splitSentences } from './sentences';

export const ANALYZER_VERSION = 'analyze-v1';

export interface CleanResult {
  pages: CleanPage[];
  report: CleaningReport;
}

export function cleanDocument(pages: ExtractedPage[]): CleanResult {
  return cleanPages(pages);
}

export interface AnalyzeOptions {
  language: string;
  skipFrontMatter: boolean;
  title?: string;
  llm?: LLMHelper;
  pronunciation?: boolean;
  signal?: AbortSignal;
  log?: Logger;
  onProgress?: (done: number, total: number, message?: string) => void;
}

/** Detect extraction damage that deterministic rules cannot fix. */
export function looksBroken(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length >= 6 && tokens.filter((t) => /^\p{L}$/u.test(t)).length / tokens.length > 0.5) return true; // "T h e  e n d"
  if (/[�ﬀ-ﬆ]/.test(text)) return true;
  const letters = text.replace(/[^\p{L}]/gu, '').length || 1;
  const odd = text.replace(/[\p{L}\p{N}\s.,;:!?'"()\-–—…’‘“”%$&/]/gu, '').length;
  if (odd / letters > 0.08) return true;
  if (tokens.filter((t) => /^\p{L}{26,}$/u.test(t)).length >= 2) return true; // glued words
  return false;
}

function joinTokens(tokens: Token[]): { text: string; offsets: number[] } {
  const offsets: number[] = [];
  let text = '';
  tokens.forEach((t, i) => {
    if (i > 0) text += ' ';
    offsets.push(text.length);
    text += t.t;
  });
  return { text, offsets };
}

function buildSentences(p: RawParagraph, ci: number, pi: number, lang: string, lexicon: Record<string, string>): Sentence[] {
  const { text, offsets } = joinTokens(p.tokens);
  const spans = p.kind === 'heading' ? [{ start: 0, end: text.length }] : splitSentences(text, lang);
  const out: Sentence[] = [];
  for (const span of spans) {
    const toks = p.tokens.filter((t, k) => offsets[k] < span.end && offsets[k] + t.t.length > span.start);
    const st = text.slice(span.start, span.end).trim();
    if (!toks.length || !isSpeakable(st)) continue;
    const narration = p.kind === 'heading' ? headingNarration(normalizeNarration(st, lang, lexicon)) : normalizeNarration(st, lang, lexicon);
    if (!isSpeakable(narration)) continue;
    out.push({ id: `c${ci}-p${pi}-s${out.length}`, index: 0, text: st, narration, regions: regionsFor(toks) });
  }
  return out;
}

export async function analyzeCleaned(clean: CleanResult, meta: ExtractionMeta, opts: AnalyzeOptions): Promise<Analysis> {
  const log = opts.log ?? silentLogger;
  const warnings: string[] = [];
  const body = clean.report.bodyFontSize;
  const vocab = buildVocabulary(clean.pages);
  const { paragraphs: paras, dehyphenated } = buildParagraphs(clean.pages, body, vocab);
  const report: CleaningReport = { ...clean.report, dehyphenated };
  if (!paras.length) throw Object.assign(new Error('No readable text'), { code: 'PDF_NO_TEXT' });
  opts.onProgress?.(1, 4, 'Detecting chapters');

  // ── Chapters: deterministic first, LLM only for ambiguous structure ──
  const det = detectChapters(paras, meta.toc, body);
  let starts: ChapterStart[] = det.starts;
  let source: ChapterSource = det.source;
  if ((det.ambiguous || starts.length < 2) && det.candidates.length >= 2 && opts.llm) {
    const ids = await opts.llm.pickChapterHeadings(det.candidates, opts.signal);
    if (ids && ids.length >= 2) {
      starts = ids.map((i) => ({ paraIndex: i, title: paraText(paras[i]) }));
      source = 'llm';
    }
  }
  if (starts.length < 2) {
    const lastPage = paras[paras.length - 1].pageEnd;
    if (lastPage - paras[0].pageStart >= 18) {
      starts = fallbackSections(paras);
      source = 'fallback';
      warnings.push('No chapter structure found; the book was split into parts of about 12 pages.');
    } else if (!starts.length) {
      starts = [{ paraIndex: 0, title: opts.title || meta.title || 'Full Text' }];
      source = 'fallback';
    }
  }
  starts.sort((a, b) => a.paraIndex - b.paraIndex);

  // Front matter before the first chapter
  if (starts[0].paraIndex > 0 && !opts.skipFrontMatter) starts.unshift({ paraIndex: 0, title: 'Opening Pages' });
  if (opts.skipFrontMatter) {
    const kept = starts.filter((s) => !isFrontMatterTitle(s.title));
    if (kept.length) starts = kept;
  }
  opts.onProgress?.(2, 4, 'Segmenting sentences');

  // ── Pronunciation lexicon (opt-in) ──
  let lexicon: Record<string, string> = {};
  if (opts.pronunciation && opts.llm && opts.language === 'en') {
    const freq = new Map<string, number>();
    for (const p of paras)
      p.tokens.forEach((t, k) => {
        const w = t.t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
        if ((k > 0 && /^\p{Lu}\p{Ll}{3,}$/u.test(w)) || /[^\x00-\x7f]/.test(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
      });
    const words = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 150).map(([w]) => w);
    lexicon = await opts.llm.pronunciations(words, opts.signal);
  }

  // ── Build chapters → paragraphs → sentences ──
  const chapters: Chapter[] = [];
  starts.forEach((s, ci) => {
    const end = ci + 1 < starts.length ? starts[ci + 1].paraIndex : paras.length;
    const cps = paras.slice(s.paraIndex, end);
    if (!cps.length) return;
    const idx = chapters.length;
    const paragraphs: Paragraph[] = [];
    cps.forEach((p) => {
      const pi = paragraphs.length;
      const sentences = buildSentences(p, idx, pi, opts.language, lexicon);
      if (!sentences.length) return;
      const text = paraText(p);
      paragraphs.push({
        id: `c${idx}-p${pi}`,
        index: pi,
        kind: p.kind,
        text,
        pageStart: p.pageStart,
        pageEnd: p.pageEnd,
        regions: regionsFor(p.tokens),
        sentences,
      });
    });
    if (!paragraphs.length) return;
    let n = 0;
    for (const p of paragraphs) for (const st of p.sentences) st.index = n++;
    chapters.push({ index: idx, title: s.title, pageStart: cps[0].pageStart, pageEnd: cps[cps.length - 1].pageEnd, source, paragraphs });
  });

  // ── LLM repair only for paragraphs that look broken ──
  let llmRepairs = 0;
  if (opts.llm && (await opts.llm.available())) {
    const broken = chapters.flatMap((c) => c.paragraphs).filter((p) => looksBroken(p.text)).slice(0, 300);
    if (broken.length) {
      log.info(`LLM repair for ${broken.length} suspicious paragraphs`);
      await mapLimit(broken, 2, async (p, i) => {
        const fixed = await opts.llm!.repairSentences(p.sentences.map((s) => s.narration), opts.signal);
        opts.onProgress?.(3 + i / broken.length, 4, 'Repairing damaged text');
        if (!fixed) return;
        p.sentences.forEach((s, k) => {
          if (fixed[k] && fixed[k] !== s.narration) {
            s.narration = fixed[k];
            llmRepairs++;
          }
        });
      });
    }
  } else {
    const broken = chapters.flatMap((c) => c.paragraphs).filter((p) => looksBroken(p.text)).length;
    if (broken > 0) warnings.push(`${broken} paragraphs look damaged by PDF extraction; enable Ollama to repair them.`);
  }
  opts.onProgress?.(4, 4, 'Done');

  const sentences = chapters.reduce((n, c) => n + c.paragraphs.reduce((m, p) => m + p.sentences.length, 0), 0);
  return {
    version: ANALYZER_VERSION,
    language: opts.language,
    title: opts.title || meta.title || 'Untitled',
    chapters,
    stats: {
      chapters: chapters.length,
      paragraphs: chapters.reduce((n, c) => n + c.paragraphs.length, 0),
      sentences,
      words: chapters.reduce((n, c) => n + c.paragraphs.reduce((m, p) => m + p.text.split(/\s+/).length, 0), 0),
      llmUsed: !!opts.llm?.used,
      llmRepairs,
      chapterSource: source,
    },
    cleaning: report,
    lexicon,
    warnings,
  };
}
