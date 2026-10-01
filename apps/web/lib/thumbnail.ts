import { type ThumbnailDesign, type ThumbnailLayout, YOUTUBE_LIMITS } from '@app/types';

/**
 * YouTube thumbnails drawn on a canvas in the browser (1280×720), so the preview is exactly the
 * JPEG that gets saved. Fonts are the app's own (Newsreader + Geist), Bangla falls back to the
 * system's Bangla fonts through the CSS font stacks.
 */

export const THUMB_W = YOUTUBE_LIMITS.thumbnail.width;
export const THUMB_H = YOUTUBE_LIMITS.thumbnail.height;

/** Every layout keeps the book title big and readable on a phone — the first thing searchers check. */
export const THUMB_LAYOUTS: { value: ThumbnailLayout; label: string; hint: string }[] = [
  { value: 'cover', label: 'Cover', hint: 'Book cover on a blurred backdrop — a safe, classic choice' },
  { value: 'player', label: 'Listen now', hint: 'Play button and sound wave: says “audiobook” at a glance' },
  { value: 'quote', label: 'Opening line', hint: 'The book’s first sentence as a hook — makes people curious' },
  { value: 'bold', label: 'Bold', hint: 'Huge title on the accent colour — stands out in a feed' },
  { value: 'split', label: 'Split', hint: 'Title panel next to the cover art' },
  { value: 'cinematic', label: 'Cinematic', hint: 'Centred title, film-poster look' },
  { value: 'ribbon', label: 'Ribbon', hint: 'Corner ribbon with the format, cover on the left' },
  { value: 'minimal', label: 'Minimal', hint: 'Quiet serif on paper — literary classics' },
  { value: 'photo', label: 'Full image', hint: 'Your image fills the frame' },
];

export const THUMB_ACCENTS = ['#FFD54F', '#FF7043', '#EF5350', '#AB47BC', '#42A5F5', '#26A69A', '#9CCC65', '#F5F5F5'];

export const DEFAULT_DESIGN: ThumbnailDesign = { layout: 'cover', kicker: 'Full audiobook', accent: '#FFD54F', showAuthor: true, showBadge: true };

export interface ThumbContent {
  title: string;
  author?: string;
  /** e.g. "38 min · With text" */
  badge: string;
  image: HTMLImageElement | null;
  /** The book's first sentence, for the "Opening line" layout. */
  quote?: string;
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

/** A stable 0..1 sequence from a string (the same title always draws the same sound wave). */
function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function darker(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(v * f);
  return `rgb(${c((n >> 16) & 255)} ${c((n >> 8) & 255)} ${c(n & 255)})`;
}

function backdrop(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, W: number, H: number, shade: number) {
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, 0, W, H);
  if (img) blurred(ctx, img, W, H);
  ctx.fillStyle = `rgba(8,8,8,${shade})`;
  ctx.fillRect(0, 0, W, H);
}

/** Title (+ author) block, left-aligned at x; returns the y below it. */
function titleBlock(ctx: CanvasRenderingContext2D, o: { title: string; author?: string; x: number; y: number; width: number; maxLines: number; max: number; min: number; font: (px: number) => string; color: string; authorColor: string; authorFont: string; lead?: number }) {
  const r = fit(ctx, o.title, { width: o.width, maxLines: o.maxLines, max: o.max, min: o.min, font: o.font });
  ctx.font = r.font;
  ctx.fillStyle = o.color;
  const lead = o.lead ?? 1.02;
  r.lines.forEach((l, i) => ctx.fillText(l, o.x, o.y + r.size * 0.86 + i * r.size * lead));
  let y = o.y + r.lines.length * r.size * lead;
  if (o.author) {
    ctx.font = o.authorFont;
    ctx.fillStyle = o.authorColor;
    ctx.fillText(o.author, o.x + 4, y + 44);
    y += 60;
  }
  return y;
}

function drawPlayer(ctx: CanvasRenderingContext2D, d: ThumbnailDesign, c: ThumbContent, title: string, kicker: string) {
  const W = THUMB_W;
  const H = THUMB_H;
  const { serif, sans } = c.fonts;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, darker(d.accent, 0.42));
  g.addColorStop(1, '#0B0B0C');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  book(ctx, c.image, 70, 95, 530, d.accent, title, serif);
  const x = 520;
  let y = 120;
  if (kicker) {
    pill(ctx, kicker.toUpperCase(), x, y, { bg: d.accent, fg: inkOn(d.accent), font: `800 26px ${sans}`, h: 50 });
    y += 76;
  }
  y = titleBlock(ctx, { title, author: d.showAuthor ? c.author : undefined, x, y, width: 700, maxLines: 3, max: 104, min: 50, font: (px) => `800 ${px}px ${sans}`, color: '#fff', authorColor: 'rgba(255,255,255,0.78)', authorFont: `500 38px ${sans}`, lead: 1 });
  // Player: play button, sound wave, time.
  const py = Math.max(y + 40, H - 170);
  ctx.beginPath();
  ctx.arc(x + 46, py + 46, 46, 0, Math.PI * 2);
  ctx.fillStyle = d.accent;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + 34, py + 24);
  ctx.lineTo(x + 34, py + 68);
  ctx.lineTo(x + 70, py + 46);
  ctx.closePath();
  ctx.fillStyle = inkOn(d.accent);
  ctx.fill();
  const rand = seeded(title);
  const bars = 34;
  for (let i = 0; i < bars; i++) {
    const h = 14 + Math.round(rand() * 60);
    ctx.fillStyle = i < bars * 0.35 ? d.accent : 'rgba(255,255,255,0.35)';
    roundRect(ctx, x + 120 + i * 17, py + 46 - h / 2, 9, h, 4);
    ctx.fill();
  }
  if (d.showBadge) {
    ctx.font = `700 28px ${sans}`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(c.badge, x + 4, py + 136);
  }
}

function drawQuote(ctx: CanvasRenderingContext2D, d: ThumbnailDesign, c: ThumbContent, title: string, kicker: string) {
  const W = THUMB_W;
  const H = THUMB_H;
  const { serif, sans } = c.fonts;
  backdrop(ctx, c.image, W, H, 0.78);
  ctx.fillStyle = d.accent;
  ctx.font = `700 260px ${serif}`;
  ctx.fillText('“', 40, 250);
  const quote = (c.quote ?? '').trim() || title;
  const q = fit(ctx, quote, { width: 1100, maxLines: 4, max: 76, min: 44, font: (px) => `italic 500 ${px}px ${serif}` });
  ctx.font = q.font;
  ctx.fillStyle = '#fff';
  let y = 200;
  q.lines.forEach((l, i) => ctx.fillText(l, 90, y + q.size * 0.86 + i * q.size * 1.12));
  y += q.lines.length * q.size * 1.12 + 40;
  ctx.fillStyle = d.accent;
  ctx.fillRect(94, y, 80, 6);
  y += 26;
  const t = fit(ctx, title.toUpperCase(), { width: 760, maxLines: 1, max: 56, min: 30, font: (px) => `800 ${px}px ${sans}` });
  ctx.font = t.font;
  ctx.fillStyle = '#fff';
  ctx.fillText(t.lines[0] ?? '', 92, y + t.size * 0.86);
  let bx = 92;
  const by = H - 92;
  if (kicker) bx += pill(ctx, kicker.toUpperCase(), bx, by, { bg: d.accent, fg: inkOn(d.accent), font: `800 24px ${sans}`, h: 46 }) + 14;
  if (d.showAuthor && c.author) {
    ctx.font = `500 34px ${sans}`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.author, bx + 6, by + 24);
    bx += ctx.measureText(c.author).width + 34;
    ctx.textBaseline = 'alphabetic';
  }
  if (d.showBadge) pill(ctx, c.badge, Math.max(bx, W - 420), by, { bg: 'rgba(255,255,255,0.14)', fg: '#fff', font: `700 24px ${sans}`, h: 46 });
}

function drawSplit(ctx: CanvasRenderingContext2D, d: ThumbnailDesign, c: ThumbContent, title: string, kicker: string) {
  const W = THUMB_W;
  const H = THUMB_H;
  const { sans } = c.fonts;
  const ink = inkOn(d.accent);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(640, 0);
  ctx.lineTo(W, 0);
  ctx.lineTo(W, H);
  ctx.lineTo(560, H);
  ctx.closePath();
  ctx.clip();
  if (c.image) cover(ctx, c.image, 560, 0, W - 560, H, 0.2);
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(660, 0);
  ctx.lineTo(580, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = d.accent;
  ctx.fill();
  let y = 90;
  if (kicker) {
    pill(ctx, kicker.toUpperCase(), 56, y, { bg: ink, fg: d.accent, font: `800 26px ${sans}`, h: 50 });
    y += 82;
  }
  y = titleBlock(ctx, { title: title.toUpperCase(), author: d.showAuthor ? c.author : undefined, x: 52, y, width: 500, maxLines: 4, max: 112, min: 48, font: (px) => `900 ${px}px ${sans}`, color: ink, authorColor: ink, authorFont: `600 36px ${sans}`, lead: 0.98 });
  if (d.showBadge) pill(ctx, c.badge, 56, H - 100, { bg: ink, fg: d.accent, font: `700 26px ${sans}`, h: 50 });
}

function drawCinematic(ctx: CanvasRenderingContext2D, d: ThumbnailDesign, c: ThumbContent, title: string, kicker: string) {
  const W = THUMB_W;
  const H = THUMB_H;
  const { serif, sans } = c.fonts;
  backdrop(ctx, c.image, W, H, 0.6);
  const v = ctx.createRadialGradient(W / 2, H / 2, 120, W / 2, H / 2, 760);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.75)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, 64);
  ctx.fillRect(0, H - 64, W, 64);
  ctx.textAlign = 'center';
  let y = 170;
  if (kicker) {
    ctx.font = `700 28px ${sans}`;
    ctx.letterSpacing = '10px';
    ctx.fillStyle = d.accent;
    ctx.fillText(kicker.toUpperCase(), W / 2, y);
    ctx.letterSpacing = '0px';
    y += 30;
  }
  const r = fit(ctx, title, { width: 1080, maxLines: 2, max: 140, min: 60, font: (px) => `600 ${px}px ${serif}` });
  ctx.font = r.font;
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 24;
  r.lines.forEach((l, i) => ctx.fillText(l, W / 2, y + r.size * 0.9 + i * r.size * 1.02));
  ctx.shadowBlur = 0;
  y += r.lines.length * r.size * 1.02 + 24;
  ctx.fillStyle = d.accent;
  ctx.fillRect(W / 2 - 60, y, 120, 5);
  if (d.showAuthor && c.author) {
    ctx.font = `italic 400 44px ${serif}`;
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillText(c.author, W / 2, y + 62);
  }
  ctx.textAlign = 'left';
  if (d.showBadge) {
    ctx.font = `700 24px ${sans}`;
    const w = ctx.measureText(c.badge).width + 44;
    pill(ctx, c.badge, (W - w) / 2, H - 140, { bg: 'rgba(255,255,255,0.16)', fg: '#fff', font: `700 24px ${sans}`, h: 46 });
  }
}

function drawRibbon(ctx: CanvasRenderingContext2D, d: ThumbnailDesign, c: ThumbContent, title: string, kicker: string) {
  const W = THUMB_W;
  const H = THUMB_H;
  const { serif, sans } = c.fonts;
  backdrop(ctx, c.image, W, H, 0.72);
  book(ctx, c.image, 80, 80, 560, d.accent, title, serif);
  const x = 560;
  let y = Math.max(150, 0);
  y = titleBlock(ctx, { title, author: d.showAuthor ? c.author : undefined, x, y, width: 660, maxLines: 4, max: 110, min: 50, font: (px) => `600 ${px}px ${serif}`, color: '#fff', authorColor: 'rgba(255,255,255,0.85)', authorFont: `500 40px ${sans}` });
  if (d.showBadge) pill(ctx, c.badge, x + 2, Math.min(H - 110, y + 30), { bg: 'rgba(255,255,255,0.14)', fg: '#fff', font: `700 26px ${sans}`, h: 48 });
  if (kicker) {
    ctx.save();
    ctx.translate(W - 150, 150);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = d.accent;
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 18;
    ctx.fillRect(-330, -38, 660, 76);
    ctx.shadowBlur = 0;
    ctx.fillStyle = inkOn(d.accent);
    ctx.textAlign = 'center';
    const k = fit(ctx, kicker.toUpperCase(), { width: 300, maxLines: 1, max: 34, min: 18, font: (px) => `900 ${px}px ${sans}` });
    ctx.font = k.font;
    ctx.textBaseline = 'middle';
    ctx.fillText(k.lines[0] ?? '', 0, 2);
    ctx.restore();
  }
}

export function drawThumbnail(ctx: CanvasRenderingContext2D, d: ThumbnailDesign, c: ThumbContent): void {
  const W = THUMB_W;
  const H = THUMB_H;
  const { serif, sans } = c.fonts;
  const title = c.title.trim() || 'Audiobook';
  const kicker = d.kicker.trim();
  ctx.clearRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.letterSpacing = '0px';
  ctx.shadowBlur = 0;
  if (d.layout === 'player') return drawPlayer(ctx, d, c, title, kicker);
  if (d.layout === 'quote') return drawQuote(ctx, d, c, title, kicker);
  if (d.layout === 'split') return drawSplit(ctx, d, c, title, kicker);
  if (d.layout === 'cinematic') return drawCinematic(ctx, d, c, title, kicker);
  if (d.layout === 'ribbon') return drawRibbon(ctx, d, c, title, kicker);

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
