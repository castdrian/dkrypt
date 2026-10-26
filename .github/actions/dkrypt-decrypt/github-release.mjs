import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

function validateRepository(value) {
  const repository = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) throw new Error('Set GITHUB_REPOSITORY to owner/repository before publishing a release asset');
  return repository;
}

function validateTag(value) {
  const tag = String(value ?? '').trim();
  if (!tag || tag.length > 200 || /[\s\0]/.test(tag)) throw new Error('release-tag must be a non-empty Git tag without whitespace');
  return tag;
}

function validateApiBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['/', '/api/v3', '/api/v3/'].includes(url.pathname)) throw new Error('GitHub API URL must be an HTTPS API base');
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

function validateUploadUrl(value, apiBase) {
  const uploadUrl = new URL(String(value ?? '').replace(/\{[^}]*\}$/, ''));
  const api = new URL(apiBase);
  const githubComUpload = api.hostname === 'api.github.com' && uploadUrl.hostname === 'uploads.github.com';
  if (uploadUrl.protocol !== 'https:' || (!githubComUpload && uploadUrl.origin !== api.origin)) throw new Error('GitHub returned an unsupported release upload URL');
  return uploadUrl;
}

function retryable(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function responseError(response) {
  const payload = await response.json().catch(() => undefined);
  const detail = typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
  const error = new Error(`GitHub release request failed: ${detail}`);
  error.statusCode = response.status;
  return error;
}

async function requestJson(fetchImpl, url, init, { attempts, sleep, log, timeoutMs, allowNotFound = false }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (allowNotFound && response.status === 404) return undefined;
      if (retryable(response.status)) {
        lastError = await responseError(response);
      } else if (!response.ok) {
        throw await responseError(response);
      } else {
        return await response.json();
      }
    } catch (error) {
      if (error?.statusCode && !retryable(error.statusCode)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < attempts) {
      const delay = Math.min(10_000, 500 * 2 ** (attempt - 1));
      log(`Retrying GitHub release lookup in ${Math.ceil(delay / 1_000)}s (${attempt + 1}/${attempts})`);
      await sleep(delay);
    }
  }
  throw new Error(`GitHub release lookup failed after ${attempts} attempts: ${lastError?.message ?? 'unknown error'}`);
}

function requestHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function getRelease(fetchImpl, apiBase, repository, tag, token, dependencies) {
  const url = `${apiBase}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  return requestJson(fetchImpl, url, { headers: requestHeaders(token) }, { ...dependencies, allowNotFound: true });
}

async function createRelease(fetchImpl, apiBase, repository, tag, token, options, dependencies) {
  const url = `${apiBase}/repos/${repository}/releases`;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: requestHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        tag_name: tag,
        name: options.releaseName?.trim() || tag,
        body: options.releaseNotes ?? '',
        draft: options.draft === true,
      }),
      signal: AbortSignal.timeout(dependencies.timeoutMs),
    });
    if (!response.ok) throw await responseError(response);
    return await response.json();
  } catch (error) {
    const existing = await getRelease(fetchImpl, apiBase, repository, tag, token, dependencies);
    if (existing) return existing;
    throw new Error(`GitHub Release creation failed without a confirmed release: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validatePageUrl(value, apiBase, label) {
  const url = new URL(String(value ?? ''));
  const api = new URL(apiBase);
  const githubComPage = api.hostname === 'api.github.com' && url.hostname === 'github.com';
  if (url.protocol !== 'https:' || (!githubComPage && url.origin !== api.origin)) throw new Error(`GitHub returned an unsupported ${label}`);
  return url.href;
}

async function listReleaseAssets(fetchImpl, apiBase, repository, release, token, dependencies) {
  const assets = [];
  for (let page = 1; page <= 10; page += 1) {
    const values = await requestJson(fetchImpl, `${apiBase}/repos/${repository}/releases/${encodeURIComponent(String(release.id))}/assets?per_page=100&page=${page}`, {
      headers: requestHeaders(token),
    }, dependencies);
    if (!Array.isArray(values)) throw new Error('GitHub returned an invalid release asset list');
    assets.push(...values);
    if (values.length < 100) break;
  }
  return assets;
}

async function sha256File(filePath) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

export async function publishVerifiedIpaToGitHubRelease(options, dependencies = {}) {
  const token = String(options.token ?? '').trim();
  if (!token) throw new Error('github-token is required when publish-to-release is enabled');
  const repository = validateRepository(options.repository);
  const tag = validateTag(options.tag);
  const apiBase = validateApiBase(options.apiUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com');
  const assetName = String(options.assetName ?? '').trim();
  if (!assetName || assetName.length > 255 || /[\/\\\0]/.test(assetName) || !assetName.toLowerCase().endsWith('.ipa')) throw new Error('GitHub Release asset name must be a safe .ipa filename');
  const filePath = String(options.filePath ?? '');
  const file = await stat(filePath);
  if (!file.isFile() || file.size < 1) throw new Error('Verified IPA file is unavailable for release upload');
  const expectedSize = options.sizeBytes;
  const expectedHash = String(options.sha256 ?? '').toLowerCase();
  if (!Number.isSafeInteger(expectedSize) || file.size !== expectedSize || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Verified IPA metadata is invalid for release upload');
  if (await sha256File(filePath) !== expectedHash) throw new Error('IPA changed after its initial integrity verification');
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const log = dependencies.log ?? (() => {});
  const requestOptions = {
    attempts: dependencies.maxAttempts ?? 4,
    sleep: dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    log,
    timeoutMs: dependencies.requestTimeoutMs ?? 60_000,
  };

  let release = await getRelease(fetchImpl, apiBase, repository, tag, token, requestOptions);
  if (!release && options.createRelease !== true) throw new Error(`GitHub Release ${tag} was not found; set create-release to true to create it`);
  if (!release) release = await createRelease(fetchImpl, apiBase, repository, tag, token, options, requestOptions);
  if (!Number.isSafeInteger(release.id) || typeof release.html_url !== 'string') throw new Error('GitHub returned an invalid release record');
  const releaseUrl = validatePageUrl(release.html_url, apiBase, 'release page URL');

  const existingAssets = await listReleaseAssets(fetchImpl, apiBase, repository, release, token, requestOptions);
  if (existingAssets.some((asset) => asset.name === assetName)) throw new Error(`GitHub Release already contains an asset named ${assetName}`);

  const uploadUrl = validateUploadUrl(release.upload_url, apiBase);
  uploadUrl.searchParams.set('name', assetName);
  const timeoutMs = (dependencies.uploadTimeoutSeconds ?? 1_800) * 1_000;
  const response = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: requestHeaders(token, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) }),
    body: createReadStream(filePath),
    duplex: 'half',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await responseError(response);
  const asset = await response.json();
  if (asset.name !== assetName || !Number.isSafeInteger(asset.size) || asset.size !== file.size || typeof asset.browser_download_url !== 'string') {
    throw new Error('GitHub returned release asset metadata that does not match the verified IPA');
  }
  if (typeof asset.digest === 'string' && asset.digest.toLowerCase() !== `sha256:${expectedHash}`) throw new Error('GitHub reports a release asset digest that does not match the verified IPA');
  const assetUrl = validatePageUrl(asset.browser_download_url, apiBase, 'release asset URL');
  return { releaseUrl, assetUrl, assetName, sizeBytes: asset.size };
}
