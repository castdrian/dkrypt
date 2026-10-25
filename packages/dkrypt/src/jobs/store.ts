import { randomUUID } from 'node:crypto';
import { trackBackgroundWork } from '#backgroundWork.js';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '#config.js';
import { getBillingEntitlements } from '#billing.js';
import { emitJobsChanged } from '#events.js';
import { scopedLogger } from '#logger.js';

const log = scopedLogger('jobs');
import { sendMailToUser } from '#mail.js';
import { sendPushToUser } from '#push.js';
import { DEFAULT_PROJECT_ID, getAllJobHistory, getApiKeyById, getDevice, getEffectiveDevices, getProject, getTestFlightCatalogCache, getUserEffectivePermissions, getUserPrefs, recordDeviceActivity, recordJobHistory, updateDevice, type DeviceRecord } from '#store/state.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { uninstallFromDevice } from '#appStoreInstall.js';
import { getCachedDeviceHealth } from '#deviceHealthCache.js';
import { runDecrypt, runOfflineAppStoreDecrypt } from '#jobs/runner.js';
import { appendJobTimelineEvent, type Job, type JobSource, type TestFlightJobSource } from '#jobs/types.js';
import { artifactKeyForJob, buildDashboardArtifactFileUrl, getArtifactById, getArtifactByKey, getArtifactForJob, linkArtifactToProject, migrateLegacyPath, type ArtifactRecord } from '#artifacts.js';
import { admitQuotaJob, closePersistedJobs, findPersistedActiveJobId, findPersistedReusableCompletedJobIds, loadPersistedJobs, mergeDecryptQuotaOwner, reconcileDecryptQuota, replacePersistedJobs, settleDecryptQuota, type JobBuildLookup } from '#jobs/repository.js';
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
import { offlineAppStoreProcessor, setOfflineAppStoreDispatchNotifier } from '#offlineAppStore.js';

const jobs = new Map<string, Job>();

const donePath = path.join(config.stateDir, 'done-jobs.json');
const activePath = path.join(config.stateDir, 'active-jobs.json');
const queue: string[] = [];
const busyDeviceIds = new Set<string>();
const busyOfflineWorkers = new Set<string>();
const runningJobs = new Map<string, Promise<void>>();
const runningJobControllers = new Map<string, AbortController>();
const queuedDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
const queueSloNotified = new Set<string>();
let acceptingJobs = true;

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
  replacePersistedJobs(jobs.values());
}

function persistActiveJobs(): void {
  const active = [...jobs.values()]
    .filter((j) => j.status === 'queued' || j.status === 'running')
    .map(serializableJob);
  writeLegacyMirror(activePath, active);
  replacePersistedJobs(jobs.values());
}

function loadDoneJobs(): void {
  if (!existsSync(donePath)) return;
  try {
    const restored = JSON.parse(readFileSync(donePath, 'utf8')) as Job[];
    for (const job of restored) {
      job.filePath = migrateLegacyPath(job.filePath);
      if (!job.filePath || !existsSync(job.filePath)) continue;
      jobs.set(job.id, { ...job, projectId: job.projectId ?? DEFAULT_PROJECT_ID, waiters: [] });
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
      if (restored.source === 'scheduler') {
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
      insertByPriority(job.id, job.priority);
      scheduleQueuedDeadline(job);
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
  const { queued, interrupted } = recoverPersistedActiveJobs(saved as Job[]);
  for (const job of saved.filter((entry) => entry.status === 'done' || entry.status === 'failed')) {
    job.filePath = migrateLegacyPath(job.filePath);
    if (job.status === 'done' && job.filePath && !existsSync(job.filePath)) job.filePath = undefined;
    jobs.set(job.id, { ...job, projectId: job.projectId ?? DEFAULT_PROJECT_ID, waiters: [] });
  }
  for (const job of queued) {
    const restoredJob = { ...job, waiters: [] };
    jobs.set(restoredJob.id, restoredJob);
    insertByPriority(restoredJob.id, restoredJob.priority);
    scheduleQueuedDeadline(restoredJob);
  }
  for (const job of interrupted) recordJobHistory(toHistoryEntry(job));
  replacePersistedJobs(jobs.values());
  return true;
}

if (!loadDatabaseJobs()) {
  loadDoneJobs();
  loadActiveJobs();
  replacePersistedJobs(jobs.values());
}
reconcileDecryptQuota();

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

function findActiveJobForBundle(lookup: JobBuildLookup): Job | undefined {
  const persistedId = findPersistedActiveJobId(lookup);
  const persistedJob = persistedId ? jobs.get(persistedId) : undefined;
  if (persistedJob && isMatchingBuild(persistedJob, lookup) && (persistedJob.status === 'queued' || persistedJob.status === 'running')) return persistedJob;
  for (const job of jobs.values()) {
    if (isMatchingBuild(job, lookup) && (job.status === 'queued' || job.status === 'running')) return job;
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
    apiKeyId,
    priority,
    status: 'done',
    progress: 'artifact cache hit',
    timeline: [
      { at: now, label: 'Artifact cache hit', status: 'done' },
      { at: now, label: 'Finished', status: 'done' },
    ],
    artifactId: artifact.id,
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
  const idx = queue.findIndex((qid) => (jobs.get(qid)?.priority ?? 0) < priority);
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
  appendJobTimelineEvent(job, `Failed: ${job.error}`, 'failed', now);
  incrementMetric('jobs_failed_total', { source: job.source, failureClass: job.failureClass });
  log.warn('queued job expired before it could start', { jobId: job.id, bundleId: job.bundleId });
  recordJobHistory(toHistoryEntry(job));
  settle(job);
  persistActiveJobs();
  settleDecryptQuota(job.id, false);
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
    projectId = DEFAULT_PROJECT_ID,
    minimumOsVersion,
  } = options;
  if (!acceptingJobs) throw new JobsShuttingDownError();
  if (options.billingOwnerId && options.billingOwnerId !== 'root' && !hasPermission(getUserEffectivePermissions(options.billingOwnerId), PermissionFlag.requestDecrypt)) throw new AutomationOwnerUnavailableError();
  const lookup = { bundleId, externalVersionId, testFlightBuildId: testflight?.build.id, projectId };
  const existing = findActiveJobForBundle(lookup);
  if (existing) {
    deferScheduledJobIfUnavailable(source, existing, options.deferWhenNoDispatchableDevice);
    if (source === 'scheduler') {
      extendJobDeadlineForScheduler(existing);
    }
    if (existing.status === 'queued') pumpWorkers();
    return existing;
  }
  requireProjectAvailable(projectId);
  const artifactKey = artifactKeyForJob({ id: 'lookup', bundleId, externalVersionId, testflight, versionLabel });
  const artifact = getArtifactByKey(artifactKey);
  if (artifact) {
    linkArtifactToProject(artifact.id, projectId);
    return createCachedJob(bundleId, source, externalVersionId, testflight, versionLabel, queuedBy, priority, apiKeyId, projectId, artifact, minimumOsVersion);
  }
  const reusable = findReusableCompletedJob(lookup);
  if (reusable) return reusable;
  enforceProjectQuotas(projectId);

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
    apiKeyId,
    preferredDeviceId,
    priority,
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

  if (billingOwnerId) {
    const entitlement = getBillingEntitlements(billingOwnerId);
    if (entitlement.planId !== 'viewer' && !entitlement.legacy) admitQuotaJob(job, billingOwnerId, entitlement.dailyDecryptLimit);
  }

  jobs.set(job.id, job);
  if (source === 'scheduler') {
    queue.unshift(job.id);
  } else {
    insertByPriority(job.id, priority);
  }
  scheduleQueuedDeadline(job);
  log.info('job queued', { jobId: job.id, bundleId, externalVersionId, source, priority });
  persistActiveJobs();
  emitJobsChanged();

  pumpWorkers();
  return job;
}

class ProjectQuotaExceededError extends Error {
  readonly statusCode = 429;

  constructor(message: string) {
    super(message);
    this.name = 'ProjectQuotaExceededError';
  }
}

function requireProjectAvailable(projectId: string): void {
  const project = getProject(projectId);
  if (!project || project.archivedAt !== undefined) {
    const error = new Error('project is unavailable');
    Object.assign(error, { statusCode: 404 });
    throw error;
  }
}

function enforceProjectQuotas(projectId: string): void {
  const project = getProject(projectId)!;
  const active = [...jobs.values()].filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === projectId && (job.status === 'queued' || job.status === 'running'));
  if (project.maxConcurrentJobs && active.length >= project.maxConcurrentJobs) {
    throw new ProjectQuotaExceededError('project concurrency limit reached');
  }
  if (!project.dailyJobQuota) return;
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const knownIds = new Set([...jobs.values()].map((job) => job.id));
  const jobsToday = [...jobs.values()].filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === projectId && job.createdAt >= dayStart).length;
  const historyToday = getAllJobHistory().filter((entry) => (entry.projectId ?? DEFAULT_PROJECT_ID) === projectId && entry.createdAt >= dayStart && !knownIds.has(entry.id)).length;
  if (jobsToday + historyToday >= project.dailyJobQuota) throw new ProjectQuotaExceededError('project daily job limit reached');
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function getActiveJobs(): Job[] {
  return [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running');
}

export function getArtifactBackedJobs(): Job[] {
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
  const job = jobs.get(jobId);
  if (!job || job.status === 'done' || job.status === 'failed') return undefined;

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
  const concurrencyBlocker = getJobConcurrencyBlocker(job);
  if (concurrencyBlocker) return concurrencyBlocker;
  if (requiresServerSideAppStoreAttempt(job)) {
    const readiness = offlineAppStoreProcessor.readiness(job);
    if (!readiness.ready) {
      const blockers = readiness.blockers?.join(' · ');
      return blockers ? `Waiting for server-side App Store processing · ${blockers}` : 'Waiting for server-side App Store processing';
    }
    return busyOfflineWorkers.size >= config.appStoreOfflineMaxWorkers ? 'Waiting for a server-side App Store worker' : undefined;
  }
  const enabledDevices = getEffectiveDevices().filter((device) => device.enabled && !device.draining);
  if (enabledDevices.length === 0) {
    if (canStartOfflineAttempt(job)) return busyOfflineWorkers.size >= config.appStoreOfflineMaxWorkers ? 'Waiting for a server-side App Store worker' : undefined;
    const fallback = job.offlineFailureReason ? `Server-side attempt failed: ${job.offlineFailureReason} · ` : '';
    return `${fallback}Waiting for a device accepting jobs`;
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

  const available = eligible.filter((device) => !busyDeviceIds.has(device.id));
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
  const waiters = job.waiters;
  job.waiters = [];
  for (const w of waiters) w(job);
}

function toHistoryEntry(job: Job) {
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
    offlineFailureReason: job.offlineFailureReason,
    ipaMetadata: job.ipaMetadata,
    ipaInfoPlist: job.ipaInfoPlist,
    artifactId: job.artifactId,
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
  const job = jobs.get(id);
  if (!job || job.status !== 'queued') return false;

  const idx = queue.indexOf(id);
  if (idx !== -1) queue.splice(idx, 1);
  clearQueuedDeadline(id);

  job.status = 'failed';
  job.error = `cancelled by ${cancelledBy}`;
  job.finishedAt = Date.now();
  appendJobTimelineEvent(job, job.error, 'failed', job.finishedAt);
  log.info('job cancelled', { jobId: id, bundleId: job.bundleId, cancelledBy });

  persistActiveJobs();
  recordJobHistory(toHistoryEntry(job));
  settleDecryptQuota(job.id, false);
  settle(job);

  emitJobsChanged();
  return true;
}

export function cancelRunningJob(id: string, cancelledBy: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  if (job.cancelledBy) return true;

  job.cancelledBy = cancelledBy;
  job.progress = 'cancelling…';
  appendJobTimelineEvent(job, job.progress, 'running');
  runningJobControllers.get(id)?.abort(new Error(`cancelled by ${cancelledBy}`));
  terminateJobProcess(job);
  log.info('job cancel requested', { jobId: id, bundleId: job.bundleId, cancelledBy });
  persistActiveJobs();
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
  if (!job || job.status !== 'queued' || (projectId && (job.projectId ?? DEFAULT_PROJECT_ID) !== projectId)) return false;

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
  return getJobDeviceBlocker(job, device, {
    health: getCachedDeviceHealth(device.id)?.value,
    testFlightCatalog: getTestFlightCatalogCache(),
  });
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
  const deviceCount = getEffectiveDevices().filter((device) => device.enabled && !device.draining && !busyDeviceIds.has(device.id) && isJobDispatchable(job, device)).length;
  return deviceCount + offlineWorkerSlots(job);
}

function requiresServerSideAppStoreAttempt(job: Job): boolean {
  if (job.testflight || job.offlineAttemptedAt) return false;
  return offlineAppStoreProcessor.readiness(job).enabled;
}

function canStartOfflineAttempt(job: Job): boolean {
  return requiresServerSideAppStoreAttempt(job);
}

function offlineWorkerSlots(job: Job): number {
  if (!canStartOfflineAttempt(job)) return 0;
  return Math.max(0, config.appStoreOfflineMaxWorkers - busyOfflineWorkers.size);
}

export function notifyDeviceDispatchStateChanged(): void {
  pumpWorkers();
}

setOfflineAppStoreDispatchNotifier(notifyDeviceDispatchStateChanged);

function deviceScore(device: DeviceRecord, primary: DeviceRecord): number {
  const cachedHealth = getCachedDeviceHealth(device.id);
  if (!cachedHealth) return device.id === primary.id ? 1 : 0;
  const health = cachedHealth.value;
  if (!health.reachable) return -10_000;

  let score = device.id === primary.id ? 10 : 0;
  score += Math.min(health.storageFreeBytes ? Math.floor(health.storageFreeBytes / (1024 * 1024 * 1024)) : 0, 100);
  score += health.batteryCharging ? 20 : 0;
  score += health.batteryPercent ? Math.floor(health.batteryPercent / 5) : 0;
  score -= health.batteryTemperatureC && health.batteryTemperatureC >= 40 ? 50 : 0;
  score -= health.storageUsedPercent && health.storageUsedPercent >= 0.9 ? 50 : 0;
  return score;
}

function queuedByActiveCount(username: string): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue;
    if (job.queuedBy?.toLowerCase() === username.toLowerCase()) count += 1;
  }
  return count;
}

function apiKeyActiveCount(apiKeyId: string): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === 'running' && job.apiKeyId === apiKeyId) count += 1;
  }
  return count;
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
    if (!job || !isJobDispatchable(job, device)) continue;
    if (getJobConcurrencyBlocker(job)) continue;
    queue.splice(i, 1);
    return job.id;
  }
  return undefined;
}

function takeNextOfflineJobId(): string | undefined {
  for (let i = 0; i < queue.length; i++) {
    const job = jobs.get(queue[i]);
    if (!job || !canStartOfflineAttempt(job) || getJobConcurrencyBlocker(job)) continue;
    queue.splice(i, 1);
    return job.id;
  }
  return undefined;
}

function startJobWorker(job: Job, device?: DeviceRecord): void {
  if (device) busyDeviceIds.add(device.id);
  else busyOfflineWorkers.add(job.id);
  const run = withCorrelation({
    correlationId: job.correlationId ?? job.id,
    parentCorrelationId: job.parentCorrelationId,
    traceId: job.traceContext?.traceId,
    traceContext: job.traceContext,
  }, () => runOneJob(device, job));
  runningJobs.set(job.id, run);
  void run.finally(() => {
    runningJobs.delete(job.id);
    if (device) busyDeviceIds.delete(device.id);
    else busyOfflineWorkers.delete(job.id);
    pumpWorkers();
  });
}

function pumpWorkers(): void {
  for (const device of getEffectiveDevices()) {
    if (device.draining && !busyDeviceIds.has(device.id)) updateDevice(device.id, { enabled: false }, 'system');
  }
  captureQueuedBlockers();
  expireOverdueQueuedJobs();
  if (!acceptingJobs) return;
  while (busyOfflineWorkers.size < config.appStoreOfflineMaxWorkers) {
    const jobId = takeNextOfflineJobId();
    if (!jobId) break;
    const job = jobs.get(jobId);
    if (job) startJobWorker(job);
  }
  const devices = getEffectiveDevices().filter((d) => d.enabled && !d.draining);
  if (devices.length === 0) return;
  const primary = devices.find((d) => d.isPrimary) ?? devices[0];

  const rankedDevices = [...devices].sort((a, b) => deviceScore(b, primary) - deviceScore(a, primary));
  for (const device of rankedDevices) {
    if (busyDeviceIds.has(device.id)) continue;
    const jobId = takeNextDispatchableJobId(device);
    if (!jobId) continue;
    const job = jobs.get(jobId);
    if (!job) continue;

    startJobWorker(job, device);
  }
}

async function runOneJob(device: DeviceRecord | undefined, job: Job): Promise<void> {
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
      (signal) => device ? runDecrypt(job, device, signal) : runOfflineAppStoreDecrypt(job, signal),
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
    job.status = 'done';
    job.shutdownRecoveryPending = undefined;
    job.finishedAt = Date.now();
    if (!device) {
      incrementMetric('appstore_offline_attempts_total', { outcome: 'success' });
      observeMetric('appstore_offline_attempt_duration_ms', Math.max(0, job.finishedAt - startedAt), { outcome: 'success' });
    }
    incrementMetric('jobs_completed_total', { source: job.source });
    observeMetric('job_duration_ms', Math.max(0, job.finishedAt - (job.startedAt ?? job.createdAt)), { executionPath: job.executionPath, source: job.source });
    appendJobTimelineEvent(job, 'Finished', 'done', job.finishedAt);
    log.info('job done', { jobId: job.id, bundleId: job.bundleId, deviceId: device?.id, executionPath: job.executionPath, sizeBytes: job.fileSizeBytes });
    if (device) recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: 'Decrypt completed' });
    persistDoneJobs();
    persistActiveJobs();
    settleDecryptQuota(job.id, true);
  } catch (err) {
    let message = job.cancelledBy ? `cancelled by ${job.cancelledBy}` : err instanceof Error ? err.message : String(err);
    if (!device) {
      const outcome = job.deadlineExceeded ? 'deadline' : job.cancelledBy ? 'cancelled' : job.shutdownRecoveryPending ? 'interrupted' : 'failure';
      incrementMetric('appstore_offline_attempts_total', { outcome });
      observeMetric('appstore_offline_attempt_duration_ms', Math.max(0, Date.now() - startedAt), { outcome });
    }
    const preventsDeviceFallback = Boolean(err && typeof err === 'object' && 'fallbackToDevice' in err && err.fallbackToDevice === false);
    if (device && job.offlineFailureReason) message = `${message}; earlier server-side attempt failed: ${job.offlineFailureReason}`;
    if (job.filePath?.startsWith(`${config.artifactDir}/.staging/`)) {
      await rm(job.filePath, { force: true }).catch(() => {});
      job.filePath = undefined;
    }
    if (job.shutdownRecoveryPending) {
      persistShutdownRecovery(job);
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
      if (job.cancelledBy) {
        job.status = 'failed';
        job.finishedAt = Date.now();
        job.error = `cancelled by ${job.cancelledBy}`;
        job.failureClass = classifyJobFailure(job.error);
        appendJobTimelineEvent(job, job.error, 'failed', job.finishedAt);
        log.info('job cancelled during retry backoff', { jobId: job.id, bundleId: job.bundleId, cancelledBy: job.cancelledBy });
        persistActiveJobs();
        recordJobHistory(toHistoryEntry(job));
        settleDecryptQuota(job.id, false);
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
    incrementMetric('jobs_failed_total', { source: job.source, failureClass: job.failureClass });
    observeMetric('job_duration_ms', Math.max(0, job.finishedAt - (job.startedAt ?? job.createdAt)), { executionPath: job.executionPath, source: job.source });
    job.error = message;
    appendJobTimelineEvent(job, `Failed: ${message}`, 'failed', job.finishedAt);
    log.error('job failed', { jobId: job.id, bundleId: job.bundleId, deviceId: device?.id, executionPath: job.executionPath, error: job.error, retried: (job.retryCount ?? 0) > 0 });
    if (device) recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: 'Decrypt failed' });
    persistActiveJobs();
    settleDecryptQuota(job.id, false);
  }

  const completedArtifact = job.status === 'done' && job.artifactId ? getArtifactById(job.artifactId) : undefined;
  const downloadUrl = completedArtifact ? buildDashboardArtifactFileUrl(completedArtifact.id) : undefined;

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

    const shouldPush = job.status === 'done' ? (prefs.pushOnSuccess ?? true) : (prefs.pushOnFailure ?? true);
    if (shouldPush) {
      void sendPushToUser(job.queuedBy, {
        title,
        body,
        url: downloadUrl ?? `/?job=${encodeURIComponent(job.id)}`,
        actions: downloadUrl
          ? [{ action: 'download', title: 'Download' }]
          : [{ action: 'open-job', title: 'Open job' }],
      });
    }

    const shouldMail = job.status === 'done' ? (prefs.emailOnSuccess ?? false) : (prefs.emailOnFailure ?? false);
    if (shouldMail) void sendMailToUser(job.queuedBy, {
      subject: title,
      text: downloadUrl ? `${body}\n\nDownload: ${downloadUrl}` : body,
    });
  }

  settle(job);
}

async function cleanupJob(job: Job): Promise<void> {
  clearQueuedDeadline(job.id);
  if (job.filePath && !job.artifactId && !getArtifactForJob(job)) {
    await rm(job.filePath, { force: true }).catch((err: unknown) => {
      log.warn('failed to remove job file', { jobId: job.id, error: String(err) });
    });
  }
  jobs.delete(job.id);
  log.info('job cleaned up', { jobId: job.id, bundleId: job.bundleId });
  persistDoneJobs();
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
  pumpWorkers();
  const intervalMs = 60_000;
  jobSweepTimer ??= setInterval(() => {
    void trackBackgroundWork('queue-slo-monitor', monitorQueueSlo)
      .catch((error: unknown) => log.warn('queue SLO monitoring failed', { error: String(error) }));
    const now = Date.now();
    const retentionMs = config.jobRetentionMinutes * 60_000;

    for (const job of jobs.values()) {

      const finishedAt = job.finishedAt ?? job.createdAt;
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
}

export function stopAcceptingJobs(): void {
  acceptingJobs = false;
}

export interface JobShutdownResult {
  drained: boolean;
  completion: Promise<void>;
}

export function closeJobStore(): void {
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
      if (job.status !== 'running') continue;
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
