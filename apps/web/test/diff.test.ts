import { describe, expect, it } from 'vitest';
import { diffText } from '@/lib/diff';

const render = (before: string, after: string) => diffText(before, after).map((p) => (p.type === 'same' ? p.text : p.type === 'removed' ? `[-${p.text}]` : `[+${p.text}]`)).join('');

describe('diffText', () => {
  it('shows removed letter spacing', () => {
    expect(render('T h e end', 'The end')).toBe('T[- ]h[- ]e end');
  });

  it('shows an added space in glued words', () => {
    expect(render('wordsglued here', 'words glued here')).toBe('words[+ ]glued here');
  });

  it('shows a replaced glyph', () => {
    expect(render('eﬃcient', 'efficient')).toBe('e[-ﬃ][+ffi]cient');
  });

  it('keeps unchanged text as one run and reconstructs both sides', () => {
    const parts = diffText('same text', 'same text');
    expect(parts).toEqual([{ type: 'same', text: 'same text' }]);
    const before = 'পোস্ট মাস্টার', after = 'পোস্টমাস্টার';
    const d = diffText(before, after);
    expect(d.filter((p) => p.type !== 'added').map((p) => p.text).join('')).toBe(before);
    expect(d.filter((p) => p.type !== 'removed').map((p) => p.text).join('')).toBe(after);
  });

  it('falls back to before/after for very long pairs', () => {
    const a = 'a'.repeat(1000), b = 'b'.repeat(1000);
    expect(diffText(a, b)).toEqual([{ type: 'removed', text: a }, { type: 'added', text: b }]);
  });
});
