'use client';

import type { LanguageCode, ProjectSummary, ShortMotion, ShortSettings, ShortTheme, ShortVoiceFx } from '@app/types';
import { AudioLines, Captions, Check, Play } from 'lucide-react';
import { useId } from 'react';
import { CheckedMark, ColorSwatches, Field, ToggleList, ToggleRow, VoiceFields } from '@/components/settings-form';
import { ShortBackdrop } from '@/components/short-preview';
import { RadioCard, RadioGroup } from '@/components/ui/radio-group';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import type { SystemConfig } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { CAPTION_STYLES, DEEP_VOICE, SHORT_ACCENTS, SHORT_MOTIONS, SHORT_THEMES, SHORT_VOICE_FX } from '@/lib/shorts';
import { applyLanguage } from '@/lib/voices';

/** A short's narration: language, voice, speed and tone (the editor and the batch page). */
export function ShortVoiceFields({ settings, config, update }: { settings: ShortSettings; config?: SystemConfig; update: (fn: (d: ShortSettings) => void) => void }) {
  const fx = settings.voiceFx ?? 'natural';
  // The deep male voice is an English Kokoro voice; in Bangla the preset is the tone and pace alone.
  const deepVoice = settings.language === 'en' && (config?.engines ?? ['kokoro']).includes(DEEP_VOICE.engine);
  const deepInUse = fx === DEEP_VOICE.fx && settings.tts.speed === DEEP_VOICE.speed && (!deepVoice || settings.tts.voice === DEEP_VOICE.voice);
  const useDeep = () =>
    update((d) => {
      if (deepVoice) {
        d.tts.engine = DEEP_VOICE.engine;
        d.tts.voice = DEEP_VOICE.voice;
      }
      d.tts.speed = DEEP_VOICE.speed;
      d.voiceFx = DEEP_VOICE.fx;
    });
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed bg-muted/40 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-foreground text-background">
          <AudioLines className="size-4" aria-hidden />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="text-sm font-medium">Deep motivation voice</p>
          <p className="text-xs text-muted-foreground">
            {deepVoice ? 'Onyx — a deep male narrator — a little slower, in the deep & powerful tone.' : 'The deep & powerful tone, a little slower.'}
          </p>
        </div>
        <Button size="sm" variant={deepInUse ? 'ghost' : 'outline'} onClick={useDeep} disabled={deepInUse}>
          {deepInUse ? (
            <>
              <Check aria-hidden /> In use
            </>
          ) : (
            'Use it'
          )}
        </Button>
      </div>
      <Field label="Language" className="sm:max-w-md">
        <Select value={settings.language} onValueChange={(l) => update((d) => applyLanguage(d, l as LanguageCode, config))}>
          <SelectTrigger className="h-10">
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
      <VoiceFields settings={settings} config={config} update={update} fx={fx} />
      <Field
        label={
          <>
            Speed
            <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular">{settings.tts.speed.toFixed(2)}×</span>
          </>
        }
        className="sm:max-w-md"
        hint="Shorts are often read a little faster, around 1.1×."
      >
        <Slider min={0.5} max={2} step={0.05} value={[settings.tts.speed]} onValueChange={([s]) => update((d) => void (d.tts.speed = Math.round(s * 100) / 100))} aria-label="Narration speed" />
      </Field>
      <Field label="Tone" hint="Applied to the narration when the video is made — its length and the captions stay the same. Listen plays the voice in this tone.">
        <RadioGroup value={fx} onValueChange={(v) => update((d) => void (d.voiceFx = v as ShortVoiceFx))} className="grid gap-2 sm:grid-cols-3" aria-label="Tone">
          {SHORT_VOICE_FX.map((t) => (
            <RadioCard key={t.value} value={t.value} className="pr-8">
              <CheckedMark />
              <span className="font-medium">{t.label}</span>
              <span className="text-xs leading-snug text-muted-foreground">{t.hint}</span>
            </RadioCard>
          ))}
        </RadioGroup>
      </Field>
    </>
  );
}

/** A short's look: background, motion, captions and the rest (the editor and the batch page). */
export function ShortLookFields({
  settings,
  updateLook,
  coverUrl,
  books,
  projectId,
  onProjectChange,
  coverMissing,
}: {
  settings: ShortSettings;
  updateLook: (fn: (d: ShortSettings) => void) => void;
  coverUrl?: string;
  books: ProjectSummary[];
  projectId: string | null;
  onProjectChange: (id: string) => void;
  coverMissing?: boolean;
}) {
  const accentId = useId();
  return (
    <>
      <Field label="Background" hint="The animated ones move behind your captions the whole way through — they catch the eye in a feed.">
        <RadioGroup value={settings.look.theme} onValueChange={(v) => updateLook((d) => void (d.look.theme = v as ShortTheme))} className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Background">
          {(Object.keys(SHORT_THEMES) as ShortTheme[]).map((k) => {
            const t = SHORT_THEMES[k];
            return (
              <RadioCard key={k} value={k} className="items-center gap-2 p-2 text-center">
                <span className="relative aspect-[9/16] w-full overflow-hidden rounded-md shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)]" aria-hidden>
                  {k === 'cover' && coverUrl ? (
                    <span className="absolute inset-0" style={{ background: `center / cover url(${coverUrl})` }} />
                  ) : (
                    <ShortBackdrop theme={k} accent={settings.look.accent} />
                  )}
                  {t.animated && (
                    <span className="absolute top-1 right-1 grid size-4 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
                      <Play className="size-2 fill-current" />
                    </span>
                  )}
                </span>
                <span className="text-xs font-medium">{t.label}</span>
              </RadioCard>
            );
          })}
        </RadioGroup>
      </Field>
      <Field label="Motion" hint="Particles over the background — the book cover too — under the title and captions.">
        <RadioGroup value={settings.look.motion ?? 'none'} onValueChange={(v) => updateLook((d) => void (d.look.motion = v as ShortMotion))} className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Motion">
          {SHORT_MOTIONS.map((m) => (
            <RadioCard key={m.value} value={m.value} className="items-center gap-2 p-2 text-center" title={m.hint}>
              <span className="relative aspect-square w-full overflow-hidden rounded-md shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)]" aria-hidden>
                <ShortBackdrop theme={settings.look.theme} motion={m.value} accent={settings.look.accent} coverUrl={coverUrl} still scale={0.6} />
              </span>
              <span className="text-xs font-medium">{m.label}</span>
            </RadioCard>
          ))}
        </RadioGroup>
      </Field>
      {settings.look.theme === 'cover' && (
        <Field label="Book" hint="Its first page is the cover, blurred behind and shown sharp above the captions.">
          <Select value={projectId ?? undefined} onValueChange={onProjectChange}>
            <SelectTrigger className="h-10 sm:max-w-md" aria-invalid={coverMissing}>
              <SelectValue placeholder="Choose a book" />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {books.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <Field label={<><Captions className="size-4" aria-hidden /> Captions</>}>
        <RadioGroup value={settings.look.captions} onValueChange={(v) => updateLook((d) => void (d.look.captions = v as ShortSettings['look']['captions']))} className="grid gap-2 sm:grid-cols-2" aria-label="Captions">
          {CAPTION_STYLES.map((c) => (
            <RadioCard key={c.value} value={c.value} className="pr-8">
              <CheckedMark />
              <span className="font-medium">{c.label}</span>
              <span className="text-xs leading-snug text-muted-foreground">{c.hint}</span>
            </RadioCard>
          ))}
        </RadioGroup>
      </Field>
      <Field label="Highlight colour">
        <ColorSwatches id={accentId} label="Highlight colour" colors={SHORT_ACCENTS} value={settings.look.accent} onChange={(hex) => updateLook((d) => void (d.look.accent = hex))} />
      </Field>
      <Field label="Caption position">
        <Segmented value={settings.look.position} onValueChange={(v) => updateLook((d) => void (d.look.position = v as 'center' | 'lower'))} aria-label="Caption position">
          <SegmentedItem value="center">Middle</SegmentedItem>
          <SegmentedItem value="lower">Lower</SegmentedItem>
        </Segmented>
      </Field>
      <ToggleList>
        <ToggleRow label="Title at the top" checked={settings.look.showTitle} onCheckedChange={(v) => updateLook((d) => void (d.look.showTitle = v))} />
        <ToggleRow label="Capital letters" description="English captions in capitals, the usual Shorts look." checked={settings.look.uppercase} onCheckedChange={(v) => updateLook((d) => void (d.look.uppercase = v))} disabled={settings.language === 'bn'} />
        <ToggleRow label="Progress bar" description="A thin bar along the top edge." checked={settings.look.showProgress} onCheckedChange={(v) => updateLook((d) => void (d.look.showProgress = v))} />
      </ToggleList>
    </>
  );
}
