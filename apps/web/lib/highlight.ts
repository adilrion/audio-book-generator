import type { HighlightStyle } from '@app/types';
import type { CSSProperties } from 'react';

/** `#RRGGBB` + alpha (0..1) → `#RRGGBBAA`. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${a}` : hex;
}

/**
 * CSS approximation of the video compositor's highlight styles
 * (workers/processing/audiobook_worker/video/compositor.py):
 * marker = multiply blend (ink stays dark), box = 18% fill + outline, underline = band under the line.
 */
export function highlightStyleCss(style: HighlightStyle, color: string): CSSProperties {
  if (style === 'underline') return { boxShadow: `inset 0 -0.22em 0 ${color}` };
  if (style === 'box') return { backgroundColor: withAlpha(color, 0.18), boxShadow: `inset 0 0 0 2px ${color}` };
  return { backgroundColor: color, mixBlendMode: 'multiply' };
}

/**
 * Fill for a highlight element sized by percentages (word / cursor overlays in the read-along
 * player). Like highlightStyleCss, but the underline is a gradient so it scales with the box.
 */
export function highlightFill(style: HighlightStyle, color: string): CSSProperties {
  if (style === 'underline') return { background: `linear-gradient(to top, ${color} 0 14%, transparent 14%)` };
  return highlightStyleCss(style, color);
}

/** The faint sentence tint under a word / cursor highlight (30% of the highlight), for inline text. */
export function tintStyleCss(style: HighlightStyle, color: string): CSSProperties {
  const faint = withAlpha(color, 0.3);
  if (style === 'underline') return { boxShadow: `inset 0 -0.22em 0 ${faint}` };
  if (style === 'box') return { backgroundColor: withAlpha(color, 0.06), boxShadow: `inset 0 0 0 2px ${faint}` };
  return { backgroundColor: faint, mixBlendMode: 'multiply' };
}
