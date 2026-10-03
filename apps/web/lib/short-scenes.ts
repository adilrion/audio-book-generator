import type { ShortMotion, ShortTheme } from '@app/types';

/**
 * The renderer's animated backgrounds and motion overlays
 * (workers/processing/audiobook_worker/shorts/scenes.py), redrawn as self-contained animated SVGs
 * for the preview, the pickers and the thumbnail. Same palettes, motifs and speeds; the video is
 * drawn by the worker, so these only have to look like it.
 *
 * Each SVG is 1080×1920 (the frame) and animates with CSS inside the file, so it plays in a plain
 * <img>. Particles start where they would be mid-animation (a negative delay), so a paused SVG —
 * the thumbnail, or reduced motion — is a natural still frame and not an empty one.
 */

export type SceneTheme = Extract<ShortTheme, 'aurora' | 'liquid' | 'galaxy' | 'synthwave' | 'waves' | 'rays'>;
export type MotionKind = Exclude<ShortMotion, 'none'>;

export const SCENE_THEMES: readonly SceneTheme[] = ['aurora', 'liquid', 'galaxy', 'synthwave', 'waves', 'rays'];
export const isSceneTheme = (t: ShortTheme): t is SceneTheme => (SCENE_THEMES as readonly string[]).includes(t);

const W = 1080;
const H = 1920;
const TAU = Math.PI * 2;

/** Small numbers keep the data URLs short. */
const n = (v: number) => Math.round(v * 10) / 10;

/** Seeded PRNG (mulberry32): the same particles on the server and in the browser. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);

/** Shared keyframes: a straight move between two per-element offsets, and a side-to-side sway. */
const BASE_CSS = [
  '.mv{animation:mv linear infinite}',
  '@keyframes mv{from{transform:translate(var(--x0,0px),var(--y0,0px))}to{transform:translate(var(--x1,0px),var(--y1,0px))}}',
  '.sw{animation:sw ease-in-out infinite alternate}',
  '@keyframes sw{from{transform:translateX(calc(var(--s) * -1))}to{transform:translateX(var(--s))}}',
].join('');

function svg(body: string, css: string, o: { paused?: boolean; defs?: string }) {
  const pause = '*{animation-play-state:paused!important}';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">` +
    `<style>${BASE_CSS}${css}${o.paused ? pause : ''}@media (prefers-reduced-motion:reduce){${pause}}</style>` +
    (o.defs ? `<defs>${o.defs}</defs>` : '') +
    body +
    '</svg>'
  );
}

export const svgDataUrl = (markup: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

/**
 * A move from `from` to `to` over `dur` seconds, looping, for an element drawn at `at` — which is
 * where it is at time 0 (the delay starts it part-way, at `at`).
 */
function travel(at: [number, number], from: [number, number], to: [number, number], dur: number) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const p = Math.min(1, Math.max(0, Math.hypot(at[0] - from[0], at[1] - from[1]) / len));
  return `--x0:${n(from[0] - at[0])}px;--y0:${n(from[1] - at[1])}px;--x1:${n(to[0] - at[0])}px;--y1:${n(to[1] - at[1])}px;animation-duration:${n(dur)}s;animation-delay:${n(-p * dur)}s`;
}

const sway = (s: number, dur: number, delay: number) => `--s:${n(s)}px;animation-duration:${n(dur)}s;animation-delay:${n(-delay)}s`;

function vgradient(id: string, stops: [number, string, number?][]) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a !== undefined ? ` stop-opacity="${a}"` : ''}/>`).join('')}</linearGradient>`;
}

function rgradient(id: string, stops: [number, string, number?][]) {
  return `<radialGradient id="${id}">${stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a !== undefined ? ` stop-opacity="${a}"` : ''}/>`).join('')}</radialGradient>`;
}

/** Twinkling stars in the top `extent` of the frame. */
function stars(r: () => number, count: number, extent: number, big = 0) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const x = n(r() * W);
    const y = n(r() * H * extent);
    const size = n([1.5, 1.5, 2, 2.5, 3, 4][Math.floor(r() * 6)]);
    const style = `animation-duration:${n(between(r, 1.6, 6))}s;animation-delay:${n(-r() * 6)}s`;
    out += `<circle class="tw" cx="${x}" cy="${y}" r="${size}" fill="#fff" style="${style}"/>`;
    if (i < big) out += `<path class="tw" d="M${x - size * 7} ${y}H${x + size * 7}M${x} ${y - size * 7}V${y + size * 7}" stroke="#fff" stroke-opacity=".45" stroke-width="1.5" style="${style}"/>`;
  }
  return out;
}
const TWINKLE_CSS = '.tw{animation:tw ease-in-out infinite alternate}@keyframes tw{from{opacity:.25}to{opacity:.95}}';

/** Darker behind the captions (like the renderer), so they stay the brightest thing on screen. */
const CALM = `<rect width="${W}" height="${H}" fill="url(#calm)"/>`;
const calmDef = (focus: number) =>
  vgradient('calm', [
    [Math.max(0, focus - 0.16), '#000', 0],
    [focus, '#000', 0.2],
    [Math.min(1, focus + 0.16), '#000', 0],
  ]);

// ─────────────────────────────── scenes ───────────────────────────────

function aurora(paused: boolean, focus: number) {
  const r = random(7);
  const bands: [string, number, number][] = [
    ['#34d399', 0.3, 14],
    ['#22d3ee', 0.43, 18],
    ['#a78bfa', 0.56, 16],
  ];
  let defs = vgradient('sky', [[0, '#020617'], [0.6, '#06162a'], [1, '#041e22']]) + calmDef(focus);
  let css = TWINKLE_CSS;
  let body = `<rect width="${W}" height="${H}" fill="url(#sky)"/>` + stars(r, 70, 0.75, 4) + '<g mask="url(#shim)">';
  bands.forEach(([color, h, dur], i) => {
    defs += vgradient(`b${i}`, [[0, color, 0], [0.7, color, 0.35], [0.9, color, 0.9], [1, color, 0]]);
    // a wavy curtain: soft above, a bright rippling lower edge
    const base = h * H;
    const ph = r() * TAU;
    const pts: string[] = [];
    for (let x = -360; x <= W + 360; x += 30) {
      const y = base + 0.045 * H * Math.sin(TAU * 1.3 * (x / W) + ph) + 0.022 * H * Math.sin(TAU * 2.9 * (x / W) + ph * 1.7);
      pts.push(`${x} ${n(y + 30)}`);
    }
    const top = base - 0.32 * H;
    body += `<g class="a${i}"><path d="M-360 ${n(top)}L${pts.join('L')}L${W + 360} ${n(top)}Z" fill="url(#b${i})"/></g>`;
    css += `.a${i}{transform-box:view-box;transform-origin:540px ${n(base)}px;animation:a${i} ${dur}s ease-in-out infinite alternate}`;
    css += `@keyframes a${i}{from{transform:translateX(${i % 2 ? 90 : -90}px) skewX(${i % 2 ? -6 : 6}deg) scaleY(.92)}to{transform:translateX(${i % 2 ? -90 : 90}px) skewX(${i % 2 ? 6 : -6}deg) scaleY(1.08)}}`;
  });
  // vertical shimmer: the rays of light inside the curtains
  defs += `<pattern id="rays" width="96" height="${H}" patternUnits="userSpaceOnUse"><rect width="96" height="${H}" fill="#fff"/><rect width="26" height="${H}" fill="#000" opacity=".22"/><rect x="50" width="14" height="${H}" fill="#000" opacity=".14"/></pattern>`;
  defs += `<mask id="shim"><rect class="sh" x="-192" width="${W + 384}" height="${H}" fill="url(#rays)"/></mask>`;
  body += '</g>';
  css += '.sh{animation:sh 11s linear infinite}@keyframes sh{to{transform:translateX(96px)}}';
  return svg(body + CALM, css, { paused, defs });
}

function liquid(paused: boolean, focus: number) {
  const r = random(5);
  const colors = ['#ec4899', '#8b5cf6', '#f97316', '#3b82f6', '#14b8a6'];
  let defs = calmDef(focus);
  let body = `<rect width="${W}" height="${H}" fill="#1a0a14"/>`;
  colors.forEach((c, i) => {
    defs += rgradient(`l${i}`, [[0, c, 1], [0.45, c, 0.85], [1, c, 0]]);
    const rad = between(r, 0.62, 0.8) * W;
    const ax = between(r, 0.25, 0.45) * W;
    const ay = between(r, 0.3, 0.55) * 0.5 * H;
    const cx = W / 2 + between(r, -0.3, 0.3) * W;
    const cy = H / 2 + between(r, -0.3, 0.3) * H;
    body += `<g class="sw" style="${sway(ax, between(r, 6.5, 11.5), r() * 10)}"><g class="sy" style="${sway(ay, between(r, 8.5, 14.5), r() * 14)}">`;
    body += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(rad)}" fill="url(#l${i})"/></g></g>`;
  });
  const css = '.sy{animation:sy ease-in-out infinite alternate}@keyframes sy{from{transform:translateY(calc(var(--s) * -1))}to{transform:translateY(var(--s))}}';
  body += `<rect width="${W}" height="${H}" fill="#000" opacity=".12"/>`;
  return svg(body + CALM, css, { paused, defs });
}

function galaxy(paused: boolean, focus: number) {
  const r = random(9);
  let defs = vgradient('space', [[0, '#030410'], [1, '#0c0820']]) + calmDef(focus);
  const clouds: [string, number][] = [
    ['#8b5cf6', 0.55],
    ['#ec4899', 0.4],
    ['#38bdf8', 0.35],
  ];
  let neb = '';
  clouds.forEach(([c, a], i) => {
    defs += rgradient(`n${i}`, [[0, c, a], [0.6, c, a * 0.35], [1, c, 0]]);
    for (let k = 0; k < 4; k++) {
      // along a diagonal band, like a galaxy arm
      const t = between(r, -0.45, 0.45);
      const cx = W / 2 + t * W * 0.9 + between(r, -120, 120);
      const cy = H / 2 - t * H * 0.55 + between(r, -160, 160);
      neb += `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(between(r, 260, 460))}" ry="${n(between(r, 180, 340))}" fill="url(#n${i})" transform="rotate(${n(between(r, -40, 40))} ${n(cx)} ${n(cy)})"/>`;
    }
  });
  defs += rgradient('core', [[0, '#fae8ff', 0.5], [1, '#fae8ff', 0]]);
  neb += `<circle cx="540" cy="960" r="360" fill="url(#core)"/>`;
  const css = `${TWINKLE_CSS}.neb{transform-box:view-box;transform-origin:540px 960px;animation:neb 330s linear infinite}@keyframes neb{to{transform:rotate(-360deg)}}`;
  const body = `<rect width="${W}" height="${H}" fill="url(#space)"/><g class="neb">${neb}</g>` + CALM + stars(r, 130, 1, 7);
  return svg(body, css, { paused, defs });
}

function synthwave(paused: boolean) {
  const r = random(3);
  const hy = Math.round(H * 0.72);
  const R = Math.round(W * 0.26);
  const sy = Math.round(hy - R * 0.42);
  const D = H - hy;
  let defs =
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="${hy}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#100526"/><stop offset=".65" stop-color="#3c0c52"/><stop offset="1" stop-color="#961e6e"/></linearGradient>` +
    vgradient('ground', [[0, '#240636'], [1, '#080214']]) +
    vgradient('sun', [[0, '#ffdd57'], [1, '#ff3282']]) +
    vgradient('hz', [[0, '#ff46a0', 0], [0.5, '#ff46a0', 0.55], [1, '#ff46a0', 0]]) +
    rgradient('halo', [[0, '#ff5a78', 0.4], [1, '#ff5a78', 0]]) +
    `<clipPath id="above"><rect width="${W}" height="${hy}"/></clipPath>`;
  // the sun's stripes: only in its lower half, thicker towards the horizon, scrolling down
  const period = (2 * R) / 9;
  const start = sy - R + 0.45 * 2 * R;
  let stripes = '';
  for (let k = -1; k < 6; k++) {
    const y0 = start + period * k;
    const ry = (y0 + period - (sy - R)) / (2 * R);
    const gap = period * (0.06 + 0.42 * Math.min(1, Math.max(0, (ry - 0.45) / 0.55)));
    stripes += `<rect x="${540 - R}" y="${n(y0)}" width="${2 * R}" height="${n(Math.max(3, gap))}"/>`;
  }
  defs += `<clipPath id="low"><rect y="${n(start)}" width="${W}" height="${n(hy - start)}"/></clipPath>`;
  defs += `<mask id="cut"><rect width="${W}" height="${H}" fill="#fff"/><g clip-path="url(#low)"><g class="st" fill="#000">${stripes}</g></g></mask>`;
  let grid = '';
  const span = W * 0.17;
  for (let k = -12; k <= 12; k++) grid += `M${n(540 + k * span * 0.07)} ${hy}L${n(540 + k * span * 1.6)} ${H}`;
  let rows = '';
  let css = `${TWINKLE_CSS}.st{animation:st ${n(1 / 0.35)}s linear infinite}@keyframes st{to{transform:translateY(${n(period)}px)}}`;
  css += `.gl{animation:gl ${n(1 / 0.9)}s linear infinite}`;
  css += '@keyframes gl{from{transform:translateY(var(--a))}to{transform:translateY(var(--b))}}';
  for (let j = 0; j < 15; j++) {
    const a = D * (0.55 / (j + 1));
    const b = j === 0 ? D * 1.05 : D * (0.55 / j);
    const op = Math.min(1, (a / D) * 2.6);
    rows += `<g class="gl" style="--a:${n(a)}px;--b:${n(b)}px"><path d="M0 ${hy}H${W}" stroke-opacity="${n(op)}"/></g>`;
  }
  const lines = (w: number, o: number) =>
    `<g stroke="#ff3cd2" stroke-width="${w}" opacity="${o}" fill="none"><path d="${grid}"/>${rows}</g>`;
  const body =
    `<rect width="${W}" height="${hy}" fill="url(#sky)"/>` +
    stars(r, 40, 0.5, 3) +
    `<circle cx="540" cy="${sy}" r="${n(R * 1.6)}" fill="url(#halo)" clip-path="url(#above)"/>` +
    `<circle cx="540" cy="${sy}" r="${R}" fill="url(#sun)" mask="url(#cut)" clip-path="url(#above)"/>` +
    `<rect y="${hy}" width="${W}" height="${D}" fill="url(#ground)"/>` +
    `<rect y="${hy - 70}" width="${W}" height="140" fill="url(#hz)"/>` +
    `<svg y="${hy}" width="${W}" height="${D}" viewBox="0 ${hy} ${W} ${D}" overflow="hidden">${lines(10, 0.25)}${lines(2.5, 1)}</svg>`;
  return svg(body, css, { paused, defs });
}

function waves(paused: boolean) {
  const r = random(4);
  const layers: [number, number, number, number, string, string][] = [
    // height, amplitude, wavelength (widths), speed, fill, crest
    [0.605, 5, 0.42, 0.1, '#71508c', '#c99be0'],
    [0.655, 9, 0.55, 0.16, '#463e80', '#8f84d4'],
    [0.725, 16, 0.7, 0.24, '#262c66', '#5f68b8'],
    [0.81, 26, 0.85, 0.34, '#141c48', '#3e4d8f'],
    [0.91, 38, 1.05, 0.46, '#090e2a', '#2c3870'],
  ];
  const defs =
    vgradient('sky', [[0, '#0e1038'], [0.3, '#48226e'], [0.5, '#c4546e'], [0.6, '#fca05c'], [1, '#fca05c']]) + rgradient('sun', [[0, '#ffc878', 0.65], [1, '#ffc878', 0]]);
  let body = `<rect width="${W}" height="${H}" fill="url(#sky)"/><circle cx="540" cy="${n(H * 0.6)}" r="540" fill="url(#sun)"/><circle cx="540" cy="${n(H * 0.6)}" r="${n(W * 0.13)}" fill="#ffecaa"/>`;
  let css = '';
  layers.forEach(([h, amp, wl, spd, fill, crest], i) => {
    const lam = wl * W;
    const ph = r() * TAU;
    const pts: string[] = [];
    for (let x = -lam; x <= W + 2 * lam; x += 18) {
      const y = h * H + amp * (0.7 * Math.sin((TAU * x) / lam + ph) + 0.3 * Math.sin((2 * TAU * x) / lam + ph * 1.3));
      pts.push(`${n(x)} ${n(y)}`);
    }
    const top = `M${pts.join('L')}`;
    body += `<g class="w${i}"><path d="${top}L${n(W + 2 * lam)} ${H + 10}L${n(-lam)} ${H + 10}Z" fill="${fill}"/><path d="${top}" fill="none" stroke="${crest}" stroke-width="2.5"/></g>`;
    css += `.w${i}{animation:w${i} ${n(1 / spd)}s linear infinite}@keyframes w${i}{from{transform:translateX(${n(-lam)}px)}to{transform:translateX(0)}}`;
  });
  return svg(body, css, { paused, defs });
}

function rays(paused: boolean, focus: number) {
  const cy = H * 0.45;
  const N = 14;
  let wedges = '';
  for (let k = 0; k < N; k++) {
    const a = (TAU * k) / N;
    const w = (TAU / N) * 0.27;
    const p = (ang: number) => `${n(540 + Math.cos(ang) * 2300)} ${n(cy + Math.sin(ang) * 2300)}`;
    wedges += `M540 ${n(cy)}L${p(a - w)}L${p(a + w)}Z`;
  }
  const defs =
    `<radialGradient id="beam" cx="540" cy="${n(cy)}" r="1700" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4f44d8"/><stop offset="1" stop-color="#2a2580" stop-opacity=".35"/></radialGradient>` +
    rgradient('glow', [[0, '#bec4ff', 0.6], [1, '#bec4ff', 0]]) +
    `<radialGradient id="vig" cx="540" cy="${n(cy)}" r="1250" gradientUnits="userSpaceOnUse"><stop offset=".35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></radialGradient>` +
    calmDef(focus);
  const css = `.rot{transform-box:view-box;transform-origin:540px ${n(cy)}px;animation:rot 70s linear infinite}@keyframes rot{to{transform:rotate(360deg)}}.pu{animation:pu 6s ease-in-out infinite alternate}@keyframes pu{from{opacity:.8}to{opacity:1}}`;
  const body =
    `<rect width="${W}" height="${H}" fill="#161440"/><g class="rot"><path d="${wedges}" fill="url(#beam)"/></g>` +
    `<circle class="pu" cx="540" cy="${n(cy)}" r="460" fill="url(#glow)"/><rect width="${W}" height="${H}" fill="url(#vig)"/>` +
    CALM;
  return svg(body, css, { paused, defs });
}

/** An animated background as SVG markup. `focus` is where the captions sit (0..1 of the height). */
export function sceneSvg(theme: SceneTheme, o: { paused?: boolean; focus?: number } = {}): string {
  const paused = !!o.paused;
  const focus = o.focus ?? 0.52;
  switch (theme) {
    case 'aurora':
      return aurora(paused, focus);
    case 'liquid':
      return liquid(paused, focus);
    case 'galaxy':
      return galaxy(paused, focus);
    case 'synthwave':
      return synthwave(paused);
    case 'waves':
      return waves(paused);
    case 'rays':
      return rays(paused, focus);
  }
}

// ─────────────────────────────── motion overlays ───────────────────────────────

/** On light backgrounds the particles are drawn as soft ink (multiplied), as in the renderer. */
const INK = '#7a6450';

function bokeh(r: () => number, accent: string, light: boolean, scale: number) {
  const warm = light ? INK : '#ffecd2';
  const tint = light ? INK : accent;
  const defs = [tint, warm].map((c, i) => rgradient(`o${i}`, [[0, c, 0.5], [0.8, c, 0.6], [0.9, c, 0.95], [1, c, 0]])).join('');
  let body = '';
  for (let i = 0; i < Math.round(18 * scale); i++) {
    const rad = between(r, 28, 105);
    const x = r() * W;
    const y = r() * H;
    const dur = (H + 2 * rad) / between(r, 14, 42);
    body += `<g class="mv" style="${travel([x, y], [x, H + rad], [x, -rad], dur)}"><g class="sw" style="${sway(between(r, 15, 55), between(r, 3.5, 7.5), r() * 8)}">`;
    body += `<circle class="pl" cx="${n(x)}" cy="${n(y)}" r="${n(rad)}" fill="url(#o${i % 5 < 3 ? 0 : 1})" opacity="${n(between(r, 0.3, 0.75))}" style="animation-duration:${n(between(r, 2, 4.5))}s"/></g></g>`;
  }
  const css = '.pl{animation:pl ease-in-out infinite alternate}@keyframes pl{from{opacity:.45}}';
  return { body, css, defs };
}

function snow(r: () => number, light: boolean, scale: number) {
  const c = light ? INK : '#f0f6ff';
  const defs = rgradient('f', [[0, c, 1], [0.5, c, 0.8], [1, c, 0]]);
  let body = '';
  for (let i = 0; i < Math.round(80 * scale); i++) {
    const rad = [2, 2, 3, 3, 4, 5, 6, 8][Math.floor(r() * 8)] * 1.6;
    const x = r() * W;
    const y = r() * H;
    const dur = (H + 4 * rad) / (40 + 22 * (rad / 1.6));
    body += `<g class="mv" style="${travel([x, y], [x, -2 * rad], [x, H + 2 * rad], dur)}"><g class="sw" style="${sway(between(r, 8, 40), between(r, 1.5, 4), r() * 4)}">`;
    body += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(rad)}" fill="url(#f)" opacity="${n(between(r, 0.55, 1))}"/></g></g>`;
  }
  return { body, css: '', defs };
}

function rain(r: () => number, light: boolean, scale: number) {
  const c = light ? INK : '#afc8e6';
  let body = '';
  const slant = 0.13;
  for (let i = 0; i < Math.round(70 * scale); i++) {
    const len = between(r, 40, 110);
    const vy = between(r, 1300, 2000);
    const x = between(r, -0.1, 1) * W;
    const y = r() * H;
    const dur = (H + len) / vy;
    const from: [number, number] = [x - slant * (y + len), -len];
    const to: [number, number] = [x + slant * (H - y), H];
    body += `<g class="mv" style="${travel([x, y], from, to, dur)}"><path d="M${n(x)} ${n(y)}l${n(slant * len)} ${n(len)}" stroke="${c}" stroke-width="${r() < 0.6 ? 2 : 3}" stroke-linecap="round" opacity="${n(between(r, 0.3, 0.7))}"/></g>`;
  }
  return { body, css: '', defs: '' };
}

function embers(r: () => number, light: boolean, scale: number) {
  const defs = rgradient('e', light ? [[0, INK, 1], [0.4, INK, 0.6], [1, INK, 0]] : [[0, '#ffe6b4', 1], [0.25, '#ffb060', 0.9], [0.6, '#ff781e', 0.45], [1, '#ff781e', 0]]);
  let body = '';
  for (let i = 0; i < Math.round(55 * scale); i++) {
    const rad = between(r, 9, 22) * 1.3;
    const life = between(r, 0.35, 0.95) * H;
    const x = r() * W;
    const dur = life / between(r, 70, 230);
    const y = H + 10 - r() * life;
    body += `<g class="mv em" style="${travel([x, y], [x, H + 10], [x + between(r, -0.12, 0.12) * life, H + 10 - life], dur)}"><g class="sw" style="${sway(between(r, 10, 45), between(r, 1, 2.5), r() * 3)}">`;
    body += `<circle class="fl" cx="${n(x)}" cy="${n(y)}" r="${n(rad)}" fill="url(#e)" style="animation-duration:${n(between(r, 0.09, 0.2))}s"/></g></g>`;
  }
  const css =
    '.em{animation-name:mv,em}@keyframes em{0%,100%{opacity:0}20%{opacity:1}75%{opacity:.85}}.fl{animation:fl ease-in-out infinite alternate}@keyframes fl{from{opacity:.65}}';
  return { body, css, defs };
}

function sparkles(r: () => number, accent: string, light: boolean, scale: number) {
  let body = '';
  for (let i = 0; i < Math.round(26 * scale); i++) {
    const s = n(between(r, 18, 48));
    const x = between(r, 0.04, 0.96) * W;
    const y = between(r, 0.03, 0.97) * H;
    const k = n(s * 0.12);
    const d = `M0 ${-s}C${k} ${-k} ${k} ${-k} ${s} 0C${k} ${k} ${k} ${k} 0 ${s}C${-k} ${k} ${-k} ${k} ${-s} 0C${-k} ${-k} ${-k} ${-k} 0 ${-s}Z`;
    const per = between(r, 2.2, 5.5);
    const fill = light ? INK : i % 2 ? accent : '#ffffff';
    body += `<g transform="translate(${n(x)} ${n(y)})"><path class="sp" d="${d}" fill="${fill}" style="animation-duration:${n(per)}s;animation-delay:${n(-r() * per)}s"/></g>`;
  }
  const css =
    '.sp{transform-box:fill-box;transform-origin:center;animation:sp ease-in-out infinite}@keyframes sp{0%,100%{transform:scale(.1) rotate(0);opacity:0}50%{transform:scale(1) rotate(45deg);opacity:1}}';
  return { body, css, defs: '' };
}

/**
 * A motion overlay as SVG markup (transparent background). Draw it over the background with
 * `mix-blend-mode: screen` (light themes: `multiply`) — the renderer adds the particles as light.
 * `scale` thins the particles out for small swatches.
 */
export function motionSvg(motion: MotionKind, o: { accent: string; light?: boolean; paused?: boolean; scale?: number }): string {
  const r = random(11);
  const light = !!o.light;
  const scale = o.scale ?? 1;
  const part =
    motion === 'bokeh'
      ? bokeh(r, o.accent, light, scale)
      : motion === 'snow'
        ? snow(r, light, scale)
        : motion === 'rain'
          ? rain(r, light, scale)
          : motion === 'embers'
            ? embers(r, light, scale)
            : sparkles(r, o.accent, light, scale);
  return svg(part.body, part.css, { paused: o.paused, defs: part.defs });
}

/** How a motion overlay is blended onto the background, in CSS and on a canvas. */
export const motionBlend = (light: boolean): 'multiply' | 'screen' => (light ? 'multiply' : 'screen');
