/**
 * Plain-text cleaning shared by the server (AI output) and the browser (scripts pasted from other
 * tools), so both read text the same way.
 */

/** Text without links, angle brackets, timestamp lines or hashtag-only lines, at most `maxChars`. */
export function cleanText(raw: unknown, maxChars: number): string {
  if (typeof raw !== 'string') return '';
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/[<>]/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\d{1,2}:)?\d{1,2}:\d{2}\b/.test(l)) // timestamp lines
    .filter((l) => !/^\s*(#[\p{L}\p{M}\p{N}_]+\s*)+$/u.test(l)) // lines of hashtags only
    .map((l) => l.replace(/[ \t]+/g, ' ').trim());
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return clip(text, maxChars);
}

/** Cut at a word boundary with an ellipsis when longer than `max` characters. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
