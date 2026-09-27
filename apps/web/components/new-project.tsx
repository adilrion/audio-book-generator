'use client';

import { DEFAULT_SETTINGS, type ProjectDetail, type ProjectSettings } from '@app/types';
import { CircleCheck, Headphones, ListTree, LoaderCircle, Play, ScanText, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { BookCover } from '@/components/book-cover';
import { HealthBanner } from '@/components/health-banner';
import { PageHeader } from '@/components/page-header';
import { FormSection, LookPreview, SettingsForm, validateSettings } from '@/components/settings-form';
import { isPdfFile, UploadDropzone } from '@/components/upload-dropzone';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useApi } from '@/hooks/use-api';
import { ApiError, api, toApiError, type UploadHandle, uploadProject } from '@/lib/api';
import { estimateNarrationSec, formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { cloneSettings, diffSettings, isEmptyPatch, settingsForUpload } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { ENGINE_LABELS } from '@/lib/voices';

type Upload =
  | { state: 'idle' }
  | { state: 'uploading'; file: File; progress: number }
  | { state: 'done'; file: File; project: ProjectDetail }
  | { state: 'error'; file: File; error: ApiError };

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-0.5 rounded-xl bg-muted/60 px-3 py-2.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-[17px] leading-tight font-semibold tracking-tight tabular">{value}</span>
    </div>
  );
}

function FileCard({ upload, speed, onReset }: { upload: Exclude<Upload, { state: 'idle' }>; speed: number; onReset: () => void }) {
  const f = upload.file;
  const doc = upload.state === 'done' ? upload.project.document : undefined;
  const inspecting = upload.state === 'uploading' && upload.progress >= 1;
  return (
    <div className="grid gap-5">
      <div className="flex items-start gap-4">
        <BookCover projectId={upload.state === 'done' ? upload.project.id : undefined} title={doc?.title || f.name.replace(/\.pdf$/i, '')} className="w-16" />
        <div className="grid min-w-0 flex-1 gap-1 pt-0.5">
          <p className="truncate font-serif text-lg leading-snug font-medium" title={doc?.title || f.name}>
            {doc?.title || f.name}
          </p>
          <p className="truncate text-sm text-muted-foreground tabular">
            {doc?.author ? `${doc.author} · ` : ''}
            {doc?.title ? `${f.name} · ` : ''}
            {formatBytes(f.size)}
          </p>
          {upload.state === 'uploading' && (
            <div className="mt-2 grid gap-1.5">
              <Progress value={upload.progress * 100} live={inspecting} className="h-1.5" />
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                {inspecting ? 'Inspecting PDF — counting pages and words…' : `Uploading… ${Math.round(upload.progress * 100)}%`}
              </p>
            </div>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onReset} disabled={upload.state === 'uploading'} className="shrink-0 text-muted-foreground">
          <X aria-hidden /> <span className="hidden sm:inline">Replace</span>
        </Button>
      </div>

      {upload.state === 'error' && <ApiErrorAlert error={upload.error} title="Upload failed" onRetry={onReset} retryLabel="Choose another file" />}

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

export function NewProject() {
  const router = useRouter();
  const config = useApi('config', (signal) => api.config(signal));
  // New books pause for a chapter review by default: a wrong chapter list is cheap to fix before narration.
  const withReview = (s: ProjectSettings) => ({ ...s, text: { ...s.text, reviewChapters: true } });
  const [settings, setSettings] = useState<ProjectSettings>(() => withReview(cloneSettings(DEFAULT_SETTINGS)));
  const touched = useRef(false);
  const [upload, setUpload] = useState<Upload>({ state: 'idle' });
  const handle = useRef<UploadHandle | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ApiError>();
  const [localError, setLocalError] = useState<string>();

  // Server defaults (engine/voice come from the API's .env) — unless the user already changed something.
  useEffect(() => {
    if (config.data && !touched.current) setSettings(withReview(cloneSettings(config.data.defaults)));
  }, [config.data]);

  useEffect(() => () => handle.current?.abort(), []);

  const maxMb = config.data?.maxUploadMb;

  const onFile = (file: File) => {
    setLocalError(undefined);
    setStartError(undefined);
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
    setUpload({ state: 'uploading', file, progress: 0 });
    const h = uploadProject(file, {
      settings: settingsForUpload(settings),
      onProgress: (p) => setUpload((u) => (u.state === 'uploading' && u.file === file ? { ...u, progress: p } : u)),
    });
    handle.current = h;
    h.promise
      .then((project) => setUpload({ state: 'done', file, project }))
      .catch((err) => {
        if ((err as ApiError)?.code === 'ABORTED') return;
        setUpload({ state: 'error', file, error: toApiError(err) });
      })
      .finally(() => {
        if (handle.current === h) handle.current = null;
      });
  };

  const reset = () => {
    handle.current?.abort();
    // The project was created by the upload but never started — remove it (the PDF is kept if other projects use it).
    if (upload.state === 'done') void api.deleteProject(upload.project.id, false).catch(() => undefined);
    setUpload({ state: 'idle' });
    setStartError(undefined);
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
      ? 'Upload a PDF to continue.'
      : upload.state === 'uploading'
        ? 'Uploading… you can keep configuring meanwhile.'
        : upload.state === 'error'
          ? 'Fix the upload problem to continue.'
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
        description="Upload a PDF, choose a voice and a look, then start. Processing runs in the background — you can close this tab."
      />

      <HealthBanner />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px] xl:gap-8">
        <div className="grid min-w-0 gap-6">
          <FormSection step={1} title="Upload your PDF" description="Your PDF stays on this Mac. The same file is only stored once.">
            {upload.state === 'idle' ? <UploadDropzone onFile={onFile} maxMb={maxMb} /> : <FileCard upload={upload} speed={settings.tts.speed} onReset={reset} />}
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
              <SummaryRow label="Book">{doc?.title || (upload.state !== 'idle' ? upload.file.name : <span className="font-normal text-muted-foreground">No file yet</span>)}</SummaryRow>
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
