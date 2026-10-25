import { expect, mock, test } from 'bun:test';
import type { Job } from '#jobs/types.js';
import { DEFAULT_PROJECT_ID, createDevice, deleteDevice, recordJobHistory } from '#store/state.js';
import { setCachedDeviceHealth } from '#deviceHealthCache.js';

mock.module('./jobs/runner.js', () => ({
  runOfflineAppStoreDecrypt: async () => {},
  runDecrypt: (_job: Job, _device: unknown, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
    const abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('operation aborted'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  }),
}));

const { cancelJob, cancelQueuedJob, enqueueDecryptJob, waitForJob } = await import('#jobs/store.js');
const { buildDashboardOverview } = await import('#dashboardOverview.js');

test('dashboard overview reports each queued job estimated start and completion times', async () => {
  const device = createDevice({ name: 'dashboard-eta-device', transport: 'wifi', host: '127.0.0.4' }, 'tests');
  setCachedDeviceHealth(device.id, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
  const bundleId = `com.test.dashboard-eta-${crypto.randomUUID()}`;
  const historyFinishedAt = Date.now() - 20_000;
  recordJobHistory({
    id: `dashboard-eta-history-${crypto.randomUUID()}`,
    projectId: DEFAULT_PROJECT_ID,
    bundleId,
    source: 'manual',
    status: 'done',
    createdAt: historyFinishedAt - 10_000,
    startedAt: historyFinishedAt - 10_000,
    finishedAt: historyFinishedAt,
  });
  const running = enqueueDecryptJob(`com.test.dashboard-eta-blocker-${crypto.randomUUID()}`, 'manual', {
    projectId: DEFAULT_PROJECT_ID,
    preferredDeviceId: device.id,
  });
  const queued = enqueueDecryptJob(bundleId, 'manual', {
    projectId: DEFAULT_PROJECT_ID,
    preferredDeviceId: device.id,
  });

  try {
    const overview = buildDashboardOverview(0n, 'root');
    expect(running.status).toBe('running');
    expect(queued.status).toBe('queued');
    expect(overview.activeJobs.find((job) => job.id === queued.id)?.queue).toMatchObject({
      position: 2,
      total: 2,
      predictedStartMs: 10_000,
      predictedCompletionMs: 20_000,
    });
    expect(overview.activeJobs.find((job) => job.id === queued.id)?.preferredDeviceId).toBe(device.id);
  } finally {
    if (queued.status === 'queued') cancelQueuedJob(queued.id, 'dashboard queue ETA test cleanup');
    if (running.status === 'running') cancelJob(running.id, 'dashboard queue ETA test cleanup');
    await Promise.all([waitForJob(queued, 1_000), waitForJob(running, 1_000)]);
    deleteDevice(device.id, 'tests');
  }
});

test('dashboard overview estimates queue times from workspace-wide job history', async () => {
  const device = createDevice({ name: 'dashboard-shared-eta-device', transport: 'wifi', host: '127.0.0.5' }, 'tests');
  setCachedDeviceHealth(device.id, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
  const historyFinishedAt = Date.now() - 20_000;
  recordJobHistory({
    id: `dashboard-shared-eta-history-${crypto.randomUUID()}`,
    projectId: DEFAULT_PROJECT_ID,
    bundleId: `com.test.dashboard-shared-history-${crypto.randomUUID()}`,
    source: 'manual',
    status: 'done',
    createdAt: historyFinishedAt - 10_000,
    startedAt: historyFinishedAt - 10_000,
    finishedAt: historyFinishedAt,
  });
  const running = enqueueDecryptJob(`com.test.dashboard-shared-blocker-${crypto.randomUUID()}`, 'manual', {
    projectId: DEFAULT_PROJECT_ID,
    preferredDeviceId: device.id,
  });
  const queued = enqueueDecryptJob(`com.test.dashboard-shared-queued-${crypto.randomUUID()}`, 'manual', {
    projectId: DEFAULT_PROJECT_ID,
    preferredDeviceId: device.id,
  });

  try {
    const activeJob = buildDashboardOverview(0n, 'root').activeJobs.find((job) => job.id === queued.id);
    expect(running.status).toBe('running');
    expect(queued.status).toBe('queued');
    expect(activeJob?.queue?.predictedStartMs).toBeGreaterThan(0);
    expect(activeJob?.queue?.predictedCompletionMs).toBeGreaterThan(activeJob?.queue?.predictedStartMs ?? Infinity);
  } finally {
    if (queued.status === 'queued') cancelQueuedJob(queued.id, 'dashboard shared queue ETA test cleanup');
    if (running.status === 'running') cancelJob(running.id, 'dashboard shared queue ETA test cleanup');
    await Promise.all([waitForJob(queued, 1_000), waitForJob(running, 1_000)]);
    deleteDevice(device.id, 'tests');
  }
});
