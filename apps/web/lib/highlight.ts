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
