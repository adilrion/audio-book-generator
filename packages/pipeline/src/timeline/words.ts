/**
 * Word timings inside a sentence.
 *
 * Sentence start/end come from sample counts and are exact. Inside a sentence the local engines
 * report no word boundaries, so the time is shared out by how long each word takes to say:
 * spoken characters plus a gap, plus the pause its trailing punctuation invites. The error is
 * bounded by the sentence (it can never drift into the next one).
 *
 * The voice reads the *narration* ("for example"), the page shows the *printed* words ("e.g."),
 * so the printed words are aligned to the narration first: words that match are anchors and
 * take the narration word's time; runs in between share the time between their anchors.
 */

export interface TimedWord {
  t: string;
  start: number;
  end: number;
}

const norm = (w: string) => w.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Abbreviations and initials: the full stop is not a pause ("Mr. Hargreaves", "J. R. R."). */
const ABBREVIATION = /^(?:mr|mrs|ms|dr|st|jr|sr|prof|rev|gen|capt|col|lt|sgt|vs|etc|no|vol|fig|p|pp|ch)\.$|^(?:\p{L}\.)+$/iu;

/** Relative time it takes to say `w`, in "characters". The sentence's last word gets no pause (it is trimmed off the audio). */
export function speechWeight(w: string, last = false): number {
  const spoken = w.replace(/[^\p{L}\p{N}]+/gu, '').length;
  if (!spoken) return 0.5;
  let pause = 0;
  if (/[,;:)\]”’"']$/u.test(w)) pause = /[;:]$/.test(w) ? 4 : 2.5;
  if (/[.!?…]["'”’)\]]*$/u.test(w)) pause = 5;
  if (/[—–-]$/u.test(w)) pause = 2;
  if (last || ABBREVIATION.test(w)) pause = 0;
  // Digits are read as words ("1920" → "nineteen twenty") and take longer than their length.
  const digits = w.replace(/[^\p{N}]+/gu, '').length;
  return spoken + digits * 1.5 + 1 + pause;
}

/** Share [start, end] between `words` by speaking weight. Contiguous: each word ends where the next begins. */
export function estimateWordTimes(words: string[], start: number, end: number): TimedWord[] {
  const weights = words.map((w, i) => speechWeight(w, i === words.length - 1));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const out: TimedWord[] = [];
  let acc = 0;
  words.forEach((t, i) => {
    const s = start + ((end - start) * acc) / total;
    acc += weights[i];
    out.push({ t, start: s, end: i === words.length - 1 ? end : start + ((end - start) * acc) / total });
  });
  return out;
}

/** Longest common subsequence of normalized tokens → matched index pairs, in order. */
function anchors(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] && a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * Speaking time of each printed word, given the narration's word times over [start, end].
 * `spoken` defaults to an estimate from the narration text.
 */
export function printedWordTimes(printed: string[], narration: string, start: number, end: number, spoken?: TimedWord[]): { start: number; end: number }[] {
  if (!printed.length) return [];
  const said = spoken?.length ? spoken : estimateWordTimes(narration.split(/\s+/).filter(Boolean), start, end);
  const pairs = anchors(printed.map(norm), said.map((w) => norm(w.t)));
  const starts = new Array<number>(printed.length);
  // Sentinels: before the first printed word / after the last one.
  const marks: [number, number, number][] = [[-1, -1, start], ...pairs.map(([i, j]) => [i, j, said[j].start] as [number, number, number]), [printed.length, said.length, end]];
  for (let k = 0; k + 1 < marks.length; k++) {
    const [i0, j0] = marks[k];
    const [i1, j1, t1] = marks[k + 1];
    if (i0 >= 0) starts[i0] = marks[k][2];
    // Printed words between two anchors share the time of the narration words between them.
    const from = j0 >= 0 ? said[j0].end : start;
    const to = j1 < said.length ? t1 : end;
    const run = printed.slice(i0 + 1, i1);
    if (!run.length) continue;
    const lo = Math.min(from, to);
    const times = estimateWordTimes(run, lo, Math.max(lo, to));
    run.forEach((_, r) => (starts[i0 + 1 + r] = times[r].start));
  }
  // Monotonic and contiguous.
  for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i], starts[i - 1]);
  return starts.map((s, i) => ({ start: s, end: i + 1 < starts.length ? starts[i + 1] : Math.max(s, end) }));
}
