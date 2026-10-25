import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '#config.js';
import { exportBillingSnapshot, replaceBillingSnapshot } from '#billing.js';
import { SCHEDULER_JOB_TIMEOUT_MS } from '#jobs/timeouts.js';
import { artifactKeyForJob, promoteArtifact } from '#artifacts.js';
import { currentCorrelation, withCorrelation } from '#correlation.js';
import { createDevice, createProject, deleteDevice, getJobHistoryEntryById, getTestFlightCatalogCache, recordJobHistory, setTestFlightCatalogCache, type DeviceRecord } from '#store/state.js';
import { traceContextFromHeader } from '#telemetry.js';
import { getRecentLogs } from '#logger.js';
import { createOtlpMetricsPayload } from '#metrics.js';
import { loadPersistedJobs } from '#jobs/repository.js';
import { getDecryptQuotaUsage } from '#jobs/repository.js';
import { setCachedDeviceHealth } from '#deviceHealthCache.js';
import type { Job } from '#jobs/types.js';

let retryDeadlineAttempts = 0;
let actionRequiredAttempts = 0;
let observedWorkerCorrelation: ReturnType<typeof currentCorrelation>;
let offlineWorkerEnabled = false;
let offlineWorkerReady = false;
let offlineWorkerHold = false;
let offlineWorkerAttempts = 0;
let offlineWorkerRunCount = 0;
let offlineAppStoreDispatchNotifier = () => {};

function metricSample(name: string, labels: Record<string, string>): { sum?: string; count?: string } {
  const metric = createOtlpMetricsPayload('dkrypt').resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((item) => item.name === `dkrypt_${name}`);
  const matchesLabels = (attributes: Array<{ key: string; value: unknown }>) => Object.entries(labels).every(([key, expected]) => {
    const value = attributes.find((attribute) => attribute.key === key)?.value;
    return value !== undefined && typeof value === 'object' && value !== null && 'stringValue' in value && value.stringValue === expected;
  });
  return {
    sum: metric?.sum?.dataPoints.find((point) => matchesLabels(point.attributes))?.asInt,
    count: metric?.histogram?.dataPoints.find((point) => matchesLabels(point.attributes))?.count,
  };
}

function metricCounterValue(name: string, labels: Record<string, string>): number {
  return Number(metricSample(name, labels).sum ?? 0);
}

function metricHistogramCount(name: string, labels: Record<string, string>): number {
  return Number(metricSample(name, labels).count ?? 0);
}

mock.module('#offlineAppStore.js', () => ({
  OfflineAppStoreUnsupportedPackageError: class OfflineAppStoreUnsupportedPackageError extends Error {},
  setOfflineAppStoreDispatchNotifier: (notifier: () => void) => { offlineAppStoreDispatchNotifier = notifier; },
  offlineAppStoreProcessor: {
    readiness: (job?: Pick<Job, 'testflight'>) => ({
      enabled: offlineWorkerEnabled,
      ready: offlineWorkerEnabled && offlineWorkerReady && !job?.testflight,
      blockers: offlineWorkerEnabled && !offlineWorkerReady ? ['Apple Account session needs verification'] : [],
    }),
  },
}));

mock.module('./runner.js', () => ({
  runOfflineAppStoreDecrypt: (job: Job, signal?: AbortSignal) => {
    offlineWorkerRunCount += 1;
    if (offlineWorkerHold) {
      return new Promise<void>((_resolve, reject) => {
        const abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('operation aborted'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (offlineWorkerEnabled && !offlineWorkerReady) return Promise.reject(new Error('Apple Account session needs verification'));
    if (job.bundleId.includes('offline-unavailable')) {
      return Promise.reject(Object.assign(new Error('This app is not available in the signed-in Apple Account storefront'), { retryable: false }));
    }
    if (job.bundleId.includes('offline-fallback')) {
      offlineWorkerAttempts += 1;
      job.retryCount = 2;
      return Promise.reject(new Error('App Store provider download failed'));
    }
    return Promise.reject(new Error('unexpected server-side App Store test job'));
  },
  runDecrypt: (job: Job, _device: unknown, signal?: AbortSignal) => {
    if (job.bundleId.includes('offline-unavailable')) return Promise.resolve();
    if (job.bundleId === 'com.test.trace-propagation') observedWorkerCorrelation = currentCorrelation();
    if (job.bundleId === 'com.test.appstore-action-required') {
      actionRequiredAttempts += 1;
      return Promise.reject(Object.assign(new Error('App Store requires device action before installation can continue'), { retryable: false }));
    }
    if (job.bundleId === 'com.test.retry-deadline' || job.bundleId === 'com.test.retry-cancel') {
      retryDeadlineAttempts += 1;
      if (job.bundleId === 'com.test.retry-deadline') job.deadlineAt = Date.now() + 75;
      return Promise.reject(new Error(job.bundleId === 'com.test.retry-cancel' ? 'the dkrypt device agent connection was lost' : 'network unavailable'));
    }
    return new Promise<void>((_resolve, reject) => {
      const abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('operation aborted'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  },
}));

const { cancelJob, cancelQueuedJob, enqueueDecryptJob, getActiveJobs, getJob, getQueueInfo, getQueueReason, isJobDispatchable, notifyDeviceDispatchStateChanged, prioritizeQueuedJob, reclaimJobFile, recoverPersistedActiveJobs, reorderQueue, ScheduledJobDeferredError, waitForJob } = await import('./store.js');
const { jobSummary } = await import('./http.js');

let testDeviceId = '';

beforeAll(() => {
  testDeviceId = createDevice({ name: 'job-test-device', transport: 'wifi', host: '127.0.0.1' }, 'tests').id;
});

afterAll(() => {
  if (testDeviceId) deleteDevice(testDeviceId, 'tests');
});

async function clearActiveTestJobs(): Promise<void> {
  const active = getActiveJobs();
  for (const job of active) {
    if (job.status === 'queued') cancelQueuedJob(job.id, 'test reset');
    else cancelJob(job.id, 'test reset');
  }
  await Promise.all(active.map((job) => waitForJob(job, 1_000)));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('recoverPersistedActiveJobs', () => {
  test('keeps queued jobs and records a running job as interrupted after a restart', () => {
    const traceContext = traceContextFromHeader('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
    const base = {
      bundleId: 'com.test.restart',
      source: 'scheduler' as const,
      priority: 0,
      progress: 'decrypting',
      createdAt: 1,
      waiters: [],
    };
    const { queued, interrupted } = recoverPersistedActiveJobs([
      { ...base, id: 'queued', status: 'queued', executionStage: 'decrypting', parentCorrelationId: 'request-recovered-1', traceContext },
      { ...base, id: 'running', status: 'running', executionStage: 'decrypting', startedAt: 2 },
    ], 3);

    expect(queued.map((job) => job.id)).toEqual(['queued']);
    expect(queued[0]?.parentCorrelationId).toBe('request-recovered-1');
    expect(queued[0]?.traceContext).toEqual(traceContext);
    expect(queued[0]?.executionStage).toBeUndefined();
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({
      id: 'running',
      status: 'failed',
      error: 'interrupted by dkrypt restart',
      finishedAt: 3,
    });
    expect(interrupted[0]?.executionStage).toBeUndefined();
  });

  test('restores queued scheduler jobs with the scheduler deadline', () => {
    const createdAt = 1_000;
    const deadlineAt = createdAt + 30 * 60 * 1000;
    const { queued } = recoverPersistedActiveJobs([{
      id: 'legacy-scheduler-queue',
      bundleId: 'com.test.legacy-scheduler-queue',
      source: 'scheduler',
      status: 'queued',
      progress: 'queued',
      priority: 0,
      createdAt,
      deadlineAt,
      waiters: [],
    }], createdAt + 60 * 60 * 1000);

    expect(queued[0]?.deadlineAt).toBe(createdAt + SCHEDULER_JOB_TIMEOUT_MS);
    expect(queued[0]?.schedulerDeadlineAt).toBe(createdAt + SCHEDULER_JOB_TIMEOUT_MS);
  });

  test('preserves a longer adopted manual-job deadline after a restart', () => {
    const createdAt = 1_000;
    const schedulerDeadlineAt = createdAt + SCHEDULER_JOB_TIMEOUT_MS;
    const deadlineAt = schedulerDeadlineAt + SCHEDULER_JOB_TIMEOUT_MS;
    const { queued } = recoverPersistedActiveJobs([{
      id: 'adopted-manual-queue',
      bundleId: 'com.test.adopted-manual-queue',
      source: 'manual',
      status: 'queued',
      progress: 'queued',
      priority: 0,
      createdAt,
      schedulerDeadlineAt,
      deadlineAt,
      waiters: [],
    }], createdAt + 60 * 60 * 1000);

    expect(queued[0]?.deadlineAt).toBe(deadlineAt);
    expect(queued[0]?.schedulerDeadlineAt).toBe(schedulerDeadlineAt);
  });

  test('records graceful shutdown recovery independently from the bounded timeline', () => {
    const { queued } = recoverPersistedActiveJobs([{
      id: 'graceful-shutdown-recovery',
      bundleId: 'com.test.graceful-shutdown-recovery',
      source: 'manual',
      status: 'running',
      progress: 'decrypting',
      priority: 0,
      createdAt: 1,
      startedAt: 2,
      shutdownRecoveryPending: true,
      executionStage: 'decrypting',
      waiters: [],
    }], 3);

    expect(queued[0]?.shutdownRecoveryAt).toBe(3);
    expect(queued[0]?.executionStage).toBeUndefined();
  });
});

describe('enqueueDecryptJob', () => {
  test('reserves only new jobs against the account allowance and releases cancelled work', async () => {
    await clearActiveTestJobs();
    const previous = exportBillingSnapshot();
    const ownerId = `quota-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    replaceBillingSnapshot({
      ...previous,
      subscriptions: [...previous.subscriptions, { provider: 'stripe', subscriptionId: `sub_${ownerId}`, customerId: `cus_${ownerId}`, userId: ownerId, status: 'active', planId: 'access', priceId: 'price_access', productId: 'prod_access', occurredAt: now, updatedAt: now }],
    });
    const first = enqueueDecryptJob(`com.test.quota.first.${crypto.randomUUID()}`, 'manual', { queuedBy: ownerId, preferredDeviceId: 'missing-device' });
    enqueueDecryptJob(`com.test.quota.second.${crypto.randomUUID()}`, 'manual', { queuedBy: ownerId, preferredDeviceId: 'missing-device' });
    try {
      expect(enqueueDecryptJob(first.bundleId, 'manual', { queuedBy: ownerId }).id).toBe(first.id);
      expect(() => enqueueDecryptJob(`com.test.quota.third.${crypto.randomUUID()}`, 'manual', { queuedBy: ownerId, preferredDeviceId: 'missing-device' })).toThrow('daily decrypt allowance exhausted');
      expect(cancelQueuedJob(first.id, 'test')).toBe(true);
      expect(enqueueDecryptJob(`com.test.quota.replacement.${crypto.randomUUID()}`, 'manual', { queuedBy: ownerId, preferredDeviceId: 'missing-device' }).status).toBe('queued');
    } finally {
      await clearActiveTestJobs();
      replaceBillingSnapshot(previous);
    }
  });

  test('allows unpinned jobs on any enabled device when no blocker is known', () => {
    const job = { preferredDeviceId: undefined } as Job;

    expect(isJobDispatchable(job, { id: 'secondary-device' } as DeviceRecord)).toBeTrue();
  });

  test('propagates request trace context into queued job execution', async () => {
    await clearActiveTestJobs();
    observedWorkerCorrelation = undefined;
    const traceContext = traceContextFromHeader('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
    const job = withCorrelation({ correlationId: 'request-trace-123', traceId: traceContext.traceId, traceContext }, () =>
      enqueueDecryptJob('com.test.trace-propagation', 'manual'),
    );

    try {
      for (let attempt = 0; attempt < 100 && observedWorkerCorrelation === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(job.traceContext).toEqual(traceContext);
      expect(job).toMatchObject({ parentCorrelationId: 'request-trace-123' });
      const persistedJob = loadPersistedJobs().find((entry) => entry.id === job.id);
      expect(persistedJob).toMatchObject({
        parentCorrelationId: 'request-trace-123',
        traceContext,
      });
      expect(observedWorkerCorrelation).toMatchObject({
        correlationId: job.correlationId,
        parentCorrelationId: 'request-trace-123',
        traceId: traceContext.traceId,
        traceContext,
      });
      const jobLog = getRecentLogs({ scope: 'jobs', limit: 500 }).logs.find((entry) => entry.meta?.jobId === job.id && entry.message === 'job started');
      expect(jobLog?.meta).toMatchObject({ correlationId: job.correlationId, parentCorrelationId: 'request-trace-123' });
    } finally {
      if (job.status === 'running') cancelJob(job.id, 'trace propagation test cleanup');
      await waitForJob(job, 1_000);
    }
  });

  test('records the assigned device transport in job history', async () => {
    const job = enqueueDecryptJob(`com.test.transport.${crypto.randomUUID()}`, 'manual');
    try {
      expect(job).toMatchObject({ status: 'running', deviceId: testDeviceId, transport: 'wifi' });
    } finally {
      if (job.status === 'running') cancelJob(job.id, 'transport test cleanup');
      await waitForJob(job, 1_000);
    }

    expect(getJobHistoryEntryById(job.id)).toMatchObject({ deviceId: testDeviceId, transport: 'wifi' });
  });

  test('falls back to the device on the same job and keeps its quota reservation', async () => {
    await clearActiveTestJobs();
    const previousBilling = exportBillingSnapshot();
    const ownerId = `offline-fallback-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    replaceBillingSnapshot({
      ...previousBilling,
      subscriptions: [...previousBilling.subscriptions, { provider: 'stripe', subscriptionId: `sub_${ownerId}`, customerId: `cus_${ownerId}`, userId: ownerId, status: 'active', planId: 'access', priceId: 'price_access', productId: 'prod_access', occurredAt: now, updatedAt: now }],
    });
    offlineWorkerEnabled = true;
    offlineWorkerReady = true;
    offlineWorkerAttempts = 0;
    const bundleId = `com.test.offline-fallback.${crypto.randomUUID()}`;
    const fallbackCountBefore = metricCounterValue('appstore_offline_device_fallbacks_total', { failureClass: 'app_store', source: 'manual' });
    const offlineFailureCountBefore = metricHistogramCount('appstore_offline_attempt_duration_ms', { outcome: 'failure' });
    const deviceStartCountBefore = metricHistogramCount('appstore_offline_to_device_start_ms', { source: 'manual' });
    const job = enqueueDecryptJob(bundleId, 'manual', { queuedBy: ownerId, preferredDeviceId: testDeviceId });

    try {
      for (let attempt = 0; attempt < 200 && (job.executionPath !== 'device_fallback' || job.status !== 'running'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(offlineWorkerAttempts).toBe(1);
      expect(getJob(job.id)).toMatchObject({ id: job.id, status: 'running', attempt: 4, retryCount: 2, executionPath: 'device_fallback', deviceId: testDeviceId });
      expect(job.timeline?.some((event) => event.label.includes('App Store provider download failed'))).toBe(true);
      expect(getDecryptQuotaUsage(ownerId, 2).used).toBe(1);
      expect(metricCounterValue('appstore_offline_device_fallbacks_total', { failureClass: 'app_store', source: 'manual' })).toBe(fallbackCountBefore + 1);
      expect(metricHistogramCount('appstore_offline_attempt_duration_ms', { outcome: 'failure' })).toBe(offlineFailureCountBefore + 1);
      expect(metricHistogramCount('appstore_offline_to_device_start_ms', { source: 'manual' })).toBe(deviceStartCountBefore + 1);
    } finally {
      offlineWorkerEnabled = false;
      offlineWorkerReady = false;
      if (job.status === 'queued') cancelQueuedJob(job.id, 'offline fallback test cleanup');
      if (job.status === 'running') cancelJob(job.id, 'offline fallback test cleanup');
      await waitForJob(job, 1_000);
      replaceBillingSnapshot(previousBilling);
    }
  });

  test('does not hand an offline job to a device after the user cancels it', async () => {
    await clearActiveTestJobs();
    offlineWorkerEnabled = true;
    offlineWorkerReady = true;
    offlineWorkerHold = true;
    offlineWorkerRunCount = 0;
    const cancelledAttemptCountBefore = metricHistogramCount('appstore_offline_attempt_duration_ms', { outcome: 'cancelled' });
    const job = enqueueDecryptJob(`com.test.offline-cancelled.${crypto.randomUUID()}`, 'manual', { preferredDeviceId: testDeviceId });

    try {
      expect(job).toMatchObject({ status: 'running', executionPath: 'appstore_offline' });
      for (let attempt = 0; attempt < 50 && offlineWorkerRunCount === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(cancelJob(job.id, 'tester')).toBe(true);
      await waitForJob(job, 1_000);
      expect(job).toMatchObject({ status: 'failed', executionPath: 'appstore_offline', cancelledBy: 'tester' });
      expect(job.deviceId).toBeUndefined();
      expect(offlineWorkerRunCount).toBe(1);
      expect(metricHistogramCount('appstore_offline_attempt_duration_ms', { outcome: 'cancelled' })).toBe(cancelledAttemptCountBefore + 1);
    } finally {
      offlineWorkerEnabled = false;
      offlineWorkerReady = false;
      offlineWorkerHold = false;
      if (job.status === 'queued') cancelQueuedJob(job.id, 'offline cancellation test cleanup');
      if (job.status === 'running') cancelJob(job.id, 'offline cancellation test cleanup');
      await waitForJob(job, 1_000);
    }
  });

  test('falls back to the device when the Apple Account storefront has no app listing', async () => {
    await clearActiveTestJobs();
    const previousBilling = exportBillingSnapshot();
    const ownerId = `offline-unavailable-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    replaceBillingSnapshot({
      ...previousBilling,
      subscriptions: [...previousBilling.subscriptions, { provider: 'stripe', subscriptionId: `sub_${ownerId}`, customerId: `cus_${ownerId}`, userId: ownerId, status: 'active', planId: 'access', priceId: 'price_access', productId: 'prod_access', occurredAt: now, updatedAt: now }],
    });
    offlineWorkerEnabled = true;
    offlineWorkerReady = true;
    offlineWorkerRunCount = 0;
    const bundleId = `com.test.offline-unavailable.${crypto.randomUUID()}`;
    const job = enqueueDecryptJob(bundleId, 'manual', { queuedBy: ownerId, preferredDeviceId: testDeviceId });

    try {
      for (let attempt = 0; attempt < 200 && job.status !== 'done'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(offlineWorkerRunCount).toBe(1);
      expect(job).toMatchObject({
        status: 'done',
        attempt: 2,
        executionPath: 'device_fallback',
        deviceId: testDeviceId,
      });
      expect(job.timeline?.some((event) => event.label.startsWith('Started on '))).toBe(true);
      expect(getDecryptQuotaUsage(ownerId, 2).used).toBe(1);
    } finally {
      offlineWorkerEnabled = false;
      offlineWorkerReady = false;
      if (job.status === 'queued') cancelQueuedJob(job.id, 'storefront availability test cleanup');
      if (job.status === 'running') cancelJob(job.id, 'storefront availability test cleanup');
      await waitForJob(job, 1_000);
      replaceBillingSnapshot(previousBilling);
    }
  });

  test('uses a device immediately when server-side App Store prerequisites are not ready', async () => {
    await clearActiveTestJobs();
    offlineWorkerEnabled = true;
    offlineWorkerReady = false;
    offlineWorkerRunCount = 0;
    const job = enqueueDecryptJob(`com.test.offline-not-ready.${crypto.randomUUID()}`, 'manual', { preferredDeviceId: testDeviceId });

    try {
      for (let attempt = 0; attempt < 200 && job.status !== 'running'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(job).toMatchObject({ status: 'running', attempt: 1, executionPath: 'device', deviceId: testDeviceId });
      expect(offlineWorkerRunCount).toBe(0);
    } finally {
      offlineWorkerEnabled = false;
      offlineWorkerReady = false;
      if (job.status === 'queued') cancelQueuedJob(job.id, 'offline readiness test cleanup');
      if (job.status === 'running') cancelJob(job.id, 'offline readiness test cleanup');
      await waitForJob(job, 1_000);
    }
  });

  test('keeps TestFlight jobs on the device workflow when server-side App Store processing is ready', async () => {
    await clearActiveTestJobs();
    const previousCatalog = getTestFlightCatalogCache();
    const bundleId = `com.test.testflight-device.${crypto.randomUUID()}`;
    const appId = Math.floor(Math.random() * 1_000_000) + 1;
    const verifiedAt = Date.now();
    setTestFlightCatalogCache({
      fetchedAt: verifiedAt,
      deviceIds: [testDeviceId],
      apps: [{ appId, bundleId, displayName: 'TestFlight dispatch test', devices: [{ id: testDeviceId, name: 'job-test-device', verifiedAt }], lastVerifiedAt: verifiedAt, deviceSource: true }],
      complete: true,
    });
    offlineWorkerEnabled = true;
    offlineWorkerReady = true;
    offlineWorkerRunCount = 0;
    const job = enqueueDecryptJob(bundleId, 'manual', {
      preferredDeviceId: testDeviceId,
      testflight: { appId, build: { id: 1, cfBundleShortVersion: '1.0', cfBundleVersion: '1', bundleId } },
    });

    try {
      expect(job).toMatchObject({ status: 'running', executionPath: 'device', deviceId: testDeviceId });
      expect(offlineWorkerRunCount).toBe(0);
    } finally {
      offlineWorkerEnabled = false;
      offlineWorkerReady = false;
      if (job.status === 'queued') cancelQueuedJob(job.id, 'TestFlight dispatch test cleanup');
      if (job.status === 'running') cancelJob(job.id, 'TestFlight dispatch test cleanup');
      await waitForJob(job, 1_000);
      setTestFlightCatalogCache(previousCatalog ?? { fetchedAt: 0, deviceIds: [], apps: [], complete: true });
    }
  });

  test('starts a waiting App Store job when server-side processing becomes ready', async () => {
    await clearActiveTestJobs();
    offlineWorkerEnabled = false;
    offlineWorkerReady = false;
    offlineWorkerHold = true;
    const job = enqueueDecryptJob(`com.test.offline-readiness-recovered.${crypto.randomUUID()}`, 'manual', { preferredDeviceId: 'missing-device' });

    try {
      expect(job.status).toBe('queued');
      offlineWorkerEnabled = true;
      offlineWorkerReady = true;
      offlineAppStoreDispatchNotifier();
      expect(job).toMatchObject({ status: 'running', executionPath: 'appstore_offline' });
    } finally {
      offlineWorkerEnabled = false;
      offlineWorkerReady = false;
      offlineWorkerHold = false;
      if (job.status === 'queued') cancelQueuedJob(job.id, 'offline readiness recovery test cleanup');
      if (job.status === 'running') cancelJob(job.id, 'offline readiness recovery test cleanup');
      await waitForJob(job, 1_000);
    }
  });

  test('does not send new App Store jobs to a device when offline workers are occupied', async () => {
    await clearActiveTestJobs();
    offlineWorkerEnabled = true;
    offlineWorkerReady = true;
    offlineWorkerHold = true;
    const first = enqueueDecryptJob(`com.test.offline-worker-first.${crypto.randomUUID()}`, 'manual');
    const second = enqueueDecryptJob(`com.test.offline-worker-second.${crypto.randomUUID()}`, 'manual', { preferredDeviceId: testDeviceId });

    try {
      expect(first).toMatchObject({ status: 'running', executionPath: 'appstore_offline' });
      expect(second).toMatchObject({ status: 'queued' });
      expect(second.executionPath).toBeUndefined();
      expect(getQueueReason(second)).toBe('Waiting for a server-side App Store worker');
    } finally {
      offlineWorkerEnabled = false;
      offlineWorkerReady = false;
      offlineWorkerHold = false;
      if (second.status === 'queued') cancelQueuedJob(second.id, 'offline capacity test cleanup');
      if (first.status === 'running') cancelJob(first.id, 'offline capacity test cleanup');
      await Promise.all([waitForJob(first, 1_000), waitForJob(second, 1_000)]);
    }
  });

  test('scheduler jumps queued dashboard jobs, dedupes same bundle, never overtakes a running job', () => {
    const running = enqueueDecryptJob('com.test.running', 'manual');
    expect(running.status).toBe('running');

    const queuedManual = enqueueDecryptJob('com.test.manual', 'manual');
    const queuedManualAgain = enqueueDecryptJob('com.test.manual', 'manual');
    expect(queuedManualAgain.id).toBe(queuedManual.id);

    const queuedScheduler = enqueueDecryptJob('com.test.scheduler', 'scheduler');

    const runningPos = getQueueInfo(running.id);
    const manualPos = getQueueInfo(queuedManual.id);
    const schedulerPos = getQueueInfo(queuedScheduler.id);

    expect(runningPos?.position).toBe(1);
    expect(schedulerPos?.position).toBeLessThan(manualPos!.position);
    expect(getActiveJobs().map((j) => j.id)).toContain(running.id);
  });

  test('labels an unpinned App Store job as the current release', () => {
    const job = enqueueDecryptJob('com.test.current-release', 'manual');
    expect(job.versionLabel).toBe('Current App Store release');
  });

  test('explains why a queued job is waiting', () => {
    const job = enqueueDecryptJob(`com.test.queue-reason-${crypto.randomUUID()}`, 'manual');
    expect(job.status).toBe('queued');
    expect(getQueueReason(job)).toMatch(/^Waiting /);
  });

  test('preserves distinct device blockers when no device can run a queued job', () => {
    const olderDevice = createDevice({
      name: 'job-test-device-old-ios',
      transport: 'wifi',
      host: '127.0.0.2',
      iosVersion: '17.0',
    }, 'tests');
    let job: Job | undefined;

    try {
      job = enqueueDecryptJob(`com.test.queue-blockers-${crypto.randomUUID()}`, 'manual', { minimumOsVersion: '18.0' });
      const queueReason = getQueueReason(job) ?? '';
      expect(job.status).toBe('queued');
      expect(queueReason).toContain('device iOS version is unknown; cannot verify minimum iOS 18.0');
      expect(queueReason).toContain('device is running iOS 17.0; this build requires iOS 18.0');
    } finally {
      if (job?.status === 'queued') cancelQueuedJob(job.id, 'queue blocker test cleanup');
      deleteDevice(olderDevice.id, 'tests');
    }
  });

  test('reports only the assigned device blocker for a device-pinned job', () => {
    const otherDevice = createDevice({
      name: 'job-test-device-other',
      transport: 'wifi',
      host: '127.0.0.3',
      iosVersion: '17.0',
    }, 'tests');
    let job: Job | undefined;

    try {
      job = enqueueDecryptJob(`com.test.queue-pinned-blocker-${crypto.randomUUID()}`, 'manual', {
        minimumOsVersion: '18.0',
        preferredDeviceId: testDeviceId,
      });
      const queueReason = getQueueReason(job) ?? '';
      expect(queueReason).toContain('device iOS version is unknown; cannot verify minimum iOS 18.0');
      expect(queueReason).not.toContain('job is assigned to another device');
      expect(queueReason).not.toContain('iOS 17.0');
      expect(jobSummary(job).preferredDeviceId).toBe(testDeviceId);
    } finally {
      if (job?.status === 'queued') cancelQueuedJob(job.id, 'pinned queue blocker test cleanup');
      deleteDevice(otherDevice.id, 'tests');
    }
  });

  test('includes historical queue ETA in the job response', async () => {
    await clearActiveTestJobs();
    setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
    const project = createProject({ name: `Queue ETA ${crypto.randomUUID()}` }, 'tests').project!;
    const bundleId = `com.test.queue-eta-${crypto.randomUUID()}`;
    const historyFinishedAt = Date.now() - 20_000;
    recordJobHistory({
      id: `queue-eta-history-${crypto.randomUUID()}`,
      projectId: project.id,
      bundleId,
      source: 'manual',
      status: 'done',
      createdAt: historyFinishedAt - 10_000,
      startedAt: historyFinishedAt - 10_000,
      finishedAt: historyFinishedAt,
    });
    const running = enqueueDecryptJob(`com.test.queue-eta-blocker-${crypto.randomUUID()}`, 'manual', {
      projectId: project.id,
      preferredDeviceId: testDeviceId,
    });
    const queued = enqueueDecryptJob(bundleId, 'manual', {
      projectId: project.id,
      preferredDeviceId: testDeviceId,
    });

    try {
      expect(running.status).toBe('running');
      expect(queued.status).toBe('queued');
      expect(jobSummary(queued).queue).toMatchObject({
        position: 2,
        total: 2,
        predictedStartMs: 10_000,
        predictedCompletionMs: 20_000,
      });
    } finally {
      if (queued.status === 'queued') cancelQueuedJob(queued.id, 'queue ETA test cleanup');
      if (running.status === 'running') cancelJob(running.id, 'queue ETA test cleanup');
      await Promise.all([waitForJob(queued, 1_000), waitForJob(running, 1_000)]);
    }
  });

  test('fails a queued job when its end-to-end deadline expires before dispatch', async () => {
    const originalDeadline = config.jobMaxWaitSeconds;
    config.jobMaxWaitSeconds = 0;

    try {
      const job = enqueueDecryptJob(`com.test.expired-${crypto.randomUUID()}`, 'manual', { preferredDeviceId: 'missing-device' });
      const finished = await waitForJob(job, 100);
      expect(finished).toMatchObject({
        status: 'failed',
        deadlineExceeded: true,
        failureClass: 'queue',
      });
      expect(finished.queueReason).toMatch(/^Waiting /);
      expect(getQueueReason(finished)).toBe(finished.queueReason);
      expect(getJobHistoryEntryById(job.id)?.queueReason).toBe(finished.queueReason);
      expect(finished.error).toContain('job deadline exceeded while waiting in the queue');
      expect(finished.error).toContain('Waiting for');
    } finally {
      config.jobMaxWaitSeconds = originalDeadline;
    }
  });

  test('preserves the last observed queue blocker when it clears before expiration', async () => {
    await clearActiveTestJobs();
    setCachedDeviceHealth(testDeviceId, { reachable: false, error: 'USB device is offline', checkedAt: Date.now() });
    const job = enqueueDecryptJob(`com.test.expired-unblocked.${crypto.randomUUID()}`, 'scheduler', { preferredDeviceId: testDeviceId });
    const observedQueueReason = getQueueReason(job);

    try {
      expect(job.status).toBe('queued');
      expect(observedQueueReason).toContain('USB device is offline');
      expect(job.lastQueueReason).toBe(observedQueueReason);
      expect(loadPersistedJobs().find((persistedJob) => persistedJob.id === job.id)?.lastQueueReason).toBe(observedQueueReason);
      setCachedDeviceHealth(testDeviceId, { reachable: false, error: 'USB agent is unavailable', checkedAt: Date.now() });
      notifyDeviceDispatchStateChanged();
      const latestQueueReason = getQueueReason(job);
      expect(latestQueueReason).toContain('USB agent is unavailable');
      expect(job.lastQueueReason).toBe(latestQueueReason);
      job.deadlineAt = Date.now() - 1;
      setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
      notifyDeviceDispatchStateChanged();

      expect(job).toMatchObject({ status: 'failed', deadlineExceeded: true });
      expect(job.queueReason).toBe(latestQueueReason);
      expect(job.error).toContain(job.queueReason!);
      expect(getJobHistoryEntryById(job.id)?.queueReason).toBe(job.queueReason);
    } finally {
      if (job.status === 'queued') cancelQueuedJob(job.id, 'queue blocker history test cleanup');
      if (job.status === 'running') cancelJob(job.id, 'queue blocker history test cleanup');
      await waitForJob(job, 1_000);
      setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
      notifyDeviceDispatchStateChanged();
    }
  });

  test('gives scheduler jobs the full scheduler deadline instead of the interactive queue deadline', async () => {
    const originalDeadline = config.jobMaxWaitSeconds;
    config.jobMaxWaitSeconds = 0;
    let job: Job | undefined;

    try {
      job = enqueueDecryptJob(`com.test.scheduler-deadline-${crypto.randomUUID()}`, 'scheduler', { preferredDeviceId: 'missing-device' });

      expect(job.deadlineAt! - job.createdAt).toBe(SCHEDULER_JOB_TIMEOUT_MS);
      expect(job.schedulerDeadlineAt).toBe(job.deadlineAt);
    } finally {
      if (job) cancelQueuedJob(job.id, 'test cleanup');
      config.jobMaxWaitSeconds = originalDeadline;
    }
  });

  test('extends a deduplicated interactive job for the scheduler deadline', async () => {
    const originalDeadline = config.jobMaxWaitSeconds;
    config.jobMaxWaitSeconds = 1;
    let manualJob: Job | undefined;

    try {
      const bundleId = `com.test.scheduler-dedupe-deadline-${crypto.randomUUID()}`;
      manualJob = enqueueDecryptJob(bundleId, 'manual', { preferredDeviceId: 'missing-device' });
      const scheduledJob = enqueueDecryptJob(bundleId, 'scheduler', { preferredDeviceId: 'missing-device' });
      const schedulerDeadlineAt = scheduledJob.schedulerDeadlineAt;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const repeatedScheduledJob = enqueueDecryptJob(bundleId, 'scheduler', { preferredDeviceId: 'missing-device' });

      expect(scheduledJob.id).toBe(manualJob.id);
      expect(scheduledJob.deadlineAt).toBeGreaterThanOrEqual(manualJob.createdAt + SCHEDULER_JOB_TIMEOUT_MS);
      expect(repeatedScheduledJob.schedulerDeadlineAt).toBe(schedulerDeadlineAt);
      expect(repeatedScheduledJob.deadlineAt).toBe(schedulerDeadlineAt);
    } finally {
      if (manualJob) cancelQueuedJob(manualJob.id, 'test cleanup');
      config.jobMaxWaitSeconds = originalDeadline;
    }
  });

  test('keeps a deduplicated running job alive through the scheduler deadline extension', async () => {
    const originalDeadline = config.jobMaxWaitSeconds;
    await clearActiveTestJobs();
    config.jobMaxWaitSeconds = 2;
    let manualJob: Job | undefined;

    try {
      const bundleId = `com.test.scheduler-running-deadline-${crypto.randomUUID()}`;
      manualJob = enqueueDecryptJob(bundleId, 'manual');
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      const scheduledJob = enqueueDecryptJob(bundleId, 'scheduler');

      expect(manualJob.status).toBe('running');
      expect(scheduledJob.id).toBe(manualJob.id);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(manualJob.status).toBe('running');
      expect(manualJob.deadlineAt).toBeGreaterThan(Date.now());
    } finally {
      if (manualJob?.status === 'running') cancelJob(manualJob.id, 'test cleanup');
      if (manualJob) await waitForJob(manualJob, 1_000);
      config.jobMaxWaitSeconds = originalDeadline;
    }
  });

  test('reuses a completed exact build while its IPA still exists', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-cache-'));
    const outputPath = path.join(outputDir, 'app.ipa');
    await writeFile(outputPath, 'ipa');
    const bundleId = `com.test.cached.${crypto.randomUUID()}`;
    const artifact = await promoteArtifact({
      key: artifactKeyForJob({ id: 'lookup', bundleId, externalVersionId: '123' }),
      bundleId,
      channel: 'appstore',
      externalVersionId: '123',
      stagingPath: outputPath,
    });
    const completed = enqueueDecryptJob(bundleId, 'manual', { externalVersionId: '123' });

    const retry = enqueueDecryptJob(bundleId, 'manual', { externalVersionId: '123' });
    expect(completed.status).toBe('done');
    expect(completed.artifactId).toBe(artifact.id);
    expect(retry.status).toBe('done');
    expect(retry.artifactId).toBe(artifact.id);
  });

  test('deduplicates jobs and cache hits across legacy workspace identifiers', async () => {
    const bundleId = `com.test.project-cache.${crypto.randomUUID()}`;
    const projectA = createProject({ name: `Cache project A ${crypto.randomUUID()}` }, 'root').project!.id;
    const projectB = createProject({ name: `Cache project B ${crypto.randomUUID()}` }, 'root').project!.id;
    const firstProjectJob = enqueueDecryptJob(bundleId, 'manual', { projectId: projectA });
    const duplicateFirstProjectJob = enqueueDecryptJob(bundleId, 'manual', { projectId: projectA });
    const secondProjectJob = enqueueDecryptJob(bundleId, 'manual', { projectId: projectB });

    expect(firstProjectJob.id).toBe(duplicateFirstProjectJob.id);
    expect(secondProjectJob.id).toBe(firstProjectJob.id);
    expect(firstProjectJob.projectId).toBe('default');
    expect(secondProjectJob.projectId).toBe('default');

    cancelQueuedJob(firstProjectJob.id, 'project test cleanup');

    const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-project-cache-'));
    const outputPath = path.join(outputDir, 'app.ipa');
    await writeFile(outputPath, 'ipa');
    const artifact = await promoteArtifact({
      key: artifactKeyForJob({ id: 'lookup', bundleId, externalVersionId: 'project-cache-build' }),
      bundleId,
      channel: 'appstore',
      externalVersionId: 'project-cache-build',
      projectId: projectA,
      stagingPath: outputPath,
    });
    const shared = enqueueDecryptJob(bundleId, 'manual', { externalVersionId: 'project-cache-build', projectId: projectB });

    expect(shared).toMatchObject({ status: 'done', projectId: 'default', artifactId: artifact.id, cacheHit: true });
    expect(getJobHistoryEntryById(shared.id)).toMatchObject({ status: 'done', cacheHit: true });
    expect(artifact.projectIds).toEqual(['default']);
  });

  test('legacy workspace identifiers share one queue without separate project quotas', async () => {
    const project = createProject({ name: `Concurrency quota ${crypto.randomUUID()}`, maxConcurrentJobs: 1 }, 'root').project!;
    const first = enqueueDecryptJob(`com.test.project-quota.${crypto.randomUUID()}`, 'manual', { projectId: project.id });
    const otherProject = createProject({ name: `Independent quota ${crypto.randomUUID()}` }, 'root').project!;
    const independent = enqueueDecryptJob(`com.test.project-quota.${crypto.randomUUID()}`, 'manual', { projectId: otherProject.id });
    expect(independent.projectId).toBe('default');
    expect(first.projectId).toBe('default');

    cancelQueuedJob(first.id, 'project quota test cleanup');
    cancelQueuedJob(independent.id, 'project quota test cleanup');
  });

  test('reclaims a completed job file without an artifact exception', async () => {
    await clearActiveTestJobs();
    const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-job-retention-'));
    const outputPath = path.join(outputDir, 'app.ipa');
    await writeFile(outputPath, 'ipa');
    const job = enqueueDecryptJob('com.test.scheduler-share', 'scheduler', { preferredDeviceId: 'missing-device' });
    job.status = 'done';
    job.filePath = outputPath;
    job.finishedAt = Date.now();
    await reclaimJobFile(job);
    expect(getJob(job.id)).toBeUndefined();
    expect(existsSync(outputPath)).toBe(false);
  });
});

describe('cancelQueuedJob', () => {
  test('removes a queued job from the queue and marks it failed, but not a running one', async () => {
    await clearActiveTestJobs();
    const running = enqueueDecryptJob('com.test.running', 'manual');
    expect(running.status).toBe('running');
    const queued = enqueueDecryptJob('com.test.cancel-queued', 'manual');

    expect(cancelQueuedJob(running.id, 'tester')).toBe(false);
    expect(getActiveJobs().map((j) => j.id)).toContain(running.id);

    expect(cancelQueuedJob(queued.id, 'tester')).toBe(true);
    expect(getActiveJobs().map((j) => j.id)).not.toContain(queued.id);
    expect(getJob(queued.id)?.status).toBe('failed');
    expect(getJob(queued.id)?.error).toBe('cancelled by tester');

    expect(cancelQueuedJob('does-not-exist', 'tester')).toBe(false);
  });
});

describe('cancelJob', () => {
  test('accepts cancellation while an App Store install is running', async () => {
    const running = getActiveJobs().find((job) => job.status === 'running');
    expect(running).toBeDefined();
    if (!running) return;
    expect(running.status).toBe('running');
    expect(running.childProcess).toBeUndefined();

    const completion = waitForJob(running, 1_000);
    expect(cancelJob(running.id, 'tester')).toBe(true);
    expect(getJob(running.id)?.cancelledBy).toBe('tester');
    await expect(completion).resolves.toMatchObject({ status: 'failed', error: 'cancelled by tester' });
  });

  test('falls back to killing a running job process when it is not queued', () => {
    const running = getActiveJobs().find((job) => job.status === 'running') ?? enqueueDecryptJob('com.test.running', 'manual');
    expect(running.status).toBe('running');

    let killedWith: string | undefined;
    const job = getJob(running.id)!;
    job.cancelledBy = undefined;
    job.childProcess = { kill: (signal: string) => (killedWith = signal) } as unknown as typeof job.childProcess;

    expect(cancelJob(running.id, 'tester')).toBe(true);
    expect(killedWith).toBe('SIGTERM');
    expect(getJob(running.id)?.cancelledBy).toBe('tester');

    expect(cancelJob('does-not-exist', 'tester')).toBe(false);
  });
});

test('does not let transient retry backoff extend the end-to-end job deadline', async () => {
  const originalRetries = config.jobMaxRetries;
  retryDeadlineAttempts = 0;
  config.jobMaxRetries = 1;

  try {
    await clearActiveTestJobs();
    const job = enqueueDecryptJob('com.test.retry-deadline', 'manual');
    const finished = await waitForJob(job, 1_000);

    expect(finished).toMatchObject({
      status: 'failed',
      deadlineExceeded: true,
      error: 'job deadline exceeded',
      attempt: 1,
    });
    expect(finished?.retryCount).toBeUndefined();
    expect(retryDeadlineAttempts).toBe(1);
  } finally {
    config.jobMaxRetries = originalRetries;
  }
});

test('does not retry App Store failures that require a user action', async () => {
  const originalRetries = config.jobMaxRetries;
  actionRequiredAttempts = 0;
  config.jobMaxRetries = 1;

  try {
    await clearActiveTestJobs();
    const job = enqueueDecryptJob('com.test.appstore-action-required', 'manual');
    const finished = await waitForJob(job, 7_000);

    expect(finished).toMatchObject({
      status: 'failed',
      failureClass: 'app_store',
      error: 'App Store requires device action before installation can continue',
    });
    expect(finished?.retryCount).toBeUndefined();
    expect(actionRequiredAttempts).toBe(1);
  } finally {
    config.jobMaxRetries = originalRetries;
    await clearActiveTestJobs();
  }
});

test('cancels a running job while it is waiting for transient Rust device-agent retry backoff', async () => {
  const originalRetries = config.jobMaxRetries;
  retryDeadlineAttempts = 0;
  config.jobMaxRetries = 1;

  try {
    await clearActiveTestJobs();
    const job = enqueueDecryptJob('com.test.retry-cancel', 'manual');
    for (let attempt = 0; attempt < 100 && job.progress !== 'retrying after a transient failure…'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(job.progress).toBe('retrying after a transient failure…');
    expect(cancelJob(job.id, 'tester')).toBe(true);
    await expect(waitForJob(job, 250)).resolves.toMatchObject({
      status: 'failed',
      error: 'cancelled by tester',
      failureClass: 'cancelled',
    });
    expect(retryDeadlineAttempts).toBe(1);
  } finally {
    config.jobMaxRetries = originalRetries;
  }
});

test('reordering and prioritizing changes the one shared queue', async () => {
  await clearActiveTestJobs();
  const blocker = enqueueDecryptJob(`com.test.queue-blocker.${crypto.randomUUID()}`, 'manual');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const projectA = createProject({ name: `Queue project A ${crypto.randomUUID()}` }, 'root').project!.id;
  const projectB = createProject({ name: `Queue project B ${crypto.randomUUID()}` }, 'root').project!.id;
  const firstA = enqueueDecryptJob(`com.test.queue-a1.${crypto.randomUUID()}`, 'manual', { projectId: projectA });
  const firstB = enqueueDecryptJob(`com.test.queue-b1.${crypto.randomUUID()}`, 'manual', { projectId: projectB });
  const secondA = enqueueDecryptJob(`com.test.queue-a2.${crypto.randomUUID()}`, 'manual', { projectId: projectA });
  const secondB = enqueueDecryptJob(`com.test.queue-b2.${crypto.randomUUID()}`, 'manual', { projectId: projectB });

  try {
    expect(blocker.status).toBe('running');
    expect(reorderQueue([secondA.id, firstB.id, secondB.id, firstA.id])).toBe(true);
    expect(getQueueInfo(secondA.id)!.position).toBeLessThan(getQueueInfo(firstB.id)!.position);
    expect(getQueueInfo(firstB.id)!.position).toBeLessThan(getQueueInfo(secondB.id)!.position);
    expect(getQueueInfo(secondB.id)!.position).toBeLessThan(getQueueInfo(firstA.id)!.position);
    expect(prioritizeQueuedJob(firstA.id)).toBe(true);
    expect(getQueueInfo(firstA.id)!.position).toBe(2);
  } finally {
    await clearActiveTestJobs();
  }
});

test('keeps a job queued for a known device blocker and dispatches it after recovery', async () => {
  await clearActiveTestJobs();
  setCachedDeviceHealth(testDeviceId, { reachable: false, error: 'USB device is offline', checkedAt: Date.now() });
  const job = enqueueDecryptJob(`com.test.recoverable.${crypto.randomUUID()}`, 'manual');

  try {
    expect(job.status).toBe('queued');
    expect(getQueueReason(job)).toContain('USB device is offline');
    setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
    notifyDeviceDispatchStateChanged();
    for (let attempt = 0; attempt < 100 && job.status !== 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(job.status).toBe('running');
    expect(job.deviceId).toBe(testDeviceId);
  } finally {
    if (job.status === 'running') cancelJob(job.id, 'dispatch recovery test cleanup');
    await waitForJob(job, 1_000);
    setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
  }
});

test('does not queue a TestFlight scheduler job when every device is blocked', async () => {
  await clearActiveTestJobs();
  setCachedDeviceHealth(testDeviceId, { reachable: false, error: 'USB device is offline', checkedAt: Date.now() });
  const bundleId = `com.test.scheduler-deferred.${crypto.randomUUID()}`;

  try {
    let deferredError: unknown;
    try {
      enqueueDecryptJob(bundleId, 'scheduler', {
        testflight: { appId: 42, build: { id: 501, cfBundleShortVersion: '2.0', cfBundleVersion: '501', bundleId } },
        deferWhenNoDispatchableDevice: true,
      });
    } catch (error) {
      deferredError = error;
    }
    expect(deferredError).toBeInstanceOf(ScheduledJobDeferredError);
    expect(deferredError).toMatchObject({ message: expect.stringContaining('USB device is offline') });
    expect(getActiveJobs().filter((job) => job.bundleId === bundleId)).toHaveLength(0);
  } finally {
    setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
    notifyDeviceDispatchStateChanged();
  }
});

test('does not defer App Store scheduler work for a stale process heartbeat', async () => {
  await clearActiveTestJobs();
  setCachedDeviceHealth(testDeviceId, {
    reachable: true,
    jailbreakAvailable: true,
    testFlightBridgeReachable: true,
    bridgeHeartbeats: { appstore: { at: 0 } },
    subsystems: {
      usb: 'ready', mux: 'ready', agent: 'ready', appStore: 'unknown', testFlight: 'unknown', sshTunnel: 'ready', storage: 'ready', battery: 'ready', thermal: 'ready',
    },
    checkedAt: Date.now(),
  });
  const bundleId = `com.test.scheduler-stale-appstore-heartbeat.${crypto.randomUUID()}`;
  let job: Job | undefined;

  try {
    job = enqueueDecryptJob(bundleId, 'scheduler', {
      preferredDeviceId: testDeviceId,
      deferWhenNoDispatchableDevice: true,
    });

    expect(job.status).toBe('running');
  } finally {
    if (job?.status === 'queued') cancelQueuedJob(job.id, 'stale App Store heartbeat test cleanup');
    if (job?.status === 'running') cancelJob(job.id, 'stale App Store heartbeat test cleanup');
    if (job) await waitForJob(job, 1_000);
    setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
    notifyDeviceDispatchStateChanged();
  }
});

test('defers a scheduler job while its only eligible device is already running work', async () => {
  await clearActiveTestJobs();
  setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
  const running = enqueueDecryptJob(`com.test.scheduler-busy-blocker.${crypto.randomUUID()}`, 'manual', { preferredDeviceId: testDeviceId });
  const bundleId = `com.test.scheduler-busy-deferred.${crypto.randomUUID()}`;

  try {
    expect(running.status).toBe('running');
    let deferredError: unknown;
    try {
      enqueueDecryptJob(bundleId, 'scheduler', {
        preferredDeviceId: testDeviceId,
        deferWhenNoDispatchableDevice: true,
      });
    } catch (error) {
      deferredError = error;
    }
    expect(deferredError).toBeInstanceOf(ScheduledJobDeferredError);
    expect(deferredError).toMatchObject({ message: expect.stringContaining('job-test-device to become available') });
    expect(getActiveJobs().filter((job) => job.bundleId === bundleId)).toHaveLength(0);
  } finally {
    if (running.status === 'running') cancelJob(running.id, 'scheduler busy device test cleanup');
    await waitForJob(running, 1_000);
  }
});

test('defers a scheduler request for an existing queued job while its device is busy', async () => {
  await clearActiveTestJobs();
  setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
  const running = enqueueDecryptJob(`com.test.scheduler-existing-busy-blocker.${crypto.randomUUID()}`, 'manual', { preferredDeviceId: testDeviceId });
  const bundleId = `com.test.scheduler-existing-busy.${crypto.randomUUID()}`;
  const queued = enqueueDecryptJob(bundleId, 'manual', { preferredDeviceId: testDeviceId });

  try {
    expect(running.status).toBe('running');
    expect(queued.status).toBe('queued');
    let deferredError: unknown;
    try {
      enqueueDecryptJob(bundleId, 'scheduler', {
        preferredDeviceId: testDeviceId,
        deferWhenNoDispatchableDevice: true,
      });
    } catch (error) {
      deferredError = error;
    }
    expect(deferredError).toBeInstanceOf(ScheduledJobDeferredError);
    expect(queued.status).toBe('queued');
  } finally {
    await clearActiveTestJobs();
  }
});

test('defers a scheduler request for an existing job blocked by its owner concurrency limit', async () => {
  await clearActiveTestJobs();
  const originalUserConcurrencyCap = config.userConcurrencyCap;
  const secondaryDevice = createDevice({ name: 'job-test-secondary-device', transport: 'wifi', host: '127.0.0.2' }, 'tests').id;
  config.userConcurrencyCap = 1;
  setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
  setCachedDeviceHealth(secondaryDevice, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
  const running = enqueueDecryptJob(`com.test.scheduler-concurrency-blocker.${crypto.randomUUID()}`, 'manual', {
    queuedBy: 'scheduler-concurrency-owner',
    preferredDeviceId: testDeviceId,
  });
  const bundleId = `com.test.scheduler-concurrency-deferred.${crypto.randomUUID()}`;
  const queued = enqueueDecryptJob(bundleId, 'manual', {
    queuedBy: 'scheduler-concurrency-owner',
    preferredDeviceId: secondaryDevice,
  });

  try {
    expect(running.status).toBe('running');
    expect(queued.status).toBe('queued');

    let deferredError: unknown;
    try {
      enqueueDecryptJob(bundleId, 'scheduler', {
        preferredDeviceId: secondaryDevice,
        deferWhenNoDispatchableDevice: true,
      });
    } catch (error) {
      deferredError = error;
    }

    if (!(deferredError instanceof ScheduledJobDeferredError)) {
      queued.deadlineAt = Date.now() - 1;
      notifyDeviceDispatchStateChanged();
    }

    expect({ status: queued.status, error: queued.error }).toEqual({ status: 'queued', error: undefined });
    expect(deferredError).toBeInstanceOf(ScheduledJobDeferredError);
    expect(deferredError).toMatchObject({ message: expect.stringContaining('Waiting for your concurrency limit (1) to free up') });
  } finally {
    config.userConcurrencyCap = originalUserConcurrencyCap;
    if (queued.status === 'queued') cancelQueuedJob(queued.id, 'scheduler concurrency test cleanup');
    if (running.status === 'running') cancelJob(running.id, 'scheduler concurrency test cleanup');
    await Promise.all([waitForJob(queued, 1_000), waitForJob(running, 1_000)]);
    deleteDevice(secondaryDevice, 'tests');
  }
});

test('wakes an existing queued job when the scheduler adopts it after device recovery', async () => {
  await clearActiveTestJobs();
  setCachedDeviceHealth(testDeviceId, { reachable: false, error: 'USB device is offline', checkedAt: Date.now() });
  const bundleId = `com.test.scheduler-adopted-recovered.${crypto.randomUUID()}`;
  const queued = enqueueDecryptJob(bundleId, 'manual', { preferredDeviceId: testDeviceId });

  try {
    expect(queued.status).toBe('queued');
    setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
    const adopted = enqueueDecryptJob(bundleId, 'scheduler', {
      preferredDeviceId: testDeviceId,
      deferWhenNoDispatchableDevice: true,
    });

    expect(adopted).toBe(queued);
    expect(adopted.status).toBe('running');
  } finally {
    if (queued.status === 'queued') cancelQueuedJob(queued.id, 'scheduler adoption test cleanup');
    if (queued.status === 'running') cancelJob(queued.id, 'scheduler adoption test cleanup');
    await waitForJob(queued, 1_000);
    setCachedDeviceHealth(testDeviceId, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
    notifyDeviceDispatchStateChanged();
  }
});

test('retains the resolved minimum iOS version in the queued job', () => {
  const job = enqueueDecryptJob(`com.test.minimum-os.${crypto.randomUUID()}`, 'manual', { versionLabel: '2.0', minimumOsVersion: '17.0' });
  expect(job.minimumOsVersion).toBe('17.0');
  cancelQueuedJob(job.id, 'minimum OS test cleanup');
});
