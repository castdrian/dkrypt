import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '#config.js';
import { emitJobsChanged } from '#events.js';
import { scopedLogger } from '#logger.js';
import { getUserPrefs, recordDeviceActivity, type DeviceRecord } from '#store/state.js';
import { buildAppStoreOperationId, installFromAppStore } from '#appStoreInstall.js';
import { installBuild } from '#testflight.js';
import { getDeviceHealth, getDeviceInstallBlocker } from '#deviceHealth.js';
import { lookupCurrentVersion, type ItunesLookupResult } from '#appStoreMetadata.js';
import { extractIpaMetadata } from '#util/ipaMetadata.js';
import type { ExtractedIpaMetadata } from '#util/ipaMetadata.js';
import { classifyIpaDecryptOutput } from '#util/ipadecryptOutput.js';
import { artifactKeyForJob, promoteArtifact } from '#artifacts.js';
import { withIpadecrypt } from '#idevice.js';
import { terminateChildProcess } from '#jobs/process.js';
import { currentCorrelation, withCorrelation } from '#correlation.js';
import { startSpan } from '#telemetry.js';
import { abortedOperationError, throwIfAborted } from '#util/abort.js';
import { offlineAppStoreProcessor } from '#offlineAppStore.js';
import { resolveJobNotificationChannels } from '#appNotificationPreferences.js';
import { sendPushToUser } from '#push.js';

const log = scopedLogger('jobs');
import { appendJobTimelineEvent, type Job, type JobExecutionStage } from '#jobs/types.js';

export async function runDecrypt(job: Job, device: DeviceRecord, signal?: AbortSignal): Promise<void> {
  const parentContext = currentCorrelation();
  const span = startSpan('job.decrypt', { 'job.id': job.id, 'job.bundle_id': job.bundleId, 'job.device_id': device.id }, parentContext?.traceContext);
  return withCorrelation({
    correlationId: parentContext?.correlationId ?? job.correlationId ?? job.id,
    parentCorrelationId: parentContext?.parentCorrelationId ?? job.parentCorrelationId,
    traceId: span.context.traceId,
    traceContext: span.context,
  }, async () => {
    try {
      await runDecryptOperation(job, device, signal);
      span.end();
    } catch (error) {
      if (job.filePath?.includes('/.staging/')) await rm(job.filePath, { force: true }).catch(() => {});
      span.end(error);
      throw error;
    } finally {
      if (job.executionStage !== undefined) {
        job.executionStage = undefined;
        emitJobsChanged();
      }
    }
  });
}

async function runDecryptOperation(job: Job, device: DeviceRecord, signal?: AbortSignal): Promise<void> {
  const recordTimeline = (label: string) => appendJobTimelineEvent(job, label, 'running');
  const setExecutionStage = (executionStage: JobExecutionStage) => {
    if (job.executionStage === executionStage) return;
    job.executionStage = executionStage;
    emitJobsChanged();
  };

  const ensureNotCancelled = () => {
    if (job.cancelledBy) throw new Error(`cancelled by ${job.cancelledBy}`);
    throwIfAborted(signal);
    if (job.deadlineExceeded || (job.deadlineAt !== undefined && Date.now() >= job.deadlineAt)) {
      job.deadlineExceeded = true;
      throw new Error('job deadline exceeded');
    }
  };

  setExecutionStage('preparing');
  ensureNotCancelled();
  job.warnings = undefined;
  const health = await getDeviceHealth(device.id, true, signal);
  ensureNotCancelled();
  let currentAppStoreVersion: ItunesLookupResult | undefined;
  if (!job.testflight && !job.externalVersionId) {
    try {
      currentAppStoreVersion = await lookupCurrentVersion(job.bundleId, signal);
    } catch (err) {
      ensureNotCancelled();
      log.warn('could not resolve current App Store file size before install', { bundleId: job.bundleId, error: String(err) });
    }
  }
  ensureNotCancelled();
  const installBlocker = getDeviceInstallBlocker(health, job.testflight?.build.fileSize ?? currentAppStoreVersion?.fileSizeBytes, job.testflight ? 'testflight' : 'appstore');
  if (installBlocker) throw new Error(`decrypt deferred: ${installBlocker}`);
  const stagingDir = path.join(config.artifactDir, '.staging');
  await mkdir(stagingDir, { recursive: true });
  const outputPath = path.join(stagingDir, `${job.id}-${job.workerAttemptId ?? job.attempt ?? 'attempt'}.ipa`);
  job.filePath = outputPath;
  job.deviceId = device.id;

  let lastActivityStage = '';
  let lastPushStage = '';
  const report = (message: string) => {
    job.progress = message;
    recordTimeline(message);
    const stage = /foreground/i.test(message)
      ? 'Foregrounding App Store'
      : /TestFlight is running/i.test(message)
        ? 'Foregrounding TestFlight'
        : /install/i.test(message)
          ? 'Installing app build'
          : /decrypt/i.test(message)
            ? 'Decrypting app bundle'
            : '';
    if (stage && stage !== lastActivityStage) {
      lastActivityStage = stage;
      recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: stage });
    }
    if (stage && stage !== lastPushStage && job.queuedBy) {
      lastPushStage = stage;
      if (resolveJobNotificationChannels(getUserPrefs(job.queuedBy), job.bundleId, 'success').push) {
        const jobUrl = `/?job=${encodeURIComponent(job.id)}`;
        void sendPushToUser(job.queuedBy, {
          title: 'Decrypt in progress',
          body: `${job.bundleId} · ${stage}`,
          url: jobUrl,
          jobUrl,
          tag: `dkrypt-job-${job.id}`,
          silent: true,
          renotify: false,
          actions: [{ action: 'open-job', title: 'View progress' }],
        });
      }
    }
    emitJobsChanged();
  };

  report(`autoinstall transaction ${job.id}`);

  setExecutionStage('installing');
  if (job.testflight) {
    await installBuild(job.testflight.appId, job.testflight.build, report, undefined, job.id, undefined, device, signal);
  } else {
    const installed = await installFromAppStore(job.bundleId, {
      externalVersionId: job.externalVersionId,
      expectedVersion: job.externalVersionId ? job.versionLabel : undefined,
      operationId: buildAppStoreOperationId(job.id, job.retryCount ?? 0),
      onProgress: report,
      isCancelled: () => Boolean(job.cancelledBy || job.deadlineExceeded),
      currentVersion: currentAppStoreVersion,
      device,
      signal,
    });
    if (installed.shortVersion) job.versionLabel = installed.shortVersion;
  }

  ensureNotCancelled();
  setExecutionStage('preparing');

  await withIpadecrypt(device, async (runtimeDir) => {
    ensureNotCancelled();
    const args = ['--root-dir', runtimeDir, 'decrypt', job.bundleId, '--use-installed', '--output', outputPath];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(config.ipadecryptBin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      job.childProcess = child;
      child.once('spawn', () => {
        setExecutionStage('decrypting');
        report('Decrypting app bundle');
      });
      const abortChild = () => terminateChildProcess(child, 'SIGTERM');
      signal?.addEventListener('abort', abortChild, { once: true });
      if (signal?.aborted) abortChild();

      let output = '';

      const onOutput = (chunk: Buffer) => {
        const rawText = chunk.toString('utf8');
        output += rawText;
        const text = rawText.trim();
        if (!text) return;
        const lines = text.split('\n');
        const lastLine = lines.at(-1) ?? text;
        job.progress = lastLine;
        recordTimeline(lastLine);
        log.info('ipadecrypt output', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, line: lastLine });
        emitJobsChanged();
      };

      child.stdout.on('data', onOutput);
      child.stderr.on('data', onOutput);

      child.on('error', (err) => {
        signal?.removeEventListener('abort', abortChild);
        if (job.childProcess === child) job.childProcess = undefined;
        setExecutionStage('finalizing');
        reject(err);
      });

      child.once('exit', () => setExecutionStage('finalizing'));

      child.on('close', (code) => {
        signal?.removeEventListener('abort', abortChild);
        if (job.childProcess === child) job.childProcess = undefined;
        setExecutionStage('finalizing');
        if (signal?.aborted) {
          reject(abortedOperationError(signal));
          return;
        }
        const result = classifyIpaDecryptOutput(output);
        if (job.cancelledBy) {
          reject(new Error(`cancelled by ${job.cancelledBy}`));
        } else if (result.extensionOnly) {
          job.warnings = result.warnings;
          for (const warning of result.warnings) appendJobTimelineEvent(job, `Warning: ${warning}`, 'done');
          log.warn('ipadecrypt completed with extension warnings', {
            jobId: job.id,
            bundleId: job.bundleId,
            deviceId: device.id,
            encryptedPaths: result.encryptedPaths,
          });
          emitJobsChanged();
          resolve();
        } else if (code === 0 && !result.error && result.encryptedPaths.length === 0) {
          resolve();
        } else {
          reject(new Error(result.error ?? `ipadecrypt exited with code ${code}: ${job.progress}`));
        }
      });
    });
  }, signal);

  await finalizeDecryptedIpa(job, outputPath, signal, ensureNotCancelled);
}

export async function runOfflineAppStoreDecrypt(job: Job, signal?: AbortSignal, reportActivity: () => void = () => {}): Promise<void> {
  const parentContext = currentCorrelation();
  const span = startSpan('job.decrypt.offline_appstore', { 'job.id': job.id, 'job.bundle_id': job.bundleId }, parentContext?.traceContext);
  return withCorrelation({
    correlationId: parentContext?.correlationId ?? job.correlationId ?? job.id,
    parentCorrelationId: parentContext?.parentCorrelationId ?? job.parentCorrelationId,
    traceId: span.context.traceId,
    traceContext: span.context,
  }, async () => {
    const setExecutionStage = (stage: JobExecutionStage) => {
      if (job.executionStage === stage) return;
      job.executionStage = stage;
      reportActivity();
      emitJobsChanged();
    };
    const ensureNotCancelled = () => {
      if (job.cancelledBy) throw new Error(`cancelled by ${job.cancelledBy}`);
      throwIfAborted(signal);
      if (job.deadlineExceeded || (job.deadlineAt !== undefined && Date.now() >= job.deadlineAt)) {
        job.deadlineExceeded = true;
        throw new Error('job deadline exceeded');
      }
    };
    try {
      ensureNotCancelled();
      job.warnings = undefined;
      job.executionPath = 'appstore_offline';
      job.progress = 'Downloading the App Store package on the server';
      appendJobTimelineEvent(job, 'Server-side App Store download started', 'running');
      emitJobsChanged();
      setExecutionStage('offline_download');
      reportActivity();
      const result = await offlineAppStoreProcessor.run(job, signal, setExecutionStage, reportActivity);
      ensureNotCancelled();
      job.filePath = result.outputPath;
      job.warnings = result.warnings.length > 0 ? result.warnings : undefined;
      for (const warning of result.warnings) appendJobTimelineEvent(job, `Warning: ${warning}`, 'done');
      job.progress = 'Verifying and saving the server-decrypted IPA';
      appendJobTimelineEvent(job, 'Server-side FairPlay decryption verified', 'running');
      setExecutionStage('finalizing');
      await finalizeDecryptedIpa(job, result.outputPath, signal, ensureNotCancelled, result.metadata);
      span.end();
    } catch (error) {
      if (job.filePath?.includes('/.staging/')) await rm(job.filePath, { force: true }).catch(() => {});
      span.end(error);
      throw error;
    } finally {
      job.executionStage = undefined;
      emitJobsChanged();
    }
  });
}

async function finalizeDecryptedIpa(
  job: Job,
  outputPath: string,
  signal: AbortSignal | undefined,
  ensureNotCancelled: () => void,
  extractedMetadata?: ExtractedIpaMetadata,
): Promise<void> {
  ensureNotCancelled();
  const st = await stat(outputPath);
  job.fileSizeBytes = st.size;

  try {
    const metadata = extractedMetadata ?? await extractIpaMetadata(outputPath);
    job.ipaMetadata = metadata.summary;
    job.ipaInfoPlist = metadata.infoPlist;
  } catch (err) {
    log.warn('failed to extract IPA metadata', { jobId: job.id, bundleId: job.bundleId, error: String(err) });
  }

  ensureNotCancelled();
  const artifact = await promoteArtifact({
    key: artifactKeyForJob(job),
    bundleId: job.bundleId,
    channel: job.testflight ? 'testflight' : 'appstore',
    externalVersionId: job.externalVersionId,
    testflightBuildId: job.testflight?.build.id,
    versionLabel: job.ipaMetadata?.shortVersion ?? job.testflight?.build.cfBundleShortVersion ?? job.versionLabel,
    buildNumber: job.ipaMetadata?.bundleVersion ?? job.testflight?.build.cfBundleVersion,
    stagingPath: outputPath,
    sourceJobId: job.id,
    warnings: job.warnings,
    projectId: job.projectId,
    signal,
  });
  job.artifactId = artifact.id;
  job.filePath = artifact.filePath;
  job.fileSizeBytes = artifact.fileSizeBytes;
  job.sha256 = artifact.sha256;
}
