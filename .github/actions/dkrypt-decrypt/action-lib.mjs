import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

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

async function partialSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function digestFile(filePath) {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
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
  const expectedEtag = `"${normalizedSha256}"`;
  if (!/^[a-f0-9]{64}$/.test(normalizedSha256)) throw new Error('dkrypt did not report a valid artifact SHA-256');
  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0) throw new Error('dkrypt did not report a valid artifact size');
  await mkdir(path.dirname(absoluteOutputPath), { recursive: true });

  let lastError;
  const deadlineAt = Date.now() + timeoutMs;
  const temporaryPath = `${absoluteOutputPath}.partial`;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let offset = await partialSize(temporaryPath);
    if (offset > expectedSizeBytes) {
      await rm(temporaryPath, { force: true });
      offset = 0;
    }
    if (offset === expectedSizeBytes && expectedSizeBytes > 0) {
      const existing = await digestFile(temporaryPath);
      if (existing.sha256 === normalizedSha256) {
        await rename(temporaryPath, absoluteOutputPath);
        return { outputPath: absoluteOutputPath, ...existing };
      }
      await rm(temporaryPath, { force: true });
      offset = 0;
    }
    try {
      const signal = requestSignal(deadlineAt, timeoutMs, 'IPA download');
      const response = await fetchImpl(downloadUrl, {
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/octet-stream',
          Authorization: `Bearer ${apiKey}`,
          ...(offset > 0 ? { Range: `bytes=${offset}-`, 'If-Range': expectedEtag } : {}),
        },
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
      const responseEtag = response.headers.get('etag');
      const resumedFullResponse = offset > 0 && response.status === 200;
      if ((responseEtag && responseEtag !== expectedEtag && !resumedFullResponse) || (response.status === 206 && responseEtag !== expectedEtag)) {
        await rm(temporaryPath, { force: true });
        throw new ArtifactIntegrityError('dkrypt returned an ETag that does not match the expected IPA checksum');
      }
      if (response.status === 416) {
        const total = response.headers.get('content-range')?.match(/^bytes \*\/(\d+)$/)?.[1];
        if (offset === expectedSizeBytes && total === String(expectedSizeBytes)) {
          const existing = await digestFile(temporaryPath);
          if (existing.sha256 === normalizedSha256) {
            await rename(temporaryPath, absoluteOutputPath);
            return { outputPath: absoluteOutputPath, ...existing };
          }
        }
        await rm(temporaryPath, { force: true });
        lastError = new Error('dkrypt rejected the resumed IPA byte range');
        if (attempt === maxAttempts) throw lastError;
        continue;
      }
      if (!response.ok) throw new ApiRequestError(await apiErrorMessage(response), { status: response.status });
      if (!response.body) throw new Error('dkrypt returned an empty IPA response');
      if (offset > 0 && response.status === 200) {
        await rm(temporaryPath, { force: true });
        offset = 0;
      }
      if (response.status === 206) {
        const contentRange = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!contentRange || Number(contentRange[1]) !== offset || Number(contentRange[2]) !== expectedSizeBytes - 1 || Number(contentRange[3]) !== expectedSizeBytes) {
          await rm(temporaryPath, { force: true });
          throw new ApiRequestError('dkrypt returned an invalid resumed IPA byte range', { retryable: true });
        }
      }
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(temporaryPath, { flags: offset > 0 ? 'a' : 'w', mode: 0o600 }),
        { signal },
      );
      const digest = await digestFile(temporaryPath);
      if (digest.sizeBytes < expectedSizeBytes) {
        const responseContentLength = Number(response.headers.get('content-length'));
        if (Number.isSafeInteger(responseContentLength) && responseContentLength === digest.sizeBytes - offset) {
          throw new ArtifactIntegrityError(`downloaded IPA integrity check failed (expected ${expectedSizeBytes} bytes; received ${digest.sizeBytes})`);
        }
        throw new ApiRequestError(`dkrypt IPA response ended early (expected ${expectedSizeBytes} bytes; received ${digest.sizeBytes})`, { retryable: true });
      }
      if (digest.sizeBytes !== expectedSizeBytes || digest.sha256 !== normalizedSha256) {
        if (offset > 0 && digest.sizeBytes === expectedSizeBytes) {
          await rm(temporaryPath, { force: true });
          lastError = new Error('the saved partial IPA did not match the current artifact; restarting from byte zero');
          if (attempt === maxAttempts) throw new ArtifactIntegrityError(`downloaded IPA integrity check failed (expected ${expectedSizeBytes} bytes and ${normalizedSha256}; received ${digest.sizeBytes} bytes and ${digest.sha256})`);
          continue;
        }
        throw new ArtifactIntegrityError(`downloaded IPA integrity check failed (expected ${expectedSizeBytes} bytes and ${normalizedSha256}; received ${digest.sizeBytes} bytes and ${digest.sha256})`);
      }
      await rename(temporaryPath, absoluteOutputPath);
      return { outputPath: absoluteOutputPath, ...digest };
    } catch (error) {
      if (error instanceof ArtifactIntegrityError || (error instanceof ApiRequestError && !error.retryable)) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
      if (await partialSize(temporaryPath).catch(() => 0) === 0) await rm(temporaryPath, { force: true }).catch(() => {});
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
