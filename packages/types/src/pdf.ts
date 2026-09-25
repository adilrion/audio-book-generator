/** [x0, y0, x1, y1] in PDF points, origin top-left (PyMuPDF convention). */
export type Rect = [number, number, number, number];

export interface ExtractedWord {
  /** text */
  t: string;
  /** bbox */
  b: Rect;
}

export interface ExtractedLine {
  b: Rect;
  /** dominant font size in pt */
  size: number;
  font: string;
  bold: boolean;
  italic: boolean;
  words: ExtractedWord[];
}

export interface ExtractedBlock {
  b: Rect;
  lines: ExtractedLine[];
}

export interface ExtractedPage {
  /** 1-based */
  page: number;
  width: number;
  height: number;
  blocks: ExtractedBlock[];
  /** Text came from OCR rather than the PDF text layer. */
  ocr?: boolean;
}

export interface TocEntry {
  level: number;
  title: string;
  /** 1-based page, or -1 if unresolved */
  page: number;
}

export interface PdfInspection {
  pageCount: number;
  encrypted: boolean;
  needsPassword: boolean;
  title?: string;
  author?: string;
  estimatedWords: number;
  /** Sampled pages with an empty text layer but visible images. */
  likelyScanned: boolean;
  hasToc: boolean;
  fileSize: number;
}

export interface ExtractionMeta {
  pdfHash: string;
  extractorVersion: string;
  pageCount: number;
  title?: string;
  author?: string;
  toc: TocEntry[];
  wordCount: number;
  /** 1-based pages with no usable text (and not OCRed). */
  emptyPages: number[];
  ocrPages: number[];
  /** path of pages.jsonl relative to the extraction dir */
  pagesFile: string;
  /** [width, height] in points, index = page - 1 */
  pageSizes: [number, number][];
}
