export type DkryptRoute =
  | "GET /v1/artifacts"
  | "GET /v1/artifacts/{id}"
  | "GET /v1/artifacts/{id}/file"
  | "GET /v1/decrypt"
  | "GET /v1/jobs/{id}"
  | "GET /v1/jobs/{id}/events"
  | "GET /v1/jobs/{id}/wait"
  | "POST /v1/decrypts"
  | "POST /v1/jobs/status"
  | "POST /v1/testflight/decrypt";

export interface DkryptClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
}

export interface DkryptRequestInit extends RequestInit {
  path: string;
}

export interface DkryptJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress?: string;
  error?: string;
  artifactId?: string;
}

export interface DkryptDecryptOptions {
  version?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface DkryptArtifactPage {
  artifacts: DkryptArtifact[];
  nextCursor?: string;
}

export interface DkryptArtifact {
  id: string;
  bundleId: string;
  versionLabel?: string;
  fileSizeBytes?: number;
  [key: string]: unknown;
}

export interface DkryptJobEventSnapshot {
  job: DkryptJob;
  events: Array<{ at: number; label: string; status: DkryptJob['status']; durationMs?: number }>;
}

export class DkryptClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryOptions: Required<NonNullable<DkryptClientOptions['retry']>>;

  constructor(baseUrl: string, options?: DkryptClientOptions);
  constructor(baseUrl: string, fetchImpl?: typeof fetch);
  constructor(baseUrl: string, optionsOrFetch: DkryptClientOptions | typeof fetch = {}) {
    const options = typeof optionsOrFetch === 'function' ? { fetchImpl: optionsOrFetch } : optionsOrFetch;
    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryOptions = {
      maxAttempts: Math.max(1, Math.min(5, Math.floor(options.retry?.maxAttempts ?? 3))),
      baseDelayMs: Math.max(0, Math.min(30_000, Math.floor(options.retry?.baseDelayMs ?? 250))),
      maxDelayMs: Math.max(0, Math.min(30_000, Math.floor(options.retry?.maxDelayMs ?? 30_000))),
    };
  }

  async request<T>(init: DkryptRequestInit): Promise<T> {
    const { path, ...request } = init;
    const response = await this.fetchWithRetry(this.buildUrl(path), {
      ...request,
      headers: this.createHeaders(request.headers, 'application/json'),
    }, this.canRetry(request));
    if (!response.ok) throw new Error(await this.responseError(response));
    return await response.json() as T;
  }

  async download(path: string, init: Pick<RequestInit, 'headers' | 'signal'> = {}): Promise<ArrayBuffer> {
    const response = await this.fetchWithRetry(this.buildUrl(path), {
      ...init,
      method: 'GET',
      headers: this.createHeaders(init.headers, 'application/octet-stream'),
    }, true);
    if (!response.ok) throw new Error(await this.responseError(response));
    return response.arrayBuffer();
  }

  async decrypt(bundleId: string, options: DkryptDecryptOptions = {}): Promise<DkryptJob> {
    const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
    const { version, signal } = options;
    return this.request<DkryptJob>({
      path: '/v1/decrypts',
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ bundleId, ...(version ? { version } : {}) }),
      signal,
    });
  }

  getJob(id: string, signal?: AbortSignal): Promise<DkryptJob> {
    return this.request<DkryptJob>({ path: `/v1/jobs/${encodeURIComponent(id)}`, signal });
  }

  waitForJob(id: string, timeoutSeconds = 25, signal?: AbortSignal): Promise<DkryptJob> {
    const timeout = Math.max(1, Math.min(25, Math.floor(timeoutSeconds)));
    return this.request<DkryptJob>({ path: `/v1/jobs/${encodeURIComponent(id)}/wait?timeoutSeconds=${timeout}`, signal });
  }

  async *streamJobEvents(id: string, signal?: AbortSignal): AsyncGenerator<DkryptJobEventSnapshot> {
    let lastEventId: string | undefined;
    let reconnectDelayMs = 250;
    while (!signal?.aborted) {
      const headers = this.createHeaders(undefined, 'text/event-stream');
      if (lastEventId) headers.set('Last-Event-ID', lastEventId);
      let response: Response;
      try {
        response = await this.fetchWithRetry(this.buildUrl(`/v1/jobs/${encodeURIComponent(id)}/events`), {
          method: 'GET',
          headers,
          signal,
        }, true);
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return;
        await abortableDelay(reconnectDelayMs, signal ?? undefined);
        continue;
      }
      if (!response.ok) throw new Error(await this.responseError(response));
      if (!response.body) throw new Error('dkrypt job event stream has no response body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!signal?.aborted) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch {
            if (signal?.aborted) return;
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, '\n');
          let separator = buffer.indexOf('\n\n');
          while (separator >= 0) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const parsed = parseSseBlock(block);
            if (parsed?.retryMs !== undefined) reconnectDelayMs = parsed.retryMs;
            if (parsed?.event === 'snapshot' && parsed.data) {
              const snapshot = JSON.parse(parsed.data) as DkryptJobEventSnapshot;
              if (parsed.id) lastEventId = parsed.id;
              yield snapshot;
              if (snapshot.job.status === 'done' || snapshot.job.status === 'failed') return;
            }
            separator = buffer.indexOf('\n\n');
          }
          if (chunk.done) break;
        }
      } finally {
        if (signal?.aborted) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (signal?.aborted) return;
      await abortableDelay(reconnectDelayMs, signal ?? undefined);
    }
  }

  async *followJob(id: string, signal?: AbortSignal): AsyncGenerator<DkryptJob> {
    for await (const update of this.streamJobEvents(id, signal)) yield update.job;
  }

  listArtifacts(options: { q?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {}): Promise<DkryptArtifactPage> {
    const params = new URLSearchParams();
    if (options.q) params.set('q', options.q);
    params.set('limit', String(Math.max(1, Math.min(100, Math.floor(options.limit ?? 100)))));
    if (options.cursor) params.set('cursor', options.cursor);
    return this.request<DkryptArtifactPage>({ path: `/v1/artifacts?${params}`, signal: options.signal });
  }

  async *iterateArtifacts(options: { q?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {}): AsyncGenerator<DkryptArtifact> {
    let cursor = options.cursor;
    const seenCursors = new Set<string>();
    while (true) {
      const page = await this.listArtifacts({ ...options, cursor });
      yield* page.artifacts;
      if (!page.nextCursor) return;
      if (seenCursors.has(page.nextCursor)) throw new Error('dkrypt artifact pagination returned a repeated cursor');
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  async listAllArtifacts(options: { q?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {}): Promise<DkryptArtifact[]> {
    const artifacts: DkryptArtifact[] = [];
    for await (const artifact of this.iterateArtifacts(options)) artifacts.push(artifact);
    return artifacts;
  }

  downloadArtifact(id: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.download(`/v1/artifacts/${encodeURIComponent(id)}/file`, { signal });
  }

  private createHeaders(headers: RequestInit['headers'] | undefined, accept: string): Headers {
    const result = new Headers(headers);
    if (this.apiKey && !result.has('authorization')) result.set('Authorization', `Bearer ${this.apiKey}`);
    if (!result.has('accept')) result.set('Accept', accept);
    return result;
  }

  private canRetry(request: RequestInit): boolean {
    const method = (request.method ?? 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
    return new Headers(request.headers).has('Idempotency-Key');
  }

  private async fetchWithRetry(url: URL, request: RequestInit, retryable: boolean): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, request);
      } catch (error) {
        if (!retryable || attempt + 1 >= this.retryOptions.maxAttempts || request.signal?.aborted || isAbortError(error)) throw error;
        await abortableDelay(this.retryDelay(attempt), request.signal ?? undefined);
        continue;
      }
      if (!retryable || attempt + 1 >= this.retryOptions.maxAttempts || ![429, 502, 503, 504].includes(response.status)) return response;
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      await response.body?.cancel().catch(() => {});
      await abortableDelay(retryAfter ?? this.retryDelay(attempt), request.signal ?? undefined);
    }
  }

  private retryDelay(attempt: number): number {
    return Math.min(this.retryOptions.maxDelayMs, this.retryOptions.baseDelayMs * 2 ** attempt);
  }

  private buildUrl(path: string): URL {
    const baseUrl = new URL(this.baseUrl);
    const url = new URL(path, baseUrl);
    const allowsHttp = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname.toLowerCase());
    if (!['http:', 'https:'].includes(baseUrl.protocol) || !['http:', 'https:'].includes(url.protocol) || ((baseUrl.protocol === 'http:' || url.protocol === 'http:') && !allowsHttp)) {
      throw new Error('Use an HTTPS dkrypt URL; HTTP is allowed only for localhost');
    }
    if (url.origin !== baseUrl.origin) throw new Error('dkrypt requests must use the configured origin');
    return url;
  }

  private async responseError(response: Response): Promise<string> {
    const body: unknown = await response.json().catch(() => undefined);
    let detail: string | undefined;
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const errorBody = body as Record<string, unknown>;
      if (typeof errorBody.message === 'string') detail = errorBody.message;
      else if (typeof errorBody.error === 'string') detail = errorBody.error;
    }
    return detail ?? `dkrypt request failed with HTTP ${response.status}`;
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && (error as { name?: unknown }).name === 'AbortError';
}

function parseSseBlock(block: string): { id?: string; event?: string; data?: string; retryMs?: number } | undefined {
  let id: string | undefined;
  let event: string | undefined;
  let retryMs: number | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'id' && !value.includes('\0')) id = value;
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
    if (field === 'retry' && /^\d+$/.test(value)) retryMs = Math.min(30_000, Number(value));
  }
  return data.length > 0 || retryMs !== undefined ? { id, event, data: data.length ? data.join('\n') : undefined, retryMs } : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(30_000, Math.max(0, timestamp - Date.now())) : undefined;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
