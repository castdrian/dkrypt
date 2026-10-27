import { appendActionOutput, createApiClient, downloadVerifiedArtifact, validateOrigin } from './action-lib.mjs';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { publishVerifiedIpaToGitHubRelease } from './github-release.mjs';

const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;

function parseDkryptLock(contents) {
  let lock;
  try {
    lock = JSON.parse(contents);
  } catch {
    throw new Error('dkrypt.lock must contain valid JSON');
  }
  if (!lock || lock.version !== 1 || !lock.apps || typeof lock.apps !== 'object' || Array.isArray(lock.apps)) {
    throw new Error('dkrypt.lock must use version 1 with an apps object');
  }
  for (const [bundleId, entry] of Object.entries(lock.apps)) {
    if (!BUNDLE_ID_RE.test(bundleId) || !entry || typeof entry !== 'object'
      || !['appstore', 'testflight'].includes(entry.source)
      || typeof entry.resolvedVersion !== 'string' || !entry.resolvedVersion.trim()
      || (entry.build !== undefined && typeof entry.build !== 'string')) {
      throw new Error(`dkrypt.lock has an invalid entry for ${bundleId}`);
    }
  }
  return lock;
}

async function loadDkryptLock(config) {
  const file = config.lockfile?.trim();
  if (!file) {
    if (isEnabled(config.updateLockfile)) throw new Error('lockfile is required when update-lockfile is enabled');
    return undefined;
  }
  const lockPath = path.resolve(file);
  try {
    return { path: lockPath, value: parseDkryptLock(await readFile(lockPath, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT' && isEnabled(config.updateLockfile)) return { path: lockPath, value: { version: 1, apps: {} } };
    throw error;
  }
}

async function writeDkryptLockEntry(config, bundleId, source, resolvedVersion, build) {
  const loaded = await loadDkryptLock({ ...config, updateLockfile: true });
  if (!loaded) throw new Error('lockfile is required when update-lockfile is enabled');
  const apps = { ...loaded.value.apps };
  apps[bundleId] = { source, resolvedVersion, ...(build ? { build: String(build) } : {}) };
  const lock = { version: 1, apps: Object.fromEntries(Object.entries(apps).sort(([left], [right]) => left.localeCompare(right))) };
  const temporaryPath = `${loaded.path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(loaded.path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
  await rename(temporaryPath, loaded.path);
}

async function resolveLockedRelease(config, bundleId) {
  const loaded = await loadDkryptLock(config);
  const updateLockfile = isEnabled(config.updateLockfile);
  const entry = updateLockfile ? undefined : loaded?.value.apps[bundleId];
  if (loaded && !entry && !updateLockfile) throw new Error(`dkrypt.lock has no entry for ${bundleId}`);
  if (entry && config.channel?.trim() && config.channel.trim() !== entry.source) throw new Error(`channel conflicts with the dkrypt.lock entry for ${bundleId}`);
  if (entry && config.version?.trim() && config.version.trim() !== entry.resolvedVersion) throw new Error(`version conflicts with the dkrypt.lock entry for ${bundleId}`);
  return {
    channel: entry?.source ?? config.channel?.trim() ?? 'appstore',
    version: entry?.resolvedVersion ?? config.version?.trim() ?? '',
    entry,
    updateLockfile,
  };
}

function validatePositiveInteger(value, label, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} must be between 1 and ${maximum}`);
  return parsed;
}

function safeFilePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function isEnabled(value) {
  return value === true || String(value).toLowerCase() === 'true';
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

function summaryCell(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[&<>|`[\]\\]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '`': '&#96;', '[': '&#91;', ']': '&#93;', '\\': '&#92;' })[character])
    .trim();
}

function workflowSummaryRow(result) {
  const ipaPath = result.path ? summaryCell(result.path) : result.resolveOnly ? 'Resolve only' : '—';
  const size = Number.isSafeInteger(result.sizeBytes) ? `${result.sizeBytes} bytes` : '—';
  const cache = result.cacheHit === true ? 'Hit' : result.cacheHit === false ? 'Miss' : 'Unknown';
  const outcome = result.error ?? (result.resolveOnly ? 'Resolved only' : result.status === 'failure' ? 'Failed' : 'Downloaded');
  return `| ${summaryCell(result.bundleId)} | ${summaryCell(result.version)} | ${summaryCell(result.channel)} | ${cache} | ${ipaPath} | ${size} | ${summaryCell(outcome)} |`;
}

async function appendWorkflowSummary(summaryFile, result) {
  if (!summaryFile) return;
  const table = [
    '| App | Version | Channel | Cache | IPA path | Size | Result |',
    '| --- | --- | --- | --- | --- | ---: | --- |',
    workflowSummaryRow(result),
  ];
  await appendFile(summaryFile, `## dkrypt\n\n${table.join('\n')}\n\n`);
}

async function appendBatchSummary(summaryFile, results) {
  if (!summaryFile) return;
  const table = [
    '| App | Version | Channel | Cache | IPA path | Size | Result |',
    '| --- | --- | --- | --- | --- | ---: | --- |',
    ...results.map(workflowSummaryRow),
  ];
  await appendFile(summaryFile, `## dkrypt · ${results.length} apps\n\n${table.join('\n')}\n\n`);
}

async function writeOutputs(outputFile, outputs) {
  for (const [name, value] of Object.entries(outputs)) await appendActionOutput(outputFile, name, value);
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

async function runSingleAction(config, dependencies = {}) {
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
  const resolveOnly = isEnabled(config.resolveOnly);
  const publishToRelease = isEnabled(config.publishToRelease);
  const artifactModeCount = Number(Boolean(artifactId)) + Number(Boolean(latestCachedChannel));
  const summaryContext = dependencies.summaryContext;
  if (summaryContext) {
    summaryContext.bundleId = config.bundleId?.trim() || (artifactId ? `Unknown app (artifact ${artifactId})` : latestCachedChannel ? `latest cached ${latestCachedChannel}` : 'dkrypt operation');
    summaryContext.version = config.version?.trim() ?? '';
    if (latestCachedChannel) summaryContext.channel = latestCachedChannel;
    else if (!artifactId) summaryContext.channel = config.channel ?? 'appstore';
  }
  if (artifactModeCount > 1) throw new Error('Choose either artifact-id or latest-cached-channel');
  if (artifactModeCount > 0 && (config.bundleId?.trim() || config.version?.trim())) {
    throw new Error('artifact downloads cannot be combined with bundle-id or version');
  }
  if (artifactModeCount > 0 && (config.lockfile?.trim() || isEnabled(config.updateLockfile))) {
    throw new Error('lockfile inputs can only be used with a new decrypt or resolve-only request');
  }
  if (resolveOnly && artifactModeCount > 0) throw new Error('resolve-only cannot be combined with artifact download inputs');
  if (resolveOnly && publishToRelease) throw new Error('publish-to-release requires a downloaded IPA and cannot be combined with resolve-only');
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
    if (summaryContext) Object.assign(summaryContext, {
      bundleId: artifact.bundleId ?? summaryContext.bundleId,
      version: artifact.versionLabel ?? summaryContext.version,
      channel: artifact.channel ?? summaryContext.channel,
      cacheHit: true,
      sizeBytes: artifact.sizeBytes,
    });
  } else {
    const bundleId = (config.bundleId ?? '').trim();
    if (!BUNDLE_ID_RE.test(bundleId)) throw new Error('Provide a valid app bundle ID');
    const locked = await resolveLockedRelease(config, bundleId);
    const channel = locked.channel;
    const version = locked.version || undefined;
    if (!['appstore', 'testflight'].includes(channel)) throw new Error('channel must be appstore or testflight');
    if (summaryContext) Object.assign(summaryContext, { bundleId, channel, version: version ?? '' });
    if (channel === 'testflight' && version && !version.includes('_')) throw new Error('TestFlight versions must include a build number, or leave version empty to resolve the latest build');
    if (channel === 'appstore' && version?.includes('_')) throw new Error('App Store versions cannot include a TestFlight build number');

    const deadlineAt = Date.now() + timeoutSeconds * 1_000;
    log(`${resolveOnly ? 'Resolving' : 'Submitting'} ${channel === 'testflight' && !version ? 'latest TestFlight' : channel}${resolveOnly ? ' release' : ' decrypt'} for ${bundleId}`);
    job = await client.requestJson('/v1/decrypts', {
      method: 'POST',
      ...(!resolveOnly ? { headers: { 'Idempotency-Key': dependencies.idempotencyKey ?? randomUUID() } } : {}),
      body: JSON.stringify({ bundleId, ...(version ? { version } : {}), ...(channel === 'testflight' ? { channel } : {}), ...(resolveOnly ? { resolveOnly: true } : {}) }),
      deadlineAt,
      label: resolveOnly ? 'release resolution' : 'decrypt submission',
    });
    if (resolveOnly) {
      if (job.resolveOnly !== true || typeof job.resolvedVersion !== 'string' || !['appstore', 'testflight'].includes(job.channel)) {
        throw new Error('dkrypt did not return valid resolved release metadata');
      }
      const build = job.build ?? '';
      if (locked.entry && (job.channel !== locked.entry.source || job.resolvedVersion !== locked.entry.resolvedVersion || (locked.entry.build && String(build) !== locked.entry.build))) {
        throw new Error(`resolved release does not match the dkrypt.lock entry for ${bundleId}`);
      }
      if (locked.updateLockfile) await writeDkryptLockEntry(config, bundleId, job.channel, job.resolvedVersion, build);
      const outputs = {
        'job-id': '',
        'artifact-id': job.artifact?.id ?? '',
        version: job.resolvedVersion,
        'resolved-version': job.resolvedVersion,
        resolved_version: job.resolvedVersion,
        build,
        channel: job.channel,
        is_testflight: String(job.isTestFlight === true),
        'is-testflight': String(job.isTestFlight === true),
        cache_hit: String(job.cacheHit === true),
        'cache-hit': String(job.cacheHit === true),
        sha256: '',
        size_bytes: '',
        'size-bytes': '',
        path: '',
        output: '',
      };
      await writeOutputs(outputFile, outputs);
      log(`Resolved ${job.channel} ${job.resolvedVersion}${job.cacheHit ? ' · cached IPA available' : ''}; no IPA downloaded`);
      await appendWorkflowSummary(config.githubSummary ?? process.env.GITHUB_STEP_SUMMARY, {
        bundleId,
        version: job.resolvedVersion,
        channel: job.channel,
        cacheHit: job.cacheHit === true,
        artifactId: job.artifact?.id,
        sizeBytes: job.artifact?.sizeBytes,
        resolveOnly: true,
      });
      return outputs;
    }
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
    if (summaryContext) Object.assign(summaryContext, {
      bundleId: artifact.bundleId,
      version: artifact.versionLabel ?? '',
      channel: artifact.channel,
      cacheHit: artifact.cacheHit,
      sizeBytes: artifact.sizeBytes,
    });
  }

  if (typeof artifact.id !== 'string' || !artifact.id) throw new Error('dkrypt did not return an artifact ID');
  if (!artifact.buildNumber || !artifact.versionLabel || !artifact.sha256 || !Number.isSafeInteger(artifact.sizeBytes)) {
    const metadata = await client.requestJson(`/v1/artifacts/${encodeURIComponent(artifact.id)}`, { label: `artifact ${artifact.id} metadata` });
    if (metadata.id !== artifact.id) throw new Error('dkrypt returned metadata for a different artifact');
    artifact = { ...artifact, ...metadata };
  }
  if (!['appstore', 'testflight'].includes(artifact.channel)) throw new Error('dkrypt returned an invalid artifact channel');
  if (!artifactModeCount && config.bundleId?.trim()) {
    const locked = await resolveLockedRelease(config, config.bundleId.trim());
    if (locked.entry && (artifact.channel !== locked.entry.source || artifact.versionLabel !== locked.entry.resolvedVersion || (locked.entry.build && String(artifact.buildNumber ?? '') !== locked.entry.build))) {
      throw new Error(`downloaded artifact does not match the dkrypt.lock entry for ${config.bundleId.trim()}`);
    }
  }
  if (summaryContext) Object.assign(summaryContext, {
    bundleId: artifact.bundleId,
    version: artifact.versionLabel ?? '',
    channel: artifact.channel,
    cacheHit: artifactModeCount > 0 || artifact.cacheHit === true,
    sizeBytes: artifact.sizeBytes,
  });
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

  if (!artifactModeCount && config.bundleId?.trim()) {
    const locked = await resolveLockedRelease(config, config.bundleId.trim());
    if (locked.updateLockfile) await writeDkryptLockEntry(config, artifact.bundleId, artifact.channel, artifact.versionLabel, artifact.buildNumber);
  }

  const release = publishToRelease
    ? await (dependencies.publishRelease ?? publishVerifiedIpaToGitHubRelease)({
      token: config.githubToken,
      repository: config.githubRepository,
      apiUrl: config.githubApiUrl,
      tag: config.releaseTag,
      releaseName: config.releaseName,
      releaseNotes: config.releaseNotes,
      createRelease: isEnabled(config.createRelease),
      draft: isEnabled(config.releaseDraft),
      assetName: config.releaseAssetName?.trim() || `${safeFilePart(artifact.bundleId)}-${safeFilePart(artifact.versionLabel ?? artifact.buildNumber ?? artifact.id)}.ipa`,
      filePath: download.outputPath,
      sha256: download.sha256,
      sizeBytes: download.sizeBytes,
    }, {
      fetchImpl: dependencies.githubFetchImpl,
      sleep: dependencies.sleep,
      log,
      maxAttempts: dependencies.githubMaxAttempts,
      requestTimeoutMs: dependencies.githubRequestTimeoutMs,
      uploadTimeoutSeconds: dependencies.githubUploadTimeoutSeconds,
    })
    : undefined;

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
    'release-url': release?.releaseUrl ?? '',
    'release-asset-url': release?.assetUrl ?? '',
  };
  await writeOutputs(outputFile, Object.fromEntries(Object.entries(outputs).filter(([name]) => name !== 'job-id' || !jobId)));
  log(`Downloaded and verified ${artifact.channel} IPA (${download.sizeBytes} bytes, SHA-256 ${download.sha256}) at ${download.outputPath}`);
  await appendWorkflowSummary(config.githubSummary ?? process.env.GITHUB_STEP_SUMMARY, {
    bundleId: artifact.bundleId,
    version: resolvedVersion,
    channel: artifact.channel,
    cacheHit,
    artifactId: artifact.id,
    sizeBytes: download.sizeBytes,
    path: download.outputPath,
    releaseUrl: release?.releaseUrl,
  });
  return outputs;
}

export async function runAction(config, dependencies = {}) {
  const summaryContext = {};
  try {
    return await runSingleAction(config, { ...dependencies, summaryContext });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 500);
    await appendWorkflowSummary(config.githubSummary ?? process.env.GITHUB_STEP_SUMMARY, {
      bundleId: summaryContext.bundleId ?? config.bundleId?.trim() ?? 'dkrypt operation',
      version: summaryContext.version ?? config.version?.trim() ?? '',
      channel: summaryContext.channel ?? 'Unknown',
      cacheHit: summaryContext.cacheHit,
      sizeBytes: summaryContext.sizeBytes,
      status: 'failure',
      error: message,
    });
    throw error;
  }
}

function parseBundleIds(value) {
  let values = value;
  if (typeof values === 'string') {
    try {
      values = JSON.parse(values);
    } catch {
      throw new Error('bundle-ids must be a JSON array of bundle identifiers');
    }
  }
  if (!Array.isArray(values) || values.length < 1 || values.length > 20 || values.some((bundleId) => typeof bundleId !== 'string' || !BUNDLE_ID_RE.test(bundleId.trim()))) {
    throw new Error('bundle-ids must contain 1 to 20 valid bundle identifiers');
  }
  const unique = [...new Set(values.map((bundleId) => bundleId.trim()))];
  if (unique.length !== values.length) throw new Error('bundle-ids cannot contain duplicates');
  return unique;
}

function readOutputs(contents) {
  return Object.fromEntries(contents.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

export async function runBatchAction(config, dependencies = {}) {
  const bundleIds = parseBundleIds(config.bundleIds);
  if (config.bundleId?.trim()) throw new Error('choose either bundle-id or bundle-ids');
  if (config.artifactId?.trim() || config.latestCachedChannel?.trim()) {
    throw new Error('bundle-ids cannot be combined with artifact download inputs');
  }
  const outputFile = config.githubOutput ?? process.env.GITHUB_OUTPUT;
  if (!outputFile) throw new Error('GITHUB_OUTPUT is unavailable');
  const directory = config.output?.trim() ? path.resolve(config.output.trim()) : process.cwd();
  await mkdir(directory, { recursive: true });
  const results = [];

  for (const bundleId of bundleIds) {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dkrypt-action-app-'));
    const temporaryOutput = path.join(temporaryDirectory, 'outputs');
    const resolveOnly = isEnabled(config.resolveOnly);
    const output = resolveOnly ? '' : path.join(directory, `${safeFilePart(bundleId)}.ipa`);
    try {
    const result = await runAction({
        ...config,
        bundleId,
        bundleIds: undefined,
        output,
        githubOutput: temporaryOutput,
        githubSummary: '',
      }, {
        ...dependencies,
        ...(dependencies.idempotencyKey ? { idempotencyKey: `${dependencies.idempotencyKey}:${bundleId}` } : {}),
      });
      const outputs = readOutputs(await readFile(temporaryOutput, 'utf8'));
      results.push({
        bundleId,
        status: 'success',
        jobId: outputs['job-id'] || undefined,
        artifactId: outputs['artifact-id'] || undefined,
        version: outputs.version,
        build: outputs.build || undefined,
        channel: outputs.channel,
        isTestFlight: outputs.is_testflight === 'true',
        cacheHit: outputs.cache_hit === 'true',
        sha256: outputs.sha256 || undefined,
        sizeBytes: outputs.size_bytes ? Number(outputs.size_bytes) : undefined,
        path: outputs.path || undefined,
        releaseUrl: outputs['release-url'] || undefined,
        releaseAssetUrl: outputs['release-asset-url'] || undefined,
        resolveOnly,
      });
      if (result.path) process.stdout.write(`Completed ${bundleId}: ${result.path}\n`);
    } catch (error) {
      results.push({
        bundleId,
        status: 'failure',
        channel: config.channel ?? 'appstore',
        resolveOnly,
        error: String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 500),
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  const successCount = results.filter((result) => result.status === 'success').length;
  const failureCount = results.length - successCount;
  await writeOutputs(outputFile, {
    'job-id': '',
    'artifact-id': '',
    version: '',
    'resolved-version': '',
    'resolved_version': '',
    build: '',
    channel: '',
    is_testflight: '',
    'is-testflight': '',
    cache_hit: '',
    'cache-hit': '',
    sha256: '',
    size_bytes: '',
    'size-bytes': '',
    path: '',
    output: '',
    'release-url': '',
    'release-asset-url': '',
    'results-json': JSON.stringify(results),
    'success-count': String(successCount),
    'failure-count': String(failureCount),
  });
  await appendBatchSummary(config.githubSummary ?? process.env.GITHUB_STEP_SUMMARY, results);
  if (failureCount > 0) throw new Error(`${failureCount} of ${results.length} dkrypt app operations failed`);
  return { results, successCount, failureCount };
}

async function main() {
  const config = {
    apiUrl: process.env.DKRYPT_API_URL ?? '',
    apiKey: process.env.DKRYPT_API_KEY ?? '',
    bundleId: process.env.DKRYPT_BUNDLE_ID ?? '',
    bundleIds: process.env.DKRYPT_BUNDLE_IDS ?? '',
    version: process.env.DKRYPT_VERSION ?? '',
    channel: process.env.DKRYPT_CHANNEL ?? '',
    lockfile: process.env.DKRYPT_LOCKFILE ?? '',
    updateLockfile: process.env.DKRYPT_UPDATE_LOCKFILE ?? '',
    output: process.env.DKRYPT_OUTPUT ?? '',
    artifactId: process.env.DKRYPT_ARTIFACT_ID ?? '',
    latestCachedChannel: process.env.DKRYPT_LATEST_CACHED_CHANNEL ?? '',
    resolveOnly: process.env.DKRYPT_RESOLVE_ONLY ?? '',
    timeoutSeconds: process.env.DKRYPT_TIMEOUT_SECONDS ?? '1800',
    downloadTimeoutSeconds: process.env.DKRYPT_DOWNLOAD_TIMEOUT_SECONDS ?? '600',
    publishToRelease: process.env.DKRYPT_PUBLISH_TO_RELEASE ?? '',
    githubToken: process.env.DKRYPT_GITHUB_TOKEN ?? '',
    githubRepository: process.env.GITHUB_REPOSITORY ?? '',
    githubApiUrl: process.env.GITHUB_API_URL ?? '',
    releaseTag: process.env.DKRYPT_RELEASE_TAG ?? '',
    releaseName: process.env.DKRYPT_RELEASE_NAME ?? '',
    releaseNotes: process.env.DKRYPT_RELEASE_NOTES ?? '',
    createRelease: process.env.DKRYPT_CREATE_RELEASE ?? '',
    releaseDraft: process.env.DKRYPT_RELEASE_DRAFT ?? '',
    releaseAssetName: process.env.DKRYPT_RELEASE_ASSET_NAME ?? '',
  };
  return config.bundleIds.trim() ? runBatchAction(config) : runAction(config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
