import type { Rect } from '@app/types';

/** A printed piece of a word on a page. A de-hyphenated word has two parts (two lines, maybe two pages). */
export interface Part {
  page: number;
  b: Rect;
}

/** A word as spoken/displayed, with every place it is printed. */
export interface Token {
  t: string;
  parts: Part[];
}

export interface Line {
  page: number;
  block: number;
  b: Rect;
  size: number;
  bold: boolean;
  italic: boolean;
  tokens: Token[];
  text: string;
}

export interface CleanPage {
  page: number;
  width: number;
  height: number;
  lines: Line[];
}

export const TERMINAL = /[.!?…]["'”’)\]]*$/;
export const LOWER_START = /^["'“‘(\[]?\p{Ll}/u;

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}
