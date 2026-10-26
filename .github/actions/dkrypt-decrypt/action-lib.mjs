import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;

export class ApiRequestError extends Error {
  constructor(message, { retryable = false, retryAfterMs, status } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

export class ArtifactIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArtifactIntegrityError';
  }
}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(value, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function retryDelay(attempt, retryAfterMs, baseMs, maxMs, random) {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.75 + random() * 0.5));
}

function requestSignal(deadlineAt, timeoutMs, label) {
  const remaining = deadlineAt === undefined ? timeoutMs : Math.min(timeoutMs, deadlineAt - Date.now());
  if (remaining <= 0) throw new Error(`${label} timed out`);
  return AbortSignal.timeout(Math.max(1, Math.floor(remaining)));
}

function validateSameOrigin(url, origin) {
  const resolved = new URL(url, origin);
  if (resolved.origin !== origin) throw new Error('dkrypt returned a URL outside its configured origin');
  return resolved;
}

async function apiErrorMessage(response) {
  const body = await response.json().catch(() => undefined);
  return body?.message ?? body?.error ?? `dkrypt request failed with HTTP ${response.status}`;
}

async function pauseBeforeRetry({ attempt, retryAfterMs, label, log, sleep, baseMs, maxMs, random, deadlineAt }) {
  const delayMs = retryDelay(attempt, retryAfterMs, baseMs, maxMs, random);
  if (deadlineAt !== undefined && Date.now() + delayMs >= deadlineAt) throw new Error(`${label} timed out`);
  log(`Retrying ${label} in ${Math.ceil(delayMs / 1_000)}s (attempt ${attempt + 1})`);
  await sleep(delayMs);
}

export function validateOrigin(value) {
  const url = new URL(value);
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol !== 'https:' && !localHost) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('dkrypt API URL must be an HTTPS origin; HTTP is allowed only for localhost');
  }
  return url.origin;
}

export function createApiClient({
  origin,
  apiKey,
  fetchImpl = fetch,
  log = (message) => process.stdout.write(`${message}\n`),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random = Math.random,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
}) {
  async function requestJson(resource, options = {}) {
    const label = options.label ?? 'dkrypt API request';
    const url = validateSameOrigin(resource, origin);
    const requestOptions = { ...options };
    delete requestOptions.label;
    delete requestOptions.deadlineAt;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          ...requestOptions,
          redirect: 'error',
          signal: requestSignal(options.deadlineAt, requestTimeoutMs, label),
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
          },
        });
        if (retryableStatus(response.status)) {
          lastError = new ApiRequestError(`dkrypt returned HTTP ${response.status}`, {
            retryable: true,
            retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')),
            status: response.status,
          });
          if (attempt === maxAttempts) throw lastError;
          await pauseBeforeRetry({ attempt, retryAfterMs: lastError.retryAfterMs, label, log, sleep, baseMs: retryBaseMs, maxMs: retryMaxMs, random, deadlineAt: options.deadlineAt });
          continue;
        }
        if (!response.ok && response.status !== 202) {
          throw new ApiRequestError(await apiErrorMessage(response), { status: response.status });
        }
        try {
          return await response.json();
        } catch (error) {
          if (error instanceof SyntaxError) throw new Error(`dkrypt returned invalid JSON during ${label}`);
          lastError = error;
          if (attempt === maxAttempts) throw lastError;
          await pauseBeforeRetry({ attempt, label, log, sleep, baseMs: retryBaseMs, maxMs: retryMaxMs, random, deadlineAt: options.deadlineAt });
        }
      } catch (error) {
        if (error instanceof ApiRequestError && !error.retryable) throw error;
        lastError = error;
        if (attempt === maxAttempts) throw new Error(`${label} failed after ${maxAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof ApiRequestError) {
          await pauseBeforeRetry({ attempt, retryAfterMs: error.retryAfterMs, label, log, sleep, baseMs: retryBaseMs, maxMs: retryMaxMs, random, deadlineAt: options.deadlineAt });
        } else {
          await pauseBeforeRetry({ attempt, label, log, sleep, baseMs: retryBaseMs, maxMs: retryMaxMs, random, deadlineAt: options.deadlineAt });
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
  }

  return { requestJson };
}

export async function downloadVerifiedArtifact({
  url,
  origin,
  apiKey,
  outputPath,
  expectedSha256,
  expectedSizeBytes,
  fetchImpl = fetch,
  log = (message) => process.stdout.write(`${message}\n`),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random = Math.random,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
}) {
  const downloadUrl = validateSameOrigin(url, origin);
  const absoluteOutputPath = path.resolve(outputPath);
  const normalizedSha256 = typeof expectedSha256 === 'string' ? expectedSha256.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(normalizedSha256)) throw new Error('dkrypt did not report a valid artifact SHA-256');
  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0) throw new Error('dkrypt did not report a valid artifact size');
  await mkdir(path.dirname(absoluteOutputPath), { recursive: true });

  let lastError;
  const deadlineAt = Date.now() + timeoutMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const temporaryPath = `${absoluteOutputPath}.${process.pid}.${randomUUID()}.partial`;
    try {
      const signal = requestSignal(deadlineAt, timeoutMs, 'IPA download');
      const response = await fetchImpl(downloadUrl, {
        redirect: 'error',
        signal,
        headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${apiKey}` },
      });
      if (retryableStatus(response.status)) {
        lastError = new ApiRequestError(`dkrypt artifact download returned HTTP ${response.status}`, {
          retryable: true,
          retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')),
          status: response.status,
        });
        if (attempt === maxAttempts) throw lastError;
        await pauseBeforeRetry({ attempt, retryAfterMs: lastError.retryAfterMs, label: 'IPA download', log, sleep, baseMs: retryBaseMs, maxMs: retryMaxMs, random, deadlineAt });
        continue;
      }
      if (!response.ok) throw new ApiRequestError(await apiErrorMessage(response), { status: response.status });
      if (!response.body) throw new Error('dkrypt returned an empty IPA response');

      const hash = createHash('sha256');
      let sizeBytes = 0;
      const verifier = new Transform({
        transform(chunk, _encoding, callback) {
          sizeBytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        verifier,
        createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      const sha256 = hash.digest('hex');
      if (sizeBytes !== expectedSizeBytes || sha256 !== normalizedSha256) {
        throw new ArtifactIntegrityError(`downloaded IPA integrity check failed (expected ${expectedSizeBytes} bytes and ${normalizedSha256}; received ${sizeBytes} bytes and ${sha256})`);
      }
      await rename(temporaryPath, absoluteOutputPath);
      return { outputPath: absoluteOutputPath, sha256, sizeBytes };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (error instanceof ArtifactIntegrityError || (error instanceof ApiRequestError && !error.retryable)) throw error;
      lastError = error;
      if (attempt === maxAttempts) throw new Error(`IPA download failed after ${maxAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
      const retryAfterMs = error instanceof ApiRequestError ? error.retryAfterMs : undefined;
      await pauseBeforeRetry({ attempt, retryAfterMs, label: 'IPA download', log, sleep, baseMs: retryBaseMs, maxMs: retryMaxMs, random, deadlineAt });
    }
  }

  throw lastError instanceof Error ? lastError : new Error('IPA download failed');
}

export async function appendActionOutput(outputFile, name, value) {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new Error(`dkrypt returned an invalid ${name}`);
  await appendFile(outputFile, `${name}=${text}\n`);
}
