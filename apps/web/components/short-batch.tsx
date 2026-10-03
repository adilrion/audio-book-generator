'use client';

import {
  DEFAULT_SHORT_LOOK,
  SHORT_BATCH_ANGLES,
  SHORT_BATCH_EXAMPLE,
  SHORT_BATCH_MAX,
  SHORT_MAX_SEC,
  SHORT_SCRIPT_MAX_CHARS,
  SHORT_SPLIT_MAX_CHARS,
  type ShortBatchItem,
  type ShortScriptResult,
  type ShortScriptStyle,
  type ShortSettings,
  type ShortTheme,
  autoShortParts,
  batchStyle,
  estimateShortSec,
  parseShortBatch,
  shortBatchPrompt,
  similarShorts,
  splitShortScript,
} from '@app/types';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ClipboardCopy,
  ClipboardPaste,
  Download,
  FileUp,
  Lightbulb,
  LoaderCircle,
  Mic,
  Palette,
  Play,
  Plus,
  Save,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Type,
  Wand2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type DragEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { Field, FormSection } from '@/components/settings-form';
import { ShortBackdrop, ShortPreview } from '@/components/short-preview';
import { ShortLookFields, ShortVoiceFields } from '@/components/short-settings-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/hooks/use-api';
import { type ApiError, api, pageImageUrl, toApiError } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { SCENE_THEMES } from '@/lib/short-scenes';
import { SCRIPT_LENGTHS, SCRIPT_STYLES, SHORT_THEMES, formatHashtags, parseHashtags } from '@/lib/shorts';
import { cn } from '@/lib/utils';

/** The batch being put together, kept in this browser until it is created (AI scripts take minutes). */
const STORE = 'ario.shorts-batch.v1';
const COUNTS = [3, 5, 10] as const;
const FALLBACK: ShortSettings = { language: 'en', tts: { engine: 'kokoro', voice: 'af_heart', speed: 1 }, look: { ...DEFAULT_SHORT_LOOK } };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Item = ShortBatchItem & { key: string };
let seq = 0;
const withKey = (i: ShortBatchItem): Item => ({ ...i, key: `${Date.now().toString(36)}-${(seq++).toString(36)}` });
const fromAi = (r: ShortScriptResult): ShortBatchItem => ({ title: r.title, script: r.script, description: r.description, hashtags: r.hashtags, tags: r.tags });

type StyleMode = 'mixed' | ShortScriptStyle;
type AiJob = { kind: 'scripts' | 'details'; done: number; total: number };

/**
 * /shorts/batch — up to 10 Shorts at once. Scripts come from another AI tool (pasted or uploaded
 * in a simple format, with a ready-made prompt to copy), from one long script cut into parts, or
 * from the local AI (each with its own angle). They are reviewed one by one, share one voice and
 * look (backgrounds may vary), and render one after another in the background.
 */
export function ShortBatch({ initialProjectId }: { initialProjectId?: string }) {
  const router = useRouter();
  const ids = { paste: useId(), about: useId(), splitTitle: useId(), splitText: useId(), topic: useId() };
  const config = useApi('config', (signal) => api.config(signal));
  const defaults = useApi('short-defaults', (signal) => api.shortDefaults(signal));
  const projects = useApi('projects', (signal) => api.listProjects(signal));
  const books = projects.data ?? [];

  // ── the batch ──
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [selected, setSelected] = useState<string>();
  const [settings, setSettings] = useState<ShortSettings>(() => clone(FALLBACK));
  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? null);
  const [mix, setMix] = useState(false);
  const touched = useRef(false);
  const lookTouched = useRef(false);
  const [restored, setRestored] = useState(false);
  const created = useRef(false);

  // A batch left unfinished in this browser comes back.
  useEffect(() => {
    try {
      const d = JSON.parse(localStorage.getItem(STORE) ?? 'null') as { items?: ShortBatchItem[]; settings?: ShortSettings; projectId?: string | null; mix?: boolean } | null;
      if (d?.items?.length) {
        const list = d.items.slice(0, SHORT_BATCH_MAX).map(withKey);
        setItems(list);
        setSelected(list[0].key);
        if (d.settings) {
          setSettings(d.settings);
          touched.current = lookTouched.current = true;
        }
        if (!initialProjectId && d.projectId !== undefined) setProjectId(d.projectId);
        setMix(!!d.mix);
      }
    } catch {
      // unreadable or blocked storage: start fresh
    }
    setRestored(true);
  }, [initialProjectId]);
  useEffect(() => {
    if (!restored || created.current) return;
    try {
      if (items.length) localStorage.setItem(STORE, JSON.stringify({ items: items.map(({ key: _, ...i }) => i), settings, projectId, mix }));
      else localStorage.removeItem(STORE);
    } catch {
      // storage full or blocked: the batch just is not kept
    }
  }, [restored, items, settings, projectId, mix]);

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

  const room = SHORT_BATCH_MAX - items.length;
  const add = (list: ShortBatchItem[], scroll = true) => {
    const added = list.slice(0, Math.max(0, SHORT_BATCH_MAX - itemsRef.current.length)).map(withKey);
    if (!added.length) return;
    setItems((prev) => [...prev, ...added].slice(0, SHORT_BATCH_MAX));
    setSelected((s) => s ?? added[0].key);
    if (scroll) requestAnimationFrame(() => document.getElementById('batch-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const patch = (key: string, p: Partial<ShortBatchItem>) => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...p } : i)));
  const remove = (key: string) => {
    setItems((prev) => prev.filter((i) => i.key !== key));
    if (selected === key) setSelected(items.find((i) => i.key !== key)?.key);
  };
  const move = (key: string, by: -1 | 1) =>
    setItems((prev) => {
      const i = prev.findIndex((x) => x.key === key);
      const j = i + by;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  /** The background each short gets: its own choice, or the batch's (taking turns through the animated ones when mixing). */
  const themeOf = (item: Item, i: number): ShortTheme => {
    if (item.look?.theme) return item.look.theme;
    if (!mix) return settings.look.theme;
    const start = Math.max(0, (SCENE_THEMES as readonly string[]).indexOf(settings.look.theme));
    return SCENE_THEMES[(start + i) % SCENE_THEMES.length];
  };

  // ── sources ──
  const [tab, setTab] = useState<'paste' | 'split' | 'ai'>(initialProjectId ? 'ai' : 'paste');
  const [count, setCount] = useState<number>(5);
  const [seconds, setSeconds] = useState<number>(45);

  // paste or upload
  const [pasteText, setPasteText] = useState('');
  const parsed = useMemo(() => parseShortBatch(pasteText), [pasteText]);
  const [fileError, setFileError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const readFile = async (file: File | undefined) => {
    setFileError(undefined);
    if (!file) return;
    if (file.size > 1_000_000) return setFileError('That file is over 1 MB — a batch of scripts is much smaller. Is it the right file?');
    if (/\.(docx?|pdf|pages|rtf)$/i.test(file.name)) return setFileError('Save it as plain text (.txt) or copy and paste its text — Word and PDF files cannot be read here.');
    setPasteText(await file.text());
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    void readFile(e.dataTransfer.files[0]);
  };
  const addPasted = () => {
    add(parsed.items);
    setPasteText('');
  };

  // the prompt for other AI tools
  const [about, setAbout] = useState('');
  const [copied, setCopied] = useState(false);
  const prompt = shortBatchPrompt({ about, count, seconds, language: settings.language });
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this prompt:', prompt);
    }
  };
  const downloadExample = () => {
    const url = URL.createObjectURL(new Blob([SHORT_BATCH_EXAMPLE], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'shorts-batch-example.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };

  // split one long script
  const [splitTitle, setSplitTitle] = useState('');
  const [splitText, setSplitText] = useState('');
  const [parts, setParts] = useState<'auto' | number>('auto');
  const autoParts = autoShortParts(splitText, settings.language, settings.tts.speed);
  const pieces = useMemo(() => (splitText.trim() ? splitShortScript(splitText, parts === 'auto' ? autoParts : parts) : []), [splitText, parts, autoParts]);
  const addSplit = () => {
    const base = splitTitle.trim() || (pieces[0]?.split(/(?<=[.!?।])\s/)[0] ?? '').slice(0, 60).trim() || 'Untitled short';
    add(pieces.map((script, i) => ({ title: pieces.length > 1 ? `${base} — Part ${i + 1}/${pieces.length}` : base, script, description: '', hashtags: ['Shorts'], tags: [] })));
    setSplitText('');
  };

  // local AI
  const [source, setSource] = useState<'topic' | 'book'>(initialProjectId ? 'book' : 'topic');
  const [topic, setTopic] = useState('');
  const [aiBook, setAiBook] = useState<string | undefined>(initialProjectId);
  const [styleMode, setStyleMode] = useState<StyleMode>('mixed');
  const [aiJob, setAiJob] = useState<AiJob>();
  const [aiError, setAiError] = useState<ApiError>();
  const aiCtrl = useRef<AbortController | null>(null);
  useEffect(() => () => aiCtrl.current?.abort(), []);
  const llmOff = config.data && !config.data.llm.enabled;
  const toWrite = Math.min(count, room);

  const startAi = (job: AiJob) => {
    aiCtrl.current?.abort();
    const c = new AbortController();
    aiCtrl.current = c;
    setAiJob(job);
    setAiError(undefined);
    return c;
  };
  const endAi = (c: AbortController) => {
    if (aiCtrl.current === c) {
      aiCtrl.current = null;
      setAiJob(undefined);
    }
  };
  const stopAi = () => {
    aiCtrl.current?.abort();
    aiCtrl.current = null;
    setAiJob(undefined);
  };

  const writeScripts = async () => {
    const n = toWrite;
    if (!n) return;
    const c = startAi({ kind: 'scripts', done: 0, total: n });
    const kind = source === 'topic' ? 'topic' : 'book';
    const titles = itemsRef.current.map((i) => i.title);
    try {
      for (let i = 0; i < n && !c.signal.aborted; i++) {
        const r = await api.generateShortScript(
          {
            source: kind === 'topic' ? { kind: 'topic', topic: topic.trim() } : { kind: 'book', projectId: aiBook! },
            language: settings.language,
            seconds,
            style: styleMode === 'mixed' ? batchStyle(i) : styleMode,
            angle: SHORT_BATCH_ANGLES[kind][i % SHORT_BATCH_ANGLES[kind].length],
            avoid: titles.slice(-SHORT_BATCH_MAX),
            ...(kind === 'book' && { part: { index: i, of: n } }),
          },
          c.signal,
        );
        titles.push(r.title);
        add([fromAi(r)], false); // the next ones are still being written: do not pull the page away
        if (kind === 'book' && aiBook && i === 0) {
          setProjectId(aiBook);
          // Shorts about a book look best on its cover — unless the user chose a look already.
          if (!lookTouched.current) setSettings((s) => ({ ...s, look: { ...s.look, theme: 'cover' } }));
        }
        setAiJob({ kind: 'scripts', done: i + 1, total: n });
      }
    } catch (e) {
      if (!c.signal.aborted) setAiError(toApiError(e));
    } finally {
      endAi(c);
    }
  };

  const missingDetails = items.filter((i) => !i.description.trim()).length;
  const writeDetails = async () => {
    const todo = itemsRef.current.filter((i) => !i.description.trim()).map((i) => i.key);
    if (!todo.length) return;
    const c = startAi({ kind: 'details', done: 0, total: todo.length });
    try {
      for (const [n, key] of todo.entries()) {
        const it = itemsRef.current.find((x) => x.key === key);
        if (!it || c.signal.aborted) continue;
        const r = await api.generateShortMetadata({ title: it.title.trim() || 'Untitled short', script: it.script, language: settings.language, projectId: projectId ?? undefined }, c.signal);
        patch(key, { description: r.description, hashtags: r.hashtags, tags: r.tags });
        setAiJob({ kind: 'details', done: n + 1, total: todo.length });
      }
    } catch (e) {
      if (!c.signal.aborted) setAiError(toApiError(e));
    } finally {
      endAi(c);
    }
  };

  // ── checks ──
  const secs = items.map((i) => estimateShortSec(i.script, settings.language, settings.tts.speed));
  const total = secs.reduce((a, b) => a + b, 0);
  const pairs = useMemo(() => similarShorts(items), [items]);
  const warnings = items.map((_, i) =>
    pairs.flatMap((p) => (p.a === i || p.b === i ? [`${p.why === 'title' ? 'Same title as' : 'Very similar to'} short ${(p.a === i ? p.b : p.a) + 1}`] : [])),
  );
  const empty = items.findIndex((i) => !i.script.trim());
  const tooLong = secs.findIndex((s) => s > SHORT_MAX_SEC);
  const coverNeeded = items.some((it, i) => themeOf(it, i) === 'cover') && !projectId;
  const problem = !items.length
    ? 'Add scripts first.'
    : empty >= 0
      ? `Short ${empty + 1} has no script.`
      : tooLong >= 0
        ? `Short ${tooLong + 1} is over 3 minutes — shorten it or split it.`
        : !settings.tts.voice
          ? 'Choose a voice.'
          : coverNeeded
            ? 'Choose the book whose cover to show (under Look).'
            : undefined;

  // ── create ──
  const [saving, setSaving] = useState<'render' | 'draft'>();
  const [saveError, setSaveError] = useState<ApiError>();
  const create = async (render: boolean) => {
    setSaving(render ? 'render' : 'draft');
    setSaveError(undefined);
    try {
      const r = await api.createShortBatch({
        items: items.map((it, i) => ({
          title: it.title.trim() || 'Untitled short',
          script: it.script,
          description: it.description,
          hashtags: it.hashtags,
          tags: it.tags,
          look: { theme: themeOf(it, i), ...(it.look?.motion && { motion: it.look.motion }) },
        })),
        settings,
        projectId,
        render,
      });
      created.current = true;
      try {
        localStorage.removeItem(STORE);
      } catch {
        // nothing kept
      }
      router.push(`/shorts?batch=${r.shorts.map((s) => s.id).join(',')}`);
    } catch (e) {
      setSaveError(toApiError(e));
      setSaving(undefined);
    }
  };

  const coverUrl = projectId ? pageImageUrl(projectId, 1) : undefined;
  const selIndex = Math.max(0, items.findIndex((i) => i.key === selected));
  const sel = items[selIndex];
  const previewSettings: ShortSettings = sel ? { ...settings, look: { ...settings.look, theme: themeOf(sel, selIndex), ...(sel.look?.motion && { motion: sel.look.motion }) } } : settings;
  const busy = !!aiJob;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-8">
      <div className="grid min-w-0 gap-6">
        {/* ── scripts ── */}
        <FormSection step={1} title="Scripts" description={`Up to ${SHORT_BATCH_MAX} at a time — from another AI tool, one long script, or the local AI. Mix them as you like.`}>
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList className="w-full sm:w-fit">
              <TabsTrigger value="paste">
                <ClipboardPaste aria-hidden /> Paste<span className="hidden sm:inline"> or upload</span>
              </TabsTrigger>
              <TabsTrigger value="split">
                <Scissors aria-hidden /> Split<span className="hidden sm:inline"> a long script</span>
              </TabsTrigger>
              <TabsTrigger value="ai">
                <Sparkles aria-hidden /> Local AI
              </TabsTrigger>
            </TabsList>

            {/* paste or upload */}
            <TabsContent value="paste" className="grid gap-5 pt-2">
              <div className="grid gap-3 rounded-xl border border-dashed bg-muted/40 p-4">
                <div className="grid gap-1">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <Sparkles className="size-4 text-brand" aria-hidden /> Writing them with ChatGPT, Gemini or Claude?
                  </p>
                  <p className="text-xs text-muted-foreground">Copy this prompt into it, then paste its answer below — it asks for exactly the format this page reads.</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                  <Input id={ids.about} value={about} onChange={(e) => setAbout(e.target.value)} maxLength={300} placeholder="Topic or book — e.g. The Alchemist by Paulo Coelho" className="h-9" aria-label="Topic or book for the prompt" />
                  <Segmented value={String(count)} onValueChange={(v) => setCount(Number(v))} aria-label="How many shorts">
                    {COUNTS.map((c) => (
                      <SegmentedItem key={c} value={String(c)}>
                        {c}
                      </SegmentedItem>
                    ))}
                  </Segmented>
                  <Segmented value={String(seconds)} onValueChange={(v) => setSeconds(Number(v))} aria-label="Length of each">
                    {SCRIPT_LENGTHS.slice(0, 3).map((s) => (
                      <SegmentedItem key={s} value={String(s)}>
                        {s} s
                      </SegmentedItem>
                    ))}
                  </Segmented>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void copyPrompt()}>
                    {copied ? <Check aria-hidden /> : <ClipboardCopy aria-hidden />} {copied ? 'Copied' : 'Copy prompt'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={downloadExample}>
                    <Download aria-hidden /> Example file
                  </Button>
                </div>
              </div>

              <Field
                label={
                  <>
                    Scripts
                    <span className={cn('ml-auto text-xs font-normal', parsed.items.length > room ? 'text-warning-foreground dark:text-warning' : 'text-muted-foreground')} aria-live="polite">
                      {pasteFound(parsed.items.length, parsed.format, room)}
                    </span>
                  </>
                }
                htmlFor={ids.paste}
                hint={
                  <>
                    Separate shorts with headings like <code className="rounded bg-muted px-1">## Short 2</code> or a <code className="rounded bg-muted px-1">---</code> line; label parts with{' '}
                    <code className="rounded bg-muted px-1">Title:</code> <code className="rounded bg-muted px-1">Script:</code> <code className="rounded bg-muted px-1">Description:</code>{' '}
                    <code className="rounded bg-muted px-1">Hashtags:</code>. JSON and spreadsheets (CSV with a “script” column) work too. Emojis, scene notes and stage directions are left out.
                  </>
                }
              >
                <Textarea
                  id={ids.paste}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={onDrop}
                  rows={10}
                  className="min-h-56 font-mono text-[13px] leading-relaxed"
                  placeholder={'## Short 1\nTitle: What if your dream was already here?\nScript:\nA shepherd crosses a desert for a treasure…\nDescription: …\nHashtags: #Shorts #TheAlchemist\n\n## Short 2\n…\n\nOr drop a .txt, .md, .csv or .json file here.'}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={addPasted} disabled={!parsed.items.length || !room}>
                  <Plus aria-hidden /> Add {Math.min(parsed.items.length, room) || ''} {Math.min(parsed.items.length, room) === 1 ? 'short' : 'shorts'}
                </Button>
                <Button variant="outline" onClick={() => fileInput.current?.click()}>
                  <FileUp aria-hidden /> Upload a file
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  accept=".txt,.md,.markdown,.csv,.tsv,.json,text/plain,text/markdown,text/csv,application/json"
                  onChange={(e) => {
                    void readFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                {parsed.format === 'single' && parsed.items.length === 1 && (
                  <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => (setSplitText(pasteText), setPasteText(''), setTab('split'))}>
                    One long script? Split it into several shorts →
                  </button>
                )}
              </div>
              {fileError && <p className="text-sm text-destructive">{fileError}</p>}
            </TabsContent>

            {/* split one long script */}
            <TabsContent value="split" className="grid gap-5 pt-2">
              <Field label="Series title" htmlFor={ids.splitTitle} hint="Each part is titled “Series title — Part 1/4”; edit any of them afterwards.">
                <Input id={ids.splitTitle} value={splitTitle} onChange={(e) => setSplitTitle(e.target.value)} maxLength={80} placeholder="e.g. The Alchemist in 4 minutes" className="h-10" />
              </Field>
              <Field
                label={
                  <>
                    Long script
                    <span className="ml-auto text-xs font-normal text-muted-foreground">{splitText.trim() ? `~${formatDuration(estimateShortSec(splitText, settings.language, settings.tts.speed))} of narration` : ''}</span>
                  </>
                }
                htmlFor={ids.splitText}
                hint="Cut at sentence ends into parts of even length, in order. Give each part a hook as its first line once it is added — that is what stops the scroll."
              >
                <Textarea id={ids.splitText} value={splitText} onChange={(e) => setSplitText(e.target.value)} maxLength={SHORT_SPLIT_MAX_CHARS} rows={10} className="min-h-56" lang={settings.language} placeholder="Paste a whole summary, chapter or story…" />
              </Field>
              <Field label="Number of shorts">
                <Select value={String(parts)} onValueChange={(v) => setParts(v === 'auto' ? 'auto' : Number(v))}>
                  <SelectTrigger className="h-10 sm:max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Automatic — {autoParts} {autoParts === 1 ? 'short' : 'shorts'} under a minute</SelectItem>
                    {Array.from({ length: SHORT_BATCH_MAX - 1 }, (_, i) => i + 2).map((k) => (
                      <SelectItem key={k} value={String(k)}>
                        {k} shorts
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {pieces.length > 0 && (
                <ol className="grid gap-1.5 rounded-xl bg-muted/50 p-3 text-sm">
                  {pieces.map((p, i) => {
                    const s = estimateShortSec(p, settings.language, settings.tts.speed);
                    return (
                      <li key={i} className="flex min-w-0 items-baseline gap-2">
                        <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground tabular">Part {i + 1}</span>
                        <span className={cn('w-12 shrink-0 text-xs tabular', s > SHORT_MAX_SEC ? 'text-destructive' : s > 60 ? 'text-warning-foreground dark:text-warning' : 'text-muted-foreground')}>~{formatDuration(s)}</span>
                        <span className="truncate">{p}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={addSplit} disabled={!pieces.length || pieces.length > room}>
                  <Plus aria-hidden /> Add {pieces.length || ''} {pieces.length === 1 ? 'short' : 'shorts'}
                </Button>
                {pieces.length > room && <span className="text-xs text-warning-foreground dark:text-warning">Only {room} more fit in this batch — choose fewer parts.</span>}
              </div>
            </TabsContent>

            {/* local AI */}
            <TabsContent value="ai" className="grid gap-5 pt-2">
              {llmOff && (
                <p className="flex items-start gap-1.5 rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden /> The local AI is turned off (LLM_ENABLED=false in .env). Use another AI tool with the prompt under “Paste or upload”.
                </p>
              )}
              <Field label="Write about">
                <Segmented value={source} onValueChange={(v) => setSource(v as 'topic' | 'book')} aria-label="Write about" disabled={busy}>
                  <SegmentedItem value="topic">
                    <Type aria-hidden /> A topic
                  </SegmentedItem>
                  <SegmentedItem value="book">
                    <BookOpen aria-hidden /> One of my books
                  </SegmentedItem>
                </Segmented>
              </Field>
              {source === 'topic' ? (
                <Field label="Topic or idea" htmlFor={ids.topic} hint="Each short takes its own angle on it: a myth busted, a story, a tip…">
                  <Input id={ids.topic} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={500} placeholder="e.g. Stoicism for busy people" className="h-10" disabled={busy} />
                </Field>
              ) : (
                <Field label="Book" hint={books.length ? 'Each short reads a different part of the book, so the series covers all of it.' : 'Add a book in the Library first.'}>
                  <Select value={aiBook} onValueChange={setAiBook} disabled={busy || !books.length}>
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
              <div className="flex flex-wrap gap-5">
                <Field label="How many">
                  <Segmented value={String(count)} onValueChange={(v) => setCount(Number(v))} aria-label="How many" disabled={busy}>
                    {COUNTS.map((c) => (
                      <SegmentedItem key={c} value={String(c)}>
                        {c}
                      </SegmentedItem>
                    ))}
                  </Segmented>
                </Field>
                <Field label="Length of each">
                  <Segmented value={String(seconds)} onValueChange={(v) => setSeconds(Number(v))} aria-label="Length of each" disabled={busy}>
                    {SCRIPT_LENGTHS.map((s) => (
                      <SegmentedItem key={s} value={String(s)}>
                        {s} s
                      </SegmentedItem>
                    ))}
                  </Segmented>
                </Field>
              </div>
              <Field label="Style">
                <Select value={styleMode} onValueChange={(v) => setStyleMode(v as StyleMode)} disabled={busy}>
                  <SelectTrigger className="h-10 sm:max-w-md">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mixed">Mixed — hooks, key ideas and stories take turns</SelectItem>
                    {SCRIPT_STYLES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label} — {s.hint.toLowerCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  {aiJob?.kind === 'scripts' ? (
                    <Button variant="outline" onClick={stopAi}>
                      <Square className="fill-current" aria-hidden /> Stop
                    </Button>
                  ) : (
                    <Button onClick={() => void writeScripts()} disabled={busy || !!llmOff || !toWrite || (source === 'topic' ? topic.trim().length < 3 : !aiBook)}>
                      <Sparkles aria-hidden /> Write {toWrite || ''} {toWrite === 1 ? 'script' : 'scripts'}
                    </Button>
                  )}
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    {aiJob?.kind === 'scripts'
                      ? `Writing ${Math.min(aiJob.done + 1, aiJob.total)} of ${aiJob.total} — 20–60 seconds each. Finished ones appear below.`
                      : !room
                        ? `The batch is full (${SHORT_BATCH_MAX}).`
                        : `In ${settings.language === 'bn' ? 'Bangla' : 'English'}. Each script gets its own angle and avoids the titles already in the batch.`}
                  </p>
                </div>
                {aiJob?.kind === 'scripts' && <Progress value={(aiJob.done / aiJob.total) * 100} live className="h-1.5 sm:max-w-md" />}
              </div>
            </TabsContent>
          </Tabs>
          {aiError && <ApiErrorAlert error={aiError} title={aiJob?.kind === 'details' ? 'The YouTube details could not be written' : 'The local AI stopped'} />}
        </FormSection>

        {/* ── review ── */}
        <FormSection
          id="batch-review"
          step={2}
          title="Review"
          description={items.length ? `${items.length} of ${SHORT_BATCH_MAX} shorts · about ${formatDuration(total)} of narration in all. Click one to preview it.` : 'Check and edit every short before anything is made.'}
        >
          {items.length ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {aiJob?.kind === 'details' ? (
                  <Button variant="outline" size="sm" onClick={stopAi}>
                    <Square className="fill-current" aria-hidden /> Stop ({aiJob.done}/{aiJob.total})
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => void writeDetails()} disabled={busy || !missingDetails || !!llmOff}>
                    <Wand2 aria-hidden /> Write missing YouTube details{missingDetails ? ` (${missingDetails})` : ''}
                  </Button>
                )}
                <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => (setItems([]), setSelected(undefined))} disabled={busy}>
                  <Trash2 aria-hidden /> Clear all
                </Button>
              </div>
              <ol className="grid gap-3">
                {items.map((it, i) => (
                  <BatchCard
                    key={it.key}
                    item={it}
                    index={i}
                    count={items.length}
                    seconds={secs[i]}
                    theme={themeOf(it, i)}
                    batchTheme={themeOf({ ...it, look: { ...it.look, theme: undefined } }, i)}
                    accent={settings.look.accent}
                    coverUrl={coverUrl}
                    selected={it.key === sel?.key}
                    warnings={warnings[i]}
                    language={settings.language}
                    onSelect={() => setSelected(it.key)}
                    onChange={(p) => patch(it.key, p)}
                    onMove={(by) => move(it.key, by)}
                    onRemove={() => remove(it.key)}
                  />
                ))}
              </ol>
            </>
          ) : (
            <div className="grid justify-items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
              <Plus className="size-5 text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">Shorts you add above appear here.</p>
            </div>
          )}
        </FormSection>

        {/* ── voice ── */}
        <FormSection step={3} icon={<Mic />} title="Voice" description="One voice for the whole batch — local text-to-speech, nothing leaves your Mac.">
          <ShortVoiceFields settings={settings} config={config.data} update={update} />
        </FormSection>

        {/* ── look ── */}
        <FormSection step={4} icon={<Palette />} title="Look" description="Shared by every short; each one can still pick its own background in Review.">
          <Field label="Across the batch" hint="Mixing gives each short its own animated background, so a run of uploads does not look repetitive in the feed.">
            <Segmented value={mix ? 'mix' : 'same'} onValueChange={(v) => setMix(v === 'mix')} aria-label="Backgrounds across the batch">
              <SegmentedItem value="same">Same for all</SegmentedItem>
              <SegmentedItem value="mix">Mix animated</SegmentedItem>
            </Segmented>
          </Field>
          <ShortLookFields settings={settings} updateLook={updateLook} coverUrl={coverUrl} books={books} projectId={projectId} onProjectChange={setProjectId} coverMissing={coverNeeded} />
        </FormSection>

        {saveError && <ApiErrorAlert error={saveError} title="The batch could not be created" />}
      </div>

      <aside className="grid gap-4 lg:sticky lg:top-8">
        <div className="grid gap-4 rounded-2xl border bg-card p-5 shadow-card">
          <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Preview{sel ? ` · Short ${selIndex + 1}` : ''}</p>
          <ShortPreview title={sel?.title ?? ''} script={sel?.script ?? ''} settings={previewSettings} coverUrl={coverUrl} className="mx-auto w-full max-w-[220px]" />
          <dl className="grid grid-cols-2 gap-2 text-center">
            <Stat label="Shorts" value={`${items.length}/${SHORT_BATCH_MAX}`} />
            <Stat label="Narration" value={items.length ? formatDuration(total) : '—'} />
          </dl>
          <div className="grid gap-2">
            <Button size="lg" variant="brand" onClick={() => void create(true)} disabled={!!problem || !!saving || busy}>
              {saving === 'render' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Play className="fill-current" aria-hidden />}
              Create {items.length > 1 ? `${items.length} shorts` : 'short'}
            </Button>
            <Button variant="outline" onClick={() => void create(false)} disabled={!items.length || empty >= 0 || !!saving || busy}>
              {saving === 'draft' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Save aria-hidden />} Save as drafts
            </Button>
            <p className={cn('text-center text-xs', problem && items.length ? 'text-destructive' : 'text-muted-foreground')}>
              {problem && items.length ? problem : `Rendered one after another in the background — about ${Math.max(1, items.length)} min in all. You can leave this page.`}
            </p>
          </div>
          <p className="flex gap-2 rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">
            <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-brand" aria-hidden />
            <span>
              Upload one or two a day rather than all at once, and make each short say something new — YouTube can limit channels that post many near-identical videos.
            </span>
          </p>
        </div>
      </aside>
    </div>
  );
}

function pasteFound(n: number, format: string, room: number): string {
  if (!n) return '';
  const what = format === 'json' ? ' (JSON)' : format === 'table' ? ' (spreadsheet)' : '';
  if (n > room) return `Found ${n}${what} — only ${room} more fit in this batch`;
  return n === 1 ? `1 script${what}` : `Found ${n} shorts${what}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-0.5 rounded-lg bg-muted/60 px-2 py-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold tabular">{value}</dd>
    </div>
  );
}

/** One short in the review list: title, script, its own background and its YouTube text. */
function BatchCard({
  item,
  index,
  count,
  seconds,
  theme,
  batchTheme,
  accent,
  coverUrl,
  selected,
  warnings,
  language,
  onSelect,
  onChange,
  onMove,
  onRemove,
}: {
  item: Item;
  index: number;
  count: number;
  seconds: number;
  theme: ShortTheme;
  /** What the batch would give it (its own choice aside). */
  batchTheme: ShortTheme;
  accent: string;
  coverUrl?: string;
  selected: boolean;
  warnings: string[];
  language: string;
  onSelect: () => void;
  onChange: (p: Partial<ShortBatchItem>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  // Typed freely; turned into the list when the field is left (so "#" alone is not lost mid-typing).
  const [hashtags, setHashtags] = useState(formatHashtags(item.hashtags));
  useEffect(() => setHashtags(formatHashtags(item.hashtags)), [item.hashtags]);
  const tone = seconds > SHORT_MAX_SEC ? 'error' : seconds > 60 ? 'warning' : 'ok';
  return (
    <li
      className={cn('grid gap-3 rounded-xl border bg-background/40 p-3 transition-shadow sm:grid-cols-[64px_minmax(0,1fr)]', selected && 'border-ring/60 ring-[3px] ring-ring/20')}
      onFocusCapture={onSelect}
    >
      <button type="button" onClick={onSelect} className="relative hidden aspect-[9/16] w-16 overflow-hidden rounded-md sm:block" aria-label={`Preview short ${n}`}>
        <ShortBackdrop theme={theme} accent={accent} coverUrl={coverUrl} still />
        <span className="absolute inset-x-0 top-1.5 text-center text-xs font-semibold text-white [text-shadow:0_1px_4px_rgb(0_0_0/0.6)]">{n}</span>
      </button>
      <div className="grid min-w-0 gap-2">
        {/* phone: number, length and buttons, then the title on its own line */}
        <div className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold tabular sm:hidden">{n}</span>
          <Input
            value={item.title}
            onChange={(e) => onChange({ title: e.target.value })}
            maxLength={200}
            placeholder="Title"
            className="order-last h-9 basis-full font-medium sm:order-none sm:basis-auto"
            aria-label={`Title of short ${n}`}
            lang={language}
          />
          <span
            className={cn(
              'ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium tabular sm:ml-0',
              tone === 'error' ? 'bg-destructive/10 text-destructive' : tone === 'warning' ? 'bg-warning/15 text-warning-foreground dark:text-warning' : 'bg-muted text-muted-foreground',
            )}
            title={tone === 'error' ? 'Over 3 minutes: too long for a Short' : tone === 'warning' ? 'Over a minute: allowed, but shorter usually does better' : 'Estimated narration'}
          >
            ~{formatDuration(seconds)}
          </span>
          <Button variant="ghost" size="icon-xs" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move short ${n} up`}>
            <ArrowUp aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move short ${n} down`}>
            <ArrowDown aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onRemove} aria-label={`Remove short ${n}`} className="text-muted-foreground hover:text-destructive">
            <Trash2 aria-hidden />
          </Button>
        </div>
        <Textarea value={item.script} onChange={(e) => onChange({ script: e.target.value })} maxLength={SHORT_SCRIPT_MAX_CHARS} rows={3} className="min-h-20 text-sm" aria-label={`Script of short ${n}`} lang={language} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Select value={item.look?.theme ?? 'batch'} onValueChange={(v) => onChange({ look: { ...item.look, theme: v === 'batch' ? undefined : (v as ShortTheme) } })}>
            <SelectTrigger size="sm" className="h-7 w-56 max-w-full gap-1.5 px-2.5 text-xs" aria-label={`Background of short ${n}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              <SelectItem value="batch">Background: batch ({SHORT_THEMES[batchTheme].label})</SelectItem>
              {(Object.keys(SHORT_THEMES) as ShortTheme[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {SHORT_THEMES[k].label}
                  {SHORT_THEMES[k].animated ? ' · animated' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <details className="group min-w-0 basis-full text-xs sm:basis-0 sm:flex-1">
            <summary className="cursor-pointer list-none text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
              <span className="inline-block transition-transform group-open:rotate-90">›</span> YouTube details
              <span className={cn('ml-1.5', !item.description.trim() && 'text-warning-foreground dark:text-warning')}>
                {item.description.trim() ? `· ${plural(item.hashtags.length, 'hashtag')} · ${item.tags.length ? plural(item.tags.length, 'tag') : 'suggested tags'}` : '· no description yet'}
              </span>
            </summary>
            <div className="mt-2 grid gap-2">
              <Textarea value={item.description} onChange={(e) => onChange({ description: e.target.value })} maxLength={5000} rows={2} className="text-sm" placeholder="Two short sentences for the YouTube description." aria-label={`Description of short ${n}`} />
              <Input value={hashtags} onChange={(e) => setHashtags(e.target.value)} onBlur={() => onChange({ hashtags: parseHashtags(hashtags) })} placeholder="#Shorts #Audiobook" className="h-8 text-sm" aria-label={`Hashtags of short ${n}`} />
            </div>
          </details>
        </div>
        {warnings.map((w) => (
          <p key={w} className="flex items-center gap-1.5 text-xs text-warning-foreground dark:text-warning">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden /> {w} — YouTube may treat near-duplicates as repetitive content.
          </p>
        ))}
      </div>
    </li>
  );
}
