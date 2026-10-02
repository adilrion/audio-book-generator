import { AppError } from '@app/shared';
import type { BookRights, LibraryBook, LibraryBookDetail, LibraryFile, LibraryLanguage, LibrarySearchResult } from '@app/types';
import { notFound } from '../common/errors';

/**
 * The Internet Archive (archive.org) as an online book library: millions of scanned books with a
 * text layer, many in the public domain, and a large Bangla collection. Free JSON APIs, no key.
 * archive.org is sometimes slow, so answers are cached for a few minutes.
 */

const ARCHIVE = 'https://archive.org';
/** archive.org identifiers: letters, digits, '.', '-' and '_'. */
export const ARCHIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PAGE_SIZE = 24;

const LANGUAGE_QUERY: Record<Exclude<LibraryLanguage, 'any'>, string> = {
  en: 'language:(eng OR English OR en)',
  bn: 'language:(ben OR Bengali OR Bangla OR bn)',
};
/** Public domain (as labelled), CC0, or CC BY / BY-SA — licences that allow an audiobook. */
const FREE_QUERY = '(possible-copyright-status:NOT_IN_COPYRIGHT OR licenseurl:*publicdomain* OR licenseurl:*\\/by\\/* OR licenseurl:*\\/by-sa\\/*)';
/**
 * Without search words, a shelf of classics instead of the plain most-downloaded list (dictionaries,
 * sheet music, government manuals and modern books mislabelled as public domain).
 * English: library scans marked "not in copyright" with a fiction or poetry subject. Bangla: authors whose
 * works are out of copyright in Bangladesh and India (died more than 60 years ago).
 */
const CLASSICS: Record<Exclude<LibraryLanguage, 'any'>, string> = {
  en: '(possible-copyright-status:NOT_IN_COPYRIGHT AND subject:(fiction OR poetry OR novels))',
  bn: 'creator:(Tagore OR রবীন্দ্রনাথ OR Bankim OR বঙ্কিমচন্দ্র OR Saratchandra OR Sarat OR শরৎচন্দ্র OR Sukumar OR সুকুমার OR Upendrakishore OR উপেন্দ্রকিশোর OR Rokeya OR রোকেয়া OR Vidyasagar OR বিদ্যাসাগর OR Bibhutibhushan OR বিভূতিভূষণ OR Madhusudan OR মধুসূদন OR Mosharraf OR মোশাররফ)',
};
const FIELDS = ['identifier', 'title', 'creator', 'year', 'date', 'language', 'imagecount', 'downloads', 'licenseurl', 'possible-copyright-status'];

export interface SearchOptions {
  q: string;
  language: LibraryLanguage;
  /** Only books labelled public domain or with a licence that allows adaptations. */
  freeOnly: boolean;
  page: number;
}

/** Lucene query for archive.org's advanced search; user words are stripped of query syntax. */
export function buildQuery({ q, language, freeOnly }: Omit<SearchOptions, 'page'>): string {
  const words = q
    .normalize('NFC')
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    // AND / OR / NOT typed by the user are words, not operators.
    .map((w) => (/^(AND|OR|NOT|TO)$/.test(w) ? w.toLowerCase() : w));
  const parts = ['mediatype:texts', 'format:"Text PDF"', 'NOT access-restricted-item:true'];
  if (words.length) {
    const terms = `(${words.join(' AND ')})`;
    parts.unshift(`(title:${terms} OR creator:${terms} OR subject:${terms})`);
  } else parts.unshift(CLASSICS[language === 'bn' ? 'bn' : 'en']);
  if (language !== 'any') parts.push(LANGUAGE_QUERY[language]);
  if (freeOnly) parts.push(FREE_QUERY);
  return parts.join(' AND ');
}

type Doc = Record<string, unknown>;
const first = (v: unknown): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s.trim() : typeof s === 'number' ? String(s) : undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(first(v) ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** "1913", "[1913]", "1913-1914", "1913-01-01T00:00:00Z" → 1913. */
const yearOf = (v: unknown): number | undefined => {
  const y = Number(/(?:^|\D)(\d{4})(?:\D|$)/.exec(first(v) ?? '')?.[1]);
  return y > 0 && y < 3000 ? y : undefined;
};

/** archive.org language values ("eng", "English", "ben", "Bengali", …) → the app's codes where it has one. */
export function languageCode(v: unknown): string | undefined {
  const raw = first(v)?.toLowerCase();
  if (!raw) return undefined;
  if (['eng', 'english', 'en'].includes(raw)) return 'en';
  if (['ben', 'bengali', 'bangla', 'bn'].includes(raw)) return 'bn';
  return raw;
}

/** The uploader's rights label → what it means for making an audiobook. */
export function rightsOf(licenseUrl: unknown, copyrightStatus: unknown): { rights: BookRights; license?: string } {
  const url = (first(licenseUrl) ?? '').toLowerCase();
  if (first(copyrightStatus) === 'NOT_IN_COPYRIGHT') return { rights: 'public_domain', license: 'Not in copyright' };
  if (url.includes('publicdomain/zero')) return { rights: 'public_domain', license: 'CC0' };
  if (url.includes('publicdomain')) return { rights: 'public_domain', license: 'Public domain mark' };
  const cc = /creativecommons\.org\/licenses\/([a-z-]+)(?:\/([\d.]+))?/.exec(url);
  if (cc) {
    const kinds = cc[1].split('-');
    const license = `CC ${cc[1].toUpperCase()}${cc[2] ? ` ${cc[2]}` : ''}`;
    return { rights: kinds.includes('nd') || kinds.includes('nc') ? 'restricted' : 'open', license };
  }
  return { rights: 'unknown' };
}

export function toBook(d: Doc): LibraryBook | undefined {
  const id = first(d.identifier);
  if (!id || !ARCHIVE_ID.test(id)) return undefined;
  const year = yearOf(d.year) ?? yearOf(d.date);
  return {
    source: 'archive',
    id,
    title: first(d.title) ?? id,
    author: first(d.creator),
    year,
    language: languageCode(d.language),
    pages: num(d.imagecount),
    downloads: num(d.downloads),
    coverUrl: `${ARCHIVE}/services/img/${encodeURIComponent(id)}`,
    pageUrl: `${ARCHIVE}/details/${encodeURIComponent(id)}`,
    ...rightsOf(d.licenseurl, d['possible-copyright-status']),
  };
}

/**
 * Downloadable PDFs of an item, best first: with a text layer, then in natural name order (Vol. 2
 * before Vol. 10). Copies of the same scan are left out: the pictures-only `book.pdf` when the
 * archive also made `book_text.pdf` with OCR text, and the grayscale `book_bw.pdf` of `book.pdf`.
 */
export function pdfFiles(files: unknown): LibraryFile[] {
  if (!Array.isArray(files)) return [];
  const rank = (f: LibraryFile) => (f.format === 'Text PDF' ? 0 : f.format === 'Additional Text PDF' ? 1 : 2);
  const pdfs: LibraryFile[] = files
    .filter((f: Doc) => typeof f?.name === 'string' && /\.pdf$/i.test(f.name) && f.private !== 'true' && f.private !== true)
    .map((f: Doc) => ({ name: String(f.name), size: num(f.size) ?? 0, format: first(f.format) ?? 'PDF' }));
  const names = new Set(pdfs.map((f) => f.name.toLowerCase()));
  const copy = (name: string) => {
    const n = name.toLowerCase();
    if (names.has(n.replace(/\.pdf$/, '_text.pdf'))) return true;
    const bw = /^(.*)_bw\.pdf$/.exec(n);
    return !!bw && names.has(`${bw[1]}.pdf`);
  };
  return pdfs.filter((f) => !copy(f.name)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export const archiveDownloadUrl = (id: string, file: string) => `${ARCHIVE}/download/${encodeURIComponent(id)}/${file.split('/').map(encodeURIComponent).join('/')}`;

/** `https://archive.org/details/<id>` (a book's page) → `<id>`. */
export function archiveIdFromUrl(url: URL): string | undefined {
  if (url.hostname !== 'archive.org' && url.hostname !== 'www.archive.org') return undefined;
  const m = /^\/details\/([^/]+)/.exec(url.pathname);
  const id = m ? decodeURIComponent(m[1]) : undefined;
  return id && ARCHIVE_ID.test(id) ? id : undefined;
}

const unavailable = (cause?: unknown) =>
  new AppError('LIBRARY_UNAVAILABLE', 'The online library (archive.org) did not answer.', {
    hint: 'Check your internet connection and try again — archive.org is sometimes slow.',
    retryable: true,
    cause,
  });

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ArchiveClient {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly opts: { timeoutMs?: number; cacheMs?: number; cacheSize?: number } = {},
  ) {}

  private async json(url: string, signal?: AbortSignal): Promise<unknown> {
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < (this.opts.cacheMs ?? 10 * 60_000)) return hit.value;
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 20_000);
    let value: unknown;
    try {
      const res = await this.fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      value = await res.json();
    } catch (e) {
      if (signal?.aborted) throw new AppError('ABORTED', 'The request was cancelled.', { retryable: true, cause: e });
      throw unavailable(e);
    }
    this.cache.delete(url);
    this.cache.set(url, { at: Date.now(), value });
    while (this.cache.size > (this.opts.cacheSize ?? 100)) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  async search(o: SearchOptions, signal?: AbortSignal): Promise<LibrarySearchResult> {
    const params = new URLSearchParams({ q: buildQuery(o), rows: String(PAGE_SIZE), page: String(o.page), output: 'json' });
    for (const f of FIELDS) params.append('fl[]', f);
    params.append('sort[]', 'downloads desc');
    const body = (await this.json(`${ARCHIVE}/advancedsearch.php?${params}`, signal)) as { response?: { numFound?: number; docs?: Doc[] } };
    if (!body?.response || !Array.isArray(body.response.docs)) throw unavailable(new Error('unexpected search response'));
    const books = body.response.docs.map(toBook).filter((b): b is LibraryBook => !!b);
    return { total: body.response.numFound ?? books.length, page: o.page, pageSize: PAGE_SIZE, books };
  }

  async item(id: string, signal?: AbortSignal): Promise<LibraryBookDetail> {
    if (!ARCHIVE_ID.test(id)) throw notFound('Book');
    const body = (await this.json(`${ARCHIVE}/metadata/${encodeURIComponent(id)}`, signal)) as { metadata?: Doc; files?: unknown; is_dark?: boolean };
    // Unknown identifiers answer {}; withdrawn ("dark") items have no files to offer.
    if (!body?.metadata || body.is_dark) throw notFound('Book');
    const m = body.metadata;
    const book = toBook({ ...m, identifier: id });
    if (!book) throw notFound('Book');
    const restricted = first(m['access-restricted-item']) === 'true';
    return { ...book, files: restricted ? [] : pdfFiles(body.files) };
  }
}
