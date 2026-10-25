import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createJobRepository, sharedOfflineWorkerCapacity, workerRuntimeConfigurationConsistent, type PersistedWorkerInstance } from '#jobs/repository.js';
import type { Job } from '#jobs/types.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

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
