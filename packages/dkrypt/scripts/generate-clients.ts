import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { preserveOpenApiPathOrder } from './openapiPathOrder.js';

const stateDir = mkdtempSync(path.join('/tmp', 'dkrypt-client-generation-'));
process.env.API_KEY ??= 'client-generation-api-key';
process.env.SESSION_SIGNING_SECRET ??= 'client-generation-session-secret';
process.env.ADMIN_PASSWORD ??= 'client-generation-admin-password';
process.env.STATE_DIR = stateDir;
process.env.OUTPUT_DIR = path.join(stateDir, 'tmp');
process.env.ARTIFACT_DIR = path.join(stateDir, 'artifacts');

const { buildServer } = await import('../src/server.ts');
const { createPublicOpenApiDocument } = await import('../src/publicApi.ts');
const server = await buildServer({ includePublicRoutes: false });
await server.ready();
const document = createPublicOpenApiDocument(server.swagger());
const openApiPath = path.resolve(process.cwd(), 'clients', 'openapi.json');
if (existsSync(openApiPath)) {
  const previousDocument = JSON.parse(readFileSync(openApiPath, 'utf8')) as { paths?: Record<string, Record<string, unknown>> };
  document.paths = preserveOpenApiPathOrder(previousDocument.paths ?? {}, document.paths ?? {});
}
const routes = Object.entries(document.paths ?? {}).flatMap(([route, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${route}`)).sort();
const outputDirectory = path.resolve(process.cwd(), 'clients');
mkdirSync(path.join(outputDirectory, 'typescript'), { recursive: true });
mkdirSync(path.join(outputDirectory, 'python'), { recursive: true });
writeFileSync(openApiPath, `${JSON.stringify(document, null, 2)}\n`);
writeFileSync(path.join(outputDirectory, 'typescript', 'dkrypt.ts'), renderTypeScript(routes));
writeFileSync(path.join(outputDirectory, 'python', 'dkrypt_client.py'), renderPython(routes));
await server.close();

function renderTypeScript(routes: string[]): string {
  const routeUnion = routes.map((route) => `  | ${JSON.stringify(route)}`).join('\n');
  return `export type DkryptRoute =
${routeUnion};

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
    return this.request<DkryptJob>({ path: \`/v1/jobs/\${encodeURIComponent(id)}\`, signal });
  }

  waitForJob(id: string, timeoutSeconds = 25, signal?: AbortSignal): Promise<DkryptJob> {
    const timeout = Math.max(1, Math.min(25, Math.floor(timeoutSeconds)));
    return this.request<DkryptJob>({ path: \`/v1/jobs/\${encodeURIComponent(id)}/wait?timeoutSeconds=\${timeout}\`, signal });
  }

  async *streamJobEvents(id: string, signal?: AbortSignal): AsyncGenerator<DkryptJobEventSnapshot> {
    let lastEventId: string | undefined;
    let reconnectDelayMs = 250;
    while (!signal?.aborted) {
      const headers = this.createHeaders(undefined, 'text/event-stream');
      if (lastEventId) headers.set('Last-Event-ID', lastEventId);
      let response: Response;
      try {
        response = await this.fetchWithRetry(this.buildUrl(\`/v1/jobs/\${encodeURIComponent(id)}/events\`), {
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
          buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\\r\\n/g, '\\n');
          let separator = buffer.indexOf('\\n\\n');
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
            separator = buffer.indexOf('\\n\\n');
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
    return this.request<DkryptArtifactPage>({ path: \`/v1/artifacts?\${params}\`, signal: options.signal });
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
    return this.download(\`/v1/artifacts/\${encodeURIComponent(id)}/file\`, { signal });
  }

  private createHeaders(headers: RequestInit['headers'] | undefined, accept: string): Headers {
    const result = new Headers(headers);
    if (this.apiKey && !result.has('authorization')) result.set('Authorization', \`Bearer \${this.apiKey}\`);
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
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== baseUrl.origin) {
      throw new Error('dkrypt requests must use the configured origin');
    }
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
    return detail ?? \`dkrypt request failed with HTTP \${response.status}\`;
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
  for (const line of block.split('\\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'id' && !value.includes('\\0')) id = value;
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
    if (field === 'retry' && /^\\d+$/.test(value)) retryMs = Math.min(30_000, Number(value));
  }
  return data.length > 0 || retryMs !== undefined ? { id, event, data: data.length ? data.join('\\n') : undefined, retryMs } : undefined;
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
`;
}

function renderPython(routes: string[]): string {
  const routeValues = routes.map((route) => `    ${JSON.stringify(route)},`).join('\n');
  return `from __future__ import annotations

import json
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.parse import SplitResult, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROUTES = (
${routeValues}
)

@dataclass
class DkryptClient:
    base_url: str
    api_key: str | None = None
    retry_attempts: int = 3
    retry_base_delay: float = 0.25
    retry_max_delay: float = 30.0

    def request(self, method: str, path: str, body: object | None = None) -> object:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        response = self._send(method, path, payload, "application/json")
        return json.loads(response.decode("utf-8"))

    def download(self, path: str) -> bytes:
        return self._send("GET", path, None, "application/octet-stream")

    def decrypt(self, bundle_id: str, version: str | None = None, idempotency_key: str | None = None) -> object:
        from uuid import uuid4
        headers = {"Idempotency-Key": idempotency_key or str(uuid4())}
        body = {"bundleId": bundle_id}
        if version:
            body["version"] = version
        payload = json.dumps(body).encode("utf-8")
        return json.loads(self._send("POST", "/v1/decrypts", payload, "application/json", headers).decode("utf-8"))

    def get_job(self, job_id: str) -> object:
        from urllib.parse import quote
        return self.request("GET", f"/v1/jobs/{quote(job_id, safe='')}")

    def wait_for_job(self, job_id: str, timeout_seconds: int = 25) -> object:
        from urllib.parse import quote
        from urllib.parse import urlencode
        timeout = max(1, min(25, int(timeout_seconds)))
        return self.request("GET", f"/v1/jobs/{quote(job_id, safe='')}/wait?{urlencode({'timeoutSeconds': timeout})}")

    def iter_job_events(self, job_id: str):
        from urllib.parse import quote
        last_event_id = None
        reconnect_delay_seconds = 0.25
        while True:
            headers = {"Accept": "text/event-stream"}
            if last_event_id:
                headers["Last-Event-ID"] = last_event_id
            url = self._build_url(f"/v1/jobs/{quote(job_id, safe='')}/events")
            attempts = max(1, min(5, int(self.retry_attempts)))
            for attempt in range(attempts):
                request = Request(url, headers=headers, method="GET")
                if self.api_key:
                    request.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
                try:
                    handler = DkryptRedirectHandler(self._origin(urlsplit(self.base_url)), self.api_key)
                    with build_opener(handler).open(request, timeout=35) as response:
                        current = {"event": "message", "id": None, "data": []}
                        for raw_line in response:
                            line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line
                            line = line.rstrip("\\r\\n")
                            if not line:
                                if current["event"] == "snapshot" and current["data"]:
                                    snapshot = json.loads("\\n".join(current["data"]))
                                    if current["id"]:
                                        last_event_id = current["id"]
                                    yield snapshot
                                    job = snapshot.get("job", {}) if isinstance(snapshot, dict) else {}
                                    if isinstance(job, dict) and job.get("status") in ("done", "failed"):
                                        return
                                current = {"event": "message", "id": None, "data": []}
                                continue
                            if line.startswith(":"):
                                continue
                            field, separator, value = line.partition(":")
                            if separator and value.startswith(" "):
                                value = value[1:]
                            if field == "event":
                                current["event"] = value
                            elif field == "id" and "\\0" not in value:
                                current["id"] = value
                            elif field == "data":
                                current["data"].append(value)
                            elif field == "retry" and value.isdecimal():
                                reconnect_delay_seconds = min(30.0, int(value) / 1000)
                    break
                except HTTPError as error:
                    if attempt + 1 < attempts and error.code in (429, 502, 503, 504):
                        delay = self._retry_after(error.headers.get("Retry-After"))
                        error.close()
                        sleep(self._retry_delay(attempt) if delay is None else delay)
                        continue
                    detail = error.read().decode("utf-8", errors="replace")
                    raise RuntimeError(f"dkrypt request failed with HTTP {error.code}: {detail}") from error
                except URLError:
                    if attempt + 1 >= attempts:
                        break
                    sleep(self._retry_delay(attempt))
            sleep(reconnect_delay_seconds)

    def follow_job(self, job_id: str):
        for snapshot in self.iter_job_events(job_id):
            if isinstance(snapshot, dict) and isinstance(snapshot.get("job"), dict):
                yield snapshot["job"]

    def list_artifacts(self, query: str | None = None, limit: int = 100, cursor: str | None = None) -> object:
        from urllib.parse import urlencode
        params = {"limit": max(1, min(100, int(limit)))}
        if query:
            params["q"] = query
        if cursor:
            params["cursor"] = cursor
        return self.request("GET", f"/v1/artifacts?{urlencode(params)}")

    def iter_artifacts(self, query: str | None = None, limit: int = 100, cursor: str | None = None):
        seen_cursors = set()
        while True:
            page = self.list_artifacts(query, limit, cursor)
            if not isinstance(page, dict):
                raise RuntimeError("dkrypt artifact page has an invalid response")
            yield from page.get("artifacts", [])
            next_cursor = page.get("nextCursor")
            if not next_cursor:
                return
            if next_cursor in seen_cursors:
                raise RuntimeError("dkrypt artifact pagination returned a repeated cursor")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

    def list_all_artifacts(self, query: str | None = None, limit: int = 100, cursor: str | None = None) -> list[object]:
        return list(self.iter_artifacts(query, limit, cursor))

    def download_artifact(self, artifact_id: str) -> bytes:
        from urllib.parse import quote
        return self.download(f"/v1/artifacts/{quote(artifact_id, safe='')}/file")

    def _send(self, method: str, path: str, payload: bytes | None, accept: str, extra_headers: dict[str, str] | None = None) -> bytes:
        headers = {"Accept": accept}
        headers.update(extra_headers or {})
        if payload is not None:
            headers["Content-Type"] = "application/json"
        url = self._build_url(path)
        normalized_method = method.upper()
        safe_to_retry = normalized_method in ("GET", "HEAD", "OPTIONS") or any(name.lower() == "idempotency-key" for name in headers)
        attempts = max(1, min(5, int(self.retry_attempts))) if safe_to_retry else 1
        for attempt in range(attempts):
            request = Request(url, data=payload, headers=headers, method=normalized_method)
            if self.api_key:
                request.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
            try:
                redirect_handler = DkryptRedirectHandler(self._origin(urlsplit(self.base_url)), self.api_key)
                with build_opener(redirect_handler).open(request) as response:
                    return response.read()
            except HTTPError as error:
                if attempt + 1 < attempts and error.code in (429, 502, 503, 504):
                    delay = self._retry_after(error.headers.get("Retry-After"))
                    error.close()
                    sleep(self._retry_delay(attempt) if delay is None else delay)
                    continue
                detail = error.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"dkrypt request failed with HTTP {error.code}: {detail}") from error
            except URLError:
                if attempt + 1 >= attempts:
                    raise
                sleep(self._retry_delay(attempt))
        raise RuntimeError("dkrypt request could not be completed")

    def _retry_delay(self, attempt: int) -> float:
        return min(max(0.0, self.retry_max_delay), max(0.0, self.retry_base_delay) * (2 ** attempt))

    def _retry_after(self, value: str | None) -> float | None:
        if value is None:
            return None
        try:
            return min(30.0, max(0.0, float(value)))
        except ValueError:
            try:
                from datetime import datetime, timezone
                return min(30.0, max(0.0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()))
            except (TypeError, ValueError, OverflowError):
                return None

    def _build_url(self, path: str) -> str:
        base_url = self.base_url.rstrip("/") + "/"
        request_url = urljoin(base_url, path)
        base = urlsplit(base_url)
        target = urlsplit(request_url)
        if (
            target.scheme.lower() not in ("http", "https")
            or target.username is not None
            or target.password is not None
            or self._origin(base) != self._origin(target)
        ):
            raise ValueError("dkrypt requests must use the configured origin")
        return request_url

    @staticmethod
    def _origin(url: SplitResult) -> tuple[str, str | None, int]:
        scheme = url.scheme.lower()
        default_port = 443 if scheme == "https" else 80
        port = url.port
        return scheme, url.hostname, default_port if port is None else port

class DkryptRedirectHandler(HTTPRedirectHandler):
    def __init__(self, origin: tuple[str, str | None, int], api_key: str | None):
        super().__init__()
        self.origin = origin
        self.api_key = api_key

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        target = urlsplit(newurl)
        if (
            redirected is not None
            and self.api_key
            and target.username is None
            and target.password is None
            and DkryptClient._origin(target) == self.origin
        ):
            redirected.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
        return redirected
`;
}
