'use client';

import { DEFAULT_SHORT_LOOK, type LanguageCode, type ShortDetail, type ShortScriptStyle, type ShortSettings, type ShortTheme } from '@app/types';
import { BookOpen, Captions, LoaderCircle, Mic, Palette, PenLine, Play, Save, Sparkles, Square, TriangleAlert, Type } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { CheckedMark, ColorSwatches, Field, FormSection, ToggleList, ToggleRow, VoiceFields } from '@/components/settings-form';
import { ShortPreview } from '@/components/short-preview';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioCard, RadioGroup } from '@/components/ui/radio-group';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/hooks/use-api';
import { type ApiError, api, pageImageUrl, toApiError } from '@/lib/api';
import { CAPTION_STYLES, SCRIPT_LENGTHS, SCRIPT_STYLES, SHORT_THEMES, formatHashtags, lengthVerdict, parseHashtags } from '@/lib/shorts';
import { cn } from '@/lib/utils';
import { applyLanguage } from '@/lib/voices';

const ACCENTS = [
  { value: '#FACC15', label: 'Yellow' },
  { value: '#A3E635', label: 'Lime' },
  { value: '#22D3EE', label: 'Cyan' },
  { value: '#F472B6', label: 'Pink' },
  { value: '#FB923C', label: 'Orange' },
  { value: '#FFFFFF', label: 'White' },
];

const FALLBACK: ShortSettings = { language: 'en', tts: { engine: 'kokoro', voice: 'af_heart', speed: 1 }, look: { ...DEFAULT_SHORT_LOOK } };
const clone = (s: ShortSettings): ShortSettings => JSON.parse(JSON.stringify(s)) as ShortSettings;

function Rail({ children }: { children: ReactNode }) {
  return <aside className="grid gap-4 lg:sticky lg:top-8">{children}</aside>;
}

/**
 * New short, or the edit form of an existing one. The script is written by hand or by the local AI
 * (from a topic or one of the user's books); the preview on the right follows every change.
 */
export function ShortEditor({ initial, initialProjectId, onSaved, onCancel }: { initial?: ShortDetail; initialProjectId?: string; onSaved: (s: ShortDetail) => void; onCancel?: () => void }) {
  const ids = { title: useId(), script: useId(), topic: useId(), desc: useId(), tags: useId(), accent: useId() };
  const config = useApi('config', (signal) => api.config(signal));
  const defaults = useApi(initial ? null : 'short-defaults', (signal) => api.shortDefaults(signal));
  const projects = useApi('projects', (signal) => api.listProjects(signal));

  const [title, setTitle] = useState(initial?.title ?? '');
  const [script, setScript] = useState(initial?.script ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [hashtags, setHashtags] = useState(initial ? formatHashtags(initial.hashtags) : '');
  const [settings, setSettings] = useState<ShortSettings>(() => clone(initial?.settings ?? FALLBACK));
  const [projectId, setProjectId] = useState<string | null>(initial?.projectId ?? initialProjectId ?? null);
  const touched = useRef(!!initial);
  const lookTouched = useRef(!!initial);

  // Server defaults (voice from .env) — unless the user already changed something.
  useEffect(() => {
    if (defaults.data && !touched.current) setSettings(clone(defaults.data));
  }, [defaults.data]);

  const update = (fn: (d: ShortSettings) => void) => {
    touched.current = true;
    setSettings((s) => {
      const d = clone(s);
      fn(d);
      return d;
    });
  };
  const updateLook = (fn: (d: ShortSettings) => void) => {
    lookTouched.current = true;
    update(fn);
  };

  // ── AI script ──
  const [tab, setTab] = useState<'write' | 'ai'>(initialProjectId && !initial ? 'ai' : 'write');
  const [source, setSource] = useState<'topic' | 'book'>(initialProjectId ? 'book' : 'topic');
  const [topic, setTopic] = useState('');
  const [aiBook, setAiBook] = useState<string | undefined>(initialProjectId ?? initial?.projectId);
  const [seconds, setSeconds] = useState<number>(60);
  const [style, setStyle] = useState<ShortScriptStyle>('hook');
  const [writing, setWriting] = useState(false);
  const [aiError, setAiError] = useState<ApiError>();
  const [aiModel, setAiModel] = useState<string>();
  const aiCtrl = useRef<AbortController | null>(null);
  useEffect(() => () => aiCtrl.current?.abort(), []);

  const books = projects.data ?? [];
  const canWrite = source === 'topic' ? topic.trim().length >= 3 : !!aiBook;

  const writeScript = async () => {
    aiCtrl.current?.abort();
    const c = new AbortController();
    aiCtrl.current = c;
    setWriting(true);
    setAiError(undefined);
    try {
      const r = await api.generateShortScript(
        { source: source === 'topic' ? { kind: 'topic', topic: topic.trim() } : { kind: 'book', projectId: aiBook! }, language: settings.language, seconds, style },
        c.signal,
      );
      setTitle(r.title);
      setScript(r.script);
      setDescription(r.description);
      setHashtags(formatHashtags(r.hashtags));
      setAiModel(r.model);
      if (source === 'book' && aiBook) {
        setProjectId(aiBook);
        // A short about a book looks best on its cover — unless the user chose a look already.
        if (!lookTouched.current) setSettings((s) => ({ ...s, look: { ...s.look, theme: 'cover' } }));
      }
      setTab('write');
    } catch (e) {
      if (!c.signal.aborted) setAiError(toApiError(e));
    } finally {
      if (aiCtrl.current === c) {
        aiCtrl.current = null;
        setWriting(false);
      }
    }
  };
  const stopWriting = () => {
    aiCtrl.current?.abort();
    aiCtrl.current = null;
    setWriting(false);
  };

  // ── save ──
  const [saving, setSaving] = useState<'draft' | 'render'>();
  const [saveError, setSaveError] = useState<ApiError>();
  const verdict = lengthVerdict(script, settings.language, settings.tts.speed);
  const coverMissing = settings.look.theme === 'cover' && !projectId;
  const problem = !script.trim() ? 'Write or generate a script first.' : verdict.tone === 'error' ? verdict.text : !settings.tts.voice ? 'Choose a voice.' : coverMissing ? 'Choose the book whose cover to show.' : undefined;

  const save = async (render: boolean) => {
    setSaving(render ? 'render' : 'draft');
    setSaveError(undefined);
    const body = { title: title.trim() || 'Untitled short', script, description, hashtags: parseHashtags(hashtags), settings, projectId, render };
    try {
      onSaved(initial ? await api.updateShort(initial.id, body) : await api.createShort(body));
    } catch (e) {
      setSaveError(toApiError(e));
      setSaving(undefined);
    }
  };

  const coverUrl = projectId ? pageImageUrl(projectId, 1) : undefined;
  const llmOff = config.data && !config.data.llm.enabled;

  const actions = (className?: string) => (
    <div className={cn('grid gap-2', className)}>
      <Button size="lg" variant="brand" onClick={() => void save(true)} disabled={!!problem || !!saving}>
        {saving === 'render' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Play className="fill-current" aria-hidden />}
        {initial ? 'Save & render again' : 'Create short'}
      </Button>
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={() => void save(false)} disabled={!!saving || (!!problem && !script.trim())}>
          {saving === 'draft' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Save aria-hidden />}
          {initial ? 'Save' : 'Save draft'}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={!!saving}>
            Cancel
          </Button>
        )}
      </div>
      <p className={cn('text-center text-xs', problem ? 'text-destructive' : 'text-muted-foreground')}>{problem ?? 'Renders in the background — usually under a minute.'}</p>
    </div>
  );

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-8">
      <div className="grid min-w-0 gap-6">
        {/* ── script ── */}
        <FormSection step={1} title="Script" description="What the voice says. Paste your own, or let the local AI write one from a topic or one of your books.">
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'write' | 'ai')}>
            <TabsList className="w-full sm:w-fit">
              <TabsTrigger value="write">
                <PenLine aria-hidden /> Write or paste
              </TabsTrigger>
              <TabsTrigger value="ai">
                <Sparkles aria-hidden /> Generate with AI
              </TabsTrigger>
            </TabsList>

            <TabsContent value="write" className="grid gap-5 pt-2">
              <Field label="Title" htmlFor={ids.title} hint="Shown at the top of the video and used as the YouTube title.">
                <Input id={ids.title} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Tagore’s saddest story in 60 seconds" className="h-10" />
              </Field>
              <Field
                label={
                  <>
                    Script
                    <span className={cn('ml-auto text-xs font-normal', verdict.tone === 'error' ? 'text-destructive' : verdict.tone === 'warning' ? 'text-warning-foreground dark:text-warning' : 'text-muted-foreground')}>
                      {verdict.text}
                    </span>
                  </>
                }
                htmlFor={ids.script}
                hint="One idea per sentence reads best. A new line adds a longer pause."
              >
                <Textarea
                  id={ids.script}
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  maxLength={4000}
                  rows={8}
                  className="min-h-48"
                  lang={settings.language}
                  placeholder={'What if one letter could change a life?\n\nIn a tiny Bengal village, a lonely postmaster…'}
                />
              </Field>
              {aiModel && <p className="-mt-3 text-xs text-muted-foreground">Written by the local AI ({aiModel}). Check the facts and edit freely.</p>}
            </TabsContent>

            <TabsContent value="ai" className="grid gap-5 pt-2">
              {llmOff && (
                <p className="flex items-start gap-1.5 rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden /> The local AI is turned off (LLM_ENABLED=false in .env). Write the script yourself instead.
                </p>
              )}
              <Field label="Write about">
                <Segmented value={source} onValueChange={(v) => setSource(v as 'topic' | 'book')} aria-label="Write about" disabled={writing}>
                  <SegmentedItem value="topic">
                    <Type aria-hidden /> A topic
                  </SegmentedItem>
                  <SegmentedItem value="book">
                    <BookOpen aria-hidden /> One of my books
                  </SegmentedItem>
                </Segmented>
              </Field>
              {source === 'topic' ? (
                <Field label="Topic or idea" htmlFor={ids.topic} hint="Anything: a book, a fact, a lesson, a story idea.">
                  <Input id={ids.topic} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={500} placeholder="e.g. Why Gitanjali won the Nobel Prize" className="h-10" disabled={writing} />
                </Field>
              ) : (
                <Field label="Book" hint={books.length ? 'The AI reads the opening of the book (its first chapter).' : 'Add a book in the Library first.'}>
                  <Select value={aiBook} onValueChange={setAiBook} disabled={writing || !books.length}>
                    <SelectTrigger className="h-10 sm:max-w-md">
                      <SelectValue placeholder={projects.loading ? 'Loading books…' : 'Choose a book'} />
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
              <div className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)]">
                <Field label="Length">
                  <Segmented value={String(seconds)} onValueChange={(v) => setSeconds(Number(v))} aria-label="Length" disabled={writing}>
                    {SCRIPT_LENGTHS.map((s) => (
                      <SegmentedItem key={s} value={String(s)}>
                        {s} s
                      </SegmentedItem>
                    ))}
                  </Segmented>
                </Field>
              </div>
              <Field label="Style">
                <RadioGroup value={style} onValueChange={(v) => setStyle(v as ShortScriptStyle)} className="grid gap-2 sm:grid-cols-3" disabled={writing} aria-label="Style">
                  {SCRIPT_STYLES.map((s) => (
                    <RadioCard key={s.value} value={s.value} className="pr-8">
                      <CheckedMark />
                      <span className="font-medium">{s.label}</span>
                      <span className="text-xs leading-snug text-muted-foreground">{s.hint}</span>
                    </RadioCard>
                  ))}
                </RadioGroup>
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                {writing ? (
                  <Button variant="outline" onClick={stopWriting}>
                    <Square className="fill-current" aria-hidden /> Stop
                  </Button>
                ) : (
                  <Button onClick={() => void writeScript()} disabled={!canWrite || !!llmOff}>
                    <Sparkles aria-hidden /> Write script
                  </Button>
                )}
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {writing ? (
                    <span className="flex items-center gap-1.5">
                      <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> The local AI is writing — this takes 20–60 seconds…
                    </span>
                  ) : (
                    `In ${settings.language === 'bn' ? 'Bangla' : 'English'} (the narration language below). Replaces the title, script and YouTube text.`
                  )}
                </p>
              </div>
              {aiError && <ApiErrorAlert error={aiError} title="The script could not be written" onRetry={() => void writeScript()} />}
            </TabsContent>
          </Tabs>
        </FormSection>

        {/* ── voice ── */}
        <FormSection step={2} icon={<Mic />} title="Voice" description="Local text-to-speech — nothing leaves your Mac.">
          <Field label="Language" className="sm:max-w-md">
            <Select value={settings.language} onValueChange={(l) => update((d) => applyLanguage(d, l as LanguageCode, config.data))}>
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
          <VoiceFields settings={settings} config={config.data} update={update} />
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
        </FormSection>

        {/* ── look ── */}
        <FormSection step={3} icon={<Palette />} title="Look" description="Vertical 1080 × 1920 at 30 fps, with the captions inside YouTube’s safe area.">
          <Field label="Background">
            <RadioGroup value={settings.look.theme} onValueChange={(v) => updateLook((d) => void (d.look.theme = v as ShortTheme))} className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Background">
              {(Object.keys(SHORT_THEMES) as ShortTheme[]).map((k) => {
                const t = SHORT_THEMES[k];
                return (
                  <RadioCard key={k} value={k} className="items-center gap-2 p-2 text-center">
                    <span
                      className="aspect-[9/16] w-full rounded-md shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)]"
                      style={k === 'cover' && coverUrl ? { background: `center / cover url(${coverUrl})` } : { background: `linear-gradient(180deg, ${t.top}, ${t.bottom})` }}
                      aria-hidden
                    />
                    <span className="text-xs font-medium">{t.label}</span>
                  </RadioCard>
                );
              })}
            </RadioGroup>
          </Field>
          {settings.look.theme === 'cover' && (
            <Field label="Book" hint="Its first page is the cover, blurred behind and shown sharp above the captions.">
              <Select value={projectId ?? undefined} onValueChange={setProjectId}>
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
            <ColorSwatches id={ids.accent} label="Highlight colour" colors={ACCENTS} value={settings.look.accent} onChange={(hex) => updateLook((d) => void (d.look.accent = hex))} />
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
        </FormSection>

        {/* ── YouTube ── */}
        <FormSection step={4} title="YouTube details" description="Not in the video — ready to paste when you upload. The AI fills them with the script.">
          <Field label="Description" htmlFor={ids.desc}>
            <Textarea id={ids.desc} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} rows={3} placeholder="Two short sentences about the video." />
          </Field>
          <Field label="Hashtags" htmlFor={ids.tags} hint="#Shorts helps YouTube file it as a Short.">
            <Input id={ids.tags} value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="#Shorts #Audiobook #Tagore" className="h-10" />
          </Field>
        </FormSection>

        {saveError && <ApiErrorAlert error={saveError} title="The short could not be saved" />}
      </div>

      <Rail>
        <div className="grid gap-4 rounded-2xl border bg-card p-5 shadow-card">
          <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Preview</p>
          <ShortPreview title={title} script={script} settings={settings} coverUrl={coverUrl} className="mx-auto w-full max-w-[260px]" />
          {actions()}
        </div>
      </Rail>
    </div>
  );
}
