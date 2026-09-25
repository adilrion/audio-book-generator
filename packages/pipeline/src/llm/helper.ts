import path from 'node:path';
import { Semaphore, atomicWriteJson, hashKey, readJsonIfExists, type Logger, silentLogger } from '@app/shared';
import type { LLMProvider } from './provider';

const SYSTEM =
  'You assist an audiobook pipeline. You make minimal, conservative corrections only. ' +
  'Never paraphrase, summarize, modernize or add content. Always answer with JSON matching the schema.';

/** Similarity of two strings ignoring case, spacing and punctuation (Levenshtein ratio). */
export function letterSimilarity(a: string, b: string): number {
  const x = a.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 800);
  const y = b.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 800);
  if (!x.length && !y.length) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

/**
 * Task-level helper around an LLMProvider: bounded concurrency, disk cache, guards.
 * Every method degrades gracefully (returns null) when the model is unavailable.
 */
export class LLMHelper {
  private readonly sem: Semaphore;
  used = false;
  calls = 0;

  constructor(
    private readonly provider: LLMProvider,
    private readonly cacheDir: string,
    concurrency: number,
    private readonly log: Logger = silentLogger,
  ) {
    this.sem = new Semaphore(concurrency);
  }

  get model(): string {
    return `${this.provider.name}:${this.provider.model}`;
  }

  async available(): Promise<boolean> {
    return (await this.provider.isAvailable()).ok;
  }

  private async cached<T>(task: string, input: unknown, run: () => Promise<T>): Promise<T> {
    const file = path.join(this.cacheDir, `${task}-${hashKey(this.model, task, input)}.json`);
    const hit = await readJsonIfExists<{ value: T }>(file);
    if (hit) return hit.value;
    const value = await this.sem.run(run);
    this.calls++;
    this.used = true;
    await atomicWriteJson(file, { value });
    return value;
  }

  /** Which candidate lines start chapters? Only short heading candidates are sent. */
  async pickChapterHeadings(cands: { id: number; text: string; page: number; size: number }[], signal?: AbortSignal): Promise<number[] | null> {
    if (!(await this.available()) || cands.length < 2) return null;
    const list = cands.slice(0, 160).map((c) => `${c.id} | p.${c.page} | ${c.size.toFixed(1)}pt | ${c.text}`).join('\n');
    try {
      const r = await this.cached('chapters', list, () =>
        this.provider.generateJson<{ chapter_ids: number[] }>(
          {
            system: SYSTEM,
            prompt:
              'Below are candidate heading lines from a book PDF (id | page | font size | text).\n' +
              'Return the ids of lines that START A NEW CHAPTER (or a top-level part/prologue/epilogue). ' +
              'Exclude running headers, sub-section headings, figure captions, and the book title page.\n\n' +
              list,
            schema: {
              type: 'object',
              properties: { chapter_ids: { type: 'array', items: { type: 'integer' } } },
              required: ['chapter_ids'],
            },
            maxTokens: 1024,
          },
          signal,
        ),
      );
      const valid = new Set(cands.map((c) => c.id));
      return [...new Set(r.chapter_ids.filter((id) => valid.has(id)))].sort((a, b) => a - b);
    } catch (e) {
      this.log.warn('LLM chapter detection failed; using rules', e);
      return null;
    }
  }

  /** Fix extraction damage in sentences (letter-spacing, glued words, broken glyphs). Returns null if not trustworthy. */
  async repairSentences(sentences: string[], signal?: AbortSignal): Promise<string[] | null> {
    if (!(await this.available()) || !sentences.length) return null;
    const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
    try {
      const r = await this.cached('repair', numbered, () =>
        this.provider.generateJson<{ sentences: string[] }>(
          {
            system: SYSTEM,
            prompt:
              'These sentences were extracted from a PDF and may contain extraction errors such as letter-spaced words ' +
              '("T h e"), words glued together, broken ligatures or stray symbols. Fix ONLY such errors. Keep the wording, ' +
              `order and punctuation. Return exactly ${sentences.length} sentences in the same order.\n\n${numbered}`,
            schema: {
              type: 'object',
              properties: { sentences: { type: 'array', items: { type: 'string' }, minItems: sentences.length, maxItems: sentences.length } },
              required: ['sentences'],
            },
          },
          signal,
        ),
      );
      if (!Array.isArray(r.sentences) || r.sentences.length !== sentences.length) return null;
      // Guard: reject anything that looks like a rewrite rather than a repair.
      return r.sentences.map((fixed, i) => (letterSimilarity(fixed, sentences[i]) >= 0.8 ? fixed.trim() : sentences[i]));
    } catch (e) {
      this.log.warn('LLM repair failed; keeping original text', e);
      return null;
    }
  }

  /** Optional: respellings for words a TTS engine is likely to mispronounce. */
  async pronunciations(words: string[], signal?: AbortSignal): Promise<Record<string, string>> {
    if (!(await this.available()) || !words.length) return {};
    try {
      const r = await this.cached('pronounce', words, () =>
        this.provider.generateJson<{ items: { word: string; say: string }[] }>(
          {
            system: SYSTEM,
            prompt:
              'From this list of words found in an English book, pick ONLY names or foreign/technical words that an English ' +
              'text-to-speech voice would likely mispronounce, and give a simple English respelling for each ' +
              '(e.g. "Nietzsche" -> "Neecha"). Skip common words. List:\n' +
              words.join(', '),
            schema: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  items: { type: 'object', properties: { word: { type: 'string' }, say: { type: 'string' } }, required: ['word', 'say'] },
                },
              },
              required: ['items'],
            },
          },
          signal,
        ),
      );
      const allowed = new Set(words);
      return Object.fromEntries(r.items.filter((x) => allowed.has(x.word) && x.say && x.say.length < 40).map((x) => [x.word, x.say]));
    } catch (e) {
      this.log.warn('LLM pronunciation pass failed', e);
      return {};
    }
  }
}
