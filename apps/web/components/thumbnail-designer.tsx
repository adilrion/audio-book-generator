'use client';

import type { PublishContext, PublishState, ThumbnailDesign } from '@app/types';
import { Download, ImageUp, LoaderCircle, Save, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { CharCount, PubField } from '@/components/publish-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { ApiError, api, apiUrl, pageImageUrl, toApiError } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/format';
import { THUMB_ACCENTS, THUMB_H, THUMB_LAYOUTS, THUMB_W, canvasToJpeg, drawThumbnail, loadFonts, loadImage, pageFonts } from '@/lib/thumbnail';
import { cn } from '@/lib/utils';

function runtime(sec: number, lang: 'en' | 'bn') {
  const m = Math.max(1, Math.round(sec / 60));
  const t = m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${m} min`;
  return lang === 'bn' ? `${t} · পাঠসহ` : `${t} · Read-along`;
}

/**
 * Designs the YouTube thumbnail on a canvas: the book cover (or your own image), the title and a
 * runtime badge. "Save" stores the exact JPEG shown; the previews use the live design.
 */
export function ThumbnailDesigner({
  projectId,
  ctx,
  text,
  design,
  saved,
  onTextChange,
  onDesignChange,
  onPreview,
  onSaved,
  fileName,
  disabled,
}: {
  projectId: string;
  ctx: PublishContext;
  text: string;
  design: ThumbnailDesign;
  saved?: PublishState['thumbnail'];
  onTextChange: (t: string) => void;
  onDesignChange: (d: ThumbnailDesign) => void;
  /** Live JPEG data URL of the current design, for the YouTube / social previews. */
  onPreview: (url: string) => void;
  onSaved: (s: PublishState) => void;
  fileName: string;
  disabled?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [coverImg, setCoverImg] = useState<HTMLImageElement | null>(null);
  const [customImg, setCustomImg] = useState<HTMLImageElement | null>(null);
  const [source, setSource] = useState<'cover' | 'custom'>('cover');
  const [fonts, setFonts] = useState<{ serif: string; sans: string }>();
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<ApiError>();
  const [savedSig, setSavedSig] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const ids = { text: useId(), kicker: useId(), author: useId(), badge: useId() };

  useEffect(() => {
    const f = pageFonts();
    void loadFonts(f).then(() => setFonts(f));
    // `?cors` keeps this request apart from the cover <img> the page already cached without CORS.
    loadImage(`${pageImageUrl(projectId, 1)}?cors=1`).then(setCoverImg, () => setCoverImg(null));
  }, [projectId]);

  const image = source === 'custom' && customImg ? customImg : coverImg;
  const sig = JSON.stringify([design, text, source, customImg?.src.slice(-32), !!coverImg]);

  useEffect(() => {
    const c = canvas.current;
    const ctx2d = c?.getContext('2d');
    if (!c || !ctx2d || !fonts) return;
    drawThumbnail(ctx2d, design, { title: text, author: ctx.author, badge: runtime(ctx.durationSec, ctx.language), image, fonts });
    const t = window.setTimeout(() => onPreview(c.toDataURL('image/jpeg', 0.82)), 120);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, fonts]);

  const set = (patch: Partial<ThumbnailDesign>) => onDesignChange({ ...design, ...patch });

  const save = async () => {
    if (!canvas.current) return;
    setBusy('save');
    setError(undefined);
    try {
      const fresh = await api.uploadThumbnail(projectId, await canvasToJpeg(canvas.current));
      setSavedSig(sig);
      onSaved(fresh);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    setError(undefined);
    try {
      onSaved(await api.deleteThumbnail(projectId));
      setSavedSig(undefined);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (!canvas.current) return;
    const url = URL.createObjectURL(await canvasToJpeg(canvas.current));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const unsaved = !saved || (savedSig !== undefined && savedSig !== sig);

  return (
    <div className="grid gap-6" id="pub-thumbnail">
      <div className="grid gap-2">
        <canvas
          ref={canvas}
          width={THUMB_W}
          height={THUMB_H}
          className="aspect-video w-full rounded-xl border bg-muted shadow-card"
          role="img"
          aria-label={`Thumbnail preview: ${text}`}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {THUMB_W}×{THUMB_H} JPEG · YouTube allows up to 2 MB
          </span>
          {saved && (
            <span className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- the saved file, from the local API */}
              <img src={`${apiUrl(saved.url)}?inline=1&v=${saved.size}`} alt="Saved thumbnail" className="h-6 rounded-sm border" />
              Saved {formatRelative(saved.updatedAt)} · {formatBytes(saved.size)}
              {unsaved && savedSig !== undefined && <span className="text-info">· changed</span>}
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-2.5">
        <Label className="text-[13px]">Layout</Label>
        <Segmented value={design.layout} onValueChange={(v) => set({ layout: v as ThumbnailDesign['layout'] })} aria-label="Thumbnail layout" className="flex-wrap sm:w-full" disabled={disabled}>
          {THUMB_LAYOUTS.map((l) => (
            <SegmentedItem key={l.value} value={l.value} title={l.hint}>
              {l.label}
            </SegmentedItem>
          ))}
        </Segmented>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <PubField label="Thumbnail text" htmlFor={ids.text} counter={<CharCount value={[...text].length} max={50} warn={30} />} hint="2–5 strong words read best on a phone.">
          <Input id={ids.text} value={text} onChange={(e) => onTextChange(e.target.value)} disabled={disabled} />
        </PubField>
        <PubField label="Small line above" htmlFor={ids.kicker} hint="e.g. “Full audiobook” — leave empty to hide.">
          <Input id={ids.kicker} value={design.kicker} maxLength={40} onChange={(e) => set({ kicker: e.target.value })} disabled={disabled} />
        </PubField>
      </div>

      <div className="grid gap-2.5">
        <Label className="text-[13px]">Accent colour</Label>
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Accent colour">
          {THUMB_ACCENTS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={design.accent.toUpperCase() === c}
              aria-label={c}
              disabled={disabled}
              onClick={() => set({ accent: c })}
              className={cn(
                'size-7 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)] transition-transform hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                design.accent.toUpperCase() === c && 'ring-2 ring-foreground ring-offset-2 ring-offset-card',
              )}
              style={{ background: c }}
            />
          ))}
          <label className="relative grid size-7 cursor-pointer place-items-center overflow-hidden rounded-full border text-[10px] text-muted-foreground" title="Custom colour">
            +
            <input type="color" value={design.accent} onChange={(e) => set({ accent: e.target.value.toUpperCase() })} className="absolute inset-0 cursor-pointer opacity-0" disabled={disabled} />
          </label>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2.5">
          <Label className="text-[13px]">Image</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={source} onValueChange={(v) => (v === 'custom' && !customImg ? fileInput.current?.click() : setSource(v as 'cover' | 'custom'))} aria-label="Image" className="w-fit">
              <SegmentedItem value="cover">Book cover</SegmentedItem>
              <SegmentedItem value="custom">Your image</SegmentedItem>
            </Segmented>
            <Button variant="ghost" size="xs" onClick={() => fileInput.current?.click()} disabled={disabled}>
              <ImageUp aria-hidden /> Choose…
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                const url = URL.createObjectURL(f);
                loadImage(url).then(
                  (img) => {
                    setCustomImg(img);
                    setSource('custom');
                  },
                  () => setError(new ApiError({ code: 'BAD_IMAGE', message: 'That image could not be opened — choose a JPEG, PNG or WebP file.' })),
                );
              }}
            />
          </div>
        </div>
        <div className="grid content-start gap-3 pt-1">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={ids.author} className="text-[13px]">
              Show the author
            </Label>
            <Switch id={ids.author} checked={design.showAuthor} onCheckedChange={(v) => set({ showAuthor: v })} disabled={disabled || !ctx.author} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={ids.badge} className="text-[13px]">
              Show runtime badge
            </Label>
            <Switch id={ids.badge} checked={design.showBadge} onCheckedChange={(v) => set({ showBadge: v })} disabled={disabled} />
          </div>
        </div>
      </div>

      {error && <ApiErrorAlert error={error} />}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button variant="brand" onClick={() => void save()} disabled={disabled || !!busy || !fonts}>
          {busy === 'save' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Save aria-hidden />}
          {saved ? 'Save thumbnail' : 'Save as thumbnail'}
        </Button>
        <Button variant="outline" onClick={() => void download()} disabled={!fonts}>
          <Download aria-hidden /> Download
        </Button>
        {saved && (
          <Button variant="ghost" onClick={() => void remove()} disabled={disabled || !!busy} className="ml-auto text-muted-foreground">
            {busy === 'remove' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />} Remove saved
          </Button>
        )}
      </div>
    </div>
  );
}
