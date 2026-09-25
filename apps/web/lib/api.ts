import type {
  HealthReport,
  OutputFile,
  ProgressSnapshot,
  ProjectDetail,
  ProjectSettings,
  ProjectSummary,
  StepRecord,
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

export interface SystemConfig {
  defaults: ProjectSettings;
  engines: TTSEngineName[];
  defaultVoices: Partial<Record<TTSEngineName, string>>;
  llm: { enabled: boolean; model: string };
  maxUploadMb: number;
}

export const api = {
  listProjects: (signal?: AbortSignal) => request<ProjectSummary[]>('/projects', { signal }),
  project: (id: string, signal?: AbortSignal) => request<ProjectDetail>(`/projects/${encodeURIComponent(id)}`, { signal }),
  status: (id: string) => request<ProgressSnapshot>(`/projects/${encodeURIComponent(id)}/status`),
  steps: (id: string) => request<StepRecord[]>(`/projects/${encodeURIComponent(id)}/steps`),
  outputs: (id: string) => request<OutputFile[]>(`/projects/${encodeURIComponent(id)}/output`),
  timeline: (id: string, signal?: AbortSignal) => request<Timeline>(`/projects/${encodeURIComponent(id)}/timeline`, { signal }),
  updateSettings: (id: string, patch: SettingsPatch) => request<ProjectDetail>(`/projects/${encodeURIComponent(id)}/settings`, json('PATCH', patch)),
  process: (id: string) => request<{ jobId: string }>(`/projects/${encodeURIComponent(id)}/process`, { method: 'POST' }),
  retry: (id: string) => request<{ jobId: string }>(`/projects/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  restart: (id: string) => request<{ jobId: string }>(`/projects/${encodeURIComponent(id)}/restart`, { method: 'POST' }),
  cancel: (id: string) => request<{ ok: boolean }>(`/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  cleanCache: (id: string) => request<{ freedBytes: number }>(`/projects/${encodeURIComponent(id)}/cache`, { method: 'DELETE' }),
  deleteProject: (id: string, deleteOutputs: boolean) =>
    request<{ ok: boolean; outputsKept: boolean }>(`/projects/${encodeURIComponent(id)}?deleteOutputs=${deleteOutputs ? 'true' : 'false'}`, { method: 'DELETE' }),
  health: (fresh = false, signal?: AbortSignal) => request<HealthReport>(`/system/health${fresh ? '?fresh=1' : ''}`, { signal }),
  voices: (engine: string, signal?: AbortSignal) => request<VoicesResponse>(`/system/voices?engine=${encodeURIComponent(engine)}`, { signal }),
  config: (signal?: AbortSignal) => request<SystemConfig>('/system/config', { signal }),
};

/** Absolute URL of an API path, e.g. an OutputFile.url. */
export const apiUrl = (path: string) => `${API_URL}${path.startsWith('/') ? path : `/${path}`}`;

export const outputUrl = (id: string, name: string, opts: { inline?: boolean; v?: string | number } = {}) => {
  const q = new URLSearchParams();
  if (opts.inline) q.set('inline', '1');
  if (opts.v !== undefined) q.set('v', String(opts.v));
  const qs = q.toString();
  return `${API_URL}/projects/${encodeURIComponent(id)}/output/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`;
};

export const pageImageUrl = (id: string, page: number) => `${API_URL}/projects/${encodeURIComponent(id)}/pages/${page}/image`;

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
