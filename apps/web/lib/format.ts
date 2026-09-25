/** 1536 → "1.5 KB" */
export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 1 : 0)} ${u[i]}`;
}

/** 3725.4 → "1:02:05", 65 → "1:05" */
export function formatClock(sec: number | undefined): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? (sec as number) : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** 3725 → "1 h 2 min", 95 → "1 min 35 s", 12 → "12 s" */
export function formatDuration(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** Elapsed time between two ISO timestamps, compact: "0.4 s", "12 s", "3 min 5 s". */
export function formatElapsed(from?: string, to?: string): string | undefined {
  if (!from || !to) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatDuration(ms / 1000);
}

export function formatNumber(n: number | undefined): string {
  return n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US');
}

const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : undefined;

/** "3 minutes ago", "yesterday" … falls back to a date for anything older than a week. */
export function formatRelative(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (!rtf || abs > 7 * 86400) return formatDate(iso);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Rough narration length for an estimated word count (~155 spoken words per minute at 1.0×). */
export function estimateNarrationSec(words: number, speed = 1): number {
  return (words / 155 / Math.max(0.5, speed)) * 60;
}
