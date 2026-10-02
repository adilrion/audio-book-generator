'use client';

import type { ShortSettings } from '@app/types';
import type { CSSProperties } from 'react';
import { SHORT_THEMES, effectiveCaptions } from '@/lib/shorts';
import { cn } from '@/lib/utils';

const CAPTION_FONT = '"Avenir Next", "Arial Black", "Helvetica Neue", system-ui, sans-serif';
const BANGLA_FONT = '"Kohinoor Bangla", "Bangla Sangam MN", "Noto Sans Bengali", system-ui, sans-serif';

/**
 * One frame of the short, drawn with CSS: same layout as the renderer (sizes in container-width
 * units, so 1 cqw = 10.8 px of the real 1080-px frame). Shows the first words of the script with
 * the second one highlighted.
 */
export function ShortPreview({ title, script, settings, coverUrl, className }: { title: string; script: string; settings: ShortSettings; coverUrl?: string; className?: string }) {
  const look = settings.look;
  const cover = look.theme === 'cover' && coverUrl ? coverUrl : undefined;
  const theme = look.theme === 'cover' && !cover ? 'midnight' : look.theme;
  const t = SHORT_THEMES[theme];
  const style = effectiveCaptions(look.captions, theme);
  const bn = settings.language === 'bn' || /[ঀ-৿]/.test(script);
  const upper = look.uppercase && !bn;
  const all = (script.trim() || (bn ? 'আপনার স্ক্রিপ্ট এখানে বড় ক্যাপশন হয়ে দেখাবে।' : 'Your script appears here as big captions.')).split(/\s+/);
  const words = all.slice(0, style === 'word' ? 1 : 4).map((w) => (upper ? w.toUpperCase() : w));
  const active = style === 'plain' ? -1 : style === 'word' ? 0 : Math.min(1, words.length - 1);
  const ink = t.light ? 'rgb(28 25 23)' : '#fff';
  const top = cover ? 70 : look.position === 'lower' ? 66 : 52;

  const caption: CSSProperties = {
    fontFamily: bn ? BANGLA_FONT : CAPTION_FONT,
    fontWeight: bn ? 700 : 900,
    fontSize: style === 'word' ? '12.2cqw' : '8.5cqw',
    lineHeight: bn ? 1.3 : 1.08,
    color: ink,
    WebkitTextStroke: t.light ? undefined : '0.7cqw #000',
    paintOrder: 'stroke fill',
    textShadow: t.light ? '0 0.4cqw 1.2cqw rgb(0 0 0 / 0.2)' : '0 0.5cqw 1.4cqw rgb(0 0 0 / 0.55)',
    top: `${top}%`,
  };

  return (
    <div
      className={cn('@container relative isolate aspect-[9/16] overflow-hidden rounded-2xl bg-black shadow-book select-none', className)}
      style={cover ? undefined : { background: `linear-gradient(180deg, ${t.top}, ${t.bottom})` }}
      aria-label="Preview of the short"
      role="img"
    >
      {cover && (
        // eslint-disable-next-line @next/next/no-img-element -- page render from the local API
        <img src={cover} alt="" className="absolute inset-0 -z-10 size-full scale-125 object-cover blur-2xl brightness-[0.45]" />
      )}
      {!cover && <span className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_52%,rgb(255_255_255/0.1),transparent_60%)]" aria-hidden />}
      {look.showProgress && (
        <span className="absolute inset-x-0 top-0 h-[0.75cqw] bg-white/30">
          <span className="block h-full w-[35%]" style={{ background: look.accent }} />
        </span>
      )}
      <div className="absolute inset-x-[8%] top-[8.5%] grid justify-items-center gap-[2.2cqw]">
        {look.showTitle && title.trim() && (
          <p
            className="line-clamp-3 text-center text-[5.9cqw] leading-[1.15] font-semibold text-balance"
            style={{ color: ink, fontFamily: bn ? BANGLA_FONT : CAPTION_FONT, textShadow: t.light ? undefined : '0 0.3cqw 1cqw rgb(0 0 0 / 0.5)' }}
          >
            {title}
          </p>
        )}
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element -- page render from the local API
          <img src={cover} alt="" className="max-h-[52cqw] w-auto max-w-[62%] rounded-[1.7cqw] object-contain shadow-[0_2cqw_5cqw_rgb(0_0_0/0.5)]" />
        )}
      </div>
      <p className="absolute inset-x-[10%] -translate-y-1/2 text-center text-balance" style={caption} lang={bn ? 'bn' : undefined}>
        {words.map((w, i) => (
          <span key={i}>
            {i > 0 && ' '}
            {i === active && style === 'box' ? (
              <span className="rounded-[1.7cqw] px-[1.4cqw] [-webkit-text-stroke:0]" style={{ background: look.accent, color: 'rgb(28 25 23)', textShadow: 'none', boxDecorationBreak: 'clone' }}>
                {w}
              </span>
            ) : (
              <span style={i === active ? { color: look.accent } : undefined}>{w}</span>
            )}
          </span>
        ))}
      </p>
    </div>
  );
}
