'use client';

import type { HighlightStyle, Timeline } from '@app/types';
import { ChevronsLeft, ChevronsRight, LoaderCircle, Pause, Play, SkipBack, SkipForward, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { pageImageUrl } from '@/lib/api';
import { formatClock, formatDuration } from '@/lib/format';
import { withAlpha } from '@/lib/highlight';
import { hitTest, pageSizeOf, rectToPercent, segmentIndexAt, segmentsByPage } from '@/lib/timeline';
import { cn } from '@/lib/utils';

const RATES = [0.75, 1, 1.25, 1.5, 2];
const EPS = 0.02; // seek slightly past a segment start so float rounding can't land on the previous one

export interface ReadAlongPlayerProps {
  projectId: string;
  timeline: Timeline;
  audioSrc: string;
  highlightStyle: HighlightStyle;
  highlightColor: string;
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

/**
 * Read-along preview: streams audiobook.m4a, shows the PDF page being narrated and draws the
 * current segment's rects (PDF points → % of the page box). The playhead is sampled every
 * animation frame; a binary search finds the segment, and React only re-renders when it changes.
 */
export function ReadAlongPlayer({ projectId, timeline, audioSrc, highlightStyle, highlightColor }: ReadAlongPlayerProps) {
  const segments = timeline.segments;
  const chapters = timeline.chapters;
  const duration = timeline.duration || segments.at(-1)?.end || 0;
  const byPage = useMemo(() => segmentsByPage(segments), [segments]);

  const audioRef = useRef<HTMLAudioElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const idxRef = useRef(-1);
  const draggingRef = useRef(false);

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
    const onSeek = () => paint(a.currentTime);
    const onReady = () => setAudioState('ready');
    const onError = () => setAudioState('error');
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onPause);
    a.addEventListener('seeking', onSeek);
    a.addEventListener('seeked', onSeek);
    a.addEventListener('timeupdate', onSeek);
    a.addEventListener('loadedmetadata', onReady);
    a.addEventListener('error', onError);
    if (a.readyState >= 1) setAudioState('ready');
    paint(a.currentTime);
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

  const seek = useCallback(
    (t: number) => {
      const a = audioRef.current;
      const clamped = Math.max(0, Math.min(duration, t));
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
  const boxes = current && current.page === page ? current.rects.map((r) => rectToPercent(r, [pw, ph])) : [];
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
  const displayWidth = `min(100%, calc(max(320px, 100dvh - 360px) * ${pw} / ${ph}))`;

  return (
    <div className="grid gap-4 outline-none" onKeyDown={onPlayerKey}>
      <audio ref={audioRef} src={audioSrc} preload="metadata" className="hidden" />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        {/* Page + highlight overlay */}
        <div className="grid min-w-0 place-items-center rounded-xl bg-muted/50 p-3 sm:p-5">
          <div
            className="relative cursor-pointer overflow-hidden rounded-[3px] bg-white shadow-[0_1px_3px_rgb(0_0_0/0.12),0_8px_24px_-8px_rgb(0_0_0/0.25)]"
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
            <span className="absolute right-2 bottom-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white tabular">Page {page}</span>
          </div>
        </div>

        {/* Now reading + chapters */}
        <div className="grid min-w-0 content-start gap-4">
          <div className="grid gap-2 rounded-xl border p-4">
            <p className="text-xs font-medium text-muted-foreground">Now reading</p>
            <p className="min-h-[3lh] text-[15px] leading-relaxed" aria-live="off">
              {current ? current.text : <span className="text-muted-foreground">Press play to start the read-along.</span>}
            </p>
            <p className="text-xs text-muted-foreground tabular">
              {current ? `Sentence ${idx + 1} of ${segments.length.toLocaleString('en-US')} · Page ${current.page}` : `${segments.length.toLocaleString('en-US')} sentences`}
            </p>
          </div>

          <div className="grid gap-1 rounded-xl border p-2">
            <p className="px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground">Chapters</p>
            <ol className="grid max-h-64 gap-0.5 overflow-y-auto lg:max-h-[42vh]">
              {chapters.map((c, i) => {
                const active = chapter?.index === c.index && idx >= 0;
                return (
                  <li key={c.index}>
                    <button
                      type="button"
                      onClick={() => seek(c.start + EPS)}
                      className={cn(
                        'flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                        active && 'bg-brand/20 font-medium hover:bg-brand/25',
                      )}
                      aria-current={active ? 'true' : undefined}
                    >
                      <span className="w-5 shrink-0 text-xs text-muted-foreground tabular">{i + 1}</span>
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
      <div className="grid gap-3 rounded-xl border p-3 sm:p-4">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current?.start ?? 0)}
          aria-valuetext={current ? `${formatClock(current.start)} — ${chapter?.title ?? ''}` : '0:00'}
          className="group relative h-6 cursor-pointer touch-none outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
            <div ref={fillRef} className="h-full w-0 bg-primary" />
          </div>
          {chapters.slice(1).map((c) => (
            <span
              key={c.index}
              className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/35"
              style={{ left: `${duration ? (c.start / duration) * 100 : 0}%` }}
              title={`${c.title} · ${formatClock(c.start)}`}
            />
          ))}
          <div ref={thumbRef} className="pointer-events-none absolute top-1/2 left-0 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow-sm transition-transform group-hover:scale-110" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={prevSentence} aria-label="Previous sentence" title="Previous sentence (←)">
              <SkipBack aria-hidden />
            </Button>
            <Button size="icon" className="rounded-full" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (space)" disabled={audioState === 'error'}>
              {playing ? <Pause className="fill-current" aria-hidden /> : <Play className="translate-x-px fill-current" aria-hidden />}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={nextSentence} aria-label="Next sentence" title="Next sentence (→)">
              <SkipForward aria-hidden />
            </Button>
          </div>
          <span className="text-sm tabular">
            <span ref={timeRef}>0:00</span>
            <span className="text-muted-foreground"> / {formatClock(duration)}</span>
          </span>
          <div className="ml-auto flex items-center gap-1">
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
            <span className="hidden max-w-48 truncate text-xs text-muted-foreground sm:inline" title={chapter?.title}>
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
              className="w-14 tabular"
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
        <p className="text-[11px] text-muted-foreground">
          Tip: click any sentence on the page to jump there · ←/→ previous/next sentence · space to play/pause · {formatDuration(duration)} total
        </p>
      </div>
    </div>
  );
}
