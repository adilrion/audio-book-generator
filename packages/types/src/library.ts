import type { ProjectDetail } from './api';
import type { UserFacingError } from './status';

/** Where an online book comes from. Only the Internet Archive (archive.org) for now. */
export type LibrarySource = 'archive';

export type LibraryLanguage = 'any' | 'en' | 'bn';

/**
 * What the book's page says about its copyright. A label set by the uploader, not a legal check:
 * `public_domain` (public-domain mark, CC0 or "not in copyright"), `open` (CC BY / BY-SA: free to
 * adapt with credit), `restricted` (a NoDerivatives or NonCommercial licence) or `unknown`.
 */
export type BookRights = 'public_domain' | 'open' | 'restricted' | 'unknown';

export interface LibraryBook {
  source: LibrarySource;
  id: string;
  title: string;
  author?: string;
  year?: number;
  /** 'en', 'bn', or the archive's own code for another language. */
  language?: string;
  /** Scanned page count, when the archive knows it. */
  pages?: number;
  downloads?: number;
  coverUrl: string;
  /** The book's page on the source site. */
  pageUrl: string;
  rights: BookRights;
  /** Short licence name, e.g. "CC BY-NC-ND 4.0" or "Public domain mark". */
  license?: string;
}

/** GET /library/search */
export interface LibrarySearchResult {
  total: number;
  page: number;
  pageSize: number;
  books: LibraryBook[];
}

export interface LibraryFile {
  name: string;
  size: number;
  /** "Text PDF" has a text layer (the archive's OCR); "Image Container PDF" is pictures only. */
  format: string;
}

/** GET /library/archive/:id — the book with its downloadable PDFs (several for multi-volume items), best first. */
export interface LibraryBookDetail extends LibraryBook {
  files: LibraryFile[];
}

/** One line of the POST /projects/import response (NDJSON), sent once the download has started. */
export type ImportEvent =
  | { type: 'progress'; phase: 'downloading'; received: number; total?: number }
  | { type: 'progress'; phase: 'inspecting' }
  | { type: 'done'; project: ProjectDetail }
  | { type: 'error'; error: UserFacingError };

/** Library catalogue names → how a reader writes them: "Austen, Jane, 1775-1817" → "Jane Austen". */
export function displayAuthor(author?: string): string | undefined {
  if (!author) return undefined;
  const plain = author
    .replace(/,?\s*\(?(?:(?:b|d|fl|ca)\.\s*\d{3,4}\??|\d{3,4}\??\s*-\s*(?:\d{3,4}\??)?)\)?\.?\s*$/i, '') // life dates: "1775-1817", "1812-", "b. 1843?"
    .replace(/\s*\([^)]*\)\s*$/, '') // "(William Butler)" expansions
    .trim()
    .replace(/,$/, '');
  const parts = plain.split(',').map((p) => p.trim()).filter(Boolean);
  // "Surname, Given names" — not "Rabindranath Tagore, রবীন্দ্রনাথ ঠাকুর" or "Marcus Aurelius, Emperor of Rome".
  const surname = parts[0]?.split(/\s+/) ?? [];
  const isSurname = surname.length === 1 || (surname.length === 2 && /^(?:de|da|di|du|la|le|van|von|der|del)$/i.test(surname[0]));
  return parts.length === 2 && isSurname && !/\d/.test(plain) ? `${parts[1]} ${parts[0]}` : plain || author;
}
