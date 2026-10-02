'use client';

import {
  ASPECT_SIZES,
  type AnimationStyle,
  type AspectRatio,
  type FrameStyle,
  type HighlightMode,
  type HighlightStyle,
  type OcrMode,
  type PageFit,
  type ProjectSettings,
  type TTSEngineName,
  type VideoTheme,
} from '@app/types';
import {
  Captions,
  Check,
  Crosshair,
  Film,
  Headphones,
  Info,
  LoaderCircle,
  type LucideIcon,
  Mic,
  Move,
  Palette,
  RectangleHorizontal,
  ScanText,
  Sparkles,
  Square,
  StretchHorizontal,
  TextSelect,
  TriangleAlert,
} from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useId, useState } from 'react';
import { CommandSnippet } from '@/components/copy-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioCard, RadioGroup } from '@/components/ui/radio-group';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { VoicePreview } from '@/components/voice-preview';
import { useApi } from '@/hooks/use-api';
import { api, type SystemConfig } from '@/lib/api';
import { highlightStyleCss, tintStyleCss } from '@/lib/highlight';
import { splitHint } from '@/lib/hint';
import { cloneSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { ENGINE_LABELS, applyLanguage, defaultVoiceFor, groupVoices, pickVoice, voiceMeta } from '@/lib/voices';

// ─────────────────────────────── options ───────────────────────────────

const ASPECTS: { value: AspectRatio; label: string; hint: string }[] = [
  { value: '16:9', label: '16:9', hint: 'YouTube · 1920×1080' },
  { value: '9:16', label: '9:16', hint: 'Shorts / Reels · 1080×1920' },
  { value: '1:1', label: '1:1', hint: 'Square · 1080×1080' },
];

const ANIMATIONS: { value: AnimationStyle; label: string; hint: string; icon: LucideIcon }[] = [
  { value: 'follow', label: 'Follow the text', hint: 'Gentle zoom and pan towards the sentence being read', icon: Crosshair },
  { value: 'kenburns', label: 'Ken Burns', hint: 'Slow, continuous zoom and drift across the page', icon: Move },
  { value: 'static', label: 'Static', hint: 'Whole page, no motion', icon: Square },
];

const PAGE_FITS: { value: PageFit; label: string; hint: string; icon: LucideIcon }[] = [
  { value: 'auto', label: 'Comfortable', hint: 'The page with a margin around it — the camera style sets the zoom.', icon: RectangleHorizontal },
  { value: 'width', label: 'Full width', hint: 'The page fills the frame from edge to edge, with no background showing.', icon: StretchHorizontal },
  { value: 'text', label: 'Fit text', hint: 'Crops the page’s own margins so the printed text fills the width — the largest, easiest-to-read text.', icon: TextSelect },
];

const HIGHLIGHT_MODES: { value: HighlightMode; label: string; hint: string }[] = [
  { value: 'sentence', label: 'Sentence', hint: 'The sentence being read is highlighted.' },
  { value: 'paragraph', label: 'Paragraph', hint: 'The whole paragraph being read is highlighted.' },
  { value: 'word', label: 'Word', hint: 'The word being spoken is highlighted and glides smoothly from word to word.' },
  { value: 'cursor', label: 'Cursor', hint: 'A reading cursor sweeps through the sentence as it is spoken, filling in the words read so far.' },
];

const FRAME_STYLES: { value: FrameStyle; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'solid', label: 'Solid' },
  { value: 'double', label: 'Double' },
  { value: 'dashed', label: 'Dashed' },
];

export const THEMES: { value: VideoTheme; label: string; bg: string; page: string; ink: string }[] = [
  { value: 'paper', label: 'Paper', bg: 'rgb(236 230 218)', page: '#ffffff', ink: 'rgb(40 38 34)' },
  { value: 'light', label: 'Light', bg: 'rgb(243 244 246)', page: '#ffffff', ink: 'rgb(17 24 39)' },
  { value: 'dark', label: 'Dark', bg: 'rgb(17 19 24)', page: '#ffffff', ink: 'rgb(17 24 39)' },
];

const COLORS: { value: string; label: string }[] = [
  { value: '#FFD54F', label: 'Amber' },
  { value: '#FFF176', label: 'Lemon' },
  { value: '#A5D6A7', label: 'Mint' },
  { value: '#90CAF9', label: 'Sky' },
  { value: '#F48FB1', label: 'Rose' },
  { value: '#CE93D8', label: 'Lilac' },
  { value: '#FFAB91', label: 'Peach' },
];

const FRAME_COLORS: { value: string; label: string }[] = [
  { value: '#1F2937', label: 'Charcoal' },
  { value: '#000000', label: 'Black' },
  { value: '#FFFFFF', label: 'White' },
  { value: '#8B5E34', label: 'Walnut' },
  { value: '#1E3A8A', label: 'Navy' },
  { value: '#166534', label: 'Forest' },
  { value: '#881337', label: 'Burgundy' },
  { value: '#CA8A04', label: 'Gold' },
];

const OCR_MODES: { value: OcrMode; label: string }[] = [
  { value: 'auto', label: 'Automatic — only for scanned pages' },
  { value: 'off', label: 'Off — use the PDF text layer only' },
  { value: 'force', label: 'Always — OCR every page' },
];

export { validateSettings } from '@/lib/settings';

// ─────────────────────────────── layout helpers ───────────────────────────────

export function FormSection({
  icon,
  step,
  title,
  description,
  children,
  className,
  id,
}: {
  icon?: ReactNode;
  step?: number;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className={cn('scroll-mt-24 rounded-2xl border bg-card shadow-card', className)}>
      <header className="flex items-start gap-3.5 px-5 pt-5 pb-1 sm:px-6 sm:pt-6">
        {step !== undefined ? (
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-[13px] font-semibold text-background tabular">{step}</span>
        ) : (
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span>
        )}
        <div className="grid gap-0.5 pt-0.5">
          <h2 id={headingId} className="text-[15px] leading-tight font-semibold tracking-tight">
            {title}
          </h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      </header>
      <div className="grid gap-6 px-5 pt-4 pb-5 sm:px-6 sm:pb-6 sm:pl-[4.25rem]">{children}</div>
    </section>
  );
}

function Field({ label, htmlFor, hint, children, className }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-2.5', className)}>
      <Label htmlFor={htmlFor} className="text-[13px]">
        {label}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Grouped on/off settings, macOS-settings style. */
function ToggleList({ children }: { children: ReactNode }) {
  return <div className="divide-y overflow-hidden rounded-xl border">{children}</div>;
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid gap-3 px-4 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor={id} className="text-[13px]">
            {label}
          </Label>
          {description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
      </div>
      {children}
    </div>
  );
}

function AspectShape({ ratio }: { ratio: AspectRatio }) {
  const { width, height } = ASPECT_SIZES[ratio];
  const scale = 26 / Math.max(width, height);
  return (
    <span className="grid size-8 place-items-center" aria-hidden>
      <span className="rounded-[3px] border-2 border-current opacity-70 group-data-[state=checked]:opacity-100" style={{ width: width * scale, height: height * scale }} />
    </span>
  );
}

function CheckedMark() {
  return (
    <span
      className="absolute top-2.5 right-2.5 hidden size-4 place-items-center rounded-full bg-foreground text-background group-data-[state=checked]:grid"
      aria-hidden
    >
      <Check className="size-2.5" strokeWidth={3} />
    </span>
  );
}

/** Perceived lightness of `#RRGGBB` (0 dark … 1 light), to pick a readable check mark. */
function lightness(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/** Preset colour swatches plus a custom colour picker. */
function ColorSwatches({ id, label, colors, value, onChange }: { id: string; label: string; colors: { value: string; label: string }[]; value: string; onChange: (hex: string) => void }) {
  const custom = !colors.some((c) => c.value === value.toUpperCase());
  return (
    <div className="flex flex-wrap items-center gap-2.5" role="radiogroup" aria-label={label}>
      {colors.map((c) => {
        const on = value.toUpperCase() === c.value;
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={c.label}
            title={c.label}
            onClick={() => onChange(c.value)}
            className={cn(
              'grid size-8 place-items-center rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)] transition-transform outline-none hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none',
              on && 'ring-2 ring-foreground ring-offset-2 ring-offset-card',
            )}
            style={{ background: c.value }}
          >
            {on && <Check className={cn('size-3.5', lightness(c.value) > 0.6 ? 'text-black/70' : 'text-white/90')} strokeWidth={3} aria-hidden />}
          </button>
        );
      })}
      <label
        className={cn(
          'relative flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
          custom && 'text-foreground ring-2 ring-foreground ring-offset-2 ring-offset-card',
        )}
        htmlFor={id}
      >
        <span className="size-4 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)]" style={{ background: value }} aria-hidden />
        Custom
        <input id={id} type="color" className="absolute inset-0 cursor-pointer opacity-0" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      </label>
    </div>
  );
}

// ─────────────────────────────── highlight preview ───────────────────────────────

/** Frame border as CSS, in `cqmin` of the preview (the video scales the border with min(width, height)). */
function frameLayers(v: ProjectSettings['video'], bg: string): { inset: string; picture: CSSProperties; overlay?: CSSProperties } | undefined {
  if (v.frameStyle === 'none') return undefined;
  const b = v.frameWidth / 10.8; // px at 1080p → % of the shorter side
  const r = `${v.frameRadius / 10.8}cqmin`;
  const inset = `${b}cqmin`;
  if (v.frameStyle === 'solid') return { inset, picture: { borderRadius: r, boxShadow: `0 0 0 100cqmax ${v.frameColor}` } };
  if (v.frameStyle === 'double') {
    const line = `${b / 3}cqmin`;
    return { inset, picture: { borderRadius: r, boxShadow: `0 0 0 ${line} ${v.frameColor}, 0 0 0 100cqmax ${bg}` }, overlay: { border: `${line} solid ${v.frameColor}` } };
  }
  return { inset, picture: { borderRadius: r, boxShadow: `0 0 0 100cqmax ${bg}` }, overlay: { border: `${inset} dashed ${v.frameColor}` } };
}

/** Live mock-up of one video frame: theme, format, page size, frame, highlight mode/style/colour, chapter title and progress bar. */
export function LookPreview({ settings, className }: { settings: ProjectSettings; className?: string }) {
  const v = settings.video;
  const theme = THEMES.find((t) => t.value === v.theme) ?? THEMES[0];
  const hl = highlightStyleCss(v.highlightStyle, v.highlightColor);
  const tint = tintStyleCss(v.highlightStyle, v.highlightColor);
  const mode = v.highlightMode;
  const { width, height } = ASPECT_SIZES[v.aspectRatio];
  const frame = frameLayers(v, theme.bg);
  // Page geometry inside the picture. The page is a size container: its text scales with it.
  const fill = v.pageFit !== 'auto';
  const pageTaller = (width * 3) / 2 > height; // a full-width 2:3 page is taller than the frame
  const pageStyle: CSSProperties = fill
    ? { left: 0, right: 0, aspectRatio: '2 / 3', ...(pageTaller ? { top: v.pageFit === 'text' ? '-14%' : '-8%' } : { top: '50%', transform: 'translateY(-50%)' }) }
    : { top: '9%', bottom: '9%', left: '50%', aspectRatio: '2 / 3', transform: 'translateX(-50%)' };
  const pad = v.pageFit === 'text' ? '2.5cqw' : '5.8cqw';
  const sentence = (
    <>
      Steam engines{' '}
      {mode === 'word' ? (
        <span className="rounded-[1px]" style={hl}>
          changed
        </span>
      ) : mode === 'cursor' ? (
        <>
          <span className="rounded-[1px]" style={hl}>
            chan
          </span>
          <span className="relative">
            <span className="absolute inset-y-[-0.1em] left-0 w-[0.12em] -translate-x-1/2 rounded-full" style={{ background: v.highlightColor, filter: 'brightness(0.55)' }} />
            ged
          </span>
        </>
      ) : (
        'changed'
      )}{' '}
      how goods were made and moved.
    </>
  );
  const wordish = mode === 'word' || mode === 'cursor';
  return (
    <div className={cn('mx-auto w-full', v.aspectRatio === '9:16' ? 'max-w-[200px]' : v.aspectRatio === '1:1' ? 'max-w-[280px]' : 'max-w-[360px]', className)}>
      <div
        className="relative overflow-hidden rounded-xl [container-type:size] shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_10px_30px_-12px_rgb(0_0_0/0.4)]"
        style={{ background: theme.bg, aspectRatio: `${width} / ${height}` }}
        aria-hidden
      >
        <div className="absolute overflow-hidden" style={{ inset: frame?.inset ?? 0, borderRadius: frame?.picture.borderRadius }}>
          <div className={cn('absolute bg-white [container-type:inline-size]', !fill && 'rounded-[2px] shadow-md')} style={{ ...pageStyle, color: theme.ink }}>
            <div className="flex flex-col" style={{ padding: pad, gap: '4.7cqw' }}>
              {v.showChapterTitle && <p className="font-serif text-[8cqw] leading-tight font-semibold">Chapter 1: The Beginning</p>}
              <p className="font-serif text-[6cqw] leading-[1.5]">
                <span style={mode === 'paragraph' ? hl : undefined}>
                  The Industrial Revolution began in Britain.{' '}
                  <span className="rounded-[1px]" style={mode === 'sentence' ? hl : wordish && v.sentenceTint ? tint : undefined}>
                    {sentence}
                  </span>{' '}
                  Cities grew quickly around the new mills.
                </span>
              </p>
              <p className="font-serif text-[6cqw] leading-[1.5] opacity-80">Within a few decades the new methods had spread across Europe and beyond.</p>
            </div>
          </div>
          {v.showProgress && (
            <div className="absolute inset-x-0 bottom-0 h-[3cqh] min-h-[3px]" style={{ background: v.theme === 'dark' ? 'rgb(255 255 255 / 0.15)' : 'rgb(0 0 0 / 0.1)' }}>
              <div className="h-full w-[38%]" style={{ background: v.highlightColor }} />
            </div>
          )}
        </div>
        {frame && <div className="pointer-events-none absolute" style={{ inset: frame.inset, ...frame.picture }} />}
        {frame?.overlay && <div className="pointer-events-none absolute inset-0" style={frame.overlay} />}
      </div>
    </div>
  );
}

// ─────────────────────────────── voice picker ───────────────────────────────

function VoiceFields({ settings, config, disabled, update }: { settings: ProjectSettings; config?: SystemConfig; disabled?: boolean; update: (fn: (d: ProjectSettings) => void) => void }) {
  const engine = settings.tts.engine;
  const voices = useApi(`voices:${engine}`, (signal) => api.voices(engine, signal));
  const engines: TTSEngineName[] = config?.engines?.length ? config.engines : ['kokoro', 'piper', 'say'];
  const list = voices.data?.engine === engine ? voices.data.voices : [];
  const groups = groupVoices(list, settings.language);
  const voiceId = useId();

  // If the chosen voice is not installed for this engine, switch to the engine's default/first voice —
  // and say so: on a saved project the draft now differs from the voice the server will use.
  const currentVoice = settings.tts.voice;
  const [replaced, setReplaced] = useState<{ from: string; to: string }>();
  useEffect(() => {
    if (!list.length || list.some((v) => v.id === currentVoice)) return;
    // A multi-speaker Piper model's plain id ("bn_BD-google-medium", saved by older projects) is its
    // default speaker, listed first: the same voice under its listed id, so nothing to warn about.
    const speaker = currentVoice ? list.find((v) => v.id.startsWith(`${currentVoice}:`)) : undefined;
    if (speaker) return void update((d) => void (d.tts.voice = speaker.id));
    const next = pickVoice(list, defaultVoiceFor(config, engine, settings.language), settings.language);
    if (next && next !== currentVoice) {
      setReplaced(currentVoice ? { from: currentVoice, to: next } : undefined);
      update((d) => void (d.tts.voice = next));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, currentVoice, engine]);
  const replacedNote = replaced && replaced.to === currentVoice ? replaced : undefined;
  const selectedVoice = list.some((v) => v.id === currentVoice) ? currentVoice : undefined;

  const unavailable = voices.data && voices.data.engine === engine && !voices.data.available;
  const install = unavailable ? splitHint(voices.data?.message) : undefined;

  return (
    <>
      <Field label="Voice engine">
        <RadioGroup
          aria-label="Voice engine"
          value={engine}
          disabled={disabled}
          onValueChange={(e) =>
            update((d) => {
              d.tts.engine = e as TTSEngineName;
              d.tts.voice = defaultVoiceFor(config, e as TTSEngineName, d.language) ?? '';
            })
          }
          className={cn('grid gap-2', engines.length >= 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}
        >
          {engines.map((e) => (
            <RadioCard key={e} value={e} className="pr-8">
              <CheckedMark />
              <span className="font-medium">{ENGINE_LABELS[e]?.name ?? e}</span>
              <span className="text-xs leading-snug text-muted-foreground">{ENGINE_LABELS[e]?.description}</span>
            </RadioCard>
          ))}
        </RadioGroup>
      </Field>

      <Field
        label={
          <>
            Voice
            {voices.loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading voices" />}
          </>
        }
        htmlFor={voiceId}
        className="sm:max-w-md"
      >
        <VoicePreview engine={engine} voice={selectedVoice} speed={settings.tts.speed} language={settings.language} disabled={disabled}>
          <Select value={selectedVoice} disabled={disabled || !list.length} onValueChange={(v) => update((d) => void (d.tts.voice = v))}>
            <SelectTrigger id={voiceId} className="h-10">
              <SelectValue placeholder={voices.loading ? 'Loading voices…' : unavailable ? 'Engine not installed' : currentVoice || 'Choose a voice'} />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {groups.map((g, gi) => (
                <SelectGroup key={g.language}>
                  {gi > 0 && <SelectSeparator />}
                  <SelectLabel>
                    {g.label}
                    {g.language !== settings.language && gi > 0 && groups[0]?.language === settings.language ? ' · other language' : ''}
                  </SelectLabel>
                  {g.voices.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      <span className="shrink-0 font-medium">{v.name}</span>
                      {voiceMeta(v) && <span className="min-w-0 truncate text-muted-foreground">{voiceMeta(v)}</span>}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </VoicePreview>
        {replacedNote && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <span>
              The voice “{replacedNote.from}” is not installed for {ENGINE_LABELS[engine]?.name ?? engine}, so{' '}
              {list.find((v) => v.id === replacedNote.to)?.name ?? replacedNote.to} is selected instead.
            </span>
          </p>
        )}
        {voices.error && !voices.data && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <TriangleAlert className="size-3.5" aria-hidden /> {voices.error.message}
          </p>
        )}
      </Field>

      {unavailable && (
        <Alert variant="warning">
          <TriangleAlert aria-hidden />
          <AlertTitle>{ENGINE_LABELS[engine]?.name ?? engine} is not installed</AlertTitle>
          <AlertDescription>
            <p>{install?.command ? install.text?.replace(/\s*(?:Run|run|with):$/, '') : voices.data?.message}</p>
            {install?.command && <CommandSnippet command={install.command} className="mt-1 w-full" />}
            <p>Install it, then reopen this list — or pick another engine.</p>
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

// ─────────────────────────────── the form ───────────────────────────────

export interface SettingsFormProps {
  value: ProjectSettings;
  onChange: (next: ProjectSettings) => void;
  config?: SystemConfig;
  disabled?: boolean;
  /** Hints from the uploaded PDF. */
  document?: { likelyScanned?: boolean; hasToc?: boolean };
  /** Number of chapters detected (after analysis), for the chapter-range hint. */
  chapterCount?: number;
  /** Number the sections from this step (the new-audiobook flow); icons otherwise. */
  firstStep?: number;
  className?: string;
}

export function SettingsForm({ value, onChange, config, disabled, document, chapterCount, firstStep, className }: SettingsFormProps) {
  const update = (fn: (draft: ProjectSettings) => void) => {
    const next = cloneSettings(value);
    fn(next);
    onChange(next);
  };
  const v = value.video;
  const t = value.text;
  const videoOn = value.outputMode === 'audiobook_video';
  const ids = { lang: useId(), anim: useId(), ocr: useId(), from: useId(), to: useId(), color: useId(), frameColor: useId() };
  const range = t.chapterRange;
  const rangeError = range && (range.from < 1 || range.to < 1 || range.from > range.to) ? 'The first chapter must be 1 or higher and not after the last.' : undefined;
  const llmOff = config && !config.llm.enabled;
  const step = (n: number) => (firstStep === undefined ? undefined : firstStep + n);

  return (
    <fieldset disabled={disabled} className={cn('grid min-w-0 gap-6', className)}>
      {/* ── Output ── */}
      <FormSection id="output" step={step(0)} icon={<Film />} title="Output" description="What to produce from the book.">
        <RadioGroup aria-label="Output" value={value.outputMode} onValueChange={(m) => update((d) => void (d.outputMode = m as ProjectSettings['outputMode']))} className="grid gap-3 sm:grid-cols-2">
          <RadioCard value="audiobook_video" className="gap-2 pr-9">
            <CheckedMark />
            <span className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors group-data-[state=checked]:bg-brand group-data-[state=checked]:text-brand-foreground">
              <Film className="size-[18px]" aria-hidden />
            </span>
            <span className="flex flex-wrap items-center gap-2 font-medium">
              Audiobook + animated PDF
              <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
                Default
              </Badge>
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">Read-along MP4 with the spoken sentence highlighted, plus M4A audio and SRT subtitles.</span>
          </RadioCard>
          <RadioCard value="audiobook_only" className="gap-2 pr-9">
            <CheckedMark />
            <span className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors group-data-[state=checked]:bg-brand group-data-[state=checked]:text-brand-foreground">
              <Headphones className="size-[18px]" aria-hidden />
            </span>
            <span className="font-medium">Audiobook only</span>
            <span className="text-xs leading-relaxed text-muted-foreground">M4A audio with chapters and SRT subtitles. No video — much faster.</span>
          </RadioCard>
        </RadioGroup>
      </FormSection>

      {/* ── Narration ── */}
      <FormSection id="narration" step={step(1)} icon={<Mic />} title="Narration" description="Local text-to-speech — nothing leaves your Mac.">
        <Field label="Language" htmlFor={ids.lang} className="sm:max-w-md">
          <Select
            value={value.language}
            onValueChange={(l) => update((d) => applyLanguage(d, l as ProjectSettings['language'], config))}
          >
            <SelectTrigger id={ids.lang} className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="bn">
                Bangla{' '}
                <span className="text-muted-foreground" lang="bn">
                  বাংলা
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <VoiceFields settings={value} config={config} disabled={disabled} update={update} />
        <Field
          label={
            <>
              Speed
              <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular">{value.tts.speed.toFixed(2)}×</span>
            </>
          }
          className="sm:max-w-md"
        >
          <Slider
            min={0.5}
            max={2}
            step={0.05}
            value={[value.tts.speed]}
            onValueChange={([s]) => update((d) => void (d.tts.speed = Math.round(s * 100) / 100))}
            aria-label="Narration speed"
            disabled={disabled}
          />
          <div className="relative h-4 text-[11px] text-muted-foreground">
            <span className="absolute left-0">0.5× slower</span>
            {/* 1.0× sits at (1 - 0.5) / (2 - 0.5) = 1/3 of the track */}
            <button type="button" className="absolute left-1/3 -translate-x-1/2 rounded hover:text-foreground" onClick={() => update((d) => void (d.tts.speed = 1))}>
              1.0× normal
            </button>
            <span className="absolute right-0">2.0× faster</span>
          </div>
        </Field>
      </FormSection>

      {/* ── Video ── */}
      <FormSection id="look" step={step(2)} icon={<Palette />} title="Video & highlighting" description={videoOn ? 'How the animated PDF looks.' : 'Not used for audiobook-only output.'}>
        {!videoOn ? (
          <div className="flex flex-col gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>No video is rendered — only the audiobook and subtitles.</span>
            <Button type="button" size="sm" variant="outline" className="text-foreground" onClick={() => update((d) => void (d.outputMode = 'audiobook_video'))}>
              <Film aria-hidden /> Add the read-along video
            </Button>
          </div>
        ) : (
          <>
            <Field label="Video format">
              <RadioGroup
                aria-label="Video format"
                value={v.aspectRatio}
                onValueChange={(a) =>
                  update((d) => {
                    d.video.aspectRatio = a as AspectRatio;
                    Object.assign(d.video, ASPECT_SIZES[a as AspectRatio]);
                  })
                }
                className="grid grid-cols-3 gap-2"
              >
                {ASPECTS.map((a) => (
                  <RadioCard key={a.value} value={a.value} className="items-center gap-1 p-2.5 text-center">
                    <AspectShape ratio={a.value} />
                    <span className="font-medium">{a.label}</span>
                    <span className="text-[11px] leading-tight text-muted-foreground">{a.hint}</span>
                  </RadioCard>
                ))}
              </RadioGroup>
              {v.width !== ASPECT_SIZES[v.aspectRatio].width || v.height !== ASPECT_SIZES[v.aspectRatio].height ? (
                <p className="text-xs text-muted-foreground">
                  Custom size {v.width}×{v.height} — choosing a format resets it.
                </p>
              ) : null}
            </Field>

            <Field label="Camera" hint={ANIMATIONS.find((a) => a.value === v.animation)?.hint}>
              <RadioGroup aria-label="Camera animation" value={v.animation} onValueChange={(a) => update((d) => void (d.video.animation = a as AnimationStyle))} className="grid gap-2 sm:grid-cols-3">
                {ANIMATIONS.map((a) => (
                  <RadioCard key={a.value} value={a.value} className="flex-row items-center gap-2.5 p-2.5">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground transition-colors group-data-[state=checked]:bg-foreground group-data-[state=checked]:text-background">
                      <a.icon className="size-3.5" aria-hidden />
                    </span>
                    <span className="font-medium">{a.label}</span>
                  </RadioCard>
                ))}
              </RadioGroup>
            </Field>

            <Field
              label="Page size"
              hint={
                <>
                  {PAGE_FITS.find((f) => f.value === v.pageFit)?.hint}
                  {v.pageFit !== 'auto' && v.animation !== 'follow' ? ' The camera follows the narration, since the page is taller than the frame.' : ''}
                </>
              }
            >
              <RadioGroup aria-label="Page size" value={v.pageFit} onValueChange={(f) => update((d) => void (d.video.pageFit = f as PageFit))} className="grid gap-2 sm:grid-cols-3">
                {PAGE_FITS.map((f) => (
                  <RadioCard key={f.value} value={f.value} className="flex-row items-center gap-2.5 p-2.5">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground transition-colors group-data-[state=checked]:bg-foreground group-data-[state=checked]:text-background">
                      <f.icon className="size-3.5" aria-hidden />
                    </span>
                    <span className="font-medium">{f.label}</span>
                  </RadioCard>
                ))}
              </RadioGroup>
            </Field>

            <Field
              label="Highlight"
              hint={
                <>
                  {HIGHLIGHT_MODES.find((m) => m.value === v.highlightMode)?.hint}
                  {v.highlightMode === 'word' || v.highlightMode === 'cursor' ? ' Sentence timing is exact; word timing is estimated within each sentence.' : ''}
                </>
              }
            >
              <Segmented value={v.highlightMode} onValueChange={(m) => update((d) => void (d.video.highlightMode = m as HighlightMode))} aria-label="Highlight unit">
                {HIGHLIGHT_MODES.map((m) => (
                  <SegmentedItem key={m.value} value={m.value}>
                    {m.label}
                  </SegmentedItem>
                ))}
              </Segmented>
            </Field>

            <Field label="Style">
              <Segmented value={v.highlightStyle} onValueChange={(s) => update((d) => void (d.video.highlightStyle = s as HighlightStyle))} aria-label="Highlight style">
                <SegmentedItem value="marker">Marker</SegmentedItem>
                <SegmentedItem value="underline">Underline</SegmentedItem>
                <SegmentedItem value="box">Box</SegmentedItem>
              </Segmented>
            </Field>

            {(v.highlightMode === 'word' || v.highlightMode === 'cursor') && (
              <ToggleList>
                <ToggleRow
                  label="Tint the whole sentence"
                  description={`A faint highlight on the sentence keeps the reader’s place while the ${v.highlightMode === 'word' ? 'word highlight' : 'cursor'} moves.`}
                  checked={v.sentenceTint}
                  onCheckedChange={(c) => update((d) => void (d.video.sentenceTint = c))}
                />
              </ToggleList>
            )}

            <Field label="Highlight colour" htmlFor={ids.color}>
              <ColorSwatches id={ids.color} label="Highlight colour" colors={COLORS} value={v.highlightColor} onChange={(c) => update((d) => void (d.video.highlightColor = c))} />
            </Field>

            <Field label="Background">
              <RadioGroup aria-label="Background theme" value={v.theme} onValueChange={(th) => update((d) => void (d.video.theme = th as VideoTheme))} className="grid grid-cols-3 gap-2">
                {THEMES.map((th) => (
                  <RadioCard key={th.value} value={th.value} className="gap-2 p-2">
                    <span className="grid h-12 w-full place-items-center rounded-lg shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]" style={{ background: th.bg }} aria-hidden>
                      <span className="grid h-8 w-6 content-start gap-[3px] rounded-[2px] bg-white p-1 shadow-sm">
                        <span className="h-[2px] w-full rounded-full bg-black/25" />
                        <span className="h-[2px] w-full rounded-full" style={{ background: v.highlightColor }} />
                        <span className="h-[2px] w-3/4 rounded-full bg-black/25" />
                      </span>
                    </span>
                    <span className="px-0.5 font-medium">{th.label}</span>
                  </RadioCard>
                ))}
              </RadioGroup>
            </Field>

            <Field label="Frame border" hint={v.frameStyle === 'none' ? 'A border around the whole video, in your colour.' : 'The picture is inset inside the border, so it never covers the text.'}>
              <Segmented value={v.frameStyle} onValueChange={(f) => update((d) => void (d.video.frameStyle = f as FrameStyle))} aria-label="Frame border style">
                {FRAME_STYLES.map((f) => (
                  <SegmentedItem key={f.value} value={f.value}>
                    {f.label}
                  </SegmentedItem>
                ))}
              </Segmented>
            </Field>
            {v.frameStyle !== 'none' && (
              <div className="grid gap-6 sm:grid-cols-2">
                <Field label="Border colour" htmlFor={ids.frameColor}>
                  <ColorSwatches id={ids.frameColor} label="Border colour" colors={FRAME_COLORS} value={v.frameColor} onChange={(c) => update((d) => void (d.video.frameColor = c))} />
                </Field>
                <div className="grid content-start gap-5">
                  <Field
                    label={
                      <>
                        Thickness
                        <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular">{v.frameWidth}px</span>
                      </>
                    }
                  >
                    <Slider min={2} max={80} step={1} value={[v.frameWidth]} onValueChange={([w]) => update((d) => void (d.video.frameWidth = w))} aria-label="Border thickness" />
                  </Field>
                  <Field
                    label={
                      <>
                        Rounded corners
                        <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular">{v.frameRadius ? `${v.frameRadius}px` : 'Square'}</span>
                      </>
                    }
                  >
                    <Slider min={0} max={64} step={1} value={[v.frameRadius]} onValueChange={([r]) => update((d) => void (d.video.frameRadius = r))} aria-label="Corner radius" />
                  </Field>
                </div>
              </div>
            )}

            <ToggleList>
              <ToggleRow
                label="Progress bar"
                description="Thin bar along the bottom showing how far into the book you are."
                checked={v.showProgress}
                onCheckedChange={(c) => update((d) => void (d.video.showProgress = c))}
              />
              <ToggleRow
                label="Chapter title"
                description="Show the chapter name briefly when a chapter begins."
                checked={v.showChapterTitle}
                onCheckedChange={(c) => update((d) => void (d.video.showChapterTitle = c))}
              />
              <ToggleRow
                label={
                  <>
                    <Captions className="size-3.5 text-muted-foreground" aria-hidden /> Embed subtitles in the MP4
                  </>
                }
                description="Adds a switchable subtitle track. subtitles.srt is always exported too."
                checked={v.embedSubtitles}
                onCheckedChange={(c) => update((d) => void (d.video.embedSubtitles = c))}
              />
            </ToggleList>
          </>
        )}
      </FormSection>

      {/* ── Text ── */}
      <FormSection id="text" step={step(3)} icon={<ScanText />} title="Text processing" description="Deterministic cleanup always runs first; these options fine-tune it.">
        <ToggleList>
          <ToggleRow
            label="Review chapters before narration"
            description="Pause after chapter detection so you can untick, rename or merge chapters first."
            checked={t.reviewChapters}
            onCheckedChange={(c) => update((d) => void (d.text.reviewChapters = c))}
          />
          <ToggleRow
            label="Skip front matter"
            description="Start narrating at the first chapter — skips the copyright page, table of contents, etc."
            checked={t.skipFrontMatter}
            onCheckedChange={(c) => update((d) => void (d.text.skipFrontMatter = c))}
          />
          <ToggleRow
            label="Skip back matter"
            description="Leave out a trailing licence, index, “about the author” or “also by” section."
            checked={t.skipBackMatter}
            onCheckedChange={(c) => update((d) => void (d.text.skipBackMatter = c))}
          />
          <ToggleRow
            label={
              <>
                <Sparkles className="size-3.5 text-muted-foreground" aria-hidden /> Use local AI{config?.llm.model ? ` (Ollama ${config.llm.model})` : ' (Ollama)'}
              </>
            }
            description={
              llmOff
                ? 'Disabled in the API configuration (LLM_ENABLED=false) — rule-based processing will be used.'
                : 'Only consulted for ambiguous chapter boundaries and broken text. It never rewrites the book. Falls back to rules if Ollama is not running.'
            }
            checked={t.useLlm}
            onCheckedChange={(c) => update((d) => void (d.text.useLlm = c))}
          />
          <ToggleRow
            label="Only narrate some chapters"
            description="Handy for a quick test run before processing the whole book."
            checked={!!range}
            onCheckedChange={(c) =>
              update((d) => {
                d.text.chapterRange = c ? { from: 1, to: Math.max(1, Math.min(2, chapterCount ?? 2)) } : undefined;
              })
            }
          >
            {range && (
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Label htmlFor={ids.from} className="font-normal text-muted-foreground">
                    Chapters
                  </Label>
                  <Input
                    id={ids.from}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={chapterCount}
                    className="h-8 w-20"
                    value={Number.isFinite(range.from) ? range.from : ''}
                    aria-invalid={!!rangeError}
                    onChange={(e) => update((d) => void (d.text.chapterRange = { ...range, from: Math.trunc(Number(e.target.value)) }))}
                  />
                  <Label htmlFor={ids.to} className="font-normal text-muted-foreground">
                    to
                  </Label>
                  <Input
                    id={ids.to}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={chapterCount}
                    className="h-8 w-20"
                    value={Number.isFinite(range.to) ? range.to : ''}
                    aria-invalid={!!rangeError}
                    onChange={(e) => update((d) => void (d.text.chapterRange = { ...range, to: Math.trunc(Number(e.target.value)) }))}
                  />
                  {chapterCount ? <span className="text-xs text-muted-foreground">of {chapterCount} detected</span> : null}
                </div>
                {rangeError ? (
                  <p className="text-xs text-destructive">{rangeError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">Numbered as in the chapter list; front matter before the first chapter counts as one when present.</p>
                )}
              </div>
            )}
          </ToggleRow>
        </ToggleList>
        <Field
          label="OCR for scanned pages"
          htmlFor={ids.ocr}
          className="sm:max-w-md"
          hint={document?.likelyScanned ? 'This PDF looks scanned, so OCR is needed to read it.' : 'Text PDFs are read directly — OCR is only a fallback.'}
        >
          <Select value={t.ocr} onValueChange={(o) => update((d) => void (d.text.ocr = o as OcrMode))}>
            <SelectTrigger id={ids.ocr} className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OCR_MODES.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {document?.likelyScanned && t.ocr === 'off' && (
          <p className="-mt-3 flex items-center gap-1.5 text-xs text-destructive">
            <Info className="size-3.5" aria-hidden /> A scanned PDF cannot be processed with OCR turned off.
          </p>
        )}
      </FormSection>
    </fieldset>
  );
}
