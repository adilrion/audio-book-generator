export interface DiffPart {
  type: 'same' | 'removed' | 'added';
  text: string;
}

/**
 * Character diff of `before` → `after` (longest common subsequence), merged into runs. Repairs
 * are small edits — a removed space in "T h e", an added one in "wordsglued", a fixed glyph — so
 * characters, not words, show exactly what changed. Very long pairs fall back to before/after.
 */
export function diffText(before: string, after: string): DiffPart[] {
  const a = [...before];
  const b = [...after];
  const n = a.length;
  const m = b.length;
  if (n * m > 400_000)
    return [
      { type: 'removed', text: before },
      { type: 'added', text: after },
    ];
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const parts: DiffPart[] = [];
  const push = (type: DiffPart['type'], ch: string) => {
    const last = parts[parts.length - 1];
    if (last?.type === type) last.text += ch;
    else parts.push({ type, text: ch });
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      push('same', a[i++]);
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] > dp[i + 1][j])) push('added', b[j++]);
    else push('removed', a[i++]);
  }
  return parts;
}
