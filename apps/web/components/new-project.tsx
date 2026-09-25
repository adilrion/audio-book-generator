'use client';

import { DEFAULT_SETTINGS, type ProjectDetail, type ProjectSettings } from '@app/types';
import { ArrowLeft, BookOpen, CircleCheck, FileText, ListTree, LoaderCircle, Play, ScanText, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { HealthBanner } from '@/components/health-banner';
import { SettingsForm, validateSettings } from '@/components/settings-form';
import { isPdfFile, UploadDropzone } from '@/components/upload-dropzone';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useApi } from '@/hooks/use-api';
import { ApiError, api, toApiError, type UploadHandle, uploadProject } from '@/lib/api';
import { estimateNarrationSec, formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { cloneSettings, diffSettings, isEmptyPatch } from '@/lib/settings';

type Upload =
  | { state: 'idle' }
  | { state: 'uploading'; file: File; progress: number }
  | { state: 'done'; file: File; project: ProjectDetail }
  | { state: 'error'; file: File; error: ApiError };

function Stat({ label, value, icon }: { label: string; value: ReactNode; icon: ReactNode }) {
  return (
    <div className="grid gap-1 rounded-lg border bg-muted/30 px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </span>
      <span className="text-lg font-semibold tracking-tight tabular">{value}</span>
    </div>
  );
}

function FileCard({ upload, speed, onReset }: { upload: Exclude<Upload, { state: 'idle' }>; speed: number; onReset: () => void }) {
  const f = upload.file;
  const doc = upload.state === 'done' ? upload.project.document : undefined;
  const inspecting = upload.state === 'uploading' && upload.progress >= 1;
  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <FileText className="size-5" aria-hidden />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="truncate font-medium" title={f.name}>
            {f.name}
          </p>
          <p className="text-sm text-muted-foreground tabular">
            {formatBytes(f.size)}
            {doc?.title && (
              <>
                {' · '}“{doc.title}”{doc.author ? ` by ${doc.author}` : ''}
              </>
            )}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onReset} disabled={upload.state === 'uploading'} className="shrink-0 text-muted-foreground">
          <X aria-hidden /> <span className="hidden sm:inline">Choose another file</span>
        </Button>
      </div>

      {upload.state === 'uploading' && (
        <div className="grid gap-1.5">
          <Progress value={upload.progress * 100} />
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            {inspecting ? 'Inspecting PDF — counting pages and words…' : `Uploading… ${Math.round(upload.progress * 100)}%`}
          </p>
        </div>
      )}

      {upload.state === 'error' && <ApiErrorAlert error={upload.error} title="Upload failed" onRetry={onReset} retryLabel="Choose another file" />}

      {doc && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Pages" value={formatNumber(doc.pageCount)} icon={<BookOpen aria-hidden />} />
            <Stat label="Estimated words" value={`~${formatNumber(Math.round(doc.estimatedWords / 100) * 100 || doc.estimatedWords)}`} icon={<FileText aria-hidden />} />
            <Stat label="Narration (est.)" value={`~${formatDuration(estimateNarrationSec(doc.estimatedWords, speed))}`} icon={<Play aria-hidden />} />
            <Stat label="File size" value={formatBytes(doc.fileSize)} icon={<FileText aria-hidden />} />
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

export function NewProject() {
  const router = useRouter();
  const config = useApi('config', (signal) => api.config(signal));
  const [settings, setSettings] = useState<ProjectSettings>(() => cloneSettings(DEFAULT_SETTINGS));
  const touched = useRef(false);
  const [upload, setUpload] = useState<Upload>({ state: 'idle' });
  const handle = useRef<UploadHandle | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ApiError>();
  const [localError, setLocalError] = useState<string>();

  // Server defaults (engine/voice come from the API's .env) — unless the user already changed something.
  useEffect(() => {
    if (config.data && !touched.current) setSettings(cloneSettings(config.data.defaults));
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
      settings,
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

  return (
    <div className="grid gap-6 pb-4">
      <div className="grid gap-3">
        <Link href="/" className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden /> Projects
        </Link>
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">New audiobook</h1>
          <p className="text-sm text-muted-foreground">Upload a PDF, choose a voice and a look, then start. Processing runs in the background — you can close this tab.</p>
        </div>
      </div>

      <HealthBanner hideWhenHealthy />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="grid size-6 place-items-center rounded-full bg-primary text-xs text-primary-foreground">1</span> Upload
          </CardTitle>
          <CardDescription>Your PDF stays on this Mac. The same file is only stored once.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {upload.state === 'idle' ? <UploadDropzone onFile={onFile} maxMb={maxMb} /> : <FileCard upload={upload} speed={settings.tts.speed} onReset={reset} />}
          {localError && (
            <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert">
              <TriangleAlert className="size-4 shrink-0" aria-hidden /> {localError}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="grid size-6 place-items-center rounded-full bg-primary text-xs text-primary-foreground">2</span> Configure
          </CardTitle>
          <CardDescription>Sensible defaults are pre-selected. Everything can be changed later.</CardDescription>
        </CardHeader>
        <CardContent>
          {config.error && !config.data && <ApiErrorAlert error={config.error} className="mb-6" onRetry={() => void config.refresh()} />}
          <SettingsForm
            value={settings}
            onChange={(s) => {
              touched.current = true;
              setSettings(s);
            }}
            config={config.data}
            disabled={starting}
            document={upload.state === 'done' ? upload.project.document : undefined}
          />
        </CardContent>
      </Card>

      {startError && <ApiErrorAlert error={startError} title="Could not start processing" />}

      <div className="sticky bottom-3 z-30">
        <div className="flex flex-col gap-3 rounded-xl border bg-card/90 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/75 sm:flex-row sm:items-center sm:justify-between sm:pl-5">
          <p className="text-sm text-muted-foreground">
            {upload.state === 'idle'
              ? 'Upload a PDF to continue.'
              : upload.state === 'uploading'
                ? 'Uploading… you can keep configuring meanwhile.'
                : upload.state === 'error'
                  ? 'Fix the upload problem to continue.'
                  : invalid
                    ? invalid
                    : 'Ready. Later changes only recompute the stages they affect.'}
          </p>
          <Button size="lg" onClick={() => void start()} disabled={!canStart} className="shrink-0">
            {starting ? <LoaderCircle className="animate-spin" aria-hidden /> : <Play aria-hidden />}
            {starting ? 'Starting…' : 'Start'}
          </Button>
        </div>
      </div>
    </div>
  );
}
