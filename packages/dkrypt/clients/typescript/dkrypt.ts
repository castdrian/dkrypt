export type DkryptRoute =
  | "GET /v1/artifacts"
  | "GET /v1/artifacts/{id}"
  | "GET /v1/artifacts/{id}/file"
  | "GET /v1/decrypt"
  | "GET /v1/jobs/{id}"
  | "GET /v1/jobs/{id}/wait"
  | "POST /v1/decrypts"
  | "POST /v1/jobs/status"
  | "POST /v1/testflight/decrypt";

export interface DkryptClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface DkryptRequestInit extends RequestInit {
  path: string;
}

export class DkryptClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, options?: DkryptClientOptions);
  constructor(baseUrl: string, fetchImpl?: typeof fetch);
  constructor(baseUrl: string, optionsOrFetch: DkryptClientOptions | typeof fetch = {}) {
    const options = typeof optionsOrFetch === 'function' ? { fetchImpl: optionsOrFetch } : optionsOrFetch;
    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(init: DkryptRequestInit): Promise<T> {
    const { path, ...request } = init;
    const response = await this.fetchImpl(this.buildUrl(path), {
      ...request,
      headers: this.createHeaders(request.headers, 'application/json'),
    });
    if (!response.ok) throw new Error(await this.responseError(response));
    return await response.json() as T;
  }

  async download(path: string, init: Pick<RequestInit, 'headers' | 'signal'> = {}): Promise<ArrayBuffer> {
    const response = await this.fetchImpl(this.buildUrl(path), {
      ...init,
      method: 'GET',
      headers: this.createHeaders(init.headers, 'application/octet-stream'),
    });
    if (!response.ok) throw new Error(await this.responseError(response));
    return response.arrayBuffer();
  }

  private createHeaders(headers: RequestInit['headers'] | undefined, accept: string): Headers {
    const result = new Headers(headers);
    if (this.apiKey && !result.has('authorization')) result.set('Authorization', `Bearer ${this.apiKey}`);
    if (!result.has('accept')) result.set('Accept', accept);
    return result;
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
    return detail ?? `dkrypt request failed with HTTP ${response.status}`;
  }
}
