import { randomUUID } from 'node:crypto';
import { trackBackgroundWork } from '#backgroundWork.js';
import { deliverCompletedArtifact } from '#artifactDelivery.js';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolveJobNotificationChannels } from '#appNotificationPreferences.js';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '#config.js';
import { getBillingEntitlements, setBillingEntitlementChangeHandler } from '#billing.js';
import { emitJobsChanged } from '#events.js';
import { scopedLogger } from '#logger.js';

const log = scopedLogger('jobs');
import { sendMailToUser } from '#mail.js';
import { sendPushToUser } from '#push.js';
import { DEFAULT_PROJECT_ID, deleteJobHistoryEntry, getAccountJobQuotaLimits, getAllJobHistory, getApiKeyById, getDevice, getEffectiveDevices, getTestFlightCatalogCache, getUserEffectivePermissions, getUserPrefs, hasManuallyAssignedPermission, recordDecryptQuotaThresholdNotice, recordDeviceActivity, recordJobHistory, updateDevice, type DeviceRecord } from '#store/state.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { uninstallFromDevice } from '#appStoreInstall.js';
import { getCachedDeviceHealth } from '#deviceHealthCache.js';
import { runDecrypt, runOfflineAppStoreDecrypt } from '#jobs/runner.js';
import { appendJobTimelineEvent, type Job, type JobSource, type TestFlightJobSource } from '#jobs/types.js';
import { effectiveQueuePriority, sortQueuedByEffectivePriority } from '#jobs/fairQueue.js';
import { artifactDownloadName, artifactKeyForJob, buildDashboardArtifactFileUrl, getArtifactById, getArtifactByKey, getArtifactForJob, linkArtifactToProject, migrateLegacyPath, promoteArtifact, type ArtifactRecord } from '#artifacts.js';
import { admitPersistedJob, claimPersistedJobWorker, closePersistedJobs, countPersistedActiveWorkers, countPersistedRunningJobs, deletePersistedJob, findPersistedActiveJobId, findPersistedJobById, findPersistedReusableCompletedJobIds, getDecryptQuotaUsage, getFreeDecryptQuotaUsage, heartbeatPersistedWorker, isPersistedWorkerResourceActive, listPersistedExpiredRunningJobs, listPersistedWorkers, loadPersistedActiveJobs, loadPersistedJobs, markPersistedWorkerOffline, mergeDecryptQuotaOwner, registerPersistedWorker, requeuePersistedExpiredRunningJob, reconcileDecryptQuota, releasePersistedJobWorker, releasePersistedWorkersById, renewPersistedJobWorker, replacePersistedJobs, requestPersistedJobCancellation, setPersistedWorkerDrain, settleDecryptQuota, sharedOfflineWorkerCapacity, workerRuntimeConfigurationConsistent, type JobBuildLookup, type JobWorkerLease, type WorkerRuntimeConfiguration } from '#jobs/repository.js';
import { terminateChildProcess } from '#jobs/process.js';
import { assessQueueServiceObjective, completedJobDurationP95Ms, projectCompletedJobDurationP95Ms, queueServiceObjectiveBreachDescription, queueServiceObjectiveMs } from '#jobs/slo.js';
import { classifyJobFailure } from '#util/failureCategory.js';
import { incrementMetric, observeMetric } from '#metrics.js';
import { recordJobStarted, shouldRecordOfflineDeviceHandoff } from '#jobs/metrics.js';
import { currentCorrelation, withCorrelation } from '#correlation.js';
import { EMBED_COLOR, notify } from '#notify.js';
import { runWithJobDeadline } from '#jobs/deadline.js';
import { SCHEDULER_JOB_TIMEOUT_MS } from '#jobs/timeouts.js';
import { delayWithSignal } from '#util/abort.js';
import { getJobDeviceBlocker, minimumOsVersionForBuild } from '#jobs/deviceDispatch.js';
import { OfflineAppStoreUnsupportedPackageError, offlineAppStoreProcessor, setOfflineAppStoreDispatchNotifier } from '#offlineAppStore.js';
import { computeOfflineAttemptBudgetMs, OfflineAppStoreCircuitBreaker, runWithOfflineAttemptTimeout } from '#jobs/offlineAppStorePolicy.js';
import { createPickupUrl, EMAIL_PICKUP_LINK_TTL_MS } from '#pickupLinks.js';

const jobs = new Map<string, Job>();

const donePath = path.join(config.stateDir, 'done-jobs.json');
const activePath = path.join(config.stateDir, 'active-jobs.json');
const queue: string[] = [];
const busyDeviceIds = new Set<string>();
const busyWorkerResourceIds = new Set<string>();
const runningJobs = new Map<string, Promise<void>>();
const runningJobControllers = new Map<string, AbortController>();
const workerInstanceId = randomUUID();
const workerLeases = new Map<string, { lease: JobWorkerLease; timer: ReturnType<typeof setInterval> }>();
const lostWorkerLeaseJobIds = new Set<string>();
const queuedDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
const deferredDeviceAttempts = new Map<string, { deviceId: string; reason: string; healthCheckedAt: number }>();
const queueSloNotified = new Set<string>();
const offlineAppStoreCircuit = new OfflineAppStoreCircuitBreaker(
  config.appStoreOfflineCircuitFailureThreshold,
  config.appStoreOfflineCircuitCooldownSeconds * 1000,
);
let deviceWearCache: { expiresAt: number; jobsInLastDay: Map<string, number> } | undefined;
let offlineCircuitProbeTimer: ReturnType<typeof setTimeout> | undefined;
let acceptingJobs = true;
let jobSyncTimer: ReturnType<typeof setInterval> | undefined;
let lastJobSyncAt = 0;
let syncingPersistedJobs = false;
let jobStoreClosed = false;
let workerRegistered = false;
const JOB_SYNC_INTERVAL_MS = 1_000;
const JOB_SYNC_THROTTLE_MS = 250;
const WORKER_LEASE_MS = 60_000;
const WORKER_LEASE_HEARTBEAT_MS = 15_000;
function workerRuntimeConfiguration(): WorkerRuntimeConfiguration {
  return {
    runtimeVersion: process.version,
    offlineConcurrency: config.appStoreOfflineMaxWorkers,
    maxJobWaitSeconds: config.jobMaxWaitSeconds,
    maxRetries: config.jobMaxRetries,
    databaseBusyTimeoutMs: config.stateDbBusyTimeoutMs,
  };
}

function refreshWorkerInstance(): void {
  const runtimeConfiguration = workerRuntimeConfiguration();
  if (!workerRegistered) {
    registerPersistedWorker(workerInstanceId, runtimeConfiguration);
    workerRegistered = true;
  }
  heartbeatPersistedWorker(workerInstanceId, runtimeConfiguration);
}

function serializableJob(job: Job): Omit<Job, 'childProcess' | 'waiters'> {
  const { childProcess: _childProcess, waiters: _waiters, ...rest } = job;
  return rest;
}

function captureJobCorrelation(): Pick<Job, 'parentCorrelationId' | 'traceContext'> {
  const context = currentCorrelation();
  return { parentCorrelationId: context?.correlationId, traceContext: context?.traceContext };
}

function deadlineDurationMs(source: JobSource): number {
  return source === 'scheduler' ? SCHEDULER_JOB_TIMEOUT_MS : config.jobMaxWaitSeconds * 1000;
}

function extendJobDeadlineForScheduler(job: Job): void {
  if (job.deadlineExceeded) return;
  const schedulerDeadlineAt = job.schedulerDeadlineAt
    ?? (job.source === 'scheduler' ? job.createdAt : Date.now()) + SCHEDULER_JOB_TIMEOUT_MS;
  const deadlineAt = Math.max(job.deadlineAt ?? 0, schedulerDeadlineAt);
  const schedulerDeadlineChanged = job.schedulerDeadlineAt !== schedulerDeadlineAt;
  const deadlineChanged = job.deadlineAt !== deadlineAt;
  if (!schedulerDeadlineChanged && !deadlineChanged) return;

  job.schedulerDeadlineAt = schedulerDeadlineAt;
  if (deadlineChanged) {
    job.deadlineAt = deadlineAt;
    if (job.status === 'queued') scheduleQueuedDeadline(job);
  }
  persistActiveJobs();
  emitJobsChanged();
}

function writeLegacyMirror(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600 });
  const descriptor = openSync(temporaryPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, filePath);
}

function persistDoneJobs(): void {
  const done = [...jobs.values()]
    .filter((j) => j.status === 'done')
    .map(serializableJob);
  writeLegacyMirror(donePath, done);
  if (replacePersistedJobs(jobs.values(), workerInstanceId).length > 0) syncPersistedJobsFromRepository(true);
}

function persistActiveJobs(): void {
  const active = [...jobs.values()]
    .filter((j) => j.status === 'queued' || j.status === 'running')
    .map(serializableJob);
  writeLegacyMirror(activePath, active);
  if (replacePersistedJobs(jobs.values(), workerInstanceId).length > 0) syncPersistedJobsFromRepository(true);
}

function loadDoneJobs(): void {
  if (!existsSync(donePath)) return;
  try {
    const restored = JSON.parse(readFileSync(donePath, 'utf8')) as Job[];
    for (const job of restored) {
      job.filePath = migrateLegacyPath(job.filePath);
      if (job.freeTierResult && job.temporaryResultExpiresAt === undefined) {
        job.temporaryResultExpiresAt = (job.finishedAt ?? job.createdAt) + 30 * 60_000;
      }
      if (job.freeTierResult && job.temporaryResultExpiresAt !== undefined && job.temporaryResultExpiresAt <= Date.now()) {
        if (job.filePath && !job.temporaryResultSharedCache && !job.artifactId) void rm(job.filePath, { force: true }).catch(() => {});
        deletePersistedJob(job.id);
        deleteJobHistoryEntry(job.id);
        continue;
      }
      if (!job.filePath || !existsSync(job.filePath)) continue;
      jobs.set(job.id, { ...job, projectId: job.projectId ?? DEFAULT_PROJECT_ID, waiters: [] });
      if (job.freeTierResult) recordJobHistory(toHistoryEntry({ ...job, waiters: [] }));
    }
    log.info('restored completed jobs from previous process', { count: jobs.size });
  } catch (err) {
    throw new Error(`could not restore done jobs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function requeueAfterGracefulShutdown(job: Job, now = Date.now()): Job {
  const isSchedulerJob = job.source === 'scheduler' || job.schedulerDeadlineAt !== undefined;
  const requeuedDeadlineAt = now + deadlineDurationMs(isSchedulerJob ? 'scheduler' : 'manual');
  const requeued = {
    ...job,
    status: 'queued' as const,
    progress: 'queued after graceful shutdown',
    error: undefined,
    failureClass: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    deadlineExceeded: false,
    deadlineAt: requeuedDeadlineAt,
    schedulerDeadlineAt: isSchedulerJob ? requeuedDeadlineAt : undefined,
    shutdownRecoveryPending: undefined,
    shutdownRecoveryAt: now,
    executionStage: undefined,
    workerAttemptId: undefined,
    childProcess: undefined,
  };
  appendJobTimelineEvent(requeued, 'Requeued after graceful shutdown', 'queued', now);
  return requeued;
}

function persistShutdownRecovery(job: Job): void {
  Object.assign(job, requeueAfterGracefulShutdown(job));
  insertByPriority(job.id, job.priority);
  persistActiveJobs();
  emitJobsChanged();
}

export function recoverPersistedActiveJobs(saved: Job[], now = Date.now()): { queued: Job[]; interrupted: Job[] } {
  const queued: Job[] = [];
  const interrupted: Job[] = [];
  for (const job of saved) {
    const restored = { ...job, projectId: job.projectId ?? DEFAULT_PROJECT_ID, executionStage: undefined, childProcess: undefined, waiters: [] };
    if (restored.status === 'queued') {
      if (restored.source === 'scheduler' && restored.pausedAt === undefined) {
        const schedulerDeadlineAt = restored.createdAt + SCHEDULER_JOB_TIMEOUT_MS;
        restored.schedulerDeadlineAt ??= schedulerDeadlineAt;
        restored.deadlineAt = restored.schedulerDeadlineAt;
      }
      queued.push(restored);
      continue;
    }
    if (restored.status === 'running') {
      if (restored.shutdownRecoveryPending) {
        queued.push(requeueAfterGracefulShutdown(restored, now));
        continue;
      }
      interrupted.push({
        ...restored,
        status: 'failed',
        progress: 'interrupted by dkrypt restart',
        error: 'interrupted by dkrypt restart',
        finishedAt: now,
      });
    }
  }
  return { queued, interrupted };
}

function loadActiveJobs(): void {
  if (!existsSync(activePath)) return;
  try {
    const saved = JSON.parse(readFileSync(activePath, 'utf8')) as Job[];
    const { queued, interrupted } = recoverPersistedActiveJobs(saved);
    for (const job of queued) {
      jobs.set(job.id, job);
      if (job.pausedAt === undefined) {
        insertByPriority(job.id, job.priority);
        scheduleQueuedDeadline(job);
      }
    }
    for (const job of interrupted) recordJobHistory(toHistoryEntry(job));
    persistActiveJobs();
    if (queued.length > 0 || interrupted.length > 0) {
      log.warn('recovered jobs after dkrypt restart', { queued: queued.length, interrupted: interrupted.length });
    }
  } catch (err) {
    throw new Error(`could not restore active jobs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadDatabaseJobs(): boolean {
  const saved = loadPersistedJobs();
  if (saved.length === 0) return false;
  for (const job of saved.filter((entry) => entry.status === 'done' || entry.status === 'failed')) {
    job.filePath = migrateLegacyPath(job.filePath);
      if (job.freeTierResult && job.temporaryResultExpiresAt === undefined) {
        job.temporaryResultExpiresAt = (job.finishedAt ?? job.createdAt) + 30 * 60_000;
      }
    if (job.freeTierResult && job.temporaryResultExpiresAt !== undefined && job.temporaryResultExpiresAt <= Date.now()) {
      if (job.filePath && !job.temporaryResultSharedCache && !job.artifactId) void rm(job.filePath, { force: true }).catch(() => {});
      deletePersistedJob(job.id);
      deleteJobHistoryEntry(job.id);
      continue;
    }
    if (job.status === 'done' && job.filePath && !existsSync(job.filePath)) job.filePath = undefined;
    jobs.set(job.id, { ...job, projectId: job.projectId ?? DEFAULT_PROJECT_ID, waiters: [] });
      if (job.freeTierResult) recordJobHistory(toHistoryEntry({ ...job, waiters: [] }));
  }
  for (const job of saved.filter((entry) => entry.status === 'queued' || entry.status === 'running')) {
    const restoredJob = { ...job, projectId: job.projectId ?? DEFAULT_PROJECT_ID, executionStage: undefined, childProcess: undefined, waiters: [] } as Job;
    jobs.set(restoredJob.id, restoredJob);
    if (restoredJob.status === 'queued' && restoredJob.pausedAt === undefined) {
      if (restoredJob.source === 'scheduler') {
        restoredJob.schedulerDeadlineAt ??= restoredJob.createdAt + SCHEDULER_JOB_TIMEOUT_MS;
        restoredJob.deadlineAt = restoredJob.schedulerDeadlineAt;
      }
      insertByPriority(restoredJob.id, restoredJob.priority);
      scheduleQueuedDeadline(restoredJob);
    }
  }
  return true;
}

if (!loadDatabaseJobs()) {
  loadDoneJobs();
  loadActiveJobs();
  replacePersistedJobs(jobs.values());
}
reconcileDecryptQuota();

function removeQueuedJob(jobId: string): void {
  const index = queue.indexOf(jobId);
  if (index !== -1) queue.splice(index, 1);
}

function mergePersistedJob(saved: Job): boolean {
  const existing = jobs.get(saved.id);
  if (existing && runningJobs.has(saved.id)) {
    if (saved.cancelledBy && saved.cancelledBy !== existing.cancelledBy) {
      existing.cancelledBy = saved.cancelledBy;
      existing.progress = saved.progress;
      existing.timeline = saved.timeline;
      runningJobControllers.get(saved.id)?.abort(new Error(`cancelled by ${saved.cancelledBy}`));
      terminateJobProcess(existing);
      return true;
    }
    if (saved.status !== 'running') {
      lostWorkerLeaseJobIds.add(saved.id);
      runningJobControllers.get(saved.id)?.abort(new Error('worker lease was recovered by another instance'));
      terminateJobProcess(existing);
    }
    return false;
  }

  const previousStatus = existing?.status;
  const previousPayload = existing ? JSON.stringify(serializableJob(existing)) : undefined;
  const merged = existing ?? { ...saved, waiters: [] } as Job;
  if (existing) {
    const waiters = existing.waiters;
    const mutableExisting = existing as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutableExisting)) {
      if (key !== 'waiters' && key !== 'childProcess' && !Object.hasOwn(saved, key)) delete mutableExisting[key];
    }
    Object.assign(existing, saved, { waiters, childProcess: undefined });
  }
  jobs.set(merged.id, merged);

  if (merged.status === 'queued' && merged.pausedAt === undefined) {
    if (previousStatus !== 'queued' || !queue.includes(merged.id)) insertByPriority(merged.id, merged.priority);
    scheduleQueuedDeadline(merged);
  } else {
    removeQueuedJob(merged.id);
    clearQueuedDeadline(merged.id);
  }

  if ((merged.status === 'done' || merged.status === 'failed') && (previousStatus === 'queued' || previousStatus === 'running')) {
    if (merged.quotaReservationState === 'reserved') merged.quotaReservationState = merged.status === 'done' ? 'consumed' : 'released';
    recordJobHistory(toHistoryEntry(merged));
    settleDecryptQuota(merged.id, merged.status === 'done');
    if (existing) settle(existing);
  }

  return previousPayload !== JSON.stringify(serializableJob(merged));
}

function syncPersistedJobsFromRepository(force = false): void {
  if (jobStoreClosed) return;
  const now = Date.now();
  if (syncingPersistedJobs || (!force && now - lastJobSyncAt < JOB_SYNC_THROTTLE_MS)) return;
  syncingPersistedJobs = true;
  lastJobSyncAt = now;
  let changed = false;
  try {
    const savedActive = loadPersistedActiveJobs() as Job[];
    const activeIds = new Set(savedActive.map((job) => job.id));
    for (const saved of savedActive) changed = mergePersistedJob(saved) || changed;
    for (const local of jobs.values()) {
      if ((local.status !== 'queued' && local.status !== 'running') || activeIds.has(local.id)) continue;
      const persisted = findPersistedJobById(local.id);
      if (persisted) changed = mergePersistedJob(persisted as Job) || changed;
    }
  } finally {
    syncingPersistedJobs = false;
  }
  if (changed) emitJobsChanged();
}

function stopWorkerLeaseHeartbeat(jobId: string): void {
  const worker = workerLeases.get(jobId);
  if (worker) clearInterval(worker.timer);
}

function loseWorkerLease(jobId: string, error?: unknown): void {
  const worker = workerLeases.get(jobId);
  if (!worker) return;
  lostWorkerLeaseJobIds.add(jobId);
  stopWorkerLeaseHeartbeat(jobId);
  const job = jobs.get(jobId);
  runningJobControllers.get(jobId)?.abort(new Error('worker lease expired or was claimed by another instance'));
  if (job) terminateJobProcess(job);
  log.warn('job worker lease lost; stopping work before another worker continues', {
    jobId,
    resourceId: worker.lease.resourceId,
    error: error === undefined ? undefined : String(error),
  });
}

function renewWorkerLease(jobId: string): boolean {
  if (jobStoreClosed) return false;
  const worker = workerLeases.get(jobId);
  if (!worker) return false;
  try {
    if (!renewPersistedJobWorker(worker.lease, WORKER_LEASE_MS)) {
      loseWorkerLease(jobId);
      return false;
    }
    worker.lease = { ...worker.lease, leaseUntil: Date.now() + WORKER_LEASE_MS };
    return true;
  } catch (error) {
    if (Date.now() >= worker.lease.leaseUntil) {
      loseWorkerLease(jobId, error);
      return false;
    }
    log.warn('job worker lease heartbeat could not reach SQLite; retrying before lease expiry', {
      jobId,
      resourceId: worker.lease.resourceId,
      error: String(error),
    });
    return true;
  }
}

function startWorkerLeaseHeartbeat(jobId: string, lease: JobWorkerLease): void {
  const timer = setInterval(() => {
    renewWorkerLease(jobId);
  }, WORKER_LEASE_HEARTBEAT_MS).unref();
  workerLeases.set(jobId, { lease, timer });
}

function recoverExpiredWorkerJobs(): void {
  syncPersistedJobsFromRepository(true);
  for (const saved of listPersistedExpiredRunningJobs() as Job[]) {
    const now = Date.now();
    const local = jobs.get(saved.id);
    if (runningJobs.has(saved.id)) loseWorkerLease(saved.id);
    const offlineFailureReason = saved.executionPath === 'appstore_offline'
      ? saved.offlineFailureReason ?? 'The server-side worker stopped before the attempt completed; retrying on a device'
      : saved.offlineFailureReason;
    const recovered: Job = {
      ...saved,
      status: 'queued',
      progress: saved.executionPath === 'appstore_offline' ? 'Server-side worker stopped; waiting for device fallback' : 'Worker stopped; retrying the job',
      error: undefined,
      failureClass: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      deadlineExceeded: false,
      shutdownRecoveryPending: undefined,
      executionStage: undefined,
      workerAttemptId: undefined,
      offlineFailureReason,
      childProcess: undefined,
      waiters: local?.waiters ?? [],
      retryCount: (saved.retryCount ?? 0) + 1,
      attempt: (saved.attempt ?? 0) + 1,
    };
    appendJobTimelineEvent(recovered, 'Recovered after the worker lease expired', 'queued', now);
    if (!requeuePersistedExpiredRunningJob(recovered)) continue;
    if (local && runningJobs.has(local.id)) continue;
    mergePersistedJob(recovered);
    log.warn('recovered a job after its worker stopped renewing the lease', {
      jobId: recovered.id,
      bundleId: recovered.bundleId,
      previousExecutionPath: saved.executionPath,
      executionPath: recovered.offlineFailureReason ? 'device_fallback' : 'retry',
    });
  }
}

const RETRY_BACKOFF_MS = 5_000;

function waitForCompletionOrTimeout(completion: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    completion.then(() => {
      clearTimeout(timer);
      resolve(true);
    }, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function findActiveJobForBundle(lookup: JobBuildLookup, ownerId?: string): Job | undefined {
  syncPersistedJobsFromRepository(true);
  if (ownerId) {
    return [...jobs.values()].find((job) => isMatchingBuild(job, lookup)
      && (job.status === 'queued' || job.status === 'running')
      && job.freeTierResult === true
      && job.billingOwnerId?.toLowerCase() === ownerId.toLowerCase());
  }
  const persistedId = findPersistedActiveJobId(lookup);
  const persistedJob = persistedId ? jobs.get(persistedId) : undefined;
  if (persistedJob && !persistedJob.freeTierResult && isMatchingBuild(persistedJob, lookup) && (persistedJob.status === 'queued' || persistedJob.status === 'running')) return persistedJob;
  for (const job of jobs.values()) {
    if (!job.freeTierResult && isMatchingBuild(job, lookup) && (job.status === 'queued' || job.status === 'running')) return job;
  }
  return undefined;
}

function isMatchingBuild(job: Job, lookup: JobBuildLookup): boolean {
  return job.bundleId === lookup.bundleId &&
    job.externalVersionId === lookup.externalVersionId &&
    job.testflight?.build.id === lookup.testFlightBuildId &&
    (job.projectId ?? DEFAULT_PROJECT_ID) === lookup.projectId;
}

function findReusableCompletedJob(lookup: JobBuildLookup): Job | undefined {
  if (lookup.externalVersionId === undefined && lookup.testFlightBuildId === undefined) return undefined;
  for (const id of findPersistedReusableCompletedJobIds(lookup)) {
    const persistedJob = jobs.get(id);
    if (persistedJob && isMatchingBuild(persistedJob, lookup) && persistedJob.status === 'done' && persistedJob.filePath && existsSync(persistedJob.filePath)) return persistedJob;
  }
  for (const job of jobs.values()) {
    if (isMatchingBuild(job, lookup) && job.status === 'done' && job.filePath && existsSync(job.filePath)) return job;
  }
  return undefined;
}

function createCachedJob(
  bundleId: string,
  source: JobSource,
  externalVersionId: string | undefined,
  testflight: TestFlightJobSource | undefined,
  versionLabel: string | undefined,
  queuedBy: string | undefined,
  priority: number,
  apiKeyId: string | undefined,
  projectId: string,
  artifact: ArtifactRecord,
  billingOwnerId?: string,
  freeTierResult = false,
  minimumOsVersion?: string,
): Job {
  const now = Date.now();
  const resolvedLabel = versionLabel ?? artifact.versionLabel;
  const job: Job = {
    id: randomUUID(),
    correlationId: randomUUID(),
    ...captureJobCorrelation(),
    projectId,
    bundleId,
    externalVersionId,
    testflight,
    versionLabel: resolvedLabel,
    minimumOsVersion: minimumOsVersion ?? minimumOsVersionForBuild(testflight?.build),
    source,
    queuedBy,
    billingOwnerId,
    apiKeyId,
    priority,
    status: 'done',
    progress: 'artifact cache hit',
    timeline: [
      { at: now, label: 'Artifact cache hit', status: 'done' },
      { at: now, label: 'Finished', status: 'done' },
    ],
    artifactId: artifact.id,
    freeTierResult,
    temporaryResultExpiresAt: freeTierResult ? now + 30 * 60_000 : undefined,
    temporaryResultSharedCache: freeTierResult,
    cacheHit: true,
    filePath: artifact.filePath,
    fileSizeBytes: artifact.fileSizeBytes,
    sha256: artifact.sha256,
    createdAt: now,
    deadlineAt: now + deadlineDurationMs(source),
    attempt: 1,
    finishedAt: now,
    waiters: [],
  };
  jobs.set(job.id, job);
  persistDoneJobs();
  recordJobHistory(toHistoryEntry(job));
  emitJobsChanged();
  return job;
}

function insertByPriority(id: string, priority: number): void {
  const target = jobs.get(id);
  const targetScore = target ? effectiveQueuePriority(target) : priority;
  const idx = queue.findIndex((qid) => {
    const candidate = jobs.get(qid);
    return candidate ? effectiveQueuePriority(candidate) < targetScore : false;
  });
  if (idx === -1) queue.push(id);
  else queue.splice(idx, 0, id);
}

function clearQueuedDeadline(id: string): void {
  const timer = queuedDeadlineTimers.get(id);
  if (timer) clearTimeout(timer);
  queuedDeadlineTimers.delete(id);
}

function failExpiredQueuedJob(job: Job, now = Date.now()): void {
  if (job.status !== 'queued' || job.deadlineAt === undefined || job.deadlineAt > now) return;
  const queueReason = getQueueReason(job)
    ?? job.lastQueueReason
    ?? 'No dispatch blocker was detected; the job remained queued until its deadline';
  job.queueReason = queueReason;
  clearQueuedDeadline(job.id);
  const index = queue.indexOf(job.id);
  if (index !== -1) queue.splice(index, 1);
  job.status = 'failed';
  job.deadlineExceeded = true;
  job.progress = 'job deadline exceeded';
  const offlineFailure = job.offlineFailureReason ? `; server-side attempt failed: ${job.offlineFailureReason}` : '';
  const separateOfflineFailure = offlineFailure && !queueReason?.includes(job.offlineFailureReason ?? '') ? offlineFailure : '';
  job.error = `job deadline exceeded while waiting in the queue${queueReason ? `: ${queueReason}` : ''}${separateOfflineFailure}`;
  job.failureClass = classifyJobFailure(job.error);
  job.finishedAt = now;
  if (job.freeTierResult) job.temporaryResultExpiresAt = now + 30 * 60_000;
  appendJobTimelineEvent(job, `Failed: ${job.error}`, 'failed', now);
  incrementMetric('jobs_failed_total', { source: job.source, failureClass: job.failureClass });
  log.warn('queued job expired before it could start', { jobId: job.id, bundleId: job.bundleId });
  settleJobQuota(job, false);
  recordJobHistory(toHistoryEntry(job));
  settle(job);
  persistActiveJobs();
  emitJobsChanged();
}

function historicalDurationP95ByProject(
  sourceJobs: readonly Pick<Job, 'projectId'>[],
  history: ReturnType<typeof getAllJobHistory>,
): Map<string, number | null> {
  const globalP95 = completedJobDurationP95Ms(history);
  const projectIds = new Set(sourceJobs.map((job) => job.projectId ?? DEFAULT_PROJECT_ID));
  return new Map([...projectIds].map((projectId) => [
    projectId,
    projectCompletedJobDurationP95Ms(history, projectId, DEFAULT_PROJECT_ID) ?? globalP95,
  ]));
}

function scheduleQueuedDeadline(job: Job): void {
  clearQueuedDeadline(job.id);
  if (job.status !== 'queued' || job.deadlineAt === undefined) return;
  const timer = setTimeout(() => {
    queuedDeadlineTimers.delete(job.id);
    if (job.status !== 'queued') return;
    if (job.deadlineAt !== undefined && job.deadlineAt > Date.now()) {
      scheduleQueuedDeadline(job);
      return;
    }
    failExpiredQueuedJob(job);
  }, Math.max(1, job.deadlineAt - Date.now()));
  timer.unref();
  queuedDeadlineTimers.set(job.id, timer);
}

function terminateJobProcess(job: Job): void {
  const child = job.childProcess;
  if (!child) return;
  terminateChildProcess(child, 'SIGTERM');
  const timer = setTimeout(() => {
    if (job.childProcess === child) terminateChildProcess(child, 'SIGKILL');
  }, config.jobProcessGraceSeconds * 1000);
  timer.unref();
}

function expireOverdueQueuedJobs(now = Date.now()): void {
  for (const id of [...queue]) {
    const job = jobs.get(id);
    if (job) failExpiredQueuedJob(job, now);
  }
}

export interface EnqueueDecryptJobOptions {
  externalVersionId?: string;
  testflight?: TestFlightJobSource;
  versionLabel?: string;
  queuedBy?: string;
  billingOwnerId?: string;
  priority?: number;
  preferredDeviceId?: string;
  apiKeyId?: string;
  projectId?: string;
  minimumOsVersion?: string;
  deferWhenNoDispatchableDevice?: boolean;
  abuseNetworkHash?: string;
  abuseAddressHash?: string;
  abuseBrowserHash?: string;
  abuseTurnstileHash?: string;
  abuseNetworkDecryptLimit?: number;
  abuseAddressDecryptLimit?: number;
}

export class ScheduledJobDeferredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ScheduledJobDeferredError';
  }
}

export class JobsShuttingDownError extends Error {
  readonly statusCode = 503;

  constructor() {
    super('dkrypt is shutting down and is not accepting new jobs');
    this.name = 'JobsShuttingDownError';
  }
}

export class AutomationOwnerUnavailableError extends Error {
  readonly statusCode = 403;
  readonly code = 'automation_owner_unavailable';

  constructor() {
    super('the automation owner no longer has decrypt access');
    this.name = 'AutomationOwnerUnavailableError';
  }
}

function deferScheduledJobIfUnavailable(source: JobSource, job: Job, enabled: boolean | undefined): void {
  if (source !== 'scheduler' || !enabled || job.status !== 'queued' || getJobDispatchableDeviceCount(job) > 0 || (canStartOfflineAttempt(job) && !getJobConcurrencyBlocker(job))) return;
  throw new ScheduledJobDeferredError(getQueueReason(job) ?? 'No enabled device is available for this job');
}

export function enqueueDecryptJob(bundleId: string, source: JobSource, options: EnqueueDecryptJobOptions = {}): Job {
  const {
    externalVersionId,
    testflight,
    versionLabel,
    queuedBy,
    billingOwnerId = queuedBy,
    priority = 0,
    preferredDeviceId,
    apiKeyId,
    projectId: _requestedProjectId = DEFAULT_PROJECT_ID,
    minimumOsVersion,
  } = options;
  const projectId = DEFAULT_PROJECT_ID;
  if (!acceptingJobs) throw new JobsShuttingDownError();
  if (options.billingOwnerId && options.billingOwnerId !== 'root' && !hasPermission(getUserEffectivePermissions(options.billingOwnerId), PermissionFlag.requestDecrypt)) throw new AutomationOwnerUnavailableError();
  const lookup = { bundleId, externalVersionId, testFlightBuildId: testflight?.build.id, projectId };
  const entitlement = billingOwnerId ? getBillingEntitlements(billingOwnerId) : undefined;
  const hasUnmeteredRoleApiAccess = Boolean(apiKeyId && billingOwnerId && hasManuallyAssignedPermission(billingOwnerId, PermissionFlag.createApiKeys | PermissionFlag.accessApi));
  const freeTierResult = entitlement?.freeTier === true && billingOwnerId?.toLowerCase() !== 'root' && !hasUnmeteredRoleApiAccess;
  const effectivePriority = freeTierResult ? -5 : priority;
  const existing = findActiveJobForBundle(lookup, freeTierResult ? billingOwnerId : undefined);
  if (existing) {
    deferScheduledJobIfUnavailable(source, existing, options.deferWhenNoDispatchableDevice);
    if (source === 'scheduler') {
      extendJobDeadlineForScheduler(existing);
    }
    if (existing.status === 'queued') pumpWorkers();
    return existing;
  }
  const artifactKey = artifactKeyForJob({ id: 'lookup', bundleId, externalVersionId, testflight, versionLabel });
  const artifact = getArtifactByKey(artifactKey);
  if (artifact) {
    linkArtifactToProject(artifact.id, projectId);
    return createCachedJob(bundleId, source, externalVersionId, testflight, versionLabel, queuedBy, effectivePriority, apiKeyId, projectId, artifact, billingOwnerId, freeTierResult, minimumOsVersion);
  }
  const reusable = freeTierResult ? undefined : findReusableCompletedJob(lookup);
  if (reusable) return reusable;
  enforceAccountQuotas(projectId);

  const resolvedLabel = versionLabel ?? (testflight ? `${testflight.build.cfBundleShortVersion}_${testflight.build.cfBundleVersion}` : 'Current App Store release');

  const now = Date.now();
  const deadlineAt = now + deadlineDurationMs(source);
  const job: Job = {
    id: randomUUID(),
    correlationId: randomUUID(),
    ...captureJobCorrelation(),
    projectId,
    bundleId,
    externalVersionId,
    testflight,
    versionLabel: resolvedLabel,
    minimumOsVersion: minimumOsVersion ?? minimumOsVersionForBuild(testflight?.build),
    source,
    queuedBy,
    billingOwnerId,
    freeTierResult,
    apiKeyId,
    preferredDeviceId,
    priority: effectivePriority,
    status: 'queued',
    progress: 'queued',
    timeline: [{ at: now, label: 'Queued', status: 'queued' }],
    createdAt: now,
    deadlineAt,
    schedulerDeadlineAt: source === 'scheduler' ? deadlineAt : undefined,
    attempt: 1,
    waiters: [],
  };

  deferScheduledJobIfUnavailable(source, job, options.deferWhenNoDispatchableDevice);

  let quotaOwnerId: string | undefined;
  let quotaLimit: number | undefined;
  let previousUsage: number | undefined;
  if (billingOwnerId && entitlement) {
    if (entitlement.freeTier && !hasUnmeteredRoleApiAccess) {
      quotaOwnerId = billingOwnerId;
      quotaLimit = entitlement.rollingDecryptLimit;
      previousUsage = getFreeDecryptQuotaUsage(billingOwnerId).used;
    } else if (entitlement.planId !== 'viewer' && !entitlement.legacy) {
      quotaOwnerId = billingOwnerId;
      quotaLimit = entitlement.dailyDecryptLimit;
      if (quotaLimit !== undefined) previousUsage = getDecryptQuotaUsage(billingOwnerId, quotaLimit).used;
    }
  }
  if (quotaOwnerId && (freeTierResult || quotaLimit !== undefined)) job.quotaReservationState = 'reserved';
  const admittedId = admitPersistedJob(job, quotaOwnerId, quotaLimit, freeTierResult, {
    networkHash: options.abuseNetworkHash,
    addressHash: options.abuseAddressHash,
    browserHash: options.abuseBrowserHash,
    turnstileHash: options.abuseTurnstileHash,
    networkDecryptLimit: options.abuseNetworkDecryptLimit,
    addressDecryptLimit: options.abuseAddressDecryptLimit,
  });
  if (admittedId !== job.id) {
    syncPersistedJobsFromRepository(true);
    const existing = jobs.get(admittedId);
    if (!existing) throw new Error('a duplicate active job was admitted but could not be loaded');
    deferScheduledJobIfUnavailable(source, existing, options.deferWhenNoDispatchableDevice);
    if (source === 'scheduler') extendJobDeadlineForScheduler(existing);
    return existing;
  }
  if (quotaOwnerId && quotaLimit !== undefined && previousUsage !== undefined) {
    const nextUsage = freeTierResult ? getFreeDecryptQuotaUsage(quotaOwnerId).used : getDecryptQuotaUsage(quotaOwnerId, quotaLimit).used;
    for (const threshold of getUserPrefs(quotaOwnerId).decryptUsageAlertThresholds ?? []) {
      if (quotaLimit !== undefined && previousUsage * 100 < quotaLimit * threshold && nextUsage * 100 >= quotaLimit * threshold) {
        recordDecryptQuotaThresholdNotice(quotaOwnerId, nextUsage, quotaLimit, threshold);
      }
    }
  }

  jobs.set(job.id, job);
  if (source === 'scheduler') {
    queue.unshift(job.id);
  } else {
    insertByPriority(job.id, effectivePriority);
  }
  scheduleQueuedDeadline(job);
  log.info('job queued', { jobId: job.id, bundleId, externalVersionId, source, priority: effectivePriority });
  persistActiveJobs();
  emitJobsChanged();

  pumpWorkers();
  return job;
}

class AccountQuotaExceededError extends Error {
  readonly statusCode = 429;

  constructor(message: string) {
    super(message);
    this.name = 'AccountQuotaExceededError';
  }
}

function enforceAccountQuotas(accountId: string): void {
  const limits = getAccountJobQuotaLimits();
  const active = [...jobs.values()].filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === accountId && (job.status === 'queued' || job.status === 'running'));
  if (limits.maxConcurrentJobs && active.length >= limits.maxConcurrentJobs) {
    throw new AccountQuotaExceededError('account concurrency limit reached');
  }
  if (!limits.dailyJobQuota) return;
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const knownIds = new Set([...jobs.values()].map((job) => job.id));
  const jobsToday = [...jobs.values()].filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === accountId && job.createdAt >= dayStart).length;
  const historyToday = getAllJobHistory().filter((entry) => (entry.projectId ?? DEFAULT_PROJECT_ID) === accountId && entry.createdAt >= dayStart && !knownIds.has(entry.id)).length;
  if (jobsToday + historyToday >= limits.dailyJobQuota) throw new AccountQuotaExceededError('account daily job limit reached');
}

export function getJob(id: string): Job | undefined {
  syncPersistedJobsFromRepository(true);
  if (!jobs.has(id)) {
    const persisted = findPersistedJobById(id);
    if (persisted) mergePersistedJob(persisted as Job);
  }
  return jobs.get(id);
}

export async function retainFreeJobResult(jobId: string, ownerId: string): Promise<Job | undefined> {
  const job = getJob(jobId);
  if (!job || !job.freeTierResult || job.status !== 'done' || job.billingOwnerId?.toLowerCase() !== ownerId.toLowerCase()) return undefined;
  if (job.temporaryResultExpiresAt !== undefined && job.temporaryResultExpiresAt <= Date.now()) return undefined;
  const existingArtifact = getArtifactForJob(job);
  let artifact = existingArtifact;
  if (!artifact) {
    if (!job.filePath) return undefined;
    artifact = await promoteArtifact({
      key: artifactKeyForJob(job),
      bundleId: job.bundleId,
      channel: job.testflight ? 'testflight' : 'appstore',
      externalVersionId: job.externalVersionId,
      testflightBuildId: job.testflight?.build.id,
      versionLabel: job.ipaMetadata?.shortVersion ?? job.testflight?.build.cfBundleShortVersion ?? job.versionLabel,
      buildNumber: job.ipaMetadata?.bundleVersion ?? job.testflight?.build.cfBundleVersion,
      stagingPath: job.filePath,
      sourceJobId: job.id,
      warnings: job.warnings,
      projectId: job.projectId,
    });
  }
  job.freeTierResult = false;
  job.temporaryResultExpiresAt = undefined;
  job.temporaryResultSharedCache = false;
  job.artifactId = artifact.id;
  job.filePath = artifact.filePath;
  job.fileSizeBytes = artifact.fileSizeBytes;
  job.sha256 = artifact.sha256;
  persistDoneJobs();
  persistActiveJobs();
  recordJobHistory(toHistoryEntry(job));
  emitJobsChanged();
  return job;
}

export function getActiveJobs(): Job[] {
  syncPersistedJobsFromRepository(true);
  return [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running');
}

export function getWorkerFleetStatus() {
  refreshWorkerInstance();
  const workers = listPersistedWorkers();
  const enabledDeviceSlots = getEffectiveDevices().filter((device) => device.enabled && !device.draining).length;
  const offlineSlots = sharedOfflineWorkerCapacity(workers);
  const activeLeases = workers.reduce((total, worker) => total + worker.activeLeases, 0);
  const activeJobs = loadPersistedActiveJobs();
  const maxParallelJobs = enabledDeviceSlots + offlineSlots;
  return {
    currentWorkerId: workerInstanceId,
    workers,
    configurationConsistent: workerRuntimeConfigurationConsistent(workers),
    capacity: {
      enabledDeviceSlots,
      offlineSlots,
      maxParallelJobs,
      activeLeases,
      availableSlots: Math.max(0, maxParallelJobs - activeLeases),
      queuedJobs: activeJobs.filter((job) => job.status === 'queued').length,
      runningJobs: activeJobs.filter((job) => job.status === 'running').length,
    },
    checkedAt: Date.now(),
  };
}

export function setWorkerDrainState(workerId: string, draining: boolean): boolean {
  const changed = setPersistedWorkerDrain(workerId, draining);
  if (changed && workerId === workerInstanceId) pumpWorkers();
  return changed;
}

export function getArtifactBackedJobs(): Job[] {
  syncPersistedJobsFromRepository(true);
  return [...jobs.values()].filter((job) => job.status === 'done' && !!job.filePath);
}

export function mergeActiveJobOwner(targetUserId: string, sourceUserId: string): void {
  let changed = false;
  for (const job of jobs.values()) {
    if (job.queuedBy === sourceUserId) {
      job.queuedBy = targetUserId;
      changed = true;
    }
    if (job.billingOwnerId === sourceUserId) {
      job.billingOwnerId = targetUserId;
      changed = true;
    }
  }
  mergeDecryptQuotaOwner(targetUserId, sourceUserId);
  if (changed) {
    persistActiveJobs();
    emitJobsChanged();
  }
}

export function getQueueInfo(jobId: string): { position: number; total: number } | undefined {
  syncPersistedJobsFromRepository(true);
  const job = jobs.get(jobId);
  if (!job || job.status === 'done' || job.status === 'failed' || job.pausedAt !== undefined) return undefined;

  const runningIds = [...jobs.values()].filter((j) => j.status === 'running').map((j) => j.id);
  const ordered = [...runningIds, ...queue];
  const idx = ordered.indexOf(jobId);
  return { position: idx === -1 ? ordered.length : idx + 1, total: ordered.length };
}

export interface JobQueueSummary {
  position: number;
  total: number;
  predictedStartMs?: number;
  predictedCompletionMs?: number;
}

export function getJobQueueSummaries(sourceJobs: readonly Job[], now = Date.now()): Map<string, JobQueueSummary> {
  const queuedJobs = sourceJobs.filter((job) => job.status === 'queued');
  const history = queuedJobs.length > 0 ? getAllJobHistory() : [];
  const historicalP95ByProject = historicalDurationP95ByProject(queuedJobs, history);
  const summaries = new Map<string, JobQueueSummary>();

  for (const job of sourceJobs) {
    const queue = getQueueInfo(job.id);
    if (!queue) continue;
    if (job.status !== 'queued') {
      summaries.set(job.id, queue);
      continue;
    }

    const projectId = job.projectId ?? DEFAULT_PROJECT_ID;
    const assessment = assessQueueServiceObjective({
      createdAt: job.createdAt,
      now,
      status: job.status,
      queuePosition: queue.position,
      parallelism: getJobEligibleDeviceCount(job),
      objectiveMs: queueServiceObjectiveMs(config.queueSloMinutes),
      serviceDurationP95Ms: historicalP95ByProject.get(projectId) ?? null,
    });
    summaries.set(job.id, {
      ...queue,
      predictedStartMs: assessment.predictedStartMs ?? undefined,
      predictedCompletionMs: assessment.predictedCompletionMs ?? undefined,
    });
  }

  return summaries;
}

function getCurrentQueueReason(job: Job): string | undefined {
  if (job.status !== 'queued') return undefined;
  if (job.pausedAt !== undefined) return 'Paused by you';
  const concurrencyBlocker = getJobConcurrencyBlocker(job);
  if (concurrencyBlocker) return concurrencyBlocker;
  if (requiresServerSideAppStoreAttempt(job)) {
    const readiness = offlineAppStoreProcessor.readiness(job);
    if (!readiness.ready) {
      const blockers = readiness.blockers?.join(' · ');
      return blockers ? `Waiting for server-side App Store processing · ${blockers}` : 'Waiting for server-side App Store processing';
    }
    return offlineWorkerSlots(job) === 0 ? 'Waiting for a server-side App Store worker' : undefined;
  }
  const enabledDevices = getEffectiveDevices().filter((device) => device.enabled && !device.draining);
  if (enabledDevices.length === 0) {
    if (canStartOfflineAttempt(job)) return offlineWorkerSlots(job) === 0 ? 'Waiting for a server-side App Store worker' : undefined;
    const fallback = job.offlineFailureReason ? `Server-side attempt failed: ${job.offlineFailureReason} · ` : '';
    const offlineBlocker = offlineAppStoreBlocker(job);
    return `${fallback}Waiting for a device accepting jobs${offlineBlocker ? ` · Server-side processing unavailable: ${offlineBlocker}` : ''}`;
  }
  const devices = job.preferredDeviceId
    ? enabledDevices.filter((device) => device.id === job.preferredDeviceId)
    : enabledDevices;
  if (devices.length === 0) return 'Waiting for the assigned device to become available';

  const blockers = devices.map((device) => jobDeviceBlocker(job, device));
  const eligible = devices.filter((_, index) => !blockers[index]);
  if (eligible.length === 0) {
    const reasons = [...new Set(blockers.filter((reason): reason is string => Boolean(reason)))];
    return reasons.length > 0 ? `Waiting for a compatible device · ${reasons.join(' · ')}` : 'Waiting for a compatible device';
  }

  const available = eligible.filter((device) => !busyDeviceIds.has(device.id) && !isPersistedWorkerResourceActive(`device:${device.id}`));
  if (available.length === 0) {
    const names = eligible.map((device) => device.name).join(', ');
    return `Waiting for ${names} to become available`;
  }

  const queue = getQueueInfo(job.id);
  if (queue && queue.position > 1) return `Waiting behind ${queue.position - 1} job${queue.position === 2 ? '' : 's'}`;
  return undefined;
}

export function getQueueReason(job: Job): string | undefined {
  if (job.status !== 'queued') return job.queueReason;
  return getCurrentQueueReason(job);
}

function captureQueuedBlockers(): void {
  let changed = false;
  for (const job of jobs.values()) {
    if (job.status !== 'queued') continue;
    const queueReason = getCurrentQueueReason(job);
    if (!queueReason || queueReason === job.lastQueueReason) continue;
    job.lastQueueReason = queueReason;
    changed = true;
  }
  if (!changed) return;
  persistActiveJobs();
  emitJobsChanged();
}

export function waitForJob(job: Job, timeoutMs: number): Promise<Job> {
  if (job.status === 'done' || job.status === 'failed') return Promise.resolve(job);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(job), timeoutMs);
    job.waiters.push((finished) => {
      clearTimeout(timer);
      resolve(finished);
    });
  });
}

function settle(job: Job): void {
  deferredDeviceAttempts.delete(job.id);
  const waiters = job.waiters;
  job.waiters = [];
  for (const w of waiters) w(job);
}

function settleJobQuota(job: Job, success: boolean): void {
  if (job.quotaReservationState === 'reserved') job.quotaReservationState = success ? 'consumed' : 'released';
  settleDecryptQuota(job.id, success);
}

function toHistoryEntry(job: Job) {
  if (job.freeTierResult && job.temporaryResultExpiresAt === undefined && (job.status === 'done' || job.status === 'failed')) {
    job.temporaryResultExpiresAt = (job.finishedAt ?? Date.now()) + 30 * 60_000;
  }
  return {
    id: job.id,
    correlationId: job.correlationId,
    projectId: job.projectId ?? DEFAULT_PROJECT_ID,
    bundleId: job.bundleId,
    externalVersionId: job.externalVersionId,
    testflight: job.testflight,
    versionLabel: job.versionLabel,
    minimumOsVersion: job.minimumOsVersion,
    queuedBy: job.queuedBy,
    status: job.status as 'done' | 'failed',
    warnings: job.warnings,
    error: job.error,
    sizeBytes: job.fileSizeBytes,
    source: job.source,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? Date.now(),
    deviceId: job.deviceId,
    transport: job.transport,
    executionPath: job.executionPath,
    offlineAttemptedAt: job.offlineAttemptedAt,
    offlineAttemptDurationMs: job.offlineAttemptDurationMs,
    offlineDeviceFallbackStartedAt: job.offlineDeviceFallbackStartedAt,
    deviceFallbackDurationMs: job.deviceFallbackDurationMs,
    offlineFailureReason: job.offlineFailureReason,
    ipaMetadata: job.ipaMetadata,
    ipaInfoPlist: job.ipaInfoPlist,
    artifactId: job.artifactId,
    freeTierResult: job.freeTierResult,
    temporaryResultExpiresAt: job.temporaryResultExpiresAt,
    quotaReservationState: job.quotaReservationState,
    sha256: job.sha256,
    timeline: job.timeline,
    attempt: job.attempt,
    retryCount: job.retryCount,
    cacheHit: job.cacheHit,
    deadlineAt: job.deadlineAt,
    deadlineExceeded: job.deadlineExceeded,
    failureClass: job.failureClass,
    queueReason: job.queueReason,
  };
}

export function cancelQueuedJob(id: string, cancelledBy: string): boolean {
  syncPersistedJobsFromRepository(true);
  const job = jobs.get(id);
  if (!job || job.status !== 'queued') return false;

  const idx = queue.indexOf(id);
  if (idx !== -1) queue.splice(idx, 1);
  clearQueuedDeadline(id);

  job.status = 'failed';
  job.error = `cancelled by ${cancelledBy}`;
  job.finishedAt = Date.now();
  if (job.freeTierResult) job.temporaryResultExpiresAt = job.finishedAt + 30 * 60_000;
  appendJobTimelineEvent(job, job.error, 'failed', job.finishedAt);
  log.info('job cancelled', { jobId: id, bundleId: job.bundleId, cancelledBy });

  settleJobQuota(job, false);
  persistActiveJobs();
  recordJobHistory(toHistoryEntry(job));
  settle(job);

  emitJobsChanged();
  return true;
}

export function pauseQueuedJob(id: string, pausedBy: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'queued' || job.pausedAt !== undefined) return false;
  const now = Date.now();
  const queueIndex = queue.indexOf(id);
  job.pausedQueueIndex = queueIndex === -1 ? undefined : queueIndex;
  if (queueIndex !== -1) queue.splice(queueIndex, 1);
  clearQueuedDeadline(job.id);
  job.pausedAt = now;
  job.pausedRemainingMs = job.deadlineAt === undefined ? undefined : Math.max(0, job.deadlineAt - now);
  job.deadlineAt = undefined;
  job.progress = 'Paused by you';
  job.queueReason = 'Paused by you';
  appendJobTimelineEvent(job, 'Paused in queue', 'queued', now);
  log.info('queued job paused', { jobId: id, bundleId: job.bundleId, pausedBy });
  persistActiveJobs();
  emitJobsChanged();
  return true;
}

export function resumePausedJob(id: string, resumedBy: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'queued' || job.pausedAt === undefined) return false;
  const now = Date.now();
  job.deadlineAt = job.pausedRemainingMs === undefined ? undefined : now + job.pausedRemainingMs;
  if (job.schedulerDeadlineAt !== undefined && job.deadlineAt !== undefined) job.schedulerDeadlineAt = job.deadlineAt;
  job.pausedAt = undefined;
  const queueIndex = job.pausedQueueIndex;
  job.pausedQueueIndex = undefined;
  job.pausedRemainingMs = undefined;
  job.progress = 'queued';
  job.queueReason = undefined;
  job.lastQueueReason = undefined;
  appendJobTimelineEvent(job, 'Resumed in queue', 'queued', now);
  if (queueIndex === undefined) insertByPriority(job.id, job.priority);
  else queue.splice(Math.min(queueIndex, queue.length), 0, job.id);
  scheduleQueuedDeadline(job);
  log.info('queued job resumed', { jobId: id, bundleId: job.bundleId, resumedBy });
  persistActiveJobs();
  emitJobsChanged();
  pumpWorkers();
  return true;
}

export function cancelRunningJob(id: string, cancelledBy: string): boolean {
  syncPersistedJobsFromRepository(true);
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  if (job.cancelledBy) return true;
  const persisted = requestPersistedJobCancellation(id, cancelledBy);
  if (!persisted) return false;
  const childProcess = job.childProcess;
  const waiters = job.waiters;
  Object.assign(job, persisted, { childProcess, waiters });
  runningJobControllers.get(id)?.abort(new Error(`cancelled by ${cancelledBy}`));
  terminateJobProcess(job);
  log.info('job cancel requested', { jobId: id, bundleId: job.bundleId, cancelledBy });
  emitJobsChanged();
  return true;
}

export function cancelJob(id: string, cancelledBy: string): boolean {
  return cancelQueuedJob(id, cancelledBy) || cancelRunningJob(id, cancelledBy);
}

export function releasePinnedJobsForDevice(deviceId: string): number {
  let released = 0;
  for (const id of queue) {
    const job = jobs.get(id);
    if (job && job.preferredDeviceId === deviceId && !job.testflight) {
      job.preferredDeviceId = undefined;
      released += 1;
    }
  }
  if (released > 0) {
    log.info('released device-pinned queued jobs after device went unreachable', { deviceId, released });
    emitJobsChanged();
    pumpWorkers();
  }
  return released;
}

export function prioritizeQueuedJob(id: string, projectId?: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'queued' || job.pausedAt !== undefined || (projectId && (job.projectId ?? DEFAULT_PROJECT_ID) !== projectId)) return false;

  const targetProjectId = projectId ?? job.projectId ?? DEFAULT_PROJECT_ID;
  const scopedQueue = queue.filter((jobId) => (jobs.get(jobId)?.projectId ?? DEFAULT_PROJECT_ID) === targetProjectId);
  const idx = scopedQueue.indexOf(id);
  if (idx <= 0) return idx === 0;

  const reordered = [id, ...scopedQueue.filter((jobId) => jobId !== id)];
  let scopedIndex = 0;
  const nextQueue = queue.map((jobId) => (jobs.get(jobId)?.projectId ?? DEFAULT_PROJECT_ID) === targetProjectId ? reordered[scopedIndex++]! : jobId);
  queue.length = 0;
  queue.push(...nextQueue);
  log.info('job bumped to front of queue', { jobId: id, bundleId: job.bundleId });
  emitJobsChanged();
  return true;
}

function applyBillingPriorityToQueuedJobs(userId: string): void {
  syncPersistedJobsFromRepository(true);
  const entitlement = getBillingEntitlements(userId);
  if (entitlement.freeTier) return;
  const accountId = userId.toLowerCase();
  let changed = false;
  for (const job of jobs.values()) {
    if (job.status !== 'queued') continue;
    if ((job.billingOwnerId ?? job.queuedBy)?.toLowerCase() !== accountId) continue;
    const upgradedPriority = Math.max(job.priority, entitlement.priority);
    if (upgradedPriority <= job.priority) continue;
    job.priority = upgradedPriority;
    appendJobTimelineEvent(job, 'Paid plan priority applied while queued', 'queued');
    if (job.pausedAt === undefined) {
      removeQueuedJob(job.id);
      insertByPriority(job.id, upgradedPriority);
    }
    changed = true;
  }
  if (!changed) return;
  persistActiveJobs();
  emitJobsChanged();
  pumpWorkers();
}

setBillingEntitlementChangeHandler(applyBillingPriorityToQueuedJobs);

export function reorderQueue(orderedIds: string[], projectId?: string): boolean {
  const known = new Set(queue.filter((id) => !projectId || (jobs.get(id)?.projectId ?? DEFAULT_PROJECT_ID) === projectId));
  const requested = [...new Set(orderedIds.filter((id) => known.has(id)))];
  if (requested.length === 0) return false;

  const requestedSet = new Set(requested);
  const scopedRemainder = queue.filter((id) => known.has(id) && !requestedSet.has(id));
  const scopedOrder = [...requested, ...scopedRemainder];
  let scopedIndex = 0;
  const next = projectId
    ? queue.map((id) => known.has(id) ? scopedOrder[scopedIndex++]! : id)
    : [...scopedOrder];

  const changed = next.some((id, i) => id !== queue[i]);
  if (!changed) return false;

  queue.length = 0;
  queue.push(...next);
  log.info('queue manually reordered', { orderedIds: requested });
  emitJobsChanged();
  return true;
}

function jobDeviceBlocker(job: Job, device: DeviceRecord): string | undefined {
  const cachedHealth = getCachedDeviceHealth(device.id);
  const state = {
    health: cachedHealth?.value,
    testFlightCatalog: getTestFlightCatalogCache(),
  };
  const deferredAttempt = deferredDeviceAttempts.get(job.id);
  if (!deferredAttempt || deferredAttempt.deviceId !== device.id) return getJobDeviceBlocker(job, device, state);
  if (!cachedHealth || cachedHealth.at <= deferredAttempt.healthCheckedAt) return deferredAttempt.reason;
  deferredAttempt.healthCheckedAt = cachedHealth.at;
  const blocker = getJobDeviceBlocker(job, device, state);
  if (blocker) return blocker;
  deferredDeviceAttempts.delete(job.id);
  return undefined;
}

export function isJobDispatchable(job: Job, device: DeviceRecord): boolean {
  return !requiresServerSideAppStoreAttempt(job) && !jobDeviceBlocker(job, device);
}

export function getJobEligibleDeviceCount(job: Job): number {
  if (requiresServerSideAppStoreAttempt(job)) return canStartOfflineAttempt(job) ? config.appStoreOfflineMaxWorkers : 0;
  const deviceCount = getEffectiveDevices().filter((device) => device.enabled && !device.draining && isJobDispatchable(job, device)).length;
  return deviceCount + (canStartOfflineAttempt(job) ? config.appStoreOfflineMaxWorkers : 0);
}

function getJobDispatchableDeviceCount(job: Job): number {
  if (getJobConcurrencyBlocker(job)) return 0;
  if (requiresServerSideAppStoreAttempt(job)) return offlineWorkerSlots(job);
  const deviceCount = getEffectiveDevices().filter((device) => device.enabled && !device.draining && !busyDeviceIds.has(device.id) && !isPersistedWorkerResourceActive(`device:${device.id}`) && isJobDispatchable(job, device)).length;
  return deviceCount + offlineWorkerSlots(job);
}

function offlineAppStoreBlocker(job: Job): string | undefined {
  if (job.testflight || !config.appStoreOfflineDecryptEnabled) return undefined;
  const circuit = offlineAppStoreCircuit.getStatus();
  if (circuit.state === 'open' && circuit.nextProbeAt !== undefined) return `temporarily paused after repeated failures until ${new Date(circuit.nextProbeAt).toISOString()}`;
  const readiness = offlineAppStoreProcessor.readiness(job);
  if (readiness.ready) return undefined;
  return readiness.blockers.length > 0 ? readiness.blockers.join(' · ') : undefined;
}

function requiresServerSideAppStoreAttempt(job: Job): boolean {
  if (job.testflight || job.offlineAttemptedAt) return false;
  if (!offlineAppStoreProcessor.readiness(job).ready || !offlineAppStoreCircuit.canStartAttempt()) return false;
  return computeOfflineAttemptBudgetMs({
    now: Date.now(),
    deadlineAt: job.deadlineAt,
    maximumAttemptMs: config.appStoreOfflineAttemptTimeoutSeconds * 1000,
    fallbackReserveMs: config.appStoreOfflineFallbackReserveSeconds * 1000,
  }) > 0;
}

function canStartOfflineAttempt(job: Job): boolean {
  return requiresServerSideAppStoreAttempt(job);
}

function offlineWorkerSlots(job: Job): number {
  if (!canStartOfflineAttempt(job)) return 0;
  return Math.max(0, config.appStoreOfflineMaxWorkers - countPersistedActiveWorkers('offline:'));
}

function scheduleOfflineCircuitProbe(): void {
  if (offlineCircuitProbeTimer) clearTimeout(offlineCircuitProbeTimer);
  offlineCircuitProbeTimer = undefined;
  const status = offlineAppStoreCircuit.getStatus();
  if (status.state !== 'open' || status.nextProbeAt === undefined) return;
  offlineCircuitProbeTimer = setTimeout(() => {
    offlineCircuitProbeTimer = undefined;
    emitJobsChanged();
    pumpWorkers();
  }, Math.max(1, status.nextProbeAt - Date.now()));
  offlineCircuitProbeTimer.unref();
}

export function getOfflineAppStoreDispatchStatus(): ReturnType<OfflineAppStoreCircuitBreaker['getStatus']> {
  return offlineAppStoreCircuit.getStatus();
}

export function notifyDeviceDispatchStateChanged(): void {
  pumpWorkers();
}

setOfflineAppStoreDispatchNotifier(notifyDeviceDispatchStateChanged);

function recentDeviceJobCounts(now = Date.now()): Map<string, number> {
  if (deviceWearCache && deviceWearCache.expiresAt > now) return deviceWearCache.jobsInLastDay;
  const cutoff = now - 86_400_000;
  const jobsInLastDay = new Map<string, number>();
  for (const job of getAllJobHistory()) {
    if (job.finishedAt < cutoff || !job.deviceId) continue;
    jobsInLastDay.set(job.deviceId, (jobsInLastDay.get(job.deviceId) ?? 0) + 1);
  }
  deviceWearCache = { expiresAt: now + 30_000, jobsInLastDay };
  return jobsInLastDay;
}

function deviceScore(device: DeviceRecord, primary: DeviceRecord, jobsInLastDay: Map<string, number>): number {
  const cachedHealth = getCachedDeviceHealth(device.id);
  let score = device.id === primary.id ? 10 : 0;
  score -= Math.min(jobsInLastDay.get(device.id) ?? 0, 20) * 1.5;
  if (!cachedHealth) return score;
  const health = cachedHealth.value;
  if (!health.reachable) return -10_000;
  score += Math.min(health.storageFreeBytes ? Math.floor(health.storageFreeBytes / (1024 * 1024 * 1024)) : 0, 100);
  score += health.batteryCharging ? 20 : 0;
  score += health.batteryPercent ? Math.floor(health.batteryPercent / 5) : 0;
  score -= health.batteryTemperatureC && health.batteryTemperatureC >= 40 ? 50 : 0;
  score -= health.storageUsedPercent && health.storageUsedPercent >= 0.9 ? 50 : 0;
  score -= health.batteryHealthPercent !== undefined && health.batteryHealthPercent < 95 ? Math.min(30, (95 - health.batteryHealthPercent) * 1.5) : 0;
  score -= health.batteryCycleCount !== undefined ? Math.min(20, Math.floor(health.batteryCycleCount / 100)) : 0;
  return score;
}

function queuedByActiveCount(username: string): number {
  return countPersistedRunningJobs({ queuedBy: username });
}

function apiKeyActiveCount(apiKeyId: string): number {
  return countPersistedRunningJobs({ apiKeyId });
}

function getJobConcurrencyBlocker(job: Job): string | undefined {
  const cap = config.userConcurrencyCap;
  if (cap > 0 && job.queuedBy && queuedByActiveCount(job.queuedBy) >= cap) {
    return `Waiting for your concurrency limit (${cap}) to free up`;
  }
  if (job.apiKeyId) {
    const maxConcurrent = getApiKeyById(job.apiKeyId)?.maxConcurrent;
    if (maxConcurrent && apiKeyActiveCount(job.apiKeyId) >= maxConcurrent) {
      return `Waiting for API key concurrency limit (${maxConcurrent}) to free up`;
    }
  }
  return undefined;
}

function takeNextDispatchableJobId(device: DeviceRecord): string | undefined {
  for (let i = 0; i < queue.length; i++) {
    const job = jobs.get(queue[i]);
    if (!job || runningJobs.has(job.id) || job.status !== 'queued' || job.pausedAt !== undefined || !isJobDispatchable(job, device)) continue;
    if (getJobConcurrencyBlocker(job)) continue;
    queue.splice(i, 1);
    return job.id;
  }
  return undefined;
}

function takeNextOfflineJobId(): string | undefined {
  for (let i = 0; i < queue.length; i++) {
    const job = jobs.get(queue[i]);
    if (!job || runningJobs.has(job.id) || job.status !== 'queued' || job.pausedAt !== undefined || !canStartOfflineAttempt(job) || getJobConcurrencyBlocker(job)) continue;
    queue.splice(i, 1);
    return job.id;
  }
  return undefined;
}

function startJobWorker(job: Job, resourceId: string, device?: DeviceRecord): boolean {
  if (runningJobs.has(job.id)) return false;
  const lease = claimPersistedJobWorker(job.id, workerInstanceId, resourceId, WORKER_LEASE_MS);
  if (!lease) {
    syncPersistedJobsFromRepository(true);
    return false;
  }
  if (!device && !offlineAppStoreCircuit.beginAttempt()) {
    job.status = 'queued';
    job.startedAt = undefined;
    job.progress = 'queued';
    replacePersistedJobs(jobs.values(), workerInstanceId);
    releasePersistedJobWorker(lease);
    insertByPriority(job.id, job.priority);
    scheduleOfflineCircuitProbe();
    return false;
  }
  busyWorkerResourceIds.add(resourceId);
  job.workerAttemptId = `${lease.workerId}-${lease.generation}`;
  if (device) busyDeviceIds.add(device.id);
  startWorkerLeaseHeartbeat(job.id, lease);
  const run = withCorrelation({
    correlationId: job.correlationId ?? job.id,
    parentCorrelationId: job.parentCorrelationId,
    traceId: job.traceContext?.traceId,
    traceContext: job.traceContext,
  }, () => runOneJob(device, job));
  runningJobs.set(job.id, run);
  void run.finally(() => {
    stopWorkerLeaseHeartbeat(job.id);
    const currentLease = workerLeases.get(job.id)?.lease;
    if (currentLease && !jobStoreClosed) releasePersistedJobWorker(currentLease);
    workerLeases.delete(job.id);
    runningJobs.delete(job.id);
    lostWorkerLeaseJobIds.delete(job.id);
    busyWorkerResourceIds.delete(resourceId);
    if (device) busyDeviceIds.delete(device.id);
    if (!jobStoreClosed) {
      syncPersistedJobsFromRepository(true);
      pumpWorkers();
    }
  }).catch((error: unknown) => log.error('job worker completion cleanup failed', { jobId: job.id, error: String(error) }));
  return true;
}

function pumpWorkers(): void {
  if (jobStoreClosed) return;
  refreshWorkerInstance();
  syncPersistedJobsFromRepository();
  for (const device of getEffectiveDevices()) {
    if (device.draining && !busyDeviceIds.has(device.id) && !isPersistedWorkerResourceActive(`device:${device.id}`)) updateDevice(device.id, { enabled: false }, 'system');
  }
  captureQueuedBlockers();
  expireOverdueQueuedJobs();
  const fairOrder = sortQueuedByEffectivePriority(queue.flatMap((id) => {
    const job = jobs.get(id);
    return job && job.pausedAt === undefined ? [job] : [];
  }));
  queue.splice(0, queue.length, ...fairOrder.map((job) => job.id));
  if (!acceptingJobs) return;
  if (listPersistedWorkers().find((worker) => worker.workerId === workerInstanceId)?.state !== 'active') return;
  for (let slot = 0; slot < config.appStoreOfflineMaxWorkers; slot += 1) {
    const resourceId = `offline:${slot}`;
    if (busyWorkerResourceIds.has(resourceId) || isPersistedWorkerResourceActive(resourceId)) continue;
    const jobId = takeNextOfflineJobId();
    if (!jobId) continue;
    const job = jobs.get(jobId);
    if (job) startJobWorker(job, resourceId);
  }
  const devices = getEffectiveDevices().filter((d) => d.enabled && !d.draining);
  if (devices.length === 0) return;
  const primary = devices.find((d) => d.isPrimary) ?? devices[0];

  const jobsInLastDay = recentDeviceJobCounts();
  const rankedDevices = [...devices].sort((a, b) => deviceScore(b, primary, jobsInLastDay) - deviceScore(a, primary, jobsInLastDay));
  for (const device of rankedDevices) {
    const resourceId = `device:${device.id}`;
    if (busyDeviceIds.has(device.id) || busyWorkerResourceIds.has(resourceId) || isPersistedWorkerResourceActive(resourceId)) continue;
    const jobId = takeNextDispatchableJobId(device);
    if (!jobId) continue;
    const job = jobs.get(jobId);
    if (!job) continue;

    startJobWorker(job, resourceId, device);
  }
}

async function runOneJob(device: DeviceRecord | undefined, job: Job): Promise<void> {
  if (!renewWorkerLease(job.id)) return;
  clearQueuedDeadline(job.id);
  job.status = 'running';
  const controller = new AbortController();
  runningJobControllers.set(job.id, controller);
  const startedAt = Date.now();
  job.startedAt ??= startedAt;
  job.attempt = (job.retryCount ?? 0) + 1 + Number(Boolean(job.offlineFailureReason));
  if (device) {
    job.executionPath = job.offlineFailureReason ? 'device_fallback' : 'device';
    job.deviceId = device.id;
    job.transport = device.transport;
    if (shouldRecordOfflineDeviceHandoff(job) && job.offlineAttemptedAt !== undefined) {
      observeMetric('appstore_offline_to_device_start_ms', Math.max(0, startedAt - job.offlineAttemptedAt), { source: job.source });
      job.offlineDeviceFallbackStartedAt = startedAt;
    }
  } else {
    job.executionPath = 'appstore_offline';
    job.offlineAttemptedAt = startedAt;
    job.deviceId = undefined;
    job.transport = undefined;
  }
  recordJobStarted(job, job.startedAt);
  appendJobTimelineEvent(job, device ? `Started on ${device.name}` : 'Started server-side App Store processing', 'running', startedAt);
  log.info(device ? 'job started' : 'job started on server-side App Store worker', { jobId: job.id, bundleId: job.bundleId, deviceId: device?.id });
  if (device) recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: `Started ${job.testflight ? 'TestFlight' : 'App Store'} decrypt` });
  persistActiveJobs();
  emitJobsChanged();

  try {
    const remainingMs = job.deadlineAt === undefined ? undefined : Math.max(1, job.deadlineAt - Date.now());
    await runWithJobDeadline(
      (signal) => {
        if (device) return runDecrypt(job, device, signal);
        const attemptBudgetMs = computeOfflineAttemptBudgetMs({
          now: Date.now(),
          deadlineAt: job.deadlineAt,
          maximumAttemptMs: config.appStoreOfflineAttemptTimeoutSeconds * 1000,
          fallbackReserveMs: config.appStoreOfflineFallbackReserveSeconds * 1000,
        });
        return runWithOfflineAttemptTimeout(
          (offlineSignal, reportActivity) => runOfflineAppStoreDecrypt(job, offlineSignal, reportActivity),
          signal,
          attemptBudgetMs,
          () => terminateChildProcess(job.childProcess, 'SIGTERM'),
          config.jobProcessGraceSeconds * 1000,
          () => terminateChildProcess(job.childProcess, 'SIGKILL'),
          config.appStoreOfflineStallTimeoutSeconds * 1000,
        );
      },
      controller,
      {
        timeoutMs: remainingMs,
        getDeadlineAt: job.deadlineAt === undefined ? undefined : () => job.deadlineAt,
        graceMs: config.jobProcessGraceSeconds * 1000,
        onDeadline: () => {
          job.deadlineExceeded = true;
          job.progress = 'job deadline exceeded';
          emitJobsChanged();
        },
        forceStop: () => terminateChildProcess(job.childProcess, 'SIGKILL'),
        onForceStopTimeout: (error) => {
          job.progress = 'deadline exceeded; waiting for device work to stop';
          appendJobTimelineEvent(job, job.progress, 'running');
          log.error('job work did not stop after force-kill; keeping its worker reserved', { jobId: job.id, bundleId: job.bundleId, deviceId: device?.id, error: error ? String(error) : undefined });
          emitJobsChanged();
        },
      },
    ).finally(() => {
      if (runningJobControllers.get(job.id) === controller) runningJobControllers.delete(job.id);
    });
    if (!renewWorkerLease(job.id)) return;
    job.status = 'done';
    job.shutdownRecoveryPending = undefined;
    job.finishedAt = Date.now();
    if (job.freeTierResult) job.temporaryResultExpiresAt = job.finishedAt + 30 * 60_000;
    if (!device) {
      incrementMetric('appstore_offline_attempts_total', { outcome: 'success' });
      observeMetric('appstore_offline_attempt_duration_ms', Math.max(0, job.finishedAt - startedAt), { outcome: 'success' });
      job.offlineAttemptDurationMs = Math.max(0, job.finishedAt - startedAt);
      offlineAppStoreCircuit.recordSuccess();
      scheduleOfflineCircuitProbe();
    } else if (job.offlineDeviceFallbackStartedAt !== undefined) {
      job.deviceFallbackDurationMs = Math.max(0, job.finishedAt - job.offlineDeviceFallbackStartedAt);
    }
    incrementMetric('jobs_completed_total', { source: job.source });
    observeMetric('job_duration_ms', Math.max(0, job.finishedAt - (job.startedAt ?? job.createdAt)), { executionPath: job.executionPath, source: job.source });
    appendJobTimelineEvent(job, 'Finished', 'done', job.finishedAt);
    log.info('job done', { jobId: job.id, bundleId: job.bundleId, deviceId: device?.id, executionPath: job.executionPath, sizeBytes: job.fileSizeBytes });
    if (device) recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: 'Decrypt completed' });
    settleJobQuota(job, true);
    persistDoneJobs();
    persistActiveJobs();
  } catch (err) {
    if (job.filePath?.startsWith(`${config.artifactDir}/.staging/`)) {
      await rm(job.filePath, { force: true }).catch(() => {});
      job.filePath = undefined;
    }
    if (lostWorkerLeaseJobIds.has(job.id) || !renewWorkerLease(job.id)) return;
    let message = job.cancelledBy ? `cancelled by ${job.cancelledBy}` : err instanceof Error ? err.message : String(err);
    if (!device) {
      const outcome = job.deadlineExceeded ? 'deadline' : job.cancelledBy ? 'cancelled' : job.shutdownRecoveryPending ? 'interrupted' : 'failure';
      incrementMetric('appstore_offline_attempts_total', { outcome });
      observeMetric('appstore_offline_attempt_duration_ms', Math.max(0, Date.now() - startedAt), { outcome });
      job.offlineAttemptDurationMs = Math.max(0, Date.now() - startedAt);
      if (outcome === 'failure' && !(err instanceof OfflineAppStoreUnsupportedPackageError)) {
        offlineAppStoreCircuit.recordFailure();
        scheduleOfflineCircuitProbe();
      }
    }
    const preventsDeviceFallback = Boolean(err && typeof err === 'object' && 'fallbackToDevice' in err && err.fallbackToDevice === false);
    if (device && job.offlineFailureReason) message = `${message}; earlier server-side attempt failed: ${job.offlineFailureReason}`;
    if (job.shutdownRecoveryPending) {
      persistShutdownRecovery(job);
      return;
    }
    const deferredDeviceReason = /^decrypt deferred:\s*(.+)$/i.exec(message)?.[1];
    if (device && deferredDeviceReason && !job.cancelledBy && !job.deadlineExceeded && (job.deadlineAt === undefined || Date.now() < job.deadlineAt)) {
      deferredDeviceAttempts.set(job.id, {
        deviceId: device.id,
        reason: deferredDeviceReason,
        healthCheckedAt: getCachedDeviceHealth(device.id)?.at ?? Date.now(),
      });
      job.status = 'queued';
      job.progress = 'Waiting for device';
      job.queueReason = deferredDeviceReason;
      job.lastQueueReason = deferredDeviceReason;
      job.error = undefined;
      job.failureClass = undefined;
      job.workerAttemptId = undefined;
      if (job.source === 'scheduler') queue.unshift(job.id);
      else insertByPriority(job.id, job.priority);
      appendJobTimelineEvent(job, `Deferred: ${deferredDeviceReason}`, 'queued');
      scheduleQueuedDeadline(job);
      persistActiveJobs();
      emitJobsChanged();
      return;
    }
    if (!device && !preventsDeviceFallback && !job.cancelledBy && !job.deadlineExceeded && (job.deadlineAt === undefined || Date.now() < job.deadlineAt)) {
      job.offlineFailureReason = message.replace(/\s+/g, ' ').slice(0, 600);
      incrementMetric('appstore_offline_device_fallbacks_total', { failureClass: classifyJobFailure(message), source: job.source });
      job.executionPath = 'device_fallback';
      job.executionStage = undefined;
      job.status = 'queued';
      job.progress = 'Server-side attempt failed; waiting for device fallback';
      job.error = undefined;
      job.failureClass = undefined;
      appendJobTimelineEvent(job, `Server-side attempt failed: ${job.offlineFailureReason}`, 'queued');
      if (job.source === 'scheduler') queue.unshift(job.id);
      else insertByPriority(job.id, job.priority);
      scheduleQueuedDeadline(job);
      persistActiveJobs();
      emitJobsChanged();
      return;
    }
    job.failureClass = classifyJobFailure(message);
    const explicitlyNonRetryable = Boolean(err && typeof err === 'object' && 'retryable' in err && err.retryable === false);
    const remainingDeadlineMs = job.deadlineAt === undefined ? Number.POSITIVE_INFINITY : job.deadlineAt - Date.now();
    const canRetry = !explicitlyNonRetryable
      && !job.cancelledBy
      && !job.deadlineExceeded
      && remainingDeadlineMs > 0
      && (job.retryCount ?? 0) < config.jobMaxRetries
      && ['device_transport', 'app_store', 'testflight', 'network', 'storage'].includes(job.failureClass);
    if (canRetry) {
      job.progress = 'retrying after a transient failure…';
      appendJobTimelineEvent(job, job.progress, 'running');
      log.warn('job failed, retrying once after backoff', { jobId: job.id, bundleId: job.bundleId, deviceId: device?.id, error: message });
      persistActiveJobs();
      emitJobsChanged();
      runningJobControllers.set(job.id, controller);
      try {
        await delayWithSignal(Math.min(RETRY_BACKOFF_MS, remainingDeadlineMs), controller.signal);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      } finally {
        if (runningJobControllers.get(job.id) === controller) runningJobControllers.delete(job.id);
      }
      if (lostWorkerLeaseJobIds.has(job.id) || !renewWorkerLease(job.id)) return;
      if (job.cancelledBy) {
        job.status = 'failed';
        job.finishedAt = Date.now();
        if (job.freeTierResult) job.temporaryResultExpiresAt = job.finishedAt + 30 * 60_000;
        job.error = `cancelled by ${job.cancelledBy}`;
        job.failureClass = classifyJobFailure(job.error);
        appendJobTimelineEvent(job, job.error, 'failed', job.finishedAt);
        log.info('job cancelled during retry backoff', { jobId: job.id, bundleId: job.bundleId, cancelledBy: job.cancelledBy });
        settleJobQuota(job, false);
        persistActiveJobs();
        recordJobHistory(toHistoryEntry(job));
        emitJobsChanged();
        settle(job);
        return;
      }
      if (job.shutdownRecoveryPending) {
        persistShutdownRecovery(job);
        return;
      }
      if (job.deadlineAt !== undefined && Date.now() >= job.deadlineAt) {
        job.deadlineExceeded = true;
        job.progress = 'job deadline exceeded';
        message = job.progress;
      } else if (!controller.signal.aborted) {
        job.retryCount = (job.retryCount ?? 0) + 1;
        return runOneJob(device, job);
      }
    }

    job.failureClass = classifyJobFailure(message);
    job.status = 'failed';
    job.finishedAt = Date.now();
    if (job.freeTierResult) job.temporaryResultExpiresAt = job.finishedAt + 30 * 60_000;
    incrementMetric('jobs_failed_total', { source: job.source, failureClass: job.failureClass });
    observeMetric('job_duration_ms', Math.max(0, job.finishedAt - (job.startedAt ?? job.createdAt)), { executionPath: job.executionPath, source: job.source });
    job.error = message;
    appendJobTimelineEvent(job, `Failed: ${message}`, 'failed', job.finishedAt);
    log.error('job failed', { jobId: job.id, bundleId: job.bundleId, deviceId: device?.id, executionPath: job.executionPath, error: job.error, retried: (job.retryCount ?? 0) > 0 });
    if (device) recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: 'Decrypt failed' });
    settleJobQuota(job, false);
    persistActiveJobs();
  }

  const completedArtifact = job.status === 'done' && job.artifactId ? getArtifactById(job.artifactId) : undefined;
  if (completedArtifact && job.queuedBy) {
    void trackBackgroundWork('artifact-cloud-delivery', () => deliverCompletedArtifact(job.queuedBy!, job.id, completedArtifact)).catch((error: unknown) => {
      log.warn('artifact cloud delivery could not start', { jobId: job.id, artifactId: completedArtifact.id, error: String(error) });
    });
  }
  const downloadUrl = job.status === 'done' && job.freeTierResult
    ? `/v1/dashboard/jobs/${encodeURIComponent(job.id)}/file`
    : completedArtifact ? buildDashboardArtifactFileUrl(completedArtifact.id) : undefined;

  recordJobHistory(toHistoryEntry(job));
  emitJobsChanged();

  if (job.queuedBy) {
    const prefs = getUserPrefs(job.queuedBy);
    const label = job.versionLabel ? `${job.bundleId} (${job.versionLabel})` : job.bundleId;
    const hasWarnings = job.status === 'done' && (job.warnings?.length ?? 0) > 0;
    const title = job.status === 'done'
      ? hasWarnings ? 'Decrypt finished with warnings' : 'Decrypt finished'
      : 'Decrypt failed';
    const body = job.status === 'done'
      ? `${downloadUrl ? `${label} is ready to download.` : `${label} finished, but its artifact is unavailable.`}${hasWarnings ? ` Completed with warnings: ${job.warnings?.join(' ')}` : ''}`
      : `${label} failed: ${job.error ?? 'unknown error'}`;

    const notificationChannels = resolveJobNotificationChannels(prefs, job.bundleId, job.status === 'done' ? 'success' : 'failure');
    const shouldPush = notificationChannels.push;
    if (shouldPush) {
      const jobUrl = `/?job=${encodeURIComponent(job.id)}`;
      void sendPushToUser(job.queuedBy, {
        title,
        body,
        url: downloadUrl ?? jobUrl,
        jobUrl,
        tag: `dkrypt-job-${job.id}`,
        renotify: true,
        actions: downloadUrl
          ? [{ action: 'download', title: 'Download IPA' }, { action: 'open-job', title: 'View job' }]
          : [{ action: 'open-job', title: 'Open job' }],
      });
    }

    const sendDownloadLink = job.status === 'done' && prefs.emailDownloadLinksOnSuccess === true;
    const pickupExpiresAt = sendDownloadLink ? Math.min(Date.now() + EMAIL_PICKUP_LINK_TTL_MS, job.temporaryResultExpiresAt ?? Number.MAX_SAFE_INTEGER) : undefined;
    const canCreateDownloadLink = sendDownloadLink && pickupExpiresAt !== undefined && pickupExpiresAt > Date.now() && Boolean(completedArtifact || job.filePath);
    const emailArtifact = job.freeTierResult ? undefined : completedArtifact;
    const downloadLink = canCreateDownloadLink
      ? createPickupUrl(
          job.queuedBy,
          emailArtifact ? 'artifact' : 'job',
          emailArtifact?.id ?? job.id,
          emailArtifact ? artifactDownloadName(emailArtifact) : `${job.bundleId.replace(/[^A-Za-z0-9._-]/g, '_')}.ipa`,
          pickupExpiresAt!,
        )
      : undefined;
    const shouldMail = notificationChannels.email || Boolean(downloadLink);
    if (shouldMail) void sendMailToUser(job.queuedBy, {
      subject: title,
      text: downloadLink
        ? `${body}\n\nDownload: ${downloadLink}\nThis private link expires ${new Date(pickupExpiresAt!).toISOString()}.`
        : downloadUrl ? `${body}\n\nDownload: ${downloadUrl}` : body,
    });
  }

  settle(job);
}

async function cleanupJob(job: Job): Promise<void> {
  clearQueuedDeadline(job.id);
  if (job.filePath && !job.temporaryResultSharedCache && !job.artifactId && !getArtifactForJob(job)) {
    await rm(job.filePath, { force: true }).catch((err: unknown) => {
      log.warn('failed to remove job file', { jobId: job.id, error: String(err) });
    });
  }
  deletePersistedJob(job.id);
  jobs.delete(job.id);
  log.info('job cleaned up', { jobId: job.id, bundleId: job.bundleId });
  persistDoneJobs();
}

async function expireTemporaryResult(job: Job): Promise<void> {
  await cleanupJob(job);
  deleteJobHistoryEntry(job.id);
}

export async function reclaimJobFile(job: Job): Promise<void> {
  if (job.artifactId || getArtifactForJob(job)) return;
  job.downloadedAt = Date.now();
  await cleanupJob(job);
}

async function reclaimAndMaybeUninstall(job: Job): Promise<void> {
  const { bundleId, status } = job;
  await cleanupJob(job);
  if (status === 'done') {
    await uninstallFromDevice(bundleId, job.deviceId ? getDevice(job.deviceId) : undefined).catch((err: unknown) => {
      log.warn('device uninstall during sweep failed', { bundleId, error: String(err) });
    });
  }
}

let jobSweepTimer: NodeJS.Timeout | undefined;

async function monitorQueueSlo(): Promise<void> {
  const active = getActiveJobs();
  const activeIds = new Set(active.map((job) => job.id));
  for (const jobId of queueSloNotified) if (!activeIds.has(jobId)) queueSloNotified.delete(jobId);
  const targetMs = queueServiceObjectiveMs(config.queueSloMinutes);
  const completedHistory = getAllJobHistory();
  const historicalP95ByProject = historicalDurationP95ByProject(active, completedHistory);
  const now = Date.now();
  for (const job of active) {
    if (job.pausedAt !== undefined) continue;
    const projectId = job.projectId ?? DEFAULT_PROJECT_ID;
    const queue = job.status === 'queued' ? getQueueInfo(job.id) : undefined;
    const assessment = assessQueueServiceObjective({
      createdAt: job.createdAt,
      now,
      status: job.status,
      queuePosition: queue?.position,
      parallelism: getJobEligibleDeviceCount(job),
      objectiveMs: targetMs,
      serviceDurationP95Ms: historicalP95ByProject.get(projectId) ?? null,
    });
    if (assessment.objective !== 'breached' || queueSloNotified.has(job.id)) continue;
    queueSloNotified.add(job.id);
    void notify('queueSloBreach', {
      title: 'Queue service objective breached',
      description: queueServiceObjectiveBreachDescription(job.bundleId, assessment, targetMs),
      color: EMBED_COLOR.warn,
      fields: [
        { name: 'Job', value: job.id, inline: true },
        { name: 'Status', value: job.status, inline: true },
        { name: 'Queue reason', value: getQueueReason(job) ?? 'assigned and running', inline: false },
      ],
    }).catch((error) => log.warn('queue SLO notification failed', { jobId: job.id, error: String(error) }));
  }
}

export function startJobSweeper(): void {
  refreshWorkerInstance();
  syncPersistedJobsFromRepository(true);
  recoverExpiredWorkerJobs();
  pumpWorkers();
  jobSyncTimer ??= setInterval(() => {
    try {
      recoverExpiredWorkerJobs();
      pumpWorkers();
    } catch (error) {
      log.error('worker instance synchronization failed', { error: String(error) });
    }
  }, JOB_SYNC_INTERVAL_MS).unref();
  const intervalMs = 60_000;
  jobSweepTimer ??= setInterval(() => {
    void trackBackgroundWork('queue-slo-monitor', monitorQueueSlo)
      .catch((error: unknown) => log.warn('queue SLO monitoring failed', { error: String(error) }));
    const now = Date.now();
    const retentionMs = config.jobRetentionMinutes * 60_000;

    for (const job of jobs.values()) {

      const finishedAt = job.finishedAt ?? job.createdAt;
      if (job.freeTierResult && job.temporaryResultExpiresAt !== undefined && now >= job.temporaryResultExpiresAt) {
        void trackBackgroundWork('free-result-expiry', () => expireTemporaryResult(job))
          .catch((error: unknown) => log.warn('free result expiry failed', { jobId: job.id, error: String(error) }));
        continue;
      }
      if ((job.status === 'done' || job.status === 'failed') && now - finishedAt > retentionMs) {
        void trackBackgroundWork('job-retention-reclaim', () => reclaimAndMaybeUninstall(job))
          .catch((error: unknown) => log.warn('job retention cleanup failed', { jobId: job.id, error: String(error) }));
      }
    }
  }, intervalMs).unref();
}

export function stopJobSweeper(): void {
  if (jobSweepTimer) clearInterval(jobSweepTimer);
  jobSweepTimer = undefined;
  if (jobSyncTimer) clearInterval(jobSyncTimer);
  jobSyncTimer = undefined;
}

export function stopAcceptingJobs(): void {
  acceptingJobs = false;
}

export interface JobShutdownResult {
  drained: boolean;
  completion: Promise<void>;
}

export function closeJobStore(): void {
  for (const jobId of workerLeases.keys()) stopWorkerLeaseHeartbeat(jobId);
  try {
    releasePersistedWorkersById(workerInstanceId);
    if (workerRegistered) markPersistedWorkerOffline(workerInstanceId);
  } catch (error) {
    log.warn('could not release worker leases during shutdown', { error: String(error) });
  }
  jobStoreClosed = true;
  closePersistedJobs();
}

export async function shutdownJobs(timeoutMs = 120_000): Promise<JobShutdownResult> {
  stopJobSweeper();
  stopAcceptingJobs();
  const queuedForRecovery = queue.splice(0).filter((jobId) => jobs.get(jobId)?.status === 'queued').length;
  for (const jobId of [...queuedDeadlineTimers.keys()]) clearQueuedDeadline(jobId);
  if (queuedForRecovery > 0) log.info('queued jobs preserved for recovery after shutdown', { count: queuedForRecovery });
  persistActiveJobs();
  const runs = [...runningJobs.values()];
  if (runs.length === 0) return { drained: true, completion: Promise.resolve() };
  const runsSettled = Promise.allSettled(runs);
  const drainedBeforeTimeout = await waitForCompletionOrTimeout(runsSettled, timeoutMs);
  if (!drainedBeforeTimeout) {
    for (const job of jobs.values()) {
      if (job.status !== 'running' || !runningJobs.has(job.id)) continue;
      job.shutdownRecoveryPending = true;
      runningJobControllers.get(job.id)?.abort(new Error('dkrypt is shutting down after the drain deadline'));
      terminateJobProcess(job);
    }
    persistActiveJobs();
    const forceStopWaitMs = Math.min(config.jobProcessGraceSeconds * 1000, 10_000, Math.max(250, timeoutMs));
    await waitForCompletionOrTimeout(runsSettled, forceStopWaitMs);
    for (const job of jobs.values()) {
      if (job.status === 'running') terminateChildProcess(job.childProcess, 'SIGKILL');
    }
  }
  const drained = runningJobs.size === 0;
  const completion = runsSettled.then(() => undefined);
  if (drained) await completion;
  return { drained, completion };
}
