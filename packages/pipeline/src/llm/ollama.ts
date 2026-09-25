import { AppError } from '@app/shared';
import type { LLMProvider, LLMRequest } from './provider';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly model: string;
  private availability?: Promise<{ ok: boolean; message: string }>;

  constructor(private readonly opts: OllamaOptions) {
    this.model = opts.model;
  }

  isAvailable(): Promise<{ ok: boolean; message: string }> {
    this.availability ??= (async () => {
      try {
        const res = await fetch(`${this.opts.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { ok: false, message: `Ollama responded with HTTP ${res.status}` };
        const body = (await res.json()) as { models?: { name: string; model?: string }[] };
        const names = (body.models ?? []).flatMap((m) => [m.name, m.model ?? '']);
        const want = this.model.includes(':') ? this.model : `${this.model}:latest`;
        if (!names.includes(want) && !names.includes(this.model))
          return { ok: false, message: `Model "${this.model}" is not installed. Run: ollama pull ${this.model}` };
        return { ok: true, message: 'ready' };
      } catch {
        return { ok: false, message: `Ollama is not reachable at ${this.opts.baseUrl}. Start it with: ollama serve` };
      }
    })();
    return this.availability;
  }

  async generateJson<T>(req: LLMRequest, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const res = await fetch(`${this.opts.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        format: req.schema,
        keep_alive: '10m',
        options: { temperature: 0, num_ctx: 8192, num_predict: req.maxTokens ?? 2048 },
        messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }],
      }),
    }).catch((e) => {
      throw new AppError('OLLAMA_UNAVAILABLE', 'The local AI model service (Ollama) is not reachable.', {
        hint: 'Start it with: ollama serve',
        cause: e,
      });
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AppError('LLM_FAILED', 'The local AI model returned an error.', { details: { status: res.status, text: text.slice(0, 500) } });
    }
    const body = (await res.json()) as { message?: { content?: string } };
    const content = body.message?.content ?? '';
    try {
      return JSON.parse(content) as T;
    } catch (e) {
      throw new AppError('LLM_BAD_OUTPUT', 'The local AI model returned an unreadable answer.', { details: content.slice(0, 500), cause: e });
    }
  }
}
