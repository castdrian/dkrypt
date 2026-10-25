import type { Response } from '#http.js';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { scopedLogger } from '#logger.js';

const log = scopedLogger('jobs');
import { getJobQueueSummaries, getQueueReason } from '#jobs/store.js';
import type { Job } from '#jobs/types.js';
import { artifactDownloadName, artifactFileAvailable, getArtifactForJob, touchArtifact } from '#artifacts.js';

interface CloseAwareRequest {
  headers: { range?: string | string[] };
  on(event: 'aborted', listener: () => void): unknown;
}

interface ByteRange {
  start: number;
  end: number;
}

function parseByteRange(value: string | string[] | undefined, size: number): ByteRange | undefined | null {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || value.length > 200 || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function jobFileAvailable(job: Job | undefined): boolean {
  if (!job || job.status !== 'done') return false;
  const artifact = getArtifactForJob(job);
  if (artifact) return artifactFileAvailable(artifact);
  return !!job.filePath && existsSync(job.filePath);
}

export function jobSummary(job: Job) {
  const queue = getJobQueueSummaries([job]).get(job.id);
  return {
    id: job.id,
    correlationId: job.correlationId ?? job.id,
    bundleId: job.bundleId,
    externalVersionId: job.externalVersionId,
    testflight: job.testflight
      ? { appId: job.testflight.appId, buildId: job.testflight.build.id, version: job.testflight.build.cfBundleShortVersion, buildNumber: job.testflight.build.cfBundleVersion }
      : undefined,
    versionLabel: job.versionLabel,
    minimumOsVersion: job.minimumOsVersion,
    source: job.source,
    channel: job.testflight ? 'testflight' : 'appstore',
    queuedBy: job.queuedBy,
    priority: job.priority,
    deviceId: job.deviceId,
    preferredDeviceId: job.preferredDeviceId,
    transport: job.transport,
    executionPath: job.executionPath,
    offlineAttemptedAt: job.offlineAttemptedAt,
    offlineAttemptDurationMs: job.offlineAttemptDurationMs,
    offlineDeviceFallbackStartedAt: job.offlineDeviceFallbackStartedAt,
    deviceFallbackDurationMs: job.deviceFallbackDurationMs,
    offlineFailureReason: job.offlineFailureReason,
    offlineCompatibility: job.offlineCompatibility,
    attempt: job.attempt,
    retryCount: job.retryCount,
    deadlineAt: job.deadlineAt ? new Date(job.deadlineAt).toISOString() : undefined,
    deadlineExceeded: job.deadlineExceeded,
    failureClass: job.failureClass,
    status: job.status,
    pausedAt: job.pausedAt,
    progress: job.progress,
    warnings: job.warnings,
    error: job.error,
    artifactId: job.artifactId,
    artifactUrl: job.artifactId
      ? `/v1/artifacts/${encodeURIComponent(job.artifactId)}/file`
      : undefined,
    cacheHit: job.cacheHit,
    sizeBytes: job.fileSizeBytes,
    sha256: job.sha256,
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
    queue,
    queueReason: job.queueReason ?? getQueueReason(job),
    statusUrl: `/v1/jobs/${job.id}`,
  };
}

export async function streamFilePath(
  filePath: string,
  req: CloseAwareRequest,
  res: Response,
  filename: string,
  fileSizeBytes: number | undefined,
  contextId: string,
): Promise<void> {
  const size = fileSizeBytes ?? (await stat(filePath)).size;
  const range = parseByteRange(req.headers.range, size);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Accept-Ranges', 'bytes');

  if (range === null) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).setHeader('Content-Length', '0').send(null);
    return;
  }

  if (range) {
    const length = range.end - range.start + 1;
    res.status(206)
      .setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      .setHeader('Content-Length', String(length));
  } else {
    res.setHeader('Content-Length', String(size));
  }

  const stream = range ? createReadStream(filePath, { start: range.start, end: range.end }) : createReadStream(filePath);

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    stream.on('error', (err) => {
      log.error('file stream error', { contextId, error: String(err) });
      if (!res.headersSent) res.status(500).json({ error: 'failed to read decrypted file' });
      finish();
    });

    stream.on('end', finish);
    stream.on('close', finish);
    req.on('aborted', () => {
      stream.destroy();
      finish();
    });
    res.reply.raw.on('close', () => {
      if (!res.reply.raw.writableFinished) stream.destroy();
      finish();
    });

    res.reply.hijack();
    stream.pipe(res.raw);
  });
}

export async function streamJobFile(job: Job, req: CloseAwareRequest, res: Response): Promise<void> {
  const artifact = getArtifactForJob(job);
  const filePath = artifact?.filePath ?? job.filePath;
  if (!jobFileAvailable(job) || !filePath) {
    res.status(409).json(jobSummary(job));
    return;
  }

  if (artifact) await touchArtifact(artifact);

  await streamFilePath(
    filePath,
    req,
    res,
    artifact ? artifactDownloadName(artifact) : `${job.bundleId}.ipa`,
    artifact?.fileSizeBytes ?? job.fileSizeBytes,
    job.id,
  );
}
