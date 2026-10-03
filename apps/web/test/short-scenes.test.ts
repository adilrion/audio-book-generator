import type { ShortTheme } from '@app/types';
import { describe, expect, it } from 'vitest';
import { type MotionKind, SCENE_THEMES, isSceneTheme, motionSvg, sceneSvg, svgDataUrl } from '@/lib/short-scenes';
import { SHORT_MOTIONS, SHORT_THEMES } from '@/lib/shorts';

/** Every tag closed, in order (the SVGs are built from strings). */
function wellFormed(markup: string) {
  const stack: string[] = [];
  for (const m of markup.replace(/<style>[\s\S]*?<\/style>/g, '').matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    if (self) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0;
}

const MOTIONS = SHORT_MOTIONS.map((m) => m.value).filter((m): m is MotionKind => m !== 'none');

describe('animated short backgrounds', () => {
  it('match the themes marked animated', () => {
    const animated = (Object.keys(SHORT_THEMES) as ShortTheme[]).filter((t) => SHORT_THEMES[t].animated);
    expect(animated).toEqual([...SCENE_THEMES]);
    expect(isSceneTheme('aurora')).toBe(true);
    expect(isSceneTheme('cover')).toBe(false);
  });

  it.each(SCENE_THEMES)('%s is a well-formed, repeatable 1080×1920 SVG', (theme) => {
    const a = sceneSvg(theme);
    expect(a).toMatch(/^<svg [^>]*viewBox="0 0 1080 1920"/);
    expect(a.endsWith('</svg>')).toBe(true);
    expect(wellFormed(a)).toBe(true);
    expect(sceneSvg(theme)).toBe(a); // seeded: the same on the server and in the browser
    expect(a).not.toContain('NaN');
    expect(sceneSvg(theme, { paused: true })).toContain('animation-play-state:paused');
  });
});

describe('motion overlays', () => {
  it.each(MOTIONS)('%s is a well-formed SVG', (motion) => {
    const s = motionSvg(motion, { accent: '#22D3EE' });
    expect(wellFormed(s)).toBe(true);
    expect(s).not.toContain('NaN');
    expect(motionSvg(motion, { accent: '#22D3EE' })).toBe(s);
  });

  it('tints bokeh and sparkles with the highlight colour, and uses ink on light backgrounds', () => {
    expect(motionSvg('sparkles', { accent: '#22D3EE' })).toContain('#22D3EE');
    expect(motionSvg('bokeh', { accent: '#22D3EE' })).toContain('#22D3EE');
    expect(motionSvg('bokeh', { accent: '#22D3EE', light: true })).not.toContain('#22D3EE');
  });

  it('thins out the particles for small swatches', () => {
    const count = (s: string) => s.split('class="mv').length - 1;
    expect(count(motionSvg('snow', { accent: '#fff', scale: 0.5 }))).toBeLessThan(count(motionSvg('snow', { accent: '#fff' })));
  });

  it('is a data URL an <img> can load', () => {
    const url = svgDataUrl(motionSvg('rain', { accent: '#fff' }));
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')).toBe(true);
    expect(url).not.toContain('#');
  });
});
