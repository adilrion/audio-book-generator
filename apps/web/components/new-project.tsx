'use client';

import { DEFAULT_SETTINGS, type LibraryBook, type LibraryBookDetail, type LibraryFile, type ProjectDetail, type ProjectSettings } from '@app/types';
import { CircleCheck, FileUp, Globe, Headphones, Languages, Link2, ListTree, LoaderCircle, Play, ScanText, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { BookCover } from '@/components/book-cover';
import { BookLibrary } from '@/components/book-library';
import { HealthBanner } from '@/components/health-banner';
import { LinkImport } from '@/components/link-import';
import { PageHeader } from '@/components/page-header';
import { FormSection, LookPreview, SettingsForm, validateSettings } from '@/components/settings-form';
import { isPdfFile, UploadDropzone } from '@/components/upload-dropzone';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/hooks/use-api';
import { ApiError, api, type ImportSource, importProject, toApiError, type UploadHandle, uploadProject } from '@/lib/api';
import { estimateNarrationSec, formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { displayAuthor, linkLabel, type NewSourceTab, rightsBadge } from '@/lib/library';
import { cloneSettings, diffSettings, isEmptyPatch, settingsForUpload } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { applyLanguage, ENGINE_LABELS } from '@/lib/voices';

/** What is being added: a file from this Mac, or a PDF the API downloads (a library book or a link). */
interface Source {
  kind: 'file' | 'library' | 'link';
  name: string;
  size?: number;
  book?: LibraryBook;
}

type Upload =
  | { state: 'idle' }
  /** `progress` 0–1; a download of unknown size only knows `received` bytes. */
  | { state: 'uploading'; file: Source; phase: 'upload' | 'download' | 'inspect'; progress: number; received?: number }
  | { state: 'done'; file: Source; project: ProjectDetail }
  | { state: 'error'; file: Source; error: ApiError };


const RETRY_LABEL: Record<Source['kind'], string> = { file: 'Choose another file', library: 'Choose another book', link: 'Try another link' };

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-0.5 rounded-xl bg-muted/60 px-3 py-2.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-[17px] leading-tight font-semibold tracking-tight tabular">{value}</span>
    </div>
  );
}

function progressText(u: Extract<Upload, { state: 'uploading' }>, inspecting: boolean): string {
  if (inspecting) return 'Inspecting PDF — counting pages and words…';
  if (u.phase === 'upload') return `Uploading… ${Math.round(u.progress * 100)}%`;
  const from = u.file.kind === 'library' ? 'archive.org' : 'the link';
  if (!u.received) return `Connecting to ${from}…`;
  return u.file.size ? `Downloading from ${from}… ${Math.round(u.progress * 100)}% of ${formatBytes(u.file.size)}` : `Downloading from ${from}… ${formatBytes(u.received)}`;
}

function FileCard({ upload, speed, onReset }: { upload: Exclude<Upload, { state: 'idle' }>; speed: number; onReset: () => void }) {
  const f = upload.file;
  const doc = upload.state === 'done' ? upload.project.document : undefined;
  const title = (upload.state === 'done' && upload.project.name) || doc?.title || f.name;
  const inspecting = upload.state === 'uploading' && (upload.phase === 'inspect' || (upload.phase === 'upload' && upload.progress >= 1));
  // A download can be stopped; an upload cannot once sent (the API would create the project anyway).
  const cancellable = upload.state === 'uploading' && upload.phase === 'download';
  const size = doc?.fileSize ?? f.size;
  const rights = f.book ? rightsBadge(f.book) : undefined;
  // The library's catalogue name reads better than a scan's PDF metadata ("Tagore, Rabindranath, 1861-1941; Royal India…").
  const author = (f.book && displayAuthor(f.book.author)) || doc?.author;
  return (
    <div className="grid gap-5">
      <div className="flex items-start gap-4">
        <BookCover projectId={upload.state === 'done' ? upload.project.id : undefined} src={f.book?.coverUrl} title={title.replace(/\.pdf$/i, '')} className="w-16" />
        <div className="grid min-w-0 flex-1 gap-1 pt-0.5">
          <p className="truncate font-serif text-lg leading-snug font-medium" title={title}>
            {title}
          </p>
          <p className="truncate text-sm text-muted-foreground tabular">
            {author ? `${author} · ` : ''}
            {upload.state === 'done' && upload.project.fileName !== title ? `${upload.project.fileName} · ` : ''}
            {size ? formatBytes(size) : f.kind === 'library' ? 'Internet Archive' : 'From a link'}
          </p>
          {upload.state === 'uploading' && (
            <div className="mt-2 grid gap-1.5">
              {(upload.phase !== 'download' || f.size) && <Progress value={inspecting ? 100 : upload.progress * 100} live={inspecting} className="h-1.5" />}
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                {progressText(upload, inspecting)}
              </p>
            </div>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onReset} disabled={upload.state === 'uploading' && !cancellable} className="shrink-0 text-muted-foreground">
          <X aria-hidden /> <span className="hidden sm:inline">{cancellable ? 'Cancel' : 'Replace'}</span>
        </Button>
      </div>

      {upload.state === 'error' && (
        <ApiErrorAlert error={upload.error} title={f.kind === 'file' ? 'Upload failed' : 'Download failed'} onRetry={onReset} retryLabel={RETRY_LABEL[f.kind]} />
      )}

      {doc && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Pages" value={formatNumber(doc.pageCount)} />
            <Stat label="Words (est.)" value={`~${formatNumber(Math.round(doc.estimatedWords / 100) * 100 || doc.estimatedWords)}`} />
            <Stat label="Narration (est.)" value={`~${formatDuration(estimateNarrationSec(doc.estimatedWords, speed))}`} />
            <Stat label="File size" value={formatBytes(doc.fileSize)} />
          </div>
          <div className="flex flex-wrap gap-2">
            {doc.likelyScanned ? (
              <Badge variant="warning">
                <ScanText aria-hidden /> Looks scanned — text will be read with OCR (slower)
              </Badge>
            ) : (
              <Badge variant="success">
                <CircleCheck aria-hidden /> Text PDF — no OCR needed
              </Badge>
            )}
            {doc.hasToc ? (
              <Badge variant="success">
                <ListTree aria-hidden /> Table of contents found — used for chapters
              </Badge>
            ) : (
              <Badge variant="muted">
                <ListTree aria-hidden /> No table of contents — chapters detected from headings
              </Badge>
            )}
            {doc.encrypted && (
              <Badge variant="info">
                <ShieldCheck aria-hidden /> Encrypted PDF (opened without a password)
              </Badge>
            )}
            {rights && (
              <Badge variant={rights.variant} title={rights.help}>
                {rights.label}
              </Badge>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{children}</dd>
    </div>
  );
}

export function NewProject({ initialBook, initialTab }: { initialBook?: { id: string; file?: string }; initialTab?: NewSourceTab } = {}) {
  const router = useRouter();
  const config = useApi('config', (signal) => api.config(signal));
  // New books pause for a chapter review by default: a wrong chapter list is cheap to fix before narration.
  const withReview = (s: ProjectSettings) => ({ ...s, text: { ...s.text, reviewChapters: true } });
  const [settings, setSettings] = useState<ProjectSettings>(() => withReview(cloneSettings(DEFAULT_SETTINGS)));
  const touched = useRef(false);
  // A library pick lands after an await; read the settings as they are then, not as they were at the click.
  const latest = useRef(settings);
  latest.current = settings;
  const [upload, setUpload] = useState<Upload>({ state: 'idle' });
  const handle = useRef<UploadHandle | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ApiError>();
  const [localError, setLocalError] = useState<string>();
  const [tab, setTab] = useState<NewSourceTab>(initialTab ?? 'upload');
  const [notice, setNotice] = useState<string>();

  // Server defaults (engine/voice come from the API's .env) — unless the user already changed something.
  useEffect(() => {
    if (config.data && !touched.current) setSettings(withReview(cloneSettings(config.data.defaults)));
  }, [config.data]);

  /** Looking up a book chosen on the Online library page, before its download starts. */
  const lookup = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      handle.current?.abort();
      lookup.current?.abort();
    },
    [],
  );

  const maxMb = config.data?.maxUploadMb;

  /** Follow an upload or download until the project exists (or it fails). */
  const track = (h: UploadHandle, from: Source) => {
    handle.current = h;
    h.promise
      .then((project) => setUpload({ state: 'done', file: from, project }))
      .catch((err) => {
        if ((err as ApiError)?.code === 'ABORTED') return;
        setUpload({ state: 'error', file: from, error: toApiError(err) });
      })
      .finally(() => {
        if (handle.current === h) handle.current = null;
      });
  };

  const onFile = (file: File) => {
    setLocalError(undefined);
    setStartError(undefined);
    setNotice(undefined);
    if (!isPdfFile(file)) {
      setLocalError(`“${file.name}” is not a PDF. Choose a .pdf file.`);
      return;
    }
    if (maxMb && file.size > maxMb * 1024 * 1024) {
      setLocalError(`This file is ${formatBytes(file.size)} — the limit is ${maxMb} MB (MAX_UPLOAD_MB in .env).`);
      return;
    }
    if (file.size === 0) {
      setLocalError('This file is empty.');
      return;
    }
    const from: Source = { kind: 'file', name: file.name, size: file.size };
    setUpload({ state: 'uploading', file: from, phase: 'upload', progress: 0 });
    track(
      uploadProject(file, {
        settings: settingsForUpload(settings),
        onProgress: (p) => setUpload((u) => (u.state === 'uploading' && u.file === from ? { ...u, progress: p } : u)),
      }),
      from,
    );
  };

  /** The API downloads the PDF (library book or link) and creates the project, like an upload. */
  const onImport = (source: ImportSource, from: Source, withSettings: ProjectSettings) => {
    setLocalError(undefined);
    setStartError(undefined);
    setUpload({ state: 'uploading', file: from, phase: 'download', progress: 0 });
    track(
      importProject(source, {
        settings: settingsForUpload(withSettings),
        onProgress: (e) =>
          setUpload((u) => {
            if (u.state !== 'uploading' || u.file !== from) return u;
            if (e.phase === 'inspecting') return { ...u, phase: 'inspect', progress: 1 };
            const total = e.total ?? from.size;
            return { ...u, received: e.received, progress: total ? Math.min(1, e.received / total) : 0 };
          }),
      }),
      from,
    );
  };

  const onBook = (book: LibraryBookDetail, file: LibraryFile) => {
    // Narrate a Bangla book in Bangla (and an English one in English) unless the user picks otherwise.
    let next = latest.current;
    const lang = book.language === 'bn' || book.language === 'en' ? book.language : undefined;
    if (lang && lang !== next.language) {
      next = cloneSettings(next);
      applyLanguage(next, lang, config.data);
      touched.current = true;
      setSettings(next);
      setNotice(`Narration language set to ${lang === 'bn' ? 'Bangla' : 'English'} to match this book.`);
    } else setNotice(undefined);
    // The project gets the main title ("Pride and prejudice : a novel" → "Pride and prejudice"); show the same while it downloads.
    const title = book.title.split(/\s+:\s+/)[0];
    const name = book.files.length > 1 ? `${title} — ${file.name}` : title;
    onImport({ source: 'archive', id: book.id, file: file.name }, { kind: 'library', name, size: file.size || undefined, book }, next);
  };

  const onLink = (url: string) => {
    setNotice(undefined);
    onImport({ source: 'url', url }, { kind: 'link', name: linkLabel(url) }, latest.current);
  };

  // A book chosen on the Online library page (/new?archive=…): start it once the server defaults are in.
  const preset = useRef(initialBook);
  useEffect(() => {
    const b = preset.current;
    if (!b || (!config.data && !config.error)) return;
    preset.current = undefined; // once, also under React's doubled dev effects
    window.history.replaceState(window.history.state, '', '/new'); // a reload must not download it again
    const c = new AbortController();
    lookup.current = c;
    setUpload({ state: 'uploading', file: { kind: 'library', name: 'Book from the online library' }, phase: 'download', progress: 0 });
    api
      .libraryBook(b.id, c.signal)
      .then((detail) => {
        if (c.signal.aborted) return;
        const file = (b.file && detail.files.find((f) => f.name === b.file)) || detail.files[0];
        if (file) return onBook(detail, file);
        setUpload({ state: 'idle' });
        setLocalError(`“${detail.title}” has no PDF that can be downloaded — it may be a borrow-only book.`);
      })
      .catch((err) => {
        if (c.signal.aborted) return;
        setUpload({ state: 'idle' });
        setLocalError(toApiError(err).message);
      })
      .finally(() => {
        if (lookup.current === c) lookup.current = null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, when the config has loaded
  }, [config.data, config.error]);

  const reset = () => {
    handle.current?.abort();
    lookup.current?.abort();
    // The project was created by the upload but never started — remove it (the PDF is kept if other projects use it).
    if (upload.state === 'done') void api.deleteProject(upload.project.id, false).catch(() => undefined);
    setUpload({ state: 'idle' });
    setStartError(undefined);
    setNotice(undefined);
  };

  const invalid = validateSettings(settings);
  const canStart = upload.state === 'done' && !invalid && !starting;

  const start = async () => {
    if (upload.state !== 'done') return;
    setStarting(true);
    setStartError(undefined);
    const project = upload.project;
    try {
      const patch = diffSettings(project.settings, settings);
      if (!isEmptyPatch(patch)) await api.updateSettings(project.id, patch);
      await api.process(project.id);
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setStartError(toApiError(err));
      setStarting(false);
    }
  };

  const hint =
    upload.state === 'idle'
      ? 'Choose a PDF to continue.'
      : upload.state === 'uploading'
        ? `${upload.phase === 'download' ? 'Downloading' : 'Uploading'}… you can keep configuring meanwhile.`
        : upload.state === 'error'
          ? `Fix the ${upload.file.kind === 'file' ? 'upload' : 'download'} problem to continue.`
          : invalid
            ? invalid
            : settings.text.reviewChapters
              ? 'Ready. You will check the chapter list before narration starts.'
              : 'Ready. Later changes only recompute the stages they affect.';

  const startButton = (className?: string) => (
    <Button size="lg" variant="brand" onClick={() => void start()} disabled={!canStart} className={className}>
      {starting ? <LoaderCircle className="animate-spin" aria-hidden /> : <Play className="fill-current" aria-hidden />}
      {starting ? 'Starting…' : 'Start processing'}
    </Button>
  );

  const doc = upload.state === 'done' ? upload.project.document : undefined;
  const videoOn = settings.outputMode === 'audiobook_video';

  return (
    <div className="grid gap-8">
      <PageHeader
        back={{ href: '/', label: 'Library' }}
        title="New audiobook"
        description="Upload a PDF or pick a book from the online library, choose a voice and a look, then start. Processing runs in the background — you can close this tab."
      />

      <HealthBanner />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px] xl:gap-8">
        <div className="grid min-w-0 gap-6">
          <FormSection
            step={1}
            title="Choose your book"
            description="Upload a PDF from this Mac, find a free book online, or paste a link to a PDF. Books are kept on this Mac, and the same file is only stored once."
          >
            {/* Stays mounted while a book is loading, so “Choose another book” returns to the same search. */}
            <Tabs value={tab} onValueChange={(v) => setTab(v as NewSourceTab)} className={cn(upload.state !== 'idle' && 'hidden')}>
              <TabsList className="w-full sm:w-fit">
                <TabsTrigger value="upload">
                  <FileUp aria-hidden /> Upload
                </TabsTrigger>
                <TabsTrigger value="library">
                  <Globe aria-hidden /> Online library
                </TabsTrigger>
                <TabsTrigger value="link">
                  <Link2 aria-hidden /> <span className="sm:hidden">Link</span>
                  <span className="hidden sm:inline">Paste a link</span>
                </TabsTrigger>
              </TabsList>
              <TabsContent value="upload">
                <UploadDropzone onFile={onFile} maxMb={maxMb} />
              </TabsContent>
              <TabsContent value="library">
                <BookLibrary onPick={onBook} initial={{ language: settings.language === 'bn' ? 'bn' : 'any' }} />
              </TabsContent>
              <TabsContent value="link">
                <LinkImport onLink={onLink} />
              </TabsContent>
            </Tabs>
            {upload.state !== 'idle' && <FileCard upload={upload} speed={settings.tts.speed} onReset={reset} />}
            {notice && upload.state !== 'idle' && (
              <p className="-mt-2 flex items-center gap-1.5 text-sm text-muted-foreground" aria-live="polite">
                <Languages className="size-4 shrink-0" aria-hidden /> {notice}
              </p>
            )}
            {localError && (
              <p className="-mt-2 flex items-center gap-1.5 text-sm text-destructive" role="alert">
                <TriangleAlert className="size-4 shrink-0" aria-hidden /> {localError}
              </p>
            )}
          </FormSection>

          {config.error && !config.data && <ApiErrorAlert error={config.error} onRetry={() => void config.refresh()} />}
          <SettingsForm
            value={settings}
            onChange={(s) => {
              touched.current = true;
              setSettings(s);
            }}
            config={config.data}
            disabled={starting}
            document={doc}
            firstStep={2}
          />

          {startError && <ApiErrorAlert error={startError} title="Could not start processing" />}
        </div>

        {/* Summary rail */}
        <aside className="grid gap-4 lg:sticky lg:top-8" aria-label="Summary">
          <div className="grid gap-5 rounded-2xl border bg-card p-5 shadow-card">
            <div className="grid gap-3">
              <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Preview</p>
              {videoOn ? (
                <LookPreview settings={settings} />
              ) : (
                <div className="grid aspect-video place-items-center rounded-xl bg-muted/70 text-muted-foreground">
                  <span className="grid justify-items-center gap-2 text-sm">
                    <Headphones className="size-6" aria-hidden /> Audio only — M4A + SRT
                  </span>
                </div>
              )}
            </div>
            <dl className="divide-y border-y">
              <SummaryRow label="Book">
                {upload.state === 'done' ? upload.project.name : upload.state !== 'idle' ? upload.file.name : <span className="font-normal text-muted-foreground">No book yet</span>}
              </SummaryRow>
              <SummaryRow label="Narration">
                {doc ? `~${formatDuration(estimateNarrationSec(doc.estimatedWords, settings.tts.speed))}` : <span className="font-normal text-muted-foreground">—</span>}
              </SummaryRow>
              <SummaryRow label="Voice">
                {ENGINE_LABELS[settings.tts.engine]?.name ?? settings.tts.engine} · {settings.tts.speed.toFixed(2)}×
              </SummaryRow>
              <SummaryRow label="Output">{videoOn ? `Video ${settings.video.aspectRatio} + audio` : 'Audio only'}</SummaryRow>
            </dl>
            <div className="hidden gap-2.5 lg:grid">
              {startButton('w-full')}
              <p className={cn('text-center text-xs', invalid && upload.state === 'done' ? 'text-destructive' : 'text-muted-foreground')}>{hint}</p>
            </div>
          </div>
        </aside>
      </div>

      {/* Start bar on small screens */}
      <div className="sticky bottom-3 z-30 lg:hidden">
        <div className="flex items-center gap-3 rounded-2xl border bg-card/90 p-2.5 pl-4 shadow-float backdrop-blur-md supports-[backdrop-filter]:bg-card/75">
          <p className={cn('min-w-0 flex-1 text-xs sm:text-sm', invalid && upload.state === 'done' ? 'text-destructive' : 'text-muted-foreground')}>{hint}</p>
          {startButton('shrink-0')}
        </div>
      </div>
    </div>
  );
}
