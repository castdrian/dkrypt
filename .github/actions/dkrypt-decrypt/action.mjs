import { appendActionOutput, createApiClient, downloadVerifiedArtifact, validateOrigin } from './action-lib.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;

function validatePositiveInteger(value, label, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} must be between 1 and ${maximum}`);
  return parsed;
}

function safeFilePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function jobLogLine(job) {
  const detail = typeof job.progress === 'string' && job.progress.trim() ? ` · ${job.progress.trim().replace(/[\r\n]+/g, ' ').slice(0, 240)}` : '';
  const cacheHit = job.cacheHit === true ? ' · cache hit' : '';
  return `dkrypt job ${job.id}: ${job.status}${cacheHit}${detail}`;
}

function artifactFromJob(job, fallbackBundleId) {
  if (!job.artifactId) throw new Error(`dkrypt job ${job.id} completed without an artifact`);
  return {
    id: String(job.artifactId),
    bundleId: job.bundleId ?? fallbackBundleId,
    channel: job.channel ?? (job.testflight ? 'testflight' : 'appstore'),
    versionLabel: job.resolvedVersion ?? job.versionLabel ?? job.artifact?.versionLabel,
    buildNumber: job.testflight?.buildNumber ?? job.artifact?.buildNumber,
    sha256: job.sha256 ?? job.artifact?.sha256,
    sizeBytes: job.sizeBytes ?? job.artifact?.sizeBytes,
    fileUrl: job.artifact?.fileUrl ?? job.artifactUrl,
    cacheHit: job.cacheHit === true,
  };
}

async function fetchExistingArtifact(client, { artifactId, latestCachedChannel, deadlineAt }) {
  if (artifactId) {
    return client.requestJson(`/v1/artifacts/${encodeURIComponent(artifactId)}`, { deadlineAt, label: `artifact ${artifactId} lookup` });
  }
  const query = new URLSearchParams({ channel: latestCachedChannel, limit: '1' });
  const page = await client.requestJson(`/v1/artifacts?${query}`, { deadlineAt, label: `latest cached ${latestCachedChannel} artifact lookup` });
  const artifact = page.artifacts?.[0];
  if (!artifact) throw new Error(`No cached ${latestCachedChannel} IPA is available to this API key`);
  return artifact;
}

export async function runAction(config, dependencies = {}) {
  const log = dependencies.log ?? ((message) => process.stdout.write(`${message}\n`));
  const outputFile = config.githubOutput ?? process.env.GITHUB_OUTPUT;
  if (!outputFile) throw new Error('GITHUB_OUTPUT is unavailable');
  const apiKey = config.apiKey ?? '';
  if (!apiKey || apiKey.length < 8) throw new Error('Provide a valid dkrypt API key');
  const origin = validateOrigin(config.apiUrl ?? '');
  const timeoutSeconds = validatePositiveInteger(config.timeoutSeconds ?? 1_800, 'Timeout', 86_400);
  const downloadTimeoutSeconds = validatePositiveInteger(config.downloadTimeoutSeconds ?? 600, 'Download timeout', 3_600);
  const artifactId = config.artifactId?.trim();
  const latestCachedChannel = config.latestCachedChannel?.trim();
  const artifactModeCount = Number(Boolean(artifactId)) + Number(Boolean(latestCachedChannel));
  if (artifactModeCount > 1) throw new Error('Choose either artifact-id or latest-cached-channel');
  if (artifactModeCount > 0 && (config.bundleId?.trim() || config.version?.trim())) {
    throw new Error('artifact downloads cannot be combined with bundle-id or version');
  }
  if (latestCachedChannel && !['appstore', 'testflight'].includes(latestCachedChannel)) {
    throw new Error('latest-cached-channel must be appstore or testflight');
  }

  const client = createApiClient({
    origin,
    apiKey,
    fetchImpl: dependencies.fetchImpl,
    log,
    sleep: dependencies.sleep,
    random: dependencies.random,
    maxAttempts: dependencies.maxAttempts,
    requestTimeoutMs: dependencies.requestTimeoutMs,
    retryBaseMs: dependencies.retryBaseMs,
    retryMaxMs: dependencies.retryMaxMs,
  });

  let jobId = '';
  let artifact;
  let job;
  if (artifactId || latestCachedChannel) {
    artifact = await fetchExistingArtifact(client, { artifactId, latestCachedChannel, deadlineAt: Date.now() + timeoutSeconds * 1_000 });
  } else {
    const bundleId = (config.bundleId ?? '').trim();
    if (!BUNDLE_ID_RE.test(bundleId)) throw new Error('Provide a valid app bundle ID');
    const channel = config.channel ?? 'appstore';
    const version = config.version?.trim();
    if (!['appstore', 'testflight'].includes(channel)) throw new Error('channel must be appstore or testflight');
    if (channel === 'testflight' && version && !version.includes('_')) throw new Error('TestFlight versions must include a build number, or leave version empty to resolve the latest build');
    if (channel === 'appstore' && version?.includes('_')) throw new Error('App Store versions cannot include a TestFlight build number');

    const deadlineAt = Date.now() + timeoutSeconds * 1_000;
    log(`Submitting ${channel === 'testflight' && !version ? 'latest TestFlight' : channel} decrypt for ${bundleId}`);
    job = await client.requestJson('/v1/decrypts', {
      method: 'POST',
      headers: { 'Idempotency-Key': dependencies.idempotencyKey ?? randomUUID() },
      body: JSON.stringify({ bundleId, ...(version ? { version } : {}), ...(channel === 'testflight' ? { channel } : {}) }),
      deadlineAt,
      label: 'decrypt submission',
    });
    if (typeof job.id !== 'string' || !job.id) throw new Error('dkrypt did not return a job ID');
    jobId = job.id;
    await appendActionOutput(outputFile, 'job-id', jobId);
    log(jobLogLine(job));

    while (job.status !== 'done' && job.status !== 'failed') {
      const remainingSeconds = Math.floor((deadlineAt - Date.now()) / 1_000);
      if (remainingSeconds < 1) throw new Error(`dkrypt job ${job.id} did not finish within ${timeoutSeconds} seconds`);
      const waitSeconds = Math.min(25, remainingSeconds);
      job = await client.requestJson(`/v1/jobs/${encodeURIComponent(job.id)}/wait?timeoutSeconds=${waitSeconds}`, {
        deadlineAt,
        label: `job ${job.id} wait`,
      });
      log(jobLogLine(job));
    }

    if (job.status === 'failed') throw new Error(`dkrypt job ${job.id} failed: ${String(job.error ?? 'unknown failure').slice(0, 500)}`);
    artifact = artifactFromJob(job, bundleId);
  }

  if (typeof artifact.id !== 'string' || !artifact.id) throw new Error('dkrypt did not return an artifact ID');
  if (!artifact.buildNumber || !artifact.versionLabel || !artifact.sha256 || !Number.isSafeInteger(artifact.sizeBytes)) {
    const metadata = await client.requestJson(`/v1/artifacts/${encodeURIComponent(artifact.id)}`, { label: `artifact ${artifact.id} metadata` });
    if (metadata.id !== artifact.id) throw new Error('dkrypt returned metadata for a different artifact');
    artifact = { ...artifact, ...metadata };
  }
  if (!['appstore', 'testflight'].includes(artifact.channel)) throw new Error('dkrypt returned an invalid artifact channel');
  const fileUrl = artifact.fileUrl ?? `/v1/artifacts/${encodeURIComponent(artifact.id)}/file`;
  const defaultOutputPath = artifactModeCount > 0
    ? `${safeFilePart(artifact.bundleId)}-${safeFilePart(artifact.versionLabel ?? artifact.buildNumber ?? artifact.id)}.ipa`
    : `${safeFilePart(artifact.bundleId)}.ipa`;
  const outputPath = config.output?.trim() ? path.resolve(config.output.trim()) : path.resolve(defaultOutputPath);
  const download = await downloadVerifiedArtifact({
    url: fileUrl,
    origin,
    apiKey,
    outputPath,
    expectedSha256: artifact.sha256,
    expectedSizeBytes: artifact.sizeBytes,
    fetchImpl: dependencies.fetchImpl,
    log,
    sleep: dependencies.sleep,
    random: dependencies.random,
    maxAttempts: dependencies.maxAttempts,
    timeoutMs: downloadTimeoutSeconds * 1_000,
    retryBaseMs: dependencies.retryBaseMs,
    retryMaxMs: dependencies.retryMaxMs,
  });

  const isTestFlight = artifact.channel === 'testflight';
  const resolvedVersion = artifact.versionLabel ?? '';
  const build = artifact.buildNumber ?? '';
  const cacheHit = artifactModeCount > 0 || job?.cacheHit === true;
  const outputs = {
    'job-id': jobId,
    'artifact-id': artifact.id,
    version: resolvedVersion,
    'resolved-version': resolvedVersion,
    resolved_version: resolvedVersion,
    build,
    channel: artifact.channel,
    is_testflight: String(isTestFlight),
    'is-testflight': String(isTestFlight),
    cache_hit: String(cacheHit),
    'cache-hit': String(cacheHit),
    sha256: download.sha256,
    size_bytes: String(download.sizeBytes),
    'size-bytes': String(download.sizeBytes),
    path: download.outputPath,
    output: download.outputPath,
  };
  for (const [name, value] of Object.entries(outputs)) await appendActionOutput(outputFile, name, value);
  log(`Downloaded and verified ${artifact.channel} IPA (${download.sizeBytes} bytes, SHA-256 ${download.sha256}) at ${download.outputPath}`);
  return outputs;
}

async function main() {
  const outputs = await runAction({
    apiUrl: process.env.DKRYPT_API_URL ?? '',
    apiKey: process.env.DKRYPT_API_KEY ?? '',
    bundleId: process.env.DKRYPT_BUNDLE_ID ?? '',
    version: process.env.DKRYPT_VERSION ?? '',
    channel: process.env.DKRYPT_CHANNEL ?? 'appstore',
    output: process.env.DKRYPT_OUTPUT ?? '',
    artifactId: process.env.DKRYPT_ARTIFACT_ID ?? '',
    latestCachedChannel: process.env.DKRYPT_LATEST_CACHED_CHANNEL ?? '',
    timeoutSeconds: process.env.DKRYPT_TIMEOUT_SECONDS ?? '1800',
    downloadTimeoutSeconds: process.env.DKRYPT_DOWNLOAD_TIMEOUT_SECONDS ?? '600',
  });
  return outputs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
