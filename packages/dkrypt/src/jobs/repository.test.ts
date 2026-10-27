import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createJobRepository, sharedOfflineWorkerCapacity, workerRuntimeConfigurationConsistent, type PersistedWorkerInstance } from '#jobs/repository.js';
import type { Job } from '#jobs/types.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

const abuseContext = { networkHash: 'network-test', addressHash: 'address-test' };

function createJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'workspace-a',
    bundleId: 'com.example.app',
    source: 'manual',
    priority: 0,
    status: 'queued',
    progress: 'queued',
    createdAt: 100,
    timeline: [{ at: 100, label: 'Queued', status: 'queued' }],
    waiters: [],
    ...overrides,
  };
}

test('worker fleet estimates shared offline slots once and checks draining runtime settings', () => {
  const base: PersistedWorkerInstance = {
    workerId: 'worker-a',
    startedAt: 1,
    heartbeatAt: 1,
    state: 'active',
    configuration: { runtimeVersion: 'v1.2.3', offlineConcurrency: 2, maxJobWaitSeconds: 1800, maxRetries: 1, databaseBusyTimeoutMs: 5000 },
    activeLeases: 0,
    resources: [],
  };
  const second: PersistedWorkerInstance = {
    ...base,
    workerId: 'worker-b',
    configuration: { ...base.configuration },
  };

  expect(sharedOfflineWorkerCapacity([base, second])).toBe(2);
  expect(workerRuntimeConfigurationConsistent([base, second])).toBeTrue();
  expect(workerRuntimeConfigurationConsistent([base, { ...second, state: 'draining', configuration: { ...second.configuration, maxRetries: 2 }, activeLeases: 1 }])).toBeFalse();
  expect(sharedOfflineWorkerCapacity([{ ...base, state: 'draining' }])).toBe(0);
});

test('job repository indexes existing JSON jobs after SQLite migration', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-job-repository-migration-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  const legacyDatabase = new Database(databasePath, { create: true, strict: true });
  legacyDatabase.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);');
  legacyDatabase.query('INSERT INTO jobs (id, payload, updated_at) VALUES (?, ?, ?)').run('legacy-job', JSON.stringify({
    id: 'legacy-job',
    projectId: 'workspace-legacy',
    bundleId: 'com.example.legacy',
    source: 'manual',
    priority: 3,
    status: 'queued',
    progress: 'queued',
    createdAt: 50,
    externalVersionId: 'legacy-build',
    testflight: { appId: 42, build: { id: 501 } },
  }), 50);
  legacyDatabase.close();

  let repository: ReturnType<typeof createJobRepository> | undefined;
  try {
    const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']);
    repository = createJobRepository(database);

    expect(repository.findActiveId({
      projectId: 'default',
      bundleId: 'com.example.legacy',
      externalVersionId: 'legacy-build',
      testFlightBuildId: 501,
    })).toBe('legacy-job');
    expect(repository.findActiveId({
      projectId: 'other-scope',
      bundleId: 'com.example.legacy',
      externalVersionId: 'legacy-build',
      testFlightBuildId: 501,
    })).toBeUndefined();
    expect(repository.load()).toMatchObject([{ id: 'legacy-job', projectId: 'default', status: 'queued' }]);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('job repository persists exact-build lookups and timelines across restart', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-job-repository-restart-'));
  const options = { stateDir, filename: 'state.sqlite' };
  let repository: ReturnType<typeof createJobRepository> | undefined;

  try {
    repository = createJobRepository(openStateCollectionDatabase(options, ['jobs', 'job_timelines']));
    const traceContext = {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
      traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    };
    const completed = createJob({
      id: 'completed-build',
      correlationId: 'job-correlation-7',
      parentCorrelationId: 'http-request-7',
      traceContext,
      status: 'done',
      externalVersionId: 'build-7',
      filePath: '/artifacts/build-7.ipa',
      finishedAt: 200,
      timeline: [
        { at: 100, label: 'Queued', status: 'queued' },
        { at: 200, label: 'Finished', status: 'done' },
      ],
    });
    const otherProject = createJob({
      id: 'other-project-build',
      projectId: 'workspace-b',
      status: 'done',
      externalVersionId: 'build-7',
      filePath: '/artifacts/build-7-other.ipa',
      finishedAt: 210,
    });
    repository.replace([completed, otherProject]);

    expect(repository.findReusableCompletedIds({
      projectId: 'workspace-a',
      bundleId: 'com.example.app',
      externalVersionId: 'build-7',
    })).toEqual(['completed-build']);
    repository.close();
    repository = undefined;

    repository = createJobRepository(openStateCollectionDatabase(options, ['jobs', 'job_timelines']));
    expect(repository.load()).toContainEqual(expect.objectContaining({
      id: 'completed-build',
      status: 'done',
      correlationId: 'job-correlation-7',
      parentCorrelationId: 'http-request-7',
      traceContext,
      externalVersionId: 'build-7',
      timeline: completed.timeline,
    }));
    expect(repository.findReusableCompletedIds({
      projectId: 'workspace-b',
      bundleId: 'com.example.app',
      externalVersionId: 'build-7',
    })).toEqual(['other-project-build']);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('quota receipt is available only to its owning account and reflects reservation settlement', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-job-quota-receipt-'));
  let repository: ReturnType<typeof createJobRepository> | undefined;

  try {
    repository = createJobRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']));
    const job = createJob({ id: 'quota-receipt-job', createdAt: 1_800_000_000_000 });
    expect(repository.admit(job, 'Member@example.test', 2)).toBe(job.id);
    expect(repository.quotaReceipt(job.id, 'member@example.test')).toEqual({ admittedAt: job.createdAt, state: 'reserved' });
    expect(repository.quotaReceipt(job.id, 'another@example.test')).toBeUndefined();
    repository.settleQuota(job.id, true);
    expect(repository.quotaReceipt(job.id, 'member@example.test')).toEqual({ admittedAt: job.createdAt, state: 'consumed' });
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('free quota reservations settle to anonymous completion timestamps and expire after 30 days', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-free-quota-ledger-'));
  let repository: ReturnType<typeof createJobRepository> | undefined;

  try {
    const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']);
    repository = createJobRepository(database);
    const ownerId = 'free-member@example.test';
    const startedAt = Date.now();

    for (let index = 0; index < 3; index += 1) {
      const job = createJob({ id: `free-quota-${index}`, bundleId: `com.example.free${index}`, createdAt: startedAt + index });
      expect(repository.admit(job, ownerId, 3, true, abuseContext)).toBe(job.id);
      repository.settleQuota(job.id, true);
    }

    const rows = database.query('SELECT owner_id, job_id, reserved_at, completed_at FROM free_decrypt_quota WHERE owner_id = ?').all(ownerId) as Array<{ owner_id: string; job_id: string | null; reserved_at: number | null; completed_at: number | null }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.job_id === null && row.reserved_at === null && typeof row.completed_at === 'number')).toBeTrue();
    expect(repository.freeQuotaUsage(ownerId, Date.now() + 60_000)).toMatchObject({ limit: 3, used: 3, remaining: 0 });

    const blocked = createJob({ id: 'free-quota-blocked', bundleId: 'com.example.blocked', createdAt: Date.now() + 60_000 });
    expect(() => repository!.admit(blocked, ownerId, 3, true, abuseContext)).toThrow('free decrypt allowance exhausted');

    const nextWindow = Math.max(...rows.map((row) => row.completed_at ?? 0)) + 30 * 24 * 60 * 60 * 1000 + 1;
    expect(repository.freeQuotaUsage(ownerId, nextWindow)).toMatchObject({ limit: 3, used: 0, remaining: 3 });
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('free quota backup data contains only recent completion timestamps and restores usage', async () => {
  const firstStateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-free-quota-backup-source-'));
  const restoredStateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-free-quota-backup-target-'));
  let source: ReturnType<typeof createJobRepository> | undefined;
  let restored: ReturnType<typeof createJobRepository> | undefined;

  try {
    source = createJobRepository(openStateCollectionDatabase({ stateDir: firstStateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']));
    const ownerId = 'quota-backup@example.test';
    const now = Date.now();
    for (let index = 0; index < 2; index += 1) {
      const job = createJob({ id: `quota-backup-${index}`, createdAt: now + index });
      source.admit(job, ownerId, 3, true, abuseContext);
      source.settleQuota(job.id, true);
    }
    const pending = createJob({ id: 'quota-backup-pending', createdAt: now + 3 });
    source.admit(pending, ownerId, 3, true, abuseContext);

    const capturedAt = Date.now() + 60_000;
    const completionRecords = source.freeQuotaCompletions(capturedAt);
    expect(completionRecords).toHaveLength(2);
    expect(completionRecords.every((record) => record.ownerId === ownerId && record.completedAt >= now && record.completedAt <= capturedAt)).toBeTrue();
    expect(completionRecords[0]).not.toHaveProperty('jobId');

    restored = createJobRepository(openStateCollectionDatabase({ stateDir: restoredStateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']));
    restored.replaceFreeQuotaCompletions(completionRecords);
    expect(restored.freeQuotaUsage(ownerId, capturedAt)).toMatchObject({ used: 2, remaining: 1 });
    expect(restored.freeQuotaCompletions(Math.max(...completionRecords.map((entry) => entry.completedAt)) + 31 * 24 * 60 * 60 * 1000)).toEqual([]);
  } finally {
    source?.close();
    restored?.close();
    await rm(firstStateDir, { recursive: true, force: true });
    await rm(restoredStateDir, { recursive: true, force: true });
  }
});

test('free quota reservations are released when work fails or is cancelled', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-free-quota-release-'));
  let repository: ReturnType<typeof createJobRepository> | undefined;

  try {
    repository = createJobRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']));
    const ownerId = 'free-release@example.test';
    const job = createJob({ id: 'free-quota-release', createdAt: Date.now() });
    expect(repository.admit(job, ownerId, 3, true, abuseContext)).toBe(job.id);
    expect(repository.freeQuotaUsage(ownerId).used).toBe(1);
    repository.settleQuota(job.id, false);
    expect(repository.freeQuotaUsage(ownerId).used).toBe(0);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('burst credits reserve atomically, return after failed jobs, expire, and revoke on Stripe refunds', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-job-credit-ledger-'));
  let repository: ReturnType<typeof createJobRepository> | undefined;

  try {
    repository = createJobRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']));
    const ownerId = 'member@example.test';
    const now = 1_800_000_000_000;
    const paymentIntentId = 'pi_credit_test';
    const grant = repository.grantCredits(ownerId, 2, 'stripe', paymentIntentId, now + 60_000, now);
    expect(grant.granted).toBeTrue();
    expect(repository.grantCredits(ownerId, 2, 'stripe', paymentIntentId, now + 60_000, now).granted).toBeFalse();
    expect(repository.creditBalance(ownerId, now).available).toBe(2);

    const failed = createJob({ id: 'credit-failed-job', createdAt: now });
    expect(repository.admit(failed, ownerId, 0)).toBe(failed.id);
    expect(repository.creditBalance(ownerId, now).available).toBe(1);
    repository.replace([{ ...failed, status: 'failed', progress: 'failed' }]);
    repository.settleQuota(failed.id, false);
    expect(repository.creditBalance(ownerId, now).available).toBe(2);

    const succeeded = createJob({ id: 'credit-success-job', createdAt: now + 1 });
    expect(repository.admit(succeeded, ownerId, 0)).toBe(succeeded.id);
    repository.settleQuota(succeeded.id, true);
    expect(repository.creditBalance(ownerId, now + 1).available).toBe(1);

    const revoked = repository.revokeStripeCreditGrant(ownerId, paymentIntentId, 2, now + 2);
    expect(revoked.revoked).toBeTrue();
    expect(repository.revokeStripeCreditGrant(ownerId, paymentIntentId, 2, now + 3).revoked).toBeFalse();
    expect(repository.creditBalance(ownerId, now + 3).available).toBe(0);

    const refundedFirst = repository.revokeStripeCreditGrant(ownerId, 'pi_refunded_first', 4, now + 4);
    expect(refundedFirst.revoked).toBeTrue();
    expect(repository.grantCredits(ownerId, 4, 'stripe', 'pi_refunded_first', undefined, now + 5).granted).toBeFalse();
    expect(repository.creditBalance(ownerId, now + 5).available).toBe(0);

    repository.grantCredits(ownerId, 1, 'stripe', 'pi_active_reservation', undefined, now + 6);
    const refundedReservation = createJob({ id: 'credit-refunded-reservation', bundleId: 'com.example.refunded', createdAt: now + 6 });
    expect(repository.admit(refundedReservation, ownerId, 0)).toBe(refundedReservation.id);
    expect(repository.revokeStripeCreditGrant(ownerId, 'pi_active_reservation', 1, now + 7).revoked).toBeTrue();
    repository.replace([{ ...refundedReservation, status: 'failed', progress: 'failed' }]);
    repository.settleQuota(refundedReservation.id, false);
    expect(repository.creditBalance(ownerId, now + 8).available).toBe(0);

    repository.grantCredits(ownerId, 3, 'manual', 'expired-credit', now + 10, now);
    expect(repository.creditBalance(ownerId, now + 10).available).toBe(0);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('worker drains preserve active leases and stop new job claims', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-worker-drain-'));
  let repository: ReturnType<typeof createJobRepository> | undefined;

  try {
    repository = createJobRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']));
    const configuration = { runtimeVersion: 'v1.2.3', offlineConcurrency: 2, maxJobWaitSeconds: 1800, maxRetries: 1, databaseBusyTimeoutMs: 5000 };
    repository.registerWorker('worker-a', configuration, 1_000);
    const first = createJob({ id: 'job-running' });
    const second = createJob({ id: 'job-queued' });
    repository.replace([first, second]);
    const lease = repository.claimWorker(first.id, 'worker-a', 'device:one', 60_000, 1_000);

    expect(lease).toBeDefined();
    expect(repository.setWorkerDrain('worker-a', true, 1_001)).toBeTrue();
    expect(repository.listWorkers(1_002)).toMatchObject([{ state: 'draining', activeLeases: 1 }]);
    expect(repository.claimWorker(second.id, 'worker-a', 'device:two', 60_000, 1_002)).toBeUndefined();

    repository.releaseWorker(lease!);
    repository.heartbeatWorker('worker-a', configuration, 1_003);
    expect(repository.listWorkers(1_004)).toMatchObject([{ state: 'drained', activeLeases: 0 }]);
    expect(repository.claimWorker(second.id, 'worker-a', 'device:two', 60_000, 1_004)).toBeUndefined();

    expect(repository.setWorkerDrain('worker-a', false, 1_005)).toBeTrue();
    expect(repository.claimWorker(second.id, 'worker-a', 'device:two', 60_000, 1_006)).toBeDefined();
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('worker configuration snapshots expose stale workers and runtime differences', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-worker-configuration-'));
  let repository: ReturnType<typeof createJobRepository> | undefined;

  try {
    repository = createJobRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']));
    const first = { runtimeVersion: 'v1.2.3', offlineConcurrency: 1, maxJobWaitSeconds: 1800, maxRetries: 1, databaseBusyTimeoutMs: 5000 };
    const second = { ...first, maxRetries: 2 };
    repository.registerWorker('worker-a', first, 1_000);
    repository.registerWorker('worker-b', second, 1_000);
    repository.heartbeatWorker('worker-a', first, 1_100);

    expect(repository.listWorkers(1_101)).toMatchObject([
      { workerId: 'worker-a', state: 'active', configuration: first },
      { workerId: 'worker-b', state: 'active', configuration: second },
    ]);
    expect(repository.listWorkers(22_000)).toMatchObject([
      { workerId: 'worker-a', state: 'offline' },
      { workerId: 'worker-b', state: 'offline' },
    ]);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
