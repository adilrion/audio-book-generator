import { type LanguageCode, SHORT_THUMB_SIZE, type ShortTheme, type ShortThumbLayout, type ShortThumbnail } from '@app/types';
import { motionBlend } from './short-scenes';
import { SHORT_THEMES } from './shorts';

/**
 * Vertical thumbnails for YouTube Shorts (1080×1920), drawn on a canvas in the browser so the
 * preview is exactly the JPEG that gets saved. The look follows the short: its background, its
 * accent colour and the caption font. Important text stays in the middle of the frame, clear of
 * the title and buttons YouTube draws over a Short.
 */

export const THUMB_W = SHORT_THUMB_SIZE.width;
export const THUMB_H = SHORT_THUMB_SIZE.height;

export const SHORT_THUMB_LAYOUTS: { value: ShortThumbLayout; label: string; hint: string }[] = [
  { value: 'headline', label: 'Big hook', hint: 'Huge words on the short’s background — stops the scroll' },
  { value: 'cover', label: 'Book cover', hint: 'The cover, with the hook under it' },
  { value: 'quote', label: 'Quote', hint: 'The script’s first line, in quotes' },
];

export interface ShortThumbContent {
  title: string;
  /** The script's first sentence (the Quote layout). */
  firstLine: string;
  theme: ShortTheme;
  uppercase: boolean;
  language: LanguageCode;
  bookTitle?: string;
  author?: string;
  cover: HTMLImageElement | null;
  /** A still of the animated background (lib/short-scenes.ts), when the short has one. */
  scene?: HTMLImageElement | null;
  /** A still of the motion overlay, drawn over the background. */
  motion?: HTMLImageElement | null;
}

export function defaultShortThumbnail(o: { accent: string; language: LanguageCode; hasBook: boolean }): ShortThumbnail {
  return { layout: o.hasBook ? 'cover' : 'headline', headline: '', kicker: o.hasBook ? (o.language === 'bn' ? 'অডিওবুক' : 'Audiobook') : '', accent: o.accent };
}

const BANGLA = /[ঀ-৿]/;
const SANS = '"Avenir Next", "Helvetica Neue", "Arial Black", system-ui, sans-serif';
const BANGLA_SANS = '"Kohinoor Bangla", "Bangla Sangam MN", "Noto Sans Bengali", system-ui, sans-serif';
const SERIF = '"Newsreader Variable", Georgia, "Bangla Sangam MN", "Noto Serif Bengali", serif';
const INK = '#1c1917';

/** Canvas wants commas in rgb(); the theme table uses CSS 4 spaces. */
const color = (c: string) => c.replace(/rgb\((\d+) (\d+) (\d+)\)/, 'rgb($1,$2,$3)');

interface Word {
  t: string;
  accent: boolean;
}

/** "The *loneliest* job" → words, the starred ones in the accent colour. */
export function headlineWords(text: string): Word[] {
  const out: Word[] = [];
  for (const part of text.split(/(\*[^*]+\*)/)) {
    const accent = /^\*[^*]+\*$/.test(part);
    for (const t of part.replace(/^\*|\*$/g, '').split(/\s+/).filter(Boolean)) out.push({ t, accent });
  }
  return out;
}

function captionFont(size: number, text: string) {
  return BANGLA.test(text) ? `700 ${size}px ${BANGLA_SANS}` : `900 ${size}px ${SANS}`;
}

/** Largest size from `max` down to `min` at which the words fit in `maxLines` lines of `maxW`. */
function fit(ctx: CanvasRenderingContext2D, words: Word[], maxW: number, maxLines: number, max: number, min: number, font: (s: number) => string) {
  let size = max;
  for (;;) {
    ctx.font = font(size);
    const space = ctx.measureText(' ').width;
    const lines: Word[][] = [[]];
    let w = 0;
    let tooWide = false;
    for (const word of words) {
      const ww = ctx.measureText(word.t).width;
      if (ww > maxW) tooWide = true;
      if (lines[lines.length - 1].length && w + space + ww > maxW) {
        lines.push([]);
        w = 0;
      }
      w += (lines[lines.length - 1].length ? space : 0) + ww;
      lines[lines.length - 1].push(word);
    }
    if ((lines.length <= maxLines && !tooWide) || size <= min) return { size, lines };
    size = Math.max(min, Math.round(size * 0.92));
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function background(ctx: CanvasRenderingContext2D, c: ShortThumbContent, useCover: boolean) {
  const W = THUMB_W;
  const H = THUMB_H;
  if (useCover && c.cover) {
    const s = Math.max(W / c.cover.width, H / c.cover.height) * 1.15;
    const w = c.cover.width * s;
    const h = c.cover.height * s;
    ctx.save();
    ctx.filter = 'blur(48px) brightness(0.45) saturate(1.15)';
    ctx.drawImage(c.cover, (W - w) / 2, (H - h) / 2, w, h);
    ctx.restore();
  } else if (c.scene) {
    ctx.drawImage(c.scene, 0, 0, W, H);
  } else {
    const t = SHORT_THEMES[c.theme === 'cover' ? 'midnight' : c.theme];
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, color(t.top));
    g.addColorStop(1, color(t.bottom));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  const light = !useCover && SHORT_THEMES[c.theme]?.light;
  if (c.motion) {
    ctx.save();
    ctx.globalCompositeOperation = motionBlend(!!light);
    ctx.drawImage(c.motion, 0, 0, W, H);
    ctx.restore();
  }
  const glow = ctx.createRadialGradient(W / 2, H * 0.5, 0, W / 2, H * 0.5, H * 0.45);
  glow.addColorStop(0, light ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, light ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.45)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

/** Centered lines of words; accent words in the accent colour (a marker block on light backgrounds). */
function drawWords(ctx: CanvasRenderingContext2D, lines: Word[][], size: number, cy: number, o: { accent: string; light: boolean; font: (s: number) => string; lineHeight: number }) {
  ctx.font = o.font(size);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const space = ctx.measureText(' ').width;
  const lh = size * o.lineHeight;
  const top = cy - (lines.length * lh) / 2;
  lines.forEach((line, li) => {
    const widths = line.map((w) => ctx.measureText(w.t).width);
    let x = (THUMB_W - (widths.reduce((a, b) => a + b, 0) + space * (line.length - 1))) / 2;
    const base = top + li * lh + size * 0.82;
    line.forEach((w, i) => {
      if (o.light) {
        if (w.accent) {
          ctx.fillStyle = o.accent;
          roundRect(ctx, x - size * 0.08, base - size * 0.78, widths[i] + size * 0.16, size * 0.98, size * 0.14);
          ctx.fill();
        }
        ctx.fillStyle = INK;
      } else {
        ctx.lineJoin = 'round';
        ctx.lineWidth = size * 0.16;
        ctx.strokeStyle = '#000';
        ctx.strokeText(w.t, x, base);
        ctx.fillStyle = w.accent ? o.accent : '#fff';
      }
      ctx.fillText(w.t, x, base);
      x += widths[i] + space;
    });
  });
  return top + lines.length * lh;
}

function kickerPill(ctx: CanvasRenderingContext2D, text: string, cy: number, accent: string) {
  if (!text.trim()) return;
  const t = BANGLA.test(text) ? text : text.toUpperCase();
  ctx.font = BANGLA.test(t) ? `700 50px ${BANGLA_SANS}` : `800 46px ${SANS}`;
  const w = ctx.measureText(t).width + 72;
  const h = 92;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = accent;
  roundRect(ctx, (THUMB_W - w) / 2, cy - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(t, THUMB_W / 2, cy + 3);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function byline(ctx: CanvasRenderingContext2D, c: ShortThumbContent, y: number, light: boolean) {
  const text = [c.bookTitle, c.author].filter(Boolean).join(' · ');
  if (!text) return;
  ctx.font = BANGLA.test(text) ? `600 44px ${BANGLA_SANS}` : `600 42px ${SANS}`;
  ctx.fillStyle = light ? 'rgba(28,25,23,0.75)' : 'rgba(255,255,255,0.85)';
  ctx.textAlign = 'center';
  let t = text;
  while (ctx.measureText(t).width > THUMB_W * 0.84 && t.length > 4) t = `${t.slice(0, -2).trimEnd()}…`.replace(/……$/, '…');
  ctx.fillText(t, THUMB_W / 2, y);
  ctx.textAlign = 'left';
}

/** Draw the thumbnail at full size (1080×1920) into `ctx`. */
export function drawShortThumbnail(ctx: CanvasRenderingContext2D, d: ShortThumbnail, c: ShortThumbContent): void {
  const layout: ShortThumbLayout = d.layout === 'cover' && !c.cover ? 'headline' : d.layout;
  const useCover = (layout === 'cover' || c.theme === 'cover') && !!c.cover;
  const light = !useCover && !!SHORT_THEMES[c.theme]?.light;
  ctx.clearRect(0, 0, THUMB_W, THUMB_H);
  background(ctx, c, useCover);
  const raw = (d.headline.trim() || c.title).trim();
  const text = c.uppercase && c.language !== 'bn' ? raw.toUpperCase() : raw;
  const words = headlineWords(text);
  const font = (s: number) => captionFont(s, text);
  const bn = BANGLA.test(text);

  if (layout === 'cover' && c.cover) {
    const maxW = THUMB_W * 0.62;
    const maxH = THUMB_H * 0.4;
    const s = Math.min(maxW / c.cover.width, maxH / c.cover.height);
    const w = c.cover.width * s;
    const h = c.cover.height * s;
    const x = (THUMB_W - w) / 2;
    const y = THUMB_H * 0.13;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 60;
    ctx.shadowOffsetY = 24;
    roundRect(ctx, x, y, w, h, 24);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, x, y, w, h, 24);
    ctx.clip();
    ctx.drawImage(c.cover, x, y, w, h);
    ctx.restore();
    const ky = y + h + 90;
    kickerPill(ctx, d.kicker, ky, d.accent);
    const { size, lines } = fit(ctx, words, THUMB_W * 0.88, 3, 140, 64, font);
    const block = lines.length * size * (bn ? 1.3 : 1.08);
    drawWords(ctx, lines, size, ky + 80 + block / 2, { accent: d.accent, light, font, lineHeight: bn ? 1.3 : 1.08 });
    return;
  }

  if (layout === 'quote') {
    const line = (c.firstLine || raw).replace(/^["“'‘]|["”'’]$/g, '');
    kickerPill(ctx, d.kicker, THUMB_H * 0.2, d.accent);
    ctx.font = `700 360px ${SERIF}`;
    ctx.fillStyle = d.accent;
    ctx.textAlign = 'center';
    ctx.fillText('“', THUMB_W / 2, THUMB_H * 0.36);
    ctx.textAlign = 'left';
    const qwords = line.split(/\s+/).filter(Boolean).map((t) => ({ t, accent: false }));
    const qfont = (s: number) => (BANGLA.test(line) ? `600 ${s}px ${BANGLA_SANS}` : `italic 600 ${s}px ${SERIF}`);
    const { size, lines } = fit(ctx, qwords, THUMB_W * 0.84, 7, 96, 48, qfont);
    ctx.save();
    if (!light) {
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 20;
    }
    ctx.font = qfont(size);
    ctx.fillStyle = light ? INK : '#fff';
    ctx.textAlign = 'center';
    const lh = size * 1.28;
    const top = THUMB_H * 0.5 - (lines.length * lh) / 2;
    lines.forEach((ln, i) => ctx.fillText(ln.map((w) => w.t).join(' '), THUMB_W / 2, top + i * lh + size));
    ctx.restore();
    const end = top + lines.length * lh;
    const headlineBlock = fit(ctx, words, THUMB_W * 0.86, 2, 96, 56, font);
    drawWords(ctx, headlineBlock.lines, headlineBlock.size, end + 120 + headlineBlock.lines.length * headlineBlock.size * 0.55, { accent: d.accent, light, font, lineHeight: bn ? 1.3 : 1.08 });
    byline(ctx, c, THUMB_H * 0.8, light);
    return;
  }

  // headline
  kickerPill(ctx, d.kicker, THUMB_H * 0.27, d.accent);
  const { size, lines } = fit(ctx, words, THUMB_W * 0.88, 5, 190, 80, font);
  drawWords(ctx, lines, size, THUMB_H * 0.5, { accent: d.accent, light, font, lineHeight: bn ? 1.28 : 1.04 });
  byline(ctx, c, THUMB_H * 0.76, light);
}

/** The script's first sentence, for the Quote layout. */
export function firstSentence(script: string): string {
  const s = script.trim().split(/(?<=[.!?।])\s+/)[0] ?? '';
  return s.length > 180 ? `${s.slice(0, 177).trimEnd()}…` : s;
}
