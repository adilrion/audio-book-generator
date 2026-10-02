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
