'use client';

import type { ShortDetail, ShortThumbnail } from '@app/types';
import { Download, LoaderCircle, Save, Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { ColorSwatches, Field, ToggleList, ToggleRow } from '@/components/settings-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type ApiError, api, pageImageUrl, shortOutputUrl, toApiError } from '@/lib/api';
import { SHORT_ACCENTS, SHORT_THEMES } from '@/lib/shorts';
import { isSceneTheme, motionSvg, sceneSvg, svgDataUrl } from '@/lib/short-scenes';
import { SHORT_THUMB_LAYOUTS, type ShortThumbContent, THUMB_H, THUMB_W, defaultShortThumbnail, drawShortThumbnail, firstSentence } from '@/lib/short-thumbnail';
import { canvasToJpeg, loadImage } from '@/lib/thumbnail';
import { cn } from '@/lib/utils';

/** An image loaded from `src` (null while loading, or without a src). */
function useLoadedImage(src: string | undefined) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let live = true;
    setImg(null);
    if (src)
      loadImage(src)
        .then((i) => live && setImg(i))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [src]);
  return img;
}

const same = (a: ShortThumbnail, b?: ShortThumbnail) => !!b && a.layout === b.layout && a.headline === b.headline && a.kicker === b.kicker && a.accent === b.accent;

/**
 * The vertical YouTube thumbnail of a short. Drawn live on a canvas from the short's own look;
 * "Save" stores exactly the JPEG shown (≤ 2 MB) as thumbnail.jpg.
 */
export function ShortThumbnailDesigner({ short, busy, onChange }: { short: ShortDetail; busy: boolean; onChange: (s: ShortDetail) => void }) {
  const ids = { headline: useId(), kicker: useId(), accent: useId() };
  const [design, setDesign] = useState<ShortThumbnail>(() => short.thumbnail ?? defaultShortThumbnail({ accent: short.settings.look.accent, language: short.language, hasBook: !!short.projectId }));
  const [cover, setCover] = useState<HTMLImageElement | null>(null);
  const [saving, setSaving] = useState<'save' | 'remove' | 'intro'>();
  const [error, setError] = useState<ApiError>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const minis = useRef<Record<string, HTMLCanvasElement | null>>({});

  useEffect(() => {
    let live = true;
    setCover(null);
    if (short.projectId)
      loadImage(pageImageUrl(short.projectId, 1))
        .then((img) => live && setCover(img))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [short.projectId]);

  // stills of the animated background and the motion overlay (paused SVGs)
  const look = short.settings.look;
  const sceneUrl = isSceneTheme(look.theme) ? svgDataUrl(sceneSvg(look.theme, { paused: true })) : undefined;
  const motionUrl = look.motion && look.motion !== 'none' ? svgDataUrl(motionSvg(look.motion, { accent: look.accent, light: !!SHORT_THEMES[look.theme]?.light, paused: true })) : undefined;
  const scene = useLoadedImage(sceneUrl);
  const motion = useLoadedImage(motionUrl);

  const content: ShortThumbContent = useMemo(
    () => ({
      title: short.title,
      firstLine: firstSentence(short.script),
      theme: short.settings.look.theme,
      uppercase: short.settings.look.uppercase,
      language: short.language,
      bookTitle: short.bookTitle,
      author: short.bookAuthor,
      cover,
      scene,
      motion,
    }),
    [short.title, short.script, short.settings.look.theme, short.settings.look.uppercase, short.language, short.bookTitle, short.bookAuthor, cover, scene, motion],
  );

  useEffect(() => {
    const t = window.setTimeout(() => {
      const ctx = canvas.current?.getContext('2d');
      if (ctx) drawShortThumbnail(ctx, design, content);
      for (const l of SHORT_THUMB_LAYOUTS) {
        const m = minis.current[l.value]?.getContext('2d');
        if (!m) continue;
        m.setTransform(0.2, 0, 0, 0.2, 0, 0);
        drawShortThumbnail(m, { ...design, layout: l.value }, content);
      }
    }, 60);
    return () => window.clearTimeout(t);
  }, [design, content]);

  const saved = !!short.thumbnailVersion;
  const dirty = !saved || !same(design, short.thumbnail);

  const save = async () => {
    if (!canvas.current) return;
    setSaving('save');
    setError(undefined);
    try {
      drawShortThumbnail(canvas.current.getContext('2d')!, design, content);
      const jpeg = await canvasToJpeg(canvas.current);
      await api.updateShort(short.id, { thumbnail: design });
      onChange(await api.uploadShortThumbnail(short.id, jpeg));
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setSaving(undefined);
    }
  };

  const remove = async () => {
    setSaving('remove');
    setError(undefined);
    try {
      onChange(await api.deleteShortThumbnail(short.id));
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setSaving(undefined);
    }
  };

  const setIntro = async (on: boolean) => {
    setSaving('intro');
    setError(undefined);
    try {
      onChange(await api.updateShort(short.id, { settings: { look: { thumbnailIntro: on } } }));
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setSaving(undefined);
    }
  };

  const update = (patch: Partial<ShortThumbnail>) => setDesign((d) => ({ ...d, ...patch }));

  return (
    <section className="grid gap-5 rounded-2xl border bg-card p-5 shadow-card" aria-labelledby={`${ids.headline}-h`}>
      <div className="grid gap-0.5">
        <h2 id={`${ids.headline}-h`} className="text-[15px] font-semibold tracking-tight">
          Thumbnail
        </h2>
        <p className="text-sm text-muted-foreground">Vertical 1080 × 1920, in the short’s own look. Big, few words read best on a phone.</p>
      </div>

      <div className="grid gap-5 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
        <div className="grid content-start gap-2">
          <canvas ref={canvas} width={THUMB_W} height={THUMB_H} className="aspect-[9/16] w-full rounded-xl bg-muted shadow-book" aria-label="Thumbnail preview" role="img" />
          <p className="text-center text-xs text-muted-foreground">{saved ? (dirty ? 'Changed — save to update thumbnail.jpg' : 'Saved as thumbnail.jpg') : 'Not saved yet'}</p>
        </div>

        <div className="grid content-start gap-4">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Thumbnail layout">
            {SHORT_THUMB_LAYOUTS.map((l) => {
              const on = design.layout === l.value;
              const unavailable = l.value === 'cover' && !short.projectId;
              return (
                <button
                  key={l.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={unavailable}
                  title={unavailable ? 'Only for shorts made from a book' : l.hint}
                  onClick={() => update({ layout: l.value })}
                  className={cn(
                    'grid gap-1.5 rounded-xl border p-1.5 text-left transition-colors outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40',
                    on && 'border-foreground/50 bg-accent/50 ring-1 ring-foreground/25',
                  )}
                >
                  <canvas ref={(el) => void (minis.current[l.value] = el)} width={THUMB_W / 5} height={THUMB_H / 5} className="aspect-[9/16] w-full rounded-lg bg-muted" aria-hidden />
                  <span className="px-1 pb-0.5 text-xs font-medium">{l.label}</span>
                </button>
              );
            })}
          </div>
          <Field label="Hook" htmlFor={ids.headline} hint="Put *stars* around the words to colour, e.g. The *loneliest* job. Empty: the title.">
            <Input id={ids.headline} value={design.headline} onChange={(e) => update({ headline: e.target.value })} maxLength={120} placeholder={short.title} className="h-10" />
          </Field>
          <Field label="Label" htmlFor={ids.kicker} hint="The small pill, e.g. “60-second audiobook”. Empty: none.">
            <Input id={ids.kicker} value={design.kicker} onChange={(e) => update({ kicker: e.target.value })} maxLength={40} className="h-10" />
          </Field>
          <Field label="Accent colour">
            <ColorSwatches id={ids.accent} label="Accent colour" colors={SHORT_ACCENTS} value={design.accent} onChange={(accent) => update({ accent })} />
          </Field>
        </div>
      </div>

      <ToggleList>
        <ToggleRow
          label="Open the video with the thumbnail"
          description="Shows it for a quarter of a second at the start, so you can pick it as the cover frame in the YouTube app. Needs a saved thumbnail and a new render."
          checked={!!short.settings.look.thumbnailIntro}
          onCheckedChange={(v) => void setIntro(v)}
          disabled={busy || !!saving || !saved}
        />
      </ToggleList>

      {error && <ApiErrorAlert error={error} title="The thumbnail could not be saved" />}

      <div className="flex flex-wrap gap-2">
        <Button variant={dirty ? 'brand' : 'outline'} onClick={() => void save()} disabled={!!saving || !dirty}>
          {saving === 'save' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Save aria-hidden />} Save thumbnail
        </Button>
        {saved && (
          <>
            <Button asChild variant="outline">
              <a href={shortOutputUrl(short.id, 'thumbnail.jpg', { as: `${short.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 90) || 'short'} thumbnail`, v: short.thumbnailVersion })} download>
                <Download aria-hidden /> Download JPEG
              </a>
            </Button>
            <Button variant="ghost" className="text-muted-foreground" onClick={() => void remove()} disabled={!!saving || busy}>
              {saving === 'remove' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />} Remove
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
