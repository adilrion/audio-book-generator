'use client';

import type { HighlightMode, HighlightStyle, Rect, Timeline, TimelineSegment } from '@app/types';
import { ChevronsLeft, ChevronsRight, LoaderCircle, Pause, Play, SkipBack, SkipForward, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, type PointerEvent, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { pageImageUrl } from '@/lib/api';
import { formatClock, formatDuration } from '@/lib/format';
import { highlightFill, withAlpha } from '@/lib/highlight';
import { cursorAt, hitTest, pageSizeOf, rectToPercent, sameLine, segmentIndexAt, segmentsByPage, wordIndexAt } from '@/lib/timeline';
import { cn } from '@/lib/utils';

const RATES = [0.75, 1, 1.25, 1.5, 2];
const EPS = 0.02; // seek slightly past a segment start so float rounding can't land on the previous one

export interface ReadAlongPlayerProps {
  projectId: string;
  timeline: Timeline;
  audioSrc: string;
  highlightStyle: HighlightStyle;
  highlightColor: string;
  /** Word / cursor highlighting needs a timeline built for it (segments carry `words`); otherwise sentences are shown. */
  highlightMode?: HighlightMode;
  /** Word / cursor highlighting: tint the whole sentence faintly too. */
  sentenceTint?: boolean;
  /** Open at this time (seconds), e.g. from a `?t=` deep link. */
  initialTime?: number;
  /** False while the player is out of view (another tab) — playback pauses. */
  active?: boolean;
}

function HighlightBox({ style, color, box }: { style: HighlightStyle; color: string; box: { left: number; top: number; width: number; height: number } }) {
  const pos = { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` };
  const base = 'pointer-events-none absolute rounded-[2px] transition-[left,top,width,height] duration-200 ease-out motion-reduce:transition-none';
  if (style === 'underline')
    return (
      <span className={base} style={pos}>
        <span className="absolute inset-x-0 bottom-0 h-[14%] min-h-[2px] rounded-full" style={{ background: color }} />
      </span>
    );
  if (style === 'box') return <span className={base} style={{ ...pos, background: withAlpha(color, 0.18), boxShadow: `inset 0 0 0 2px ${color}` }} />;
  return <span className={base} style={{ ...pos, background: color, mixBlendMode: 'multiply' }} />;
}

const GLIDE_MS = 120;

interface OverlayHandle {
  update: (t: number) => void;
}

const pct = (r: Rect, size: [number, number]) => {
  const b = rectToPercent(r, size);
  return { left: `${b.left}%`, top: `${b.top}%`, width: `${b.width}%`, height: `${b.height}%` };
};

/**
 * Word and cursor highlighting. Positions are written straight to the DOM on every animation
 * frame (like the scrubber), so a moving cursor never re-renders React. The word box glides to
 * the next word on the same line (CSS transition) and cuts to a new line with a quick fade, like
 * the video. Mirrors word_marks / cursor_marks in the compositor.
 */
function WordOverlay({
  ref,
  segment,
  mode,
  pageSize,
  style,
  color,
  tint,
}: {
  ref: Ref<OverlayHandle>;
  segment: TimelineSegment;
  mode: 'word' | 'cursor';
  pageSize: [number, number];
  style: HighlightStyle;
  color: string;
  tint: boolean;
}) {
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const caretRef = useRef<HTMLSpanElement>(null);
  const shown = useRef<{ key: string; rect?: Rect }>({ key: '' });
  const lastT = useRef(segment.start);
  const segRef = useRef(segment);
  segRef.current = segment;

  const update = useCallback(
    (t: number) => {
      lastT.current = t;
      const seg = segRef.current;
      const words = seg.words;
      if (!words?.length) return;
      if (mode === 'word') {
        const k = wordIndexAt(words, t);
        const key = `${seg.i}:${k}`;
        if (key === shown.current.key) return;
        const rects = words[k].rects;
        const prev = shown.current.rect;
        const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const glide = !reduce && !!prev && rects.length === 1 && sameLine(prev, rects[0]);
        wordRefs.current.forEach((el, i) => {
          if (!el) return;
          const r = rects[i];
          el.style.display = r ? '' : 'none';
          if (!r) return;
          el.style.transition = glide ? `left ${GLIDE_MS}ms ease-out, top ${GLIDE_MS}ms ease-out, width ${GLIDE_MS}ms ease-out, height ${GLIDE_MS}ms ease-out` : 'none';
          Object.assign(el.style, pct(r, pageSize));
          if (!glide && !reduce) el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 90, easing: 'ease-out' });
        });
        shown.current = { key, rect: rects[rects.length - 1] };
        return;
      }
      const c = cursorAt(seg, t);
      if (!c) return;
      seg.rects.forEach((ln, i) => {
        const el = lineRefs.current[i];
        if (!el) return;
        const x1 = i < c.line ? ln[2] : i === c.line ? c.x : ln[0];
        el.style.display = x1 > ln[0] ? '' : 'none';
        if (x1 > ln[0]) Object.assign(el.style, pct([ln[0], ln[1], x1, ln[3]], pageSize));
      });
      const caret = caretRef.current;
      if (caret) {
        const ln = seg.rects[c.line];
        caret.style.display = t <= seg.end ? '' : 'none';
        const b = rectToPercent([c.x, ln[1], c.x, ln[3]], pageSize);
        Object.assign(caret.style, { left: `${b.left + b.width / 2}%`, top: `${b.top}%`, height: `${b.height}%` });
      }
    },
    [mode, pageSize],
  );
  useImperativeHandle(ref, () => ({ update }), [update]);
  // New segment rendered (or paused / seeked): draw its state now rather than on the next frame.
  useLayoutEffect(() => update(lastT.current), [segment, update]);

  const fill = highlightFill(style, color);
  const base = 'pointer-events-none absolute rounded-[2px]';
  return (
    <>
      {tint && segment.rects.map((r, i) => <span key={`t${i}`} className={base} style={{ ...pct(r, pageSize), ...fill, opacity: 0.3 }} />)}
      {mode === 'word'
        ? [0, 1].map((i) => <span key={`w${i}`} ref={(el) => void (wordRefs.current[i] = el)} className={base} style={{ ...fill, display: 'none' }} />)
        : segment.rects.map((_, i) => <span key={`l${segment.i}-${i}`} ref={(el) => void (lineRefs.current[i] = el)} className={base} style={{ ...fill, display: 'none' }} />)}
      {mode === 'cursor' && (
        <span ref={caretRef} className="pointer-events-none absolute w-[2px] -translate-x-1/2 rounded-full" style={{ background: color, filter: 'brightness(0.55)', display: 'none' }} />
      )}
    </>
  );
}

/**
 * Read-along preview: streams audiobook.m4a, shows the PDF page being narrated and draws the
 * current segment's rects (PDF points → % of the page box). The playhead is sampled every
 * animation frame; a binary search finds the segment, and React only re-renders when it changes.
 */
export function ReadAlongPlayer({
  projectId,
  timeline,
  audioSrc,
  highlightStyle,
  highlightColor,
  highlightMode = 'sentence',
  sentenceTint = true,
  initialTime,
  active = true,
}: ReadAlongPlayerProps) {
  const segments = timeline.segments;
  const chapters = timeline.chapters;
  const duration = timeline.duration || segments.at(-1)?.end || 0;
  const byPage = useMemo(() => segmentsByPage(segments), [segments]);

  const audioRef = useRef<HTMLAudioElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const overlayRef = useRef<OverlayHandle>(null);
  const idxRef = useRef(-1);
  const draggingRef = useRef(false);
  /** Pending start position; applied once the audio can seek, then cleared. */
  const startRef = useRef(initialTime !== undefined && Number.isFinite(initialTime) ? Math.max(0, Math.min(duration, initialTime)) : undefined);

  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [audioState, setAudioState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [imgLoaded, setImgLoaded] = useState<Record<number, boolean>>({});

  /** Update playhead UI directly (no React render) and the segment index (render only on change). */
  const paint = useCallback(
    (t: number) => {
      const frac = duration > 0 ? Math.max(0, Math.min(1, t / duration)) : 0;
      if (fillRef.current) fillRef.current.style.width = `${frac * 100}%`;
      if (thumbRef.current) thumbRef.current.style.left = `${frac * 100}%`;
      if (timeRef.current) timeRef.current.textContent = formatClock(t);
      const i = segmentIndexAt(segments, t);
      if (i !== idxRef.current) {
        idxRef.current = i;
        setIdx(i);
      }
      overlayRef.current?.update(t);
    },
    [duration, segments],
  );

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    let raf = 0;
    const tick = () => {
      paint(a.currentTime);
      raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(raf);
      paint(a.currentTime);
    };
    const onSeek = () => paint(startRef.current ?? a.currentTime);
    const applyStart = () => {
      if (startRef.current === undefined) return;
      a.currentTime = startRef.current;
      startRef.current = undefined;
    };
    const onReady = () => {
      setAudioState('ready');
      applyStart();
    };
    const onError = () => setAudioState('error');
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onPause);
    a.addEventListener('seeking', onSeek);
    a.addEventListener('seeked', onSeek);
    a.addEventListener('timeupdate', onSeek);
    a.addEventListener('loadedmetadata', onReady);
    a.addEventListener('error', onError);
    // Page + highlight at the start position right away, even before the audio has loaded.
    paint(startRef.current ?? a.currentTime);
    if (a.readyState >= 1) onReady();
    return () => {
      cancelAnimationFrame(raf);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onPause);
      a.removeEventListener('seeking', onSeek);
      a.removeEventListener('seeked', onSeek);
      a.removeEventListener('timeupdate', onSeek);
      a.removeEventListener('loadedmetadata', onReady);
      a.removeEventListener('error', onError);
    };
  }, [paint]);

  useEffect(() => {
    setAudioState('loading');
  }, [audioSrc]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    if (!active) audioRef.current?.pause();
  }, [active]);

  const seek = useCallback(
    (t: number) => {
      const a = audioRef.current;
      const clamped = Math.max(0, Math.min(duration, t));
      startRef.current = undefined; // the user's choice wins over a pending ?t= start
      if (a) a.currentTime = clamped;
      paint(clamped);
    },
    [duration, paint],
  );

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setAudioState('error'));
    else a.pause();
  }, []);

  const current = idx >= 0 ? segments[idx] : undefined;
  const prevSentence = useCallback(() => {
    const a = audioRef.current;
    const t = a?.currentTime ?? 0;
    const i = idxRef.current;
    if (i < 0) return seek(0);
    // Like a music player: first press restarts the sentence, a quick second press goes back one.
    if (t - segments[i].start > 1.2 || i === 0) seek(segments[i].start + EPS);
    else seek(segments[i - 1].start + EPS);
  }, [segments, seek]);
  const nextSentence = useCallback(() => {
    const i = idxRef.current;
    if (i + 1 < segments.length) seek(segments[i + 1].start + EPS);
  }, [segments, seek]);

  // Page shown = page of the segment being read (or of the first segment before playback).
  const page = current?.page ?? segments[0]?.page ?? 1;
  const [pw, ph] = pageSizeOf(timeline, page);
  const wordMode = (highlightMode === 'word' || highlightMode === 'cursor') && !!current?.words?.length ? highlightMode : undefined;
  const boxes = current && current.page === page && !wordMode ? current.rects.map((r) => rectToPercent(r, [pw, ph])) : [];
  const pageSize = useMemo<[number, number]>(() => [pw, ph], [pw, ph]);
  const chapterIdx = current ? chapters.findIndex((c) => c.index === current.chapterIndex) : 0;
  const chapter = chapters[Math.max(0, chapterIdx)];

  // Preload the next page so page turns don't flash.
  useEffect(() => {
    let next: number | undefined;
    for (let i = Math.max(0, idx) + 1; i < segments.length; i++) {
      if (segments[i].page !== page) {
        next = segments[i].page;
        break;
      }
    }
    if (next) {
      const img = new Image();
      img.src = pageImageUrl(projectId, next);
    }
  }, [idx, page, projectId, segments]);

  const onPageClick = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * pw;
    const y = ((e.clientY - r.top) / r.height) * ph;
    const hit = hitTest(segments, byPage.get(page), x, y);
    if (hit >= 0) seek(segments[hit].start + EPS);
  };

  // ── scrubber ──
  const seekFromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * duration);
  };
  const onScrubKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = audioRef.current?.currentTime ?? 0;
    const step = e.shiftKey ? 30 : 5;
    const map: Record<string, number | undefined> = { ArrowLeft: t - step, ArrowRight: t + step, Home: 0, End: duration, PageUp: t + 60, PageDown: t - 60 };
    if (map[e.key] !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      seek(map[e.key]!);
    }
  };

  const onPlayerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft' && !e.metaKey) {
      e.preventDefault();
      prevSentence();
    } else if (e.key === 'ArrowRight' && !e.metaKey) {
      e.preventDefault();
      nextSentence();
    } else if ((e.key === ' ' || e.key === 'k') && tag !== 'BUTTON') {
      e.preventDefault();
      toggle();
    }
  };

  // Fit the page so page + transport fit on one screen (min 320px tall on small viewports).
  const displayWidth = `min(100%, calc(max(320px, 100dvh - 380px) * ${pw} / ${ph}))`;

  return (
    // tabIndex -1: clicking the page focuses the player (not the surrounding tab panel), so the
    // shortcuts in the tip below work right after clicking a sentence.
    <div className="grid gap-4 outline-none" onKeyDown={onPlayerKey} tabIndex={-1} role="region" aria-label="Read-along player">
      <audio ref={audioRef} src={audioSrc} preload="metadata" className="hidden" />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Page + highlight overlay, on the "desk" */}
        <div className="relative grid min-w-0 place-items-center overflow-hidden rounded-2xl bg-stage p-4 sm:p-8">
          <div
            className="relative cursor-pointer overflow-hidden rounded-[3px] bg-white shadow-[0_1px_2px_rgb(0_0_0/0.12),0_18px_40px_-16px_rgb(0_0_0/0.45)]"
            style={{ aspectRatio: `${pw} / ${ph}`, width: displayWidth }}
            onClick={onPageClick}
            title="Click a sentence to jump to it"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- page renders come from the local API */}
            <img
              key={page}
              src={pageImageUrl(projectId, page)}
              alt={`Page ${page}`}
              className={cn('absolute inset-0 size-full object-contain select-none', imgLoaded[page] && 'animate-page-in')}
              draggable={false}
              onLoad={() => setImgLoaded((m) => (m[page] ? m : { ...m, [page]: true }))}
            />
            {!imgLoaded[page] && (
              <div className="absolute inset-0 grid place-items-center bg-muted/40">
                <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-label="Rendering page" />
              </div>
            )}
            {boxes.map((b, i) => (
              <HighlightBox key={i} box={b} style={highlightStyle} color={highlightColor} />
            ))}
            {wordMode && current && (
              <WordOverlay
                key={`words-${page}`}
                ref={overlayRef}
                segment={current}
                mode={wordMode}
                pageSize={pageSize}
                style={highlightStyle}
                color={highlightColor}
                tint={sentenceTint}
              />
            )}
          </div>
          <span className="absolute top-3 left-3 rounded-full bg-background/80 px-2.5 py-1 text-[11px] font-medium text-foreground/80 tabular shadow-sm backdrop-blur">
            Page {page}
          </span>
        </div>

        {/* Now reading + chapters */}
        <div className="grid min-w-0 content-start gap-4">
          <div className="grid gap-3 rounded-2xl border bg-card p-5 shadow-card">
            <p className="flex items-center justify-between gap-2 text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
              <span>Now reading</span>
              {playing && <span className="size-1.5 animate-pulse rounded-full bg-brand" aria-hidden />}
            </p>
            <p className="min-h-[4lh] font-serif text-[17px] leading-relaxed text-pretty" aria-live="off">
              {current ? <span className="marker">{current.text}</span> : <span className="text-muted-foreground">Press play to start the read-along.</span>}
            </p>
            <p className="text-xs text-muted-foreground tabular">
              {current ? `Sentence ${idx + 1} of ${segments.length.toLocaleString('en-US')} · Page ${current.page}` : `${segments.length.toLocaleString('en-US')} sentences`}
            </p>
          </div>

          <div className="grid gap-1 rounded-2xl border bg-card p-2 shadow-card">
            <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">Chapters</p>
            <ol className="grid max-h-64 gap-0.5 overflow-y-auto scrollbar-thin lg:max-h-[40vh]">
              {chapters.map((c, i) => {
                const on = chapter?.index === c.index && idx >= 0;
                return (
                  <li key={c.index}>
                    <button
                      type="button"
                      onClick={() => seek(c.start + EPS)}
                      className={cn(
                        'flex w-full items-baseline gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        on && 'bg-brand/25 font-medium hover:bg-brand/30 dark:bg-brand/15 dark:hover:bg-brand/20',
                      )}
                      aria-current={on ? 'true' : undefined}
                    >
                      <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate" title={c.title}>
                        {c.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular">{formatClock(c.start)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>

      {/* Transport */}
      {/* Sticky so the controls stay in reach while the page fills the screen. */}
      <div className="sticky bottom-3 z-20 grid gap-3 rounded-2xl border bg-card/95 p-3 shadow-float backdrop-blur-md supports-[backdrop-filter]:bg-card/85 sm:p-4">
        <div className="flex items-center gap-3">
          <span className="w-12 shrink-0 text-xs text-muted-foreground tabular" ref={timeRef}>
            0:00
          </span>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Playback position"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(current?.start ?? 0)}
            aria-valuetext={current ? `${formatClock(current.start)} — ${chapter?.title ?? ''}` : '0:00'}
            className="group relative h-6 flex-1 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onPointerDown={(e) => {
              draggingRef.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              seekFromPointer(e);
            }}
            onPointerMove={(e) => draggingRef.current && seekFromPointer(e)}
            onPointerUp={(e) => {
              draggingRef.current = false;
              e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => (draggingRef.current = false)}
            onKeyDown={onScrubKey}
          >
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-foreground/10 transition-[height] group-hover:h-2">
              <div ref={fillRef} className="h-full w-0 rounded-full bg-foreground" />
            </div>
            {chapters.slice(1).map((c) => (
              <span
                key={c.index}
                className="absolute top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-card"
                style={{ left: `${duration ? (c.start / duration) * 100 : 0}%` }}
                title={`${c.title} · ${formatClock(c.start)}`}
              />
            ))}
            <div
              ref={thumbRef}
              className="pointer-events-none absolute top-1/2 left-0 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground bg-background shadow-sm transition-transform group-hover:scale-110"
            />
          </div>
          <span className="w-12 shrink-0 text-right text-xs text-muted-foreground tabular">{formatClock(duration)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={prevSentence} aria-label="Previous sentence" title="Previous sentence (←)">
              <SkipBack className="fill-current" aria-hidden />
            </Button>
            <Button
              variant="brand"
              size="icon"
              className="size-12 rounded-full [&_svg:not([class*='size-'])]:size-5"
              onClick={toggle}
              aria-label={playing ? 'Pause' : 'Play'}
              title="Play / pause (space)"
              disabled={audioState === 'error'}
            >
              {playing ? <Pause className="fill-current" aria-hidden /> : <Play className="translate-x-px fill-current" aria-hidden />}
            </Button>
            <Button variant="ghost" size="icon" className="rounded-full" onClick={nextSentence} aria-label="Next sentence" title="Next sentence (→)">
              <SkipForward className="fill-current" aria-hidden />
            </Button>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => chapterIdx > 0 && seek(chapters[chapterIdx - 1].start + EPS)}
              disabled={chapterIdx <= 0 || idx < 0}
              aria-label="Previous chapter"
              title="Previous chapter"
            >
              <ChevronsLeft aria-hidden />
            </Button>
            <span className="hidden max-w-52 min-w-0 truncate text-xs text-muted-foreground sm:inline" title={chapter?.title}>
              {chapter ? chapter.title : ''}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => chapterIdx + 1 < chapters.length && seek(chapters[chapterIdx + 1].start + EPS)}
              disabled={chapterIdx >= chapters.length - 1}
              aria-label="Next chapter"
              title="Next chapter"
            >
              <ChevronsRight aria-hidden />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="ml-1 w-14 rounded-full tabular"
              onClick={() => setRate((r) => RATES[(RATES.indexOf(r) + 1) % RATES.length])}
              aria-label={`Playback speed ${rate}×`}
              title="Playback speed"
            >
              {rate}×
            </Button>
          </div>
        </div>
        {audioState === 'error' && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <TriangleAlert className="size-3.5" aria-hidden /> The narration (audiobook.m4a) could not be loaded. It may still be generating, or the API is not running.
          </p>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1 text-xs text-muted-foreground">
        <span>Click any sentence on the page to jump there</span>
        <span className="flex items-center gap-1">
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> sentence
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Space</Kbd> play / pause
        </span>
        <span className="tabular sm:ml-auto">{formatDuration(duration)} total</span>
      </p>
    </div>
  );
}
