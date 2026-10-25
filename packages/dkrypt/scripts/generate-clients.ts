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
  artifacts: Array<{ id: string; bundleId: string; versionLabel?: string; fileSizeBytes?: number }>;
  nextCursor?: string;
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

  async *followJob(id: string, signal?: AbortSignal): AsyncGenerator<DkryptJob> {
    while (!signal?.aborted) {
      const job = await this.waitForJob(id, 25, signal);
      yield job;
      if (job.status === 'done' || job.status === 'failed') return;
    }
  }

  listArtifacts(options: { q?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {}): Promise<DkryptArtifactPage> {
    const params = new URLSearchParams();
    if (options.q) params.set('q', options.q);
    params.set('limit', String(Math.max(1, Math.min(100, Math.floor(options.limit ?? 100)))));
    if (options.cursor) params.set('cursor', options.cursor);
    return this.request<DkryptArtifactPage>({ path: \`/v1/artifacts?\${params}\`, signal: options.signal });
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

    def follow_job(self, job_id: str):
        while True:
            job = self.wait_for_job(job_id)
            yield job
            if isinstance(job, dict) and job.get("status") in ("done", "failed"):
                return

    def list_artifacts(self, query: str | None = None, limit: int = 100, cursor: str | None = None) -> object:
        from urllib.parse import urlencode
        params = {"limit": max(1, min(100, int(limit)))}
        if query:
            params["q"] = query
        if cursor:
            params["cursor"] = cursor
        return self.request("GET", f"/v1/artifacts?{urlencode(params)}")

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
