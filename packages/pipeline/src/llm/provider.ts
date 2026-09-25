/**
 * LLM abstraction. The pipeline only ever asks for small, structured JSON answers —
 * it never sends the whole book and never lets the model rewrite the author's text.
 */
export interface LLMRequest {
  system?: string;
  prompt: string;
  /** JSON schema the answer must satisfy (Ollama structured outputs). */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  isAvailable(): Promise<{ ok: boolean; message: string }>;
  generateJson<T>(req: LLMRequest, signal?: AbortSignal): Promise<T>;
}
