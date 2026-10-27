import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRY_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 10_000;

export interface WebhookPostResult {
  ok: boolean;
  status?: number;
  error?: string;
  durationMs: number;
  signatureAcknowledged?: boolean;
}

async function retryDelayMs(res: Response): Promise<number> {
  const retryAfter = res.headers.get('retry-after');
  const headerDelay = retryAfterDelayMs(retryAfter);
  if (headerDelay !== undefined) return headerDelay;
  if (res.status !== 429) return RETRY_DELAY_MS;
  try {
    const body = (await res.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === 'number') return Math.min(body.retry_after * 1000, MAX_RETRY_DELAY_MS);
  } catch {}
  return RETRY_DELAY_MS;
}

function retryAfterDelayMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(requested) ? Math.max(0, Math.min(requested, MAX_RETRY_DELAY_MS)) : undefined;
}

interface PinnedPostResult {
  status: number;
  signatureAcknowledged: boolean;
  retryAfter?: string;
}

function postPinnedHttps(url: string, payload: string, headers: Record<string, string>, address: string): Promise<PinnedPostResult> {
  const endpoint = new URL(url);
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(address);
  if (!family) return Promise.reject(new Error('validated webhook address is invalid'));
  const lookup: NonNullable<RequestOptions['lookup']> = (_requestedHost, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpsRequest({
      protocol: 'https:',
      hostname,
      port: endpoint.port || '443',
      path: `${endpoint.pathname}${endpoint.search}`,
      method: 'POST',
      headers: { Host: endpoint.host, 'Content-Type': 'application/json', ...headers },
      lookup,
      servername: isIP(hostname) ? undefined : hostname,
      agent: false,
      signal: AbortSignal.timeout(10_000),
    }, (response) => {
      settled = true;
      const retryAfter = response.headers['retry-after'];
      response.destroy();
      resolve({
        status: response.statusCode ?? 0,
        signatureAcknowledged: String(response.headers['x-dkrypt-signature-verified'] ?? '').toLowerCase() === 'true',
        ...(typeof retryAfter === 'string' ? { retryAfter } : {}),
      });
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.end(payload);
  });
}

export async function postJsonWithRetry(url: string, body: unknown, headers: Record<string, string> = {}, pinnedAddresses?: readonly string[]): Promise<WebhookPostResult> {
  const payload = JSON.stringify(body);
  const startedAt = Date.now();

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const pinnedAddress = pinnedAddresses?.length ? pinnedAddresses[attempt % pinnedAddresses.length] : undefined;
      const response = pinnedAddress
        ? await postPinnedHttps(url, payload, headers, pinnedAddress)
        : undefined;
      const res = response ? undefined : await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const status = response?.status ?? res?.status ?? 0;
      const ok = response ? status >= 200 && status < 300 : res?.ok === true;
      const signatureAcknowledged = response?.signatureAcknowledged ?? res?.headers.get('x-dkrypt-signature-verified')?.toLowerCase() === 'true';
      if (ok) return { ok: true, status, durationMs: Date.now() - startedAt, signatureAcknowledged };
      if (attempt === 0) {
        const delay = response
          ? retryAfterDelayMs(response.retryAfter) ?? RETRY_DELAY_MS
          : res ? await retryDelayMs(res) : RETRY_DELAY_MS;
        await sleep(Number.isFinite(delay) ? delay : RETRY_DELAY_MS);
        continue;
      }
      return { ok: false, status, durationMs: Date.now() - startedAt, signatureAcknowledged };
    } catch (err) {
      if (attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { ok: false, error: String(err), durationMs: Date.now() - startedAt };
    }
  }

  return { ok: false, durationMs: Date.now() - startedAt };
}
