import { type BookRights, type LibraryBook, type LibraryFile, type LibraryLanguage, displayAuthor } from '@app/types';

export { displayAuthor };
import { formatBytes } from './format';
import { languageName } from './voices';

export const RIGHTS: Record<BookRights, { label: string; variant: 'success' | 'info' | 'warning' | 'muted'; help: string }> = {
  public_domain: { label: 'Public domain', variant: 'success', help: 'Labelled public domain: free to turn into an audiobook and publish.' },
  open: { label: 'Open licence', variant: 'info', help: 'Free to adapt and publish, with credit to the author.' },
  restricted: {
    label: 'Restricted licence',
    variant: 'warning',
    help: 'NoDerivatives or NonCommercial licence — publishing an audiobook (especially a monetised one) may not be allowed.',
  },
  unknown: { label: 'Rights unknown', variant: 'muted', help: 'The book’s page says nothing about copyright. Check before publishing.' },
};

export function rightsBadge(book: Pick<LibraryBook, 'rights' | 'license'>) {
  const r = RIGHTS[book.rights];
  // "CC BY-SA 4.0" says more than "Open licence"; the public-domain labels all mean the same.
  const label = book.rights === 'open' || book.rights === 'restricted' ? (book.license ?? r.label) : r.label;
  return { ...r, label, help: book.license && label !== book.license ? `${book.license}. ${r.help}` : r.help };
}

/** "Jane Austen · 1894 · 518 pages · English" */
export function bookMeta(book: LibraryBook): string {
  return [displayAuthor(book.author), book.year, book.pages ? `${book.pages} pages` : undefined, book.language ? languageName(book.language) : undefined].filter(Boolean).join(' · ');
}

/** "Text PDF" / "Additional Text PDF" files have the archive's OCR text layer; the others need OCR here (slower). */
export const fileMeta = (f: LibraryFile) => [f.size ? formatBytes(f.size) : undefined, /text pdf$/i.test(f.format) ? 'with text' : f.format].filter(Boolean).join(' · ');

/** A pasted link the API can try: http(s) only. Returns a user-facing problem, or undefined. */
export function linkProblem(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return 'Paste a link first.';
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return 'That is not a full link — it should start with https://';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Only http:// and https:// links can be downloaded.';
  return undefined;
}

/** A name to show while a pasted link downloads: the file name in the link, else the website. */
export function linkLabel(raw: string): string {
  try {
    const url = new URL(raw.trim());
    const last = url.pathname.split('/').filter(Boolean).pop();
    let name = last;
    try {
      name = last ? decodeURIComponent(last) : undefined;
    } catch {
      name = last;
    }
    return name && /\.pdf$/i.test(name) ? name : url.hostname.replace(/^www\./, '');
  } catch {
    return raw.trim();
  }
}

type Params = Record<string, string | string[] | undefined>;
const param = (sp: Params, k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);

/** /discover?q=…&lang=bn&free=0 → the library search to open with. */
export function parseLibrarySearch(sp: Params): { q?: string; language?: LibraryLanguage; free?: boolean } {
  const lang = param(sp, 'lang');
  return {
    q: param(sp, 'q')?.slice(0, 200),
    language: lang === 'en' || lang === 'bn' ? lang : undefined,
    free: param(sp, 'free') === '0' ? false : undefined,
  };
}

/** The search as a query string, defaults left out ("" for the plain shelf). */
export function librarySearchQuery(s: { q: string; language: LibraryLanguage; free: boolean }): string {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  if (s.language !== 'any') p.set('lang', s.language);
  if (!s.free) p.set('free', '0');
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/** New audiobook with a library book already chosen. */
export const libraryNewUrl = (id: string, file?: string) => `/new?${new URLSearchParams(file ? { archive: id, file } : { archive: id })}`;

export type NewSourceTab = 'upload' | 'library' | 'link';

/** /new?archive=<id>&file=<pdf> starts with that book; ?source=library|link opens that tab. */
export function parseNewParams(sp: Params): { book?: { id: string; file?: string }; tab?: NewSourceTab } {
  const id = param(sp, 'archive');
  const source = param(sp, 'source');
  const book = id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? { id, file: param(sp, 'file') || undefined } : undefined;
  return { book, tab: book ? 'library' : source === 'library' || source === 'link' ? source : undefined };
}
