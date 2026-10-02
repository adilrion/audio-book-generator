import type {
  ChapterEdit,
  ChapterSummary,
  HealthReport,
  LanguageCode,
  PerformancePrefs,
  PerformanceStatus,
  OutputFile,
  ProgressSnapshot,
  ProjectDetail,
  ProjectSettings,
  ProjectSummary,
  GeneratePublishRequest,
  GeneratePublishResult,
  ImportEvent,
  LibraryBookDetail,
  LibraryLanguage,
  LibrarySearchResult,
  PublishDraft,
  PublishState,
  ShortDetail,
  ShortMetadataRequest,
  ShortMetadataResult,
  ShortScriptRequest,
  ShortScriptResult,
  ShortSettings,
  ShortSummary,
  ShortThumbnail,
  StepRecord,
  TextRepair,
  Timeline,
  TTSEngineName,
  VoiceInfo,
} from '@app/types';
import type { SettingsPatch } from './settings';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/+$/, '');

export const API_UNREACHABLE_MESSAGE = 'Cannot reach the local API — start it with pnpm dev';

/** Error shape returned by the API: { error: { code, message, hint?, retryable, stepKey?, chapterIndex? } }. */
export interface ApiErrorBody {
  code: string;
  message: string;
  hint?: string;
  retryable?: boolean;
  stepKey?: string;
  chapterIndex?: number;
}

export class ApiError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly stepKey?: string;
  readonly chapterIndex?: number;

  constructor(body: ApiErrorBody, status = 0) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.hint = body.hint;
    this.retryable = body.retryable ?? false;
    this.status = status;
    this.stepKey = body.stepKey;
    this.chapterIndex = body.chapterIndex;
  }

  get unreachable() {
    return this.code === 'API_UNREACHABLE';
  }
}

export const unreachableError = () =>
  new ApiError({ code: 'API_UNREACHABLE', message: API_UNREACHABLE_MESSAGE, hint: `The web app expects the API at ${API_URL}.`, retryable: true });

const FALLBACK_MESSAGES: Record<number, string> = {
  400: 'The request was not accepted.',
  404: 'That item could not be found.',
  409: 'That action is not possible right now.',
  413: 'The file is too large to upload.',
  422: 'This file could not be processed.',
  503: 'A local service the app depends on is not running.',
  507: 'There is not enough free disk space.',
};

/** Turn any failed response body into a friendly ApiError (never raw stacks). */
export function errorFromResponse(status: number, raw: string): ApiError {
  let body: Partial<ApiErrorBody> | undefined;
  try {
    const parsed = JSON.parse(raw) as { error?: Partial<ApiErrorBody> };
    body = parsed?.error;
  } catch {
    body = undefined;
  }
  const message =
    typeof body?.message === 'string' && body.message.trim()
      ? body.message
      : (FALLBACK_MESSAGES[status] ?? 'Something went wrong in the local API. Details are in the API logs.');
  return new ApiError(
    {
      code: body?.code ?? `HTTP_${status}`,
      message,
      hint: body?.hint,
      retryable: body?.retryable ?? status >= 500,
      stepKey: body?.stepKey,
      chapterIndex: body?.chapterIndex,
    },
    status,
  );
}

/** Normalise anything thrown into an ApiError with a user-facing message. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof TypeError) return unreachableError(); // fetch() network failure
  return new ApiError({ code: 'UNKNOWN', message: 'Something unexpected happened. Please try again.', retryable: true });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: 'no-store', ...init });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw unreachableError();
  }
  const text = await res.text();
  if (!res.ok) throw errorFromResponse(res.status, text);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError({ code: 'BAD_RESPONSE', message: 'The local API sent a response the app could not read.', retryable: true }, res.status);
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export interface VoicesResponse {
  engine: string;
  available: boolean;
  message: string;
  voices: VoiceInfo[];
}

export interface LanguageDefaults {
  engine: TTSEngineName;
  voices: Partial<Record<TTSEngineName, string>>;
  engines: TTSEngineName[];
}

export interface SystemConfig {
  defaults: ProjectSettings;
  engines: TTSEngineName[];
  defaultVoices: Partial<Record<TTSEngineName, string>>;
  /** Per project language: the starting engine, the recommended voice per engine and the engines that can read it. */
  languageDefaults?: Partial<Record<LanguageCode, LanguageDefaults>>;
  llm: { enabled: boolean; model: string };
  maxUploadMb: number;
}

export interface LibrarySearchParams {
  q?: string;
  language?: LibraryLanguage;
  /** Only books labelled public domain or CC BY / BY-SA (default true). */
  free?: boolean;
  page?: number;
}

/** Body of POST /shorts and PATCH /shorts/:id. */
export interface ShortInput {
  title?: string;
  script?: string;
  description?: string;
  hashtags?: string[];
  tags?: string[];
  thumbnail?: ShortThumbnail | null;
  settings?: Partial<Omit<ShortSettings, 'look'>> & { look?: Partial<ShortSettings['look']> };
  projectId?: string | null;
  /** Start rendering right away. */
  render?: boolean;
}

export const api = {
  listProjects: (signal?: AbortSignal) => request<ProjectSummary[]>('/projects', { signal }),
  project: (id: string, signal?: AbortSignal) => request<ProjectDetail>(`/projects/${encodeURIComponent(id)}`, { signal }),
  status: (id: string) => request<ProgressSnapshot>(`/projects/${encodeURIComponent(id)}/status`),
  steps: (id: string) => request<StepRecord[]>(`/projects/${encodeURIComponent(id)}/steps`),
  outputs: (id: string) => request<OutputFile[]>(`/projects/${encodeURIComponent(id)}/output`),
  timeline: (id: string, signal?: AbortSignal) => request<Timeline>(`/projects/${encodeURIComponent(id)}/timeline`, { signal }),
  repairs: (id: string, signal?: AbortSignal) => request<TextRepair[]>(`/projects/${encodeURIComponent(id)}/repairs`, { signal }),
  updateSettings: (id: string, patch: SettingsPatch) => request<ProjectDetail>(`/projects/${encodeURIComponent(id)}/settings`, json('PATCH', patch)),
  process: (id: string) => request<{ jobId: string }>(`/projects/${encodeURIComponent(id)}/process`, { method: 'POST' }),
  retry: (id: string) => request<{ jobId: string }>(`/projects/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  restart: (id: string) => request<{ jobId: string }>(`/projects/${encodeURIComponent(id)}/restart`, { method: 'POST' }),
  chapters: (id: string, signal?: AbortSignal) => request<ChapterSummary[]>(`/projects/${encodeURIComponent(id)}/chapters`, { signal }),
  reviewChapters: (id: string, body: { items: ChapterEdit[]; start?: boolean }) =>
    request<{ jobId?: string }>(`/projects/${encodeURIComponent(id)}/chapters/review`, json('POST', body)),
  cancel: (id: string) => request<{ ok: boolean }>(`/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  cleanCache: (id: string) => request<{ freedBytes: number }>(`/projects/${encodeURIComponent(id)}/cache`, { method: 'DELETE' }),
  deleteProject: (id: string, deleteOutputs: boolean) =>
    request<{ ok: boolean; outputsKept: boolean }>(`/projects/${encodeURIComponent(id)}?deleteOutputs=${deleteOutputs ? 'true' : 'false'}`, { method: 'DELETE' }),
  publish: (id: string, signal?: AbortSignal) => request<PublishState>(`/projects/${encodeURIComponent(id)}/publish`, { signal }),
  /** `label` names the saved version in the history ("Edited", "AI · qwen3:4b", "Restored…"). */
  savePublish: (id: string, draft: PublishDraft, label?: string) => request<PublishState>(`/projects/${encodeURIComponent(id)}/publish`, json('PUT', { draft, label })),
  /** Local AI writing; can take a minute. Aborting the signal stops the model. Returns a proposal — nothing is saved. */
  generatePublish: (id: string, body: GeneratePublishRequest, signal?: AbortSignal) =>
    request<GeneratePublishResult>(`/projects/${encodeURIComponent(id)}/publish/generate`, { ...json('POST', body), signal }),
  applyPublish: (id: string) => request<PublishState>(`/projects/${encodeURIComponent(id)}/publish/apply`, { method: 'POST' }),
  uploadThumbnail: (id: string, jpeg: Blob) =>
    request<PublishState>(`/projects/${encodeURIComponent(id)}/publish/thumbnail`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg }),
  deleteThumbnail: (id: string) => request<PublishState>(`/projects/${encodeURIComponent(id)}/publish/thumbnail`, { method: 'DELETE' }),
  librarySearch: (p: LibrarySearchParams, signal?: AbortSignal) =>
    request<LibrarySearchResult>(`/library/search?${new URLSearchParams({ q: p.q ?? '', language: p.language ?? 'any', free: String(p.free ?? true), page: String(p.page ?? 1) })}`, { signal }),
  libraryBook: (id: string, signal?: AbortSignal) => request<LibraryBookDetail>(`/library/archive/${encodeURIComponent(id)}`, { signal }),
  shorts: (signal?: AbortSignal) => request<ShortSummary[]>('/shorts', { signal }),
  short: (id: string, signal?: AbortSignal) => request<ShortDetail>(`/shorts/${encodeURIComponent(id)}`, { signal }),
  shortDefaults: (signal?: AbortSignal) => request<ShortSettings>('/shorts/defaults', { signal }),
  createShort: (body: ShortInput) => request<ShortDetail>('/shorts', json('POST', body)),
  updateShort: (id: string, body: ShortInput) => request<ShortDetail>(`/shorts/${encodeURIComponent(id)}`, json('PATCH', body)),
  renderShort: (id: string) => request<{ jobId: string }>(`/shorts/${encodeURIComponent(id)}/render`, { method: 'POST' }),
  cancelShort: (id: string) => request<{ ok: boolean }>(`/shorts/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  deleteShort: (id: string) => request<{ ok: boolean }>(`/shorts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Local AI writes a script (20–60 s). Aborting the signal stops the model. Nothing is saved. */
  generateShortScript: (body: ShortScriptRequest, signal?: AbortSignal) => request<ShortScriptResult>('/shorts/script', { ...json('POST', body), signal }),
  /** Local AI writes the YouTube description, hashtags and tags for a script. Nothing is saved. */
  generateShortMetadata: (body: ShortMetadataRequest, signal?: AbortSignal) => request<ShortMetadataResult>('/shorts/metadata', { ...json('POST', body), signal }),
  uploadShortThumbnail: (id: string, jpeg: Blob) =>
    request<ShortDetail>(`/shorts/${encodeURIComponent(id)}/thumbnail`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg }),
  deleteShortThumbnail: (id: string) => request<ShortDetail>(`/shorts/${encodeURIComponent(id)}/thumbnail`, { method: 'DELETE' }),
  health: (fresh = false, signal?: AbortSignal) => request<HealthReport>(`/system/health${fresh ? '?fresh=1' : ''}`, { signal }),
  voices: (engine: string, signal?: AbortSignal) => request<VoicesResponse>(`/system/voices?engine=${encodeURIComponent(engine)}`, { signal }),
  config: (signal?: AbortSignal) => request<SystemConfig>('/system/config', { signal }),
  performance: (signal?: AbortSignal) => request<PerformanceStatus>('/system/performance', { signal }),
  setPerformance: (patch: Partial<PerformancePrefs>) => request<PerformanceStatus>('/system/performance', json('PUT', patch)),
};

/** Absolute URL of an API path, e.g. an OutputFile.url. */
export const apiUrl = (path: string) => `${API_URL}${path.startsWith('/') ? path : `/${path}`}`;

/** `as` downloads the file under another name (e.g. a descriptive name for the YouTube upload). */
export const outputUrl = (id: string, name: string, opts: { inline?: boolean; v?: string | number; as?: string } = {}) => {
  const q = new URLSearchParams();
  if (opts.inline) q.set('inline', '1');
  if (opts.as) q.set('as', opts.as);
  if (opts.v !== undefined) q.set('v', String(opts.v));
  const qs = q.toString();
  return `${API_URL}/projects/${encodeURIComponent(id)}/output/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`;
};

/** A short's video or subtitles; `v` busts the browser cache after a re-render. */
export const shortOutputUrl = (id: string, name: string, opts: { inline?: boolean; v?: string; as?: string } = {}) => {
  const q = new URLSearchParams();
  if (opts.inline) q.set('inline', '1');
  if (opts.as) q.set('as', opts.as);
  if (opts.v) q.set('v', opts.v);
  const qs = q.toString();
  return `${API_URL}/shorts/${encodeURIComponent(id)}/output/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`;
};

export const pageImageUrl = (id: string, page: number) => `${API_URL}/projects/${encodeURIComponent(id)}/pages/${page}/image`;

/** A few seconds of a voice (WAV), read at the given speed; the sample is in the voice's own language. */
export const voicePreviewUrl = (engine: string, voice: string, speed: number, language: string) =>
  `${API_URL}/system/voices/preview?${new URLSearchParams({ engine, voice, speed: speed.toFixed(2), language })}`;

export interface UploadHandle {
  promise: Promise<ProjectDetail>;
  abort: () => void;
}

/**
 * POST /projects as multipart via XMLHttpRequest, so we get real upload progress
 * (fetch() has no upload progress events).
 */
export function uploadProject(file: File, opts: { settings?: Partial<ProjectSettings> | SettingsPatch; name?: string; onProgress?: (fraction: number) => void } = {}): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<ProjectDetail>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    if (opts.settings) form.append('settings', JSON.stringify(opts.settings));
    if (opts.name?.trim()) form.append('name', opts.name.trim());

    xhr.open('POST', `${API_URL}/projects`);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as ProjectDetail);
        } catch {
          reject(new ApiError({ code: 'BAD_RESPONSE', message: 'The local API sent a response the app could not read.', retryable: true }, xhr.status));
        }
      } else {
        reject(errorFromResponse(xhr.status, xhr.responseText));
      }
    };
    xhr.onerror = () => reject(unreachableError());
    xhr.onabort = () => reject(new ApiError({ code: 'ABORTED', message: 'Upload cancelled.', retryable: true }));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

/** A book from the online library (optionally one of its PDFs), or any link to a PDF. */
export type ImportSource = { source: 'archive'; id: string; file?: string } | { source: 'url'; url: string };
export type ImportProgress = Extract<ImportEvent, { type: 'progress' }>;

const badResponse = (status = 0) => new ApiError({ code: 'BAD_RESPONSE', message: 'The local API sent a response the app could not read.', retryable: true }, status);

/**
 * POST /projects/import: the API downloads the PDF and creates the project, like an upload.
 * Problems found before the download starts come back as a normal error response; after that,
 * progress arrives as NDJSON lines ending with `done` or `error`. abort() cancels the download.
 */
export function importProject(source: ImportSource, opts: { settings?: Partial<ProjectSettings> | SettingsPatch; name?: string; onProgress?: (p: ImportProgress) => void } = {}): UploadHandle {
  const ctrl = new AbortController();
  const cancelled = () => new ApiError({ code: 'ABORTED', message: 'Download cancelled.', retryable: true });
  const promise = (async (): Promise<ProjectDetail> => {
    let res: Response;
    try {
      res = await fetch(`${API_URL}/projects/import`, {
        ...json('POST', { ...source, settings: opts.settings, name: opts.name?.trim() || undefined }),
        cache: 'no-store',
        signal: ctrl.signal,
      });
    } catch {
      throw ctrl.signal.aborted ? cancelled() : unreachableError();
    }
    if (!res.ok) throw errorFromResponse(res.status, await res.text().catch(() => ''));
    if (!res.body) throw badResponse(res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        buf += decoder.decode(value, { stream: !done });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let event: ImportEvent;
          try {
            event = JSON.parse(line) as ImportEvent;
          } catch {
            throw badResponse(res.status);
          }
          if (event.type === 'progress') opts.onProgress?.(event);
          else if (event.type === 'done') return event.project;
          else if (event.type === 'error') throw new ApiError(event.error, res.status);
        }
        if (done) break;
      }
    } catch (err) {
      if (ctrl.signal.aborted) throw cancelled();
      if (err instanceof ApiError) throw err;
      throw unreachableError(); // the connection dropped mid-download
    }
    throw new ApiError({ code: 'BAD_RESPONSE', message: 'The download stopped before it finished.', retryable: true }, res.status);
  })();
  return { promise, abort: () => ctrl.abort() };
}
