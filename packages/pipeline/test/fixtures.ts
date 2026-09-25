import type { ExtractedLine, ExtractedPage } from '@app/types';

export interface L {
  text: string;
  x?: number;
  y: number;
  size?: number;
  bold?: boolean;
}

/** Build an ExtractedPage with approximate word boxes (0.5em per char). */
export function page(n: number, lines: L[], w = 432, h = 648): ExtractedPage {
  const toLine = (l: L): ExtractedLine => {
    const size = l.size ?? 11;
    let x = l.x ?? 54;
    const words = l.text.split(' ').filter(Boolean).map((t) => {
      const b: [number, number, number, number] = [x, l.y, x + t.length * size * 0.5, l.y + size];
      x = b[2] + size * 0.3;
      return { t, b };
    });
    return {
      b: [words[0].b[0], l.y, words[words.length - 1].b[2], l.y + size],
      size,
      font: l.bold ? 'Times-Bold' : 'Times-Roman',
      bold: !!l.bold,
      italic: false,
      words,
    };
  };
  return { page: n, width: w, height: h, blocks: [{ b: [0, 0, w, h], lines: lines.map(toLine) }] };
}

/** A body paragraph as consecutive full-width lines starting at y. */
export function bodyLines(texts: string[], y0: number, indentFirst = true, pitch = 15): L[] {
  return texts.map((text, i) => ({ text, x: i === 0 && indentFirst ? 68 : 54, y: y0 + i * pitch }));
}
