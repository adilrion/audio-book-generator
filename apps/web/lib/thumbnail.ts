import { type ThumbnailDesign, type ThumbnailLayout, YOUTUBE_LIMITS } from '@app/types';

/**
 * YouTube thumbnails drawn on a canvas in the browser (1280×720), so the preview is exactly the
 * JPEG that gets saved. Fonts are the app's own (Newsreader + Geist), Bangla falls back to the
 * system's Bangla fonts through the CSS font stacks.
 */

export const THUMB_W = YOUTUBE_LIMITS.thumbnail.width;
export const THUMB_H = YOUTUBE_LIMITS.thumbnail.height;

export const THUMB_LAYOUTS: { value: ThumbnailLayout; label: string; hint: string }[] = [
  { value: 'cover', label: 'Cover', hint: 'Book cover on a blurred backdrop' },
  { value: 'bold', label: 'Bold', hint: 'Big type on the accent colour' },
  { value: 'minimal', label: 'Minimal', hint: 'Quiet serif on paper' },
  { value: 'photo', label: 'Full image', hint: 'The image fills the frame' },
];

export const THUMB_ACCENTS = ['#FFD54F', '#FF7043', '#EF5350', '#AB47BC', '#42A5F5', '#26A69A', '#9CCC65', '#F5F5F5'];

export const DEFAULT_DESIGN: ThumbnailDesign = { layout: 'cover', kicker: 'Full audiobook', accent: '#FFD54F', showAuthor: true, showBadge: true };

export interface ThumbContent {
  title: string;
  author?: string;
  /** e.g. "38 min · Read-along" */
  badge: string;
  image: HTMLImageElement | null;
  fonts: { serif: string; sans: string };
}

/** The font stacks the page actually uses (next/font gives Geist a generated family name). */
export function pageFonts(): { serif: string; sans: string } {
  const sans = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  return { serif: `'Newsreader Variable', Georgia, 'Bangla Sangam MN', 'Noto Serif Bengali', serif`, sans };
}

export async function loadFonts(fonts: { serif: string; sans: string }): Promise<void> {
  try {
    await Promise.all([document.fonts.load(`600 80px ${fonts.serif}`), document.fonts.load(`800 80px ${fonts.sans}`), document.fonts.load(`500 30px ${fonts.sans}`)]);
  } catch {
    /* draw with whatever is available */
  }
}

/** Load an image that may be drawn and exported from a canvas (CORS for the API's page renders). */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/** Ink that reads on `hex`. */
const inkOn = (hex: string) => (luminance(hex) > 0.6 ? '#141210' : '#ffffff');

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Largest font size (max → min) at which `text` fits in `maxLines` lines of `width`. Set `font` again before drawing. */
function fit(ctx: CanvasRenderingContext2D, text: string, o: { width: number; maxLines: number; max: number; min: number; font: (px: number) => string }): { size: number; lines: string[]; font: string } {
  for (let px = o.max; px >= o.min; px -= 4) {
    ctx.font = o.font(px);
    const lines = wrap(ctx, text, o.width);
    if (lines.length <= o.maxLines && lines.every((l) => ctx.measureText(l).width <= o.width)) return { size: px, lines, font: ctx.font };
  }
  ctx.font = o.font(o.min);
  const lines = wrap(ctx, text, o.width);
  if (lines.length > o.maxLines) {
    const kept = lines.slice(0, o.maxLines);
    kept[o.maxLines - 1] = `${kept[o.maxLines - 1].replace(/\s*\S*$/, '')}…`;
    return { size: o.min, lines: kept, font: ctx.font };
  }
  return { size: o.min, lines, font: ctx.font };
}

/** Draw `img` to cover the rectangle (like CSS object-fit: cover), anchored at the top. */
function cover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number, anchorY = 0) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / s;
  const sh = h / s;
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) * anchorY, sw, sh, x, y, w, h);
}

/** Cheap, portable blur: draw tiny, scale up (canvas `filter` is missing in older Safari). */
function blurred(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
  const small = document.createElement('canvas');
  small.width = 48;
  small.height = 27;
  const sctx = small.getContext('2d')!;
  cover(sctx, img, 0, 0, small.width, small.height, 0.3);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, -40, -40, w + 80, h + 80);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, o: { bg: string; fg: string; font: string; padX?: number; h?: number }) {
  ctx.font = o.font;
  const padX = o.padX ?? 22;
  const h = o.h ?? 52;
  const w = ctx.measureText(text).width + padX * 2;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = o.bg;
  ctx.fill();
  ctx.fillStyle = o.fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
  return w;
}

/** The book (a page image) with a soft shadow and a spine shade. */
function book(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, x: number, y: number, h: number, accent: string, title: string, serif: string) {
  const w = Math.round(h * (img ? Math.min(0.8, img.naturalWidth / img.naturalHeight) : 0.7));
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 48;
  ctx.shadowOffsetY = 18;
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  if (img) cover(ctx, img, x, y, w, h);
  else {
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, w, h);
    const r = fit(ctx, title, { width: w - 60, maxLines: 5, max: 56, min: 24, font: (px) => `600 ${px}px ${serif}` });
    ctx.fillStyle = inkOn(accent);
    ctx.font = r.font;
    r.lines.forEach((l, i) => ctx.fillText(l, x + 30, y + 90 + i * r.size * 1.1));
  }
  const g = ctx.createLinearGradient(x, 0, x + w * 0.08, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w * 0.08, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  return w;
}

export function drawThumbnail(ctx: CanvasRenderingContext2D, d: ThumbnailDesign, c: ThumbContent): void {
  const W = THUMB_W;
  const H = THUMB_H;
  const { serif, sans } = c.fonts;
  const title = c.title.trim() || 'Audiobook';
  const kicker = d.kicker.trim();
  ctx.clearRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  if (d.layout === 'bold') {
    const ink = inkOn(d.accent);
    ctx.fillStyle = d.accent;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(990, 370);
    ctx.rotate((-5 * Math.PI) / 180);
    book(ctx, c.image, -190, -270, 540, '#222', title, serif);
    ctx.restore();
    const r = fit(ctx, title.toUpperCase(), { width: 700, maxLines: 4, max: 132, min: 56, font: (px) => `900 ${px}px ${sans}` });
    const blockH = (kicker ? 84 : 0) + r.lines.length * r.size * 0.98 + 26 + (d.showAuthor && c.author ? 50 : 0);
    let y = Math.max(60, (H - blockH) / 2 - (d.showBadge ? 30 : 0));
    if (kicker) {
      pill(ctx, kicker.toUpperCase(), 64, y, { bg: ink, fg: d.accent, font: `800 28px ${sans}` });
      y += 84;
    }
    ctx.fillStyle = ink;
    ctx.font = r.font;
    r.lines.forEach((l, i) => ctx.fillText(l, 60, y + r.size * 0.88 + i * r.size * 0.98));
    y += r.lines.length * r.size * 0.98 + 26;
    if (d.showAuthor && c.author) {
      ctx.font = `600 38px ${sans}`;
      ctx.globalAlpha = 0.85;
      ctx.fillText(c.author, 64, y + 30);
      ctx.globalAlpha = 1;
    }
    if (d.showBadge) pill(ctx, c.badge, 64, H - 100, { bg: ink, fg: d.accent, font: `700 26px ${sans}`, h: 50 });
    return;
  }

  if (d.layout === 'minimal') {
    ctx.fillStyle = '#F4EFE6';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = d.accent;
    ctx.fillRect(0, H - 18, W, 18);
    book(ctx, c.image, 860, 110, 500, d.accent, title, serif);
    ctx.fillStyle = '#2A2622';
    let y = 150;
    if (kicker) {
      ctx.font = `600 26px ${sans}`;
      ctx.letterSpacing = '6px';
      ctx.fillStyle = '#7A6A55';
      ctx.fillText(kicker.toUpperCase(), 80, y);
      ctx.letterSpacing = '0px';
      y += 40;
    }
    ctx.fillStyle = d.accent === '#F5F5F5' ? '#2A2622' : d.accent;
    ctx.fillRect(80, y, 90, 6);
    y += 30;
    const r = fit(ctx, title, { width: 700, maxLines: 4, max: 112, min: 52, font: (px) => `500 ${px}px ${serif}` });
    ctx.fillStyle = '#211D19';
    ctx.font = r.font;
    r.lines.forEach((l, i) => ctx.fillText(l, 76, y + r.size * 0.92 + i * r.size * 1.04));
    y += r.lines.length * r.size * 1.04 + 20;
    if (d.showAuthor && c.author) {
      ctx.font = `italic 400 42px ${serif}`;
      ctx.fillStyle = '#5B5146';
      ctx.fillText(c.author, 80, y + 34);
    }
    if (d.showBadge) {
      ctx.font = `600 26px ${sans}`;
      ctx.fillStyle = '#5B5146';
      ctx.fillText(c.badge, 80, H - 70);
    }
    return;
  }

  // cover + photo: the image fills the background
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, 0, W, H);
  if (c.image) {
    if (d.layout === 'photo') cover(ctx, c.image, 0, 0, W, H, 0.35);
    else blurred(ctx, c.image, W, H);
  }
  const shade = d.layout === 'photo' ? ctx.createLinearGradient(0, H * 0.25, 0, H) : ctx.createLinearGradient(0, 0, W, 0);
  shade.addColorStop(0, d.layout === 'photo' ? 'rgba(0,0,0,0)' : 'rgba(8,8,8,0.92)');
  shade.addColorStop(d.layout === 'photo' ? 1 : 0.62, 'rgba(8,8,8,0.82)');
  if (d.layout !== 'photo') shade.addColorStop(1, 'rgba(8,8,8,0.35)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);

  const textW = d.layout === 'photo' ? 1120 : 700;
  if (d.layout === 'cover') book(ctx, c.image, 860, 70, 580, d.accent, title, serif);
  const r = fit(ctx, title, { width: textW, maxLines: d.layout === 'photo' ? 2 : 4, max: d.layout === 'photo' ? 120 : 112, min: 52, font: (px) => `600 ${px}px ${serif}` });
  const authorH = d.showAuthor && c.author ? 64 : 0;
  const kickerH = kicker ? 80 : 0;
  const blockH = kickerH + r.lines.length * r.size * 1.02 + authorH;
  let y = d.layout === 'photo' ? H - 70 - (d.showBadge ? 70 : 0) - blockH : Math.max(70, (H - blockH) / 2 - (d.showBadge ? 20 : 0));
  if (kicker) {
    pill(ctx, kicker.toUpperCase(), 64, y, { bg: d.accent, fg: inkOn(d.accent), font: `800 26px ${sans}`, h: 50 });
    y += kickerH;
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = r.font;
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 16;
  r.lines.forEach((l, i) => ctx.fillText(l, 60, y + r.size * 0.86 + i * r.size * 1.02));
  y += r.lines.length * r.size * 1.02;
  if (authorH) {
    ctx.font = `500 40px ${sans}`;
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.fillText(c.author!, 64, y + 46);
  }
  ctx.shadowBlur = 0;
  if (d.showBadge) {
    ctx.font = `700 26px ${sans}`;
    const by = d.layout === 'photo' ? H - 100 : H - 96;
    pill(ctx, c.badge, 64, by, { bg: 'rgba(255,255,255,0.14)', fg: '#fff', font: `700 26px ${sans}`, h: 48 });
  }
}

/** Encode as JPEG within YouTube's 2 MB limit. */
export async function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  for (const q of [0.92, 0.85, 0.75, 0.6]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= YOUTUBE_LIMITS.thumbnailBytes) return blob;
  }
  throw new Error('The thumbnail is too large to save.');
}
