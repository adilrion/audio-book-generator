'use client';

import {
  ASPECT_SIZES,
  type AnimationStyle,
  type AspectRatio,
  type HighlightMode,
  type HighlightStyle,
  type OcrMode,
  type ProjectSettings,
  type TTSEngineName,
  type VideoTheme,
} from '@app/types';
import { Captions, Film, Headphones, Info, LoaderCircle, Mic, Palette, ScanText, Sparkles, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { CommandSnippet } from '@/components/copy-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioCard, RadioGroup } from '@/components/ui/radio-group';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useApi } from '@/hooks/use-api';
import { api, type SystemConfig } from '@/lib/api';
import { highlightStyleCss } from '@/lib/highlight';
import { cloneSettings } from '@/lib/settings';
import { splitHint } from '@/lib/hint';
import { cn } from '@/lib/utils';
import { ENGINE_LABELS, groupVoices, pickVoice, voiceMeta } from '@/lib/voices';

// ─────────────────────────────── options ───────────────────────────────

const ASPECTS: { value: AspectRatio; label: string; hint: string }[] = [
  { value: '16:9', label: '16:9', hint: 'YouTube · 1920×1080' },
  { value: '9:16', label: '9:16', hint: 'Shorts / Reels · 1080×1920' },
  { value: '1:1', label: '1:1', hint: 'Square · 1080×1080' },
];

const ANIMATIONS: { value: AnimationStyle; label: string; hint: string }[] = [
  { value: 'follow', label: 'Follow the text', hint: 'Gentle zoom and pan towards the sentence being read' },
  { value: 'kenburns', label: 'Ken Burns', hint: 'Slow, continuous zoom and drift across the page' },
  { value: 'static', label: 'Static', hint: 'Whole page, no motion' },
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

const OCR_MODES: { value: OcrMode; label: string }[] = [
  { value: 'auto', label: 'Automatic — only for scanned pages' },
  { value: 'off', label: 'Off — use the PDF text layer only' },
  { value: 'force', label: 'Always — OCR every page' },
];

export { validateSettings } from '@/lib/settings';

// ─────────────────────────────── layout helpers ───────────────────────────────

function Section({ icon, title, description, children, className }: { icon: ReactNode; title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-4', className)}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span>
        <div className="grid gap-0.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      <div className="grid gap-5 sm:pl-10">{children}</div>
    </section>
  );
}

function Field({ label, htmlFor, hint, children, className }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-2', className)}>
      <Label htmlFor={htmlFor} className="text-[13px]">
        {label}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-1">
        <Label htmlFor={id} className="text-[13px]">
          {label}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

function AspectShape({ ratio }: { ratio: AspectRatio }) {
  const { width, height } = ASPECT_SIZES[ratio];
  const scale = 26 / Math.max(width, height);
  return (
    <span className="grid size-8 place-items-center" aria-hidden>
      <span className="rounded-[3px] border-2 border-current opacity-70" style={{ width: width * scale, height: height * scale }} />
    </span>
  );
}

// ─────────────────────────────── highlight preview ───────────────────────────────

function LookPreview({ settings }: { settings: ProjectSettings }) {
  const v = settings.video;
  const theme = THEMES.find((t) => t.value === v.theme) ?? THEMES[0];
  const hl = highlightStyleCss(v.highlightStyle, v.highlightColor);
  const para = v.highlightMode === 'paragraph';
  const { width, height } = ASPECT_SIZES[v.aspectRatio];
  return (
    <div className="grid gap-2">
      <p className="text-xs font-medium text-muted-foreground">Preview</p>
      <div className="mx-auto w-full max-w-[340px]">
        <div className="relative overflow-hidden rounded-lg border shadow-xs" style={{ background: theme.bg, aspectRatio: `${width} / ${height}` }} aria-hidden>
          <div className="absolute inset-y-[9%] left-1/2 flex aspect-[2/3] -translate-x-1/2 flex-col gap-[6%] rounded-sm bg-white p-[5%] shadow-md" style={{ color: theme.ink }}>
            {v.showChapterTitle && <p className="text-[9px] leading-tight font-semibold">Chapter 1: The Beginning</p>}
            <p className="text-[7px] leading-[1.55]">
              <span style={para ? hl : undefined}>
                The Industrial Revolution began in Britain.{' '}
                <span className="rounded-[1px]" style={para ? undefined : hl}>
                  Steam engines changed how goods were made and moved.
                </span>{' '}
                Cities grew quickly around the new mills.
              </span>
            </p>
            <p className="text-[7px] leading-[1.55] opacity-80">Within a few decades the new methods had spread across Europe and beyond.</p>
          </div>
          {v.showProgress && (
            <div className="absolute inset-x-0 bottom-0 h-[3%] min-h-[3px]" style={{ background: v.theme === 'dark' ? 'rgb(255 255 255 / 0.15)' : 'rgb(0 0 0 / 0.1)' }}>
              <div className="h-full w-[38%]" style={{ background: v.highlightColor }} />
            </div>
          )}
        </div>
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
  const engineId = useId();
  const voiceId = useId();

  // If the chosen voice is not installed for this engine, switch to the engine's default/first voice —
  // and say so: on a saved project the draft now differs from the voice the server will use.
  const currentVoice = settings.tts.voice;
  const [replaced, setReplaced] = useState<{ from: string; to: string }>();
  useEffect(() => {
    if (!list.length || list.some((v) => v.id === currentVoice)) return;
    const next = pickVoice(list, config?.defaultVoices?.[engine], settings.language);
    if (next && next !== currentVoice) {
      setReplaced(currentVoice ? { from: currentVoice, to: next } : undefined);
      update((d) => void (d.tts.voice = next));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, currentVoice, engine]);
  const replacedNote = replaced && replaced.to === currentVoice ? replaced : undefined;

  const unavailable = voices.data && voices.data.engine === engine && !voices.data.available;
  const install = unavailable ? splitHint(voices.data?.message) : undefined;

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Voice engine" htmlFor={engineId}>
          <Select
            value={engine}
            disabled={disabled}
            onValueChange={(e) =>
              update((d) => {
                d.tts.engine = e as TTSEngineName;
                d.tts.voice = config?.defaultVoices?.[e as TTSEngineName] ?? '';
              })
            }
          >
            <SelectTrigger id={engineId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {engines.map((e) => (
                <SelectItem key={e} value={e}>
                  <span className="shrink-0 font-medium">{ENGINE_LABELS[e]?.name ?? e}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{ENGINE_LABELS[e]?.description}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label={
            <>
              Voice
              {voices.loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading voices" />}
            </>
          }
          htmlFor={voiceId}
        >
          <Select value={list.some((v) => v.id === currentVoice) ? currentVoice : undefined} disabled={disabled || !list.length} onValueChange={(v) => update((d) => void (d.tts.voice = v))}>
            <SelectTrigger id={voiceId}>
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
        </Field>
      </div>

      {replacedNote && (
        <p className="-mt-2 flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
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
  className?: string;
}

export function SettingsForm({ value, onChange, config, disabled, document, chapterCount, className }: SettingsFormProps) {
  const update = (fn: (draft: ProjectSettings) => void) => {
    const next = cloneSettings(value);
    fn(next);
    onChange(next);
  };
  const v = value.video;
  const t = value.text;
  const videoOn = value.outputMode === 'audiobook_video';
  const ids = { lang: useId(), anim: useId(), ocr: useId(), from: useId(), to: useId(), color: useId() };
  const range = t.chapterRange;
  const rangeError = range && (range.from < 1 || range.to < 1 || range.from > range.to) ? 'The first chapter must be 1 or higher and not after the last.' : undefined;
  const llmOff = config && !config.llm.enabled;

  return (
    <fieldset disabled={disabled} className={cn('grid min-w-0 gap-8', className)}>
      {/* ── Output ── */}
      <Section icon={<Film />} title="Output" description="What to produce from the book.">
        <RadioGroup aria-label="Output" value={value.outputMode} onValueChange={(m) => update((d) => void (d.outputMode = m as ProjectSettings['outputMode']))} className="grid gap-3 sm:grid-cols-2">
          <RadioCard value="audiobook_video">
            <span className="flex w-full items-center gap-2 font-medium">
              <Film className="size-4 text-muted-foreground" aria-hidden /> Audiobook + Animated PDF
              <Badge variant="secondary" className="ml-auto">
                Default
              </Badge>
            </span>
            <span className="text-xs text-muted-foreground">Read-along MP4 with the spoken sentence highlighted, plus M4A audio and SRT subtitles.</span>
          </RadioCard>
          <RadioCard value="audiobook_only">
            <span className="flex items-center gap-2 font-medium">
              <Headphones className="size-4 text-muted-foreground" aria-hidden /> Audiobook only
            </span>
            <span className="text-xs text-muted-foreground">M4A audio with chapters and SRT subtitles. No video — much faster.</span>
          </RadioCard>
        </RadioGroup>
      </Section>

      {/* ── Narration ── */}
      <Section icon={<Mic />} title="Narration" description="Local text-to-speech — nothing leaves your Mac.">
        <Field label="Language" htmlFor={ids.lang} className="sm:max-w-[calc(50%-10px)]">
          <Select value={value.language} onValueChange={(l) => update((d) => void (d.language = l as ProjectSettings['language']))}>
            <SelectTrigger id={ids.lang}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="bn" disabled>
                Bangla <span className="text-muted-foreground">— coming soon</span>
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <VoiceFields settings={value} config={config} disabled={disabled} update={update} />
        <Field label={<>Speed <span className="ml-auto font-normal text-muted-foreground tabular">{value.tts.speed.toFixed(2)}×</span></>}>
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
            <button type="button" className="absolute left-1/3 -translate-x-1/2 hover:text-foreground" onClick={() => update((d) => void (d.tts.speed = 1))}>
              1.0× normal
            </button>
            <span className="absolute right-0">2.0× faster</span>
          </div>
        </Field>
      </Section>

      {/* ── Video ── */}
      <Section
        icon={<Palette />}
        title="Video & highlighting"
        description={videoOn ? 'How the animated PDF looks.' : 'Not used for audiobook-only output.'}
        className={cn(!videoOn && 'opacity-60')}
      >
        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          <div className="grid content-start gap-5">
            <Field label="Video format">
              <RadioGroup
                aria-label="Video format"
                value={v.aspectRatio}
                disabled={!videoOn || disabled}
                onValueChange={(a) =>
                  update((d) => {
                    d.video.aspectRatio = a as AspectRatio;
                    Object.assign(d.video, ASPECT_SIZES[a as AspectRatio]);
                  })
                }
                className="grid grid-cols-3 gap-2"
              >
                {ASPECTS.map((a) => (
                  <RadioCard key={a.value} value={a.value} className="items-center p-2.5 text-center">
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

            <Field label="Animation" htmlFor={ids.anim} hint={ANIMATIONS.find((a) => a.value === v.animation)?.hint}>
              <Select value={v.animation} disabled={!videoOn || disabled} onValueChange={(a) => update((d) => void (d.video.animation = a as AnimationStyle))}>
                <SelectTrigger id={ids.anim}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANIMATIONS.map((a) => (
                    <SelectItem key={a.value} value={a.value}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Highlight">
                <Segmented value={v.highlightMode} disabled={!videoOn || disabled} onValueChange={(m) => update((d) => void (d.video.highlightMode = m as HighlightMode))} aria-label="Highlight unit">
                  <SegmentedItem value="sentence">Sentence</SegmentedItem>
                  <SegmentedItem value="paragraph">Paragraph</SegmentedItem>
                </Segmented>
              </Field>
              <Field label="Style">
                <Segmented value={v.highlightStyle} disabled={!videoOn || disabled} onValueChange={(s) => update((d) => void (d.video.highlightStyle = s as HighlightStyle))} aria-label="Highlight style">
                  <SegmentedItem value="marker">Marker</SegmentedItem>
                  <SegmentedItem value="underline">Underline</SegmentedItem>
                  <SegmentedItem value="box">Box</SegmentedItem>
                </Segmented>
              </Field>
            </div>

            <Field label="Highlight color" htmlFor={ids.color}>
              <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Highlight color">
                {COLORS.map((c) => {
                  const on = v.highlightColor.toUpperCase() === c.value;
                  return (
                    <button
                      key={c.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={c.label}
                      title={c.label}
                      disabled={!videoOn || disabled}
                      onClick={() => update((d) => void (d.video.highlightColor = c.value))}
                      className={cn(
                        'size-7 rounded-full border border-black/10 shadow-xs transition-transform outline-none hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none',
                        on && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
                      )}
                      style={{ background: c.value }}
                    />
                  );
                })}
                <label
                  className={cn(
                    'relative flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2 text-xs text-muted-foreground hover:text-foreground',
                    !COLORS.some((c) => c.value === v.highlightColor.toUpperCase()) && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
                  )}
                  htmlFor={ids.color}
                >
                  <span className="size-4 rounded-full border border-black/10" style={{ background: v.highlightColor }} aria-hidden />
                  Custom
                  <input
                    id={ids.color}
                    type="color"
                    className="absolute inset-0 cursor-pointer opacity-0"
                    value={v.highlightColor}
                    disabled={!videoOn || disabled}
                    onChange={(e) => update((d) => void (d.video.highlightColor = e.target.value.toUpperCase()))}
                  />
                </label>
              </div>
            </Field>

            <Field label="Background theme">
              <RadioGroup aria-label="Background theme" value={v.theme} disabled={!videoOn || disabled} onValueChange={(th) => update((d) => void (d.video.theme = th as VideoTheme))} className="grid grid-cols-3 gap-2">
                {THEMES.map((th) => (
                  <RadioCard key={th.value} value={th.value} className="flex-row items-center gap-2 p-2.5">
                    <span className="grid size-6 shrink-0 place-items-center rounded-md border border-black/10" style={{ background: th.bg }} aria-hidden>
                      <span className="h-3.5 w-2.5 rounded-[2px] bg-white shadow-xs" />
                    </span>
                    <span className="font-medium">{th.label}</span>
                  </RadioCard>
                ))}
              </RadioGroup>
            </Field>

            <div className="grid gap-4 rounded-lg border p-4">
              <ToggleRow
                label="Progress bar"
                description="Thin bar along the bottom showing how far into the book you are."
                checked={v.showProgress}
                disabled={!videoOn || disabled}
                onCheckedChange={(c) => update((d) => void (d.video.showProgress = c))}
              />
              <ToggleRow
                label="Chapter title"
                description="Show the chapter name briefly when a chapter begins."
                checked={v.showChapterTitle}
                disabled={!videoOn || disabled}
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
                disabled={!videoOn || disabled}
                onCheckedChange={(c) => update((d) => void (d.video.embedSubtitles = c))}
              />
            </div>
          </div>
          <div className="lg:sticky lg:top-20 lg:self-start">
            <LookPreview settings={value} />
          </div>
        </div>
      </Section>

      {/* ── Text ── */}
      <Section icon={<ScanText />} title="Text processing" description="Deterministic cleanup always runs first; these options fine-tune it.">
        <div className="grid gap-4 rounded-lg border p-4">
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
            label="Skip front matter"
            description="Start narrating at the first chapter — skips the copyright page, table of contents, etc."
            checked={t.skipFrontMatter}
            onCheckedChange={(c) => update((d) => void (d.text.skipFrontMatter = c))}
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
          />
          {range && (
            <div className="grid gap-2 sm:pl-0">
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
        </div>
        <Field
          label="OCR for scanned pages"
          htmlFor={ids.ocr}
          className="sm:max-w-[calc(50%-10px)]"
          hint={document?.likelyScanned ? 'This PDF looks scanned, so OCR is needed to read it.' : 'Text PDFs are read directly — OCR is only a fallback.'}
        >
          <Select value={t.ocr} onValueChange={(o) => update((d) => void (d.text.ocr = o as OcrMode))}>
            <SelectTrigger id={ids.ocr}>
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
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <Info className="size-3.5" aria-hidden /> A scanned PDF cannot be processed with OCR turned off.
          </p>
        )}
      </Section>
    </fieldset>
  );
}
