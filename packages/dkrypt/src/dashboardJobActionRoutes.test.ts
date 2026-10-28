import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Response } from '#http.js';
import type { Job } from '#jobs/types.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { createDashboardJobActionRoutes, type DashboardJobActionServices } from '#routes/dashboardJobActionRoutes.js';
import { setSessionCookie } from '#session.js';
import type { JobHistoryEntry } from '#store/state.js';
import { buildTestServer } from '#testServer.js';

function sessionCookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

function createJob(id = 'job-1'): Job {
  return {
    id,
    correlationId: `correlation-${id}`,
    projectId: 'default',
    bundleId: 'com.example.app',
    source: 'manual',
    priority: 0,
    status: 'queued',
    progress: 'queued',
    createdAt: 100,
    waiters: [],
  };
}

function createHistoryEntry(id = 'history-1'): JobHistoryEntry {
  return {
    id,
    correlationId: `correlation-${id}`,
    projectId: 'default',
    bundleId: 'com.example.app',
    externalVersionId: 'version-1',
    versionLabel: '2.0',
    minimumOsVersion: '17.1',
    queuedBy: 'requester',
    status: 'failed',
    source: 'manual',
    createdAt: 100,
    finishedAt: 200,
    timeline: [{ at: 100, label: 'Queued', status: 'queued' }],
  };
}

function build(overrides: Partial<DashboardJobActionServices> = {}) {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  void server.register(createDashboardJobActionRoutes({
    ...overrides,
  }));
  return server;
}

test('dashboard job actions are not registered through the legacy router', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('POST /v1/dashboard/jobs/:id/cancel');
  expect(routes).not.toContain('POST /v1/dashboard/jobs/:id/prioritize');
  expect(routes).not.toContain('POST /v1/dashboard/jobs/reorder');
  expect(routes).not.toContain('POST /v1/dashboard/jobs/:id/retry');
  expect(routes).not.toContain('GET /v1/dashboard/jobs/:id/diagnostic');
  expect(routes).not.toContain('POST /v1/dashboard/decrypt');
});

test('failed-job resolution notices stay out of public API-key documentation', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as { paths?: Record<string, unknown> };
    expect(Object.keys(document.paths ?? {}).some((path) => path.includes('resolution-notice'))).toBe(false);
  } finally {
    await server.close();
  }
});

test('manual decrypt submission preserves project, device, and version selection', async () => {
  let enqueueArgs: unknown[] = [];
  const queuedJob = createJob('manual-decrypt-job');
  const server = build({
    getPrimaryDevice: () => ({ id: 'device-primary' }) as ReturnType<DashboardJobActionServices['getPrimaryDevice']>,
    getUserPriority: () => 4,
    resolveDecryptTarget: async (bundleId, selector) => ({ bundleId, platform: 'ios', selector, channel: 'appstore', versionLabel: selector ?? 'latest', minimumOsVersion: '17.0', artifactKey: 'appstore-artifact' }),
    enqueueDecryptJob: (...args) => {
      enqueueArgs = args;
      return queuedJob;
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: {
        bundleId: 'com.example.app',
        externalVersionId: 'invalid/version',
        versionLabel: '  v2  ',
        preferPrimary: true,
        projectId: 'default',
      },
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ id: 'manual-decrypt-job', bundleId: 'com.example.app', status: 'queued' });
    expect(enqueueArgs).toEqual([
      'com.example.app',
      'manual',
      expect.objectContaining({
        versionLabel: 'v2',
        queuedBy: 'root',
        priority: 4,
        preferredDeviceId: 'device-primary',
        projectId: 'default',
        minimumOsVersion: '17.0',
      }),
    ]);
  } finally {
    await server.close();
  }
});

test('tvOS decrypt submission queues the resolved release without assigning an iOS device', async () => {
  const queuedJob = { ...createJob('tvos-decrypt-job'), platform: 'tvos' as const, versionLabel: '4.2', externalVersionId: 'platform-version-42' };
  const enqueueArgs: unknown[][] = [];
  let resolveArgs: unknown[] = [];
  let primaryDeviceReads = 0;
  const server = build({
    getPrimaryDevice: () => {
      primaryDeviceReads += 1;
      return { id: 'ios-device' } as ReturnType<DashboardJobActionServices['getPrimaryDevice']>;
    },
    getUserPriority: () => 2,
    resolveDecryptTarget: async (bundleId, versionLabel, platform) => {
      resolveArgs = [bundleId, versionLabel, platform];
      return { bundleId, platform: platform ?? 'ios', channel: 'appstore', externalVersionId: 'platform-version-42', versionLabel: '4.2', minimumOsVersion: '18.0', artifactKey: 'platform-artifact' };
    },
    enqueueDecryptJob: (...args) => {
      enqueueArgs.push(args);
      return queuedJob;
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { bundleId: 'com.example.tv', platform: 'tvos', preferPrimary: true },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ id: 'tvos-decrypt-job', platform: 'tvos', versionLabel: '4.2' });
    expect(resolveArgs).toEqual(['com.example.tv', undefined, 'tvos']);
    expect(enqueueArgs[0]?.[2]).toMatchObject({ platform: 'tvos', externalVersionId: 'platform-version-42', minimumOsVersion: '18.0' });
    expect((enqueueArgs[0]?.[2] as Record<string, unknown>).preferredDeviceId).toBeUndefined();
    expect(primaryDeviceReads).toBe(0);
  } finally {
    await server.close();
  }
});

test('job cancellation and prioritization preserve project access and conflict behavior', async () => {
  const calls: string[] = [];
  const server = build({
    getJob: () => createJob(),
    cancelJob: (id, userId) => {
      calls.push(`cancel:${id}:${userId}`);
      return true;
    },
    prioritizeQueuedJob: (id, projectId) => {
      calls.push(`prioritize:${id}:${projectId}`);
      return false;
    },
  });

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices) };
    const cancelled = await server.inject({ method: 'POST', url: '/v1/dashboard/jobs/job-1/cancel', headers });
    const prioritized = await server.inject({ method: 'POST', url: '/v1/dashboard/jobs/job-1/prioritize', headers });

    expect(cancelled.statusCode).toBe(200);
    expect(JSON.parse(cancelled.body)).toEqual({ ok: true });
    expect(prioritized.statusCode).toBe(409);
    expect((JSON.parse(prioritized.body) as Record<string, unknown>).message).toContain('job is not queued');
    expect(calls).toEqual(['cancel:job-1:root', 'prioritize:job-1:default']);
  } finally {
    await server.close();
  }
});

test('queue reorder validates that every requested job belongs to the selected project', async () => {
  const reordered: string[][] = [];
  const server = build({
    getJob: (id) => id === 'job-1' ? createJob(id) : undefined,
    reorderQueue: (ids) => {
      reordered.push(ids);
      return true;
    },
  });

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices) };
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/reorder',
      headers,
      payload: { ids: ['job-1'], projectId: 'default' },
    });
    const invalidScope = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/reorder',
      headers,
      payload: { ids: ['job-unknown'], projectId: 'default' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(invalidScope.statusCode).toBe(200);
    expect(JSON.parse(invalidScope.body)).toEqual({ ok: false });
    expect(reordered).toEqual([['job-1']]);
  } finally {
    await server.close();
  }
});

test('retry uses the requested primary device and retains source job metadata', async () => {
  let enqueueArgs: unknown[] = [];
  const retriedJob = createJob('retry-job');
  const server = build({
    getJobHistoryEntryById: () => createHistoryEntry(),
    getPrimaryDevice: () => ({ id: 'device-primary' }) as ReturnType<DashboardJobActionServices['getPrimaryDevice']>,
    getUserPriority: () => 4,
    enqueueDecryptJob: (...args) => {
      enqueueArgs = args;
      return retriedJob;
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/history-1/retry',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices) },
      payload: { preferPrimary: true },
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ id: 'retry-job', bundleId: 'com.example.app', status: 'queued' });
    expect(enqueueArgs).toEqual([
      'com.example.app',
      'manual',
      expect.objectContaining({
        externalVersionId: 'version-1',
        versionLabel: '2.0',
        queuedBy: 'root',
        priority: 4,
        preferredDeviceId: 'device-primary',
        projectId: 'default',
        minimumOsVersion: '17.1',
      }),
    ]);
  } finally {
    await server.close();
  }
});

test('retrying a tvOS decrypt keeps it device-free and does not apply iOS minimum-version lookup', async () => {
  const historyEntry = { ...createHistoryEntry('tvos-history'), queuedBy: 'root', platform: 'tvos' as const, externalVersionId: 'tv-version-42' };
  const enqueueArgs: unknown[][] = [];
  let primaryDeviceReads = 0;
  let platformLookups = 0;
  const server = build({
    getJobHistoryEntryById: () => historyEntry,
    getPrimaryDevice: () => {
      primaryDeviceReads += 1;
      return { id: 'ios-device' } as ReturnType<DashboardJobActionServices['getPrimaryDevice']>;
    },
    resolveDecryptTarget: async () => {
      platformLookups += 1;
      throw new Error('tvOS retry must use its saved release metadata');
    },
    enqueueDecryptJob: (...args) => {
      enqueueArgs.push(args);
      return { ...createJob('tvos-retry-job'), platform: 'tvos' };
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/tvos-history/retry',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { preferPrimary: true },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ id: 'tvos-retry-job', platform: 'tvos' });
    expect(enqueueArgs[0]?.[2]).toMatchObject({ platform: 'tvos', externalVersionId: 'tv-version-42' });
    expect((enqueueArgs[0]?.[2] as Record<string, unknown>).preferredDeviceId).toBeUndefined();
    expect(primaryDeviceReads).toBe(0);
    expect(platformLookups).toBe(0);
  } finally {
    await server.close();
  }
});

test('failed-job resolution notices require permission and are sent only once', async () => {
  const entry = createHistoryEntry();
  let mailSends = 0;
  let noticeCreates = 0;
  const server = build({
    getJobHistoryEntryById: () => entry,
    getAuthProfile: () => ({
      userId: 'requester',
      provider: 'discord',
      providerId: '123',
      username: 'requester',
      displayName: 'Requester',
      email: 'requester@example.test',
      updatedAt: new Date(0).toISOString(),
    }),
    canSendDirectMailToUser: () => true,
    sendDirectMailToUser: async () => { mailSends += 1; },
    recordJobResolutionNotice: (_id, actor) => {
      noticeCreates += 1;
      entry.resolutionNotice = { sentAt: 300, sentBy: actor, emailStatus: 'pending' };
      return entry.resolutionNotice;
    },
    setJobResolutionEmailStatus: (_id, status) => { entry.resolutionNotice!.emailStatus = status; },
  });

  try {
    const url = '/v1/dashboard/jobs/history-1/resolution-notice';
    const reader = { cookie: sessionCookie(PermissionFlag.requestDecrypt) };
    const manager = { cookie: sessionCookie(PermissionFlag.notifyFailedJobOwners) };
    expect((await server.inject({ method: 'GET', url, headers: reader })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url, headers: reader })).statusCode).toBe(403);

    const preview = await server.inject({ method: 'GET', url, headers: manager });
    expect(preview.statusCode).toBe(200);
    expect(JSON.parse(preview.body)).toMatchObject({ requester: 'Requester', emailAvailable: true });
    expect(JSON.parse(preview.body).notice).toBeUndefined();
    const first = await server.inject({ method: 'POST', url, headers: manager });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).notice).toMatchObject({ emailStatus: 'sent', sentBy: 'root' });
    const second = await server.inject({ method: 'POST', url, headers: manager });
    expect(second.statusCode).toBe(200);
    expect(noticeCreates).toBe(1);
    expect(mailSends).toBe(1);

    entry.projectId = 'other';
    expect((await server.inject({ method: 'GET', url, headers: manager })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url, headers: manager })).statusCode).toBe(200);
  } finally {
    await server.close();
  }
});

test('resolution notice reports email failure without retrying or duplicating the in-app notice', async () => {
  const entry = createHistoryEntry();
  let noticeCreates = 0;
  const server = build({
    getJobHistoryEntryById: () => entry,
    getAuthProfile: () => ({ userId: 'requester', provider: 'discord', providerId: '123', username: 'requester', displayName: 'Requester', updatedAt: new Date(0).toISOString() }),
    canSendDirectMailToUser: () => true,
    sendDirectMailToUser: async () => { throw new Error('SMTP unavailable'); },
    recordJobResolutionNotice: (_id, actor) => {
      noticeCreates += 1;
      entry.resolutionNotice = { sentAt: 300, sentBy: actor, emailStatus: 'pending' };
      return entry.resolutionNotice;
    },
    setJobResolutionEmailStatus: (_id, status) => { entry.resolutionNotice!.emailStatus = status; },
  });

  try {
    const request = { method: 'POST' as const, url: '/v1/dashboard/jobs/history-1/resolution-notice', headers: { cookie: sessionCookie(PermissionFlag.notifyFailedJobOwners) } };
    const first = await server.inject(request);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).notice.emailStatus).toBe('failed');
    await server.inject(request);
    expect(noticeCreates).toBe(1);
  } finally {
    await server.close();
  }
});

test('diagnostics include the authorized job timeline and attachment filename', async () => {
  const job = createJob();
  job.timeline = [{ at: 100, label: 'Queued', status: 'queued' }];
  const server = build({ getJob: () => job });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs/job-1/diagnostic',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="dkrypt-job-job-1-diagnostic.json"');
    expect(JSON.parse(response.body)).toMatchObject({ correlationId: 'correlation-job-1', job: { id: 'job-1' }, timeline: job.timeline });
  } finally {
    await server.close();
  }
});

test('job actions require decrypt permission before accessing jobs', async () => {
  let lookups = 0;
  const server = build({
    getJob: () => {
      lookups += 1;
      return createJob();
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/job-1/cancel',
      headers: { cookie: sessionCookie(0n) },
    });

    expect(response.statusCode).toBe(403);
    expect(lookups).toBe(0);
  } finally {
    await server.close();
  }
});

test('job actions use one shared account scope after permission checks', async () => {
  let cancellations = 0;
  const server = build({
    getJob: () => createJob(),
    cancelJob: () => {
      cancellations += 1;
      return true;
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/job-1/cancel',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices) },
    });

    expect(response.statusCode).toBe(200);
    expect(cancellations).toBe(1);
  } finally {
    await server.close();
  }
});
