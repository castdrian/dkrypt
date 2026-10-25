import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { getRouteContract } from '#contracts.js';
import type { Response } from '#http.js';
import type { LogEntry } from '#logger.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { createDashboardReportingRoutes } from '#routes/dashboardReportingRoutes.js';
import { setSessionCookie } from '#session.js';
import type { DeviceRecord, InsightsSummary, JobHistoryEntry, WebhookDeliveryEntry } from '#store/state.js';
import { LATEST_SQLITE_SCHEMA_VERSION } from '#store/sqlite.js';

function sessionCookie(permissions = 0n): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

test('insights is served through the typed dashboard API and preserves bounded query behavior', async () => {
  const summary: InsightsSummary = {
    totalRuns: 3,
    doneCount: 2,
    failedCount: 1,
    successRate: 2 / 3,
    totalSizeBytes: 4096,
    manualCount: 2,
    systemCount: 1,
    topApps: [{ bundleId: 'com.example.app', totalRuns: 3, doneCount: 2, failedCount: 1, successRate: 2 / 3, totalSizeBytes: 4096 }],
    trend: [{ date: '2026-09-26', count: 3 }],
    failureBreakdown: [{ category: 'device_transport', count: 1 }],
    byDevice: [],
    anomalies: [],
  };
  const calls: Array<[number, number, string | undefined]> = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardReportingRoutes({
    getInsightsSummary: (topApps, trendDays, projectId) => {
      calls.push([topApps, trendDays, projectId]);
      return summary;
    },
  }));

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/insights?topApps=invalid&trendDays=999',
      headers: { cookie: sessionCookie() },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(summary);
    expect(calls).toEqual([[5, 90, 'default']]);
    expect(getRouteContract('GET', '/v1/dashboard/insights')).toHaveProperty('response.200.properties.topApps.items.properties.bundleId');
    expect(dashboardRouter.routes.map((route) => `${route.method} ${route.path}`)).not.toContain('GET /v1/dashboard/insights');
  } finally {
    await server.close();
  }
});

test('failure patterns remain permission-gated and redact volatile secrets', async () => {
  const now = Date.now();
  const history: JobHistoryEntry[] = [
    {
      id: 'failed-1',
      projectId: 'default',
      bundleId: 'com.example.first',
      status: 'failed',
      source: 'manual',
      createdAt: now - 20,
      finishedAt: now - 10,
      error: 'install failed at https://one.example/path token=first 123456',
    },
    {
      id: 'failed-2',
      projectId: 'default',
      bundleId: 'com.example.second',
      status: 'failed',
      source: 'manual',
      createdAt: now - 8,
      finishedAt: now,
      error: 'install failed at https://two.example/path token=second 987654',
    },
  ];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardReportingRoutes({
    getAllJobHistory: () => history,
  }));

  try {
    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/failure-patterns', headers: { cookie: sessionCookie() } });
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/failure-patterns',
      headers: { cookie: sessionCookie(PermissionFlag.viewAutomation) },
    });

    expect(denied.statusCode).toBe(403);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      patterns: [{
        message: 'install failed at [url] [redacted] [number]',
        count: 2,
        firstSeen: now - 10,
        lastSeen: now,
        bundleIds: ['com.example.first', 'com.example.second'],
      }],
    });
    expect(dashboardRouter.routes.map((route) => `${route.method} ${route.path}`)).not.toContain('GET /v1/dashboard/failure-patterns');
  } finally {
    await server.close();
  }
});

test('storage forecast uses thirty-day account history and reports unavailable storage', async () => {
  const now = Date.now();
  const history: JobHistoryEntry[] = [
    {
      id: 'completed-1',
      projectId: 'default',
      bundleId: 'com.example.app',
      status: 'done',
      source: 'manual',
      createdAt: now - 86_400_000,
      finishedAt: now - 86_400_000,
      sizeBytes: 30_000,
    },
    {
      id: 'old-completed',
      projectId: 'default',
      bundleId: 'com.example.app',
      status: 'done',
      source: 'manual',
      createdAt: now - 31 * 86_400_000,
      finishedAt: now - 31 * 86_400_000,
      sizeBytes: 90_000,
    },
    {
      id: 'second-completed',
      projectId: 'default',
      bundleId: 'com.example.app',
      status: 'done',
      source: 'manual',
      createdAt: now - 86_400_000,
      finishedAt: now - 86_400_000,
      sizeBytes: 60_000,
    },
  ];
  let diskReads = 0;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardReportingRoutes({
    getAllJobHistory: () => history,
    getDiskUsage: () => ++diskReads === 1 ? { totalBytes: 100_000, freeBytes: 30_000, usedBytes: 70_000, usedPercent: 0.7 } : undefined,
  }));

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.viewAutomation) };
    const response = await server.inject({ method: 'GET', url: '/v1/dashboard/storage-forecast', headers });
    const unavailable = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/storage-forecast',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ freeBytes: 30_000, bytesPerDay: 3_000, daysRemaining: 10, sampleCount: 2 });
    expect(unavailable.statusCode).toBe(503);
    expect(dashboardRouter.routes.map((route) => `${route.method} ${route.path}`)).not.toContain('GET /v1/dashboard/storage-forecast');
  } finally {
    await server.close();
  }
});

test('webhook delivery history remains log-permission gated and clamps the requested limit', async () => {
  const deliveries: WebhookDeliveryEntry[] = [{
    id: 'delivery-1',
    ts: 123,
    kind: 'scheduler',
    event: 'dispatch.completed',
    targetHost: 'hooks.example.com',
    ok: true,
    status: 204,
    durationMs: 45,
  }];
  const limits: number[] = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardReportingRoutes({
    getWebhookDeliveryLog: (limit = 100) => {
      limits.push(limit);
      return deliveries;
    },
  }));

  try {
    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/webhooks', headers: { cookie: sessionCookie() } });
    const fallbackLimit = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/webhooks?limit=invalid',
      headers: { cookie: sessionCookie(PermissionFlag.viewLogs) },
    });
    const maximumLimit = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/webhooks?limit=500',
      headers: { cookie: sessionCookie(PermissionFlag.viewLogs) },
    });

    expect(denied.statusCode).toBe(403);
    expect(fallbackLimit.statusCode).toBe(200);
    expect(maximumLimit.statusCode).toBe(200);
    expect(JSON.parse(maximumLimit.body)).toEqual({ deliveries });
    expect(limits).toEqual([100, 200]);
    expect(dashboardRouter.routes.map((route) => `${route.method} ${route.path}`)).not.toContain('GET /v1/dashboard/webhooks');
  } finally {
    await server.close();
  }
});

test('support bundles require management permission and redact sensitive diagnostic data', async () => {
  const device: DeviceRecord = { id: 'ipad-1', name: 'iPad', enabled: true, isPrimary: true, createdAt: 1, updatedAt: 2 };
  const job: JobHistoryEntry = {
    id: 'failed-job',
    correlationId: 'correlation-job-1',
    projectId: 'default',
    bundleId: 'com.example.app',
    status: 'failed',
    source: 'manual',
    createdAt: 1,
    finishedAt: 2,
    error: 'Authorization: Bearer job-token password=job-password access_token=job-access at https://private.example/path',
    queueReason: 'Waiting for a compatible device · password=queue-password',
    deadlineAt: 3,
    deadlineExceeded: true,
    failureClass: 'queue',
    deviceId: 'ipad-1',
    transport: 'usb',
    attempt: 2,
    retryCount: 1,
    timeline: [Object.assign({ at: 1, label: 'Queued password=timeline-password', status: 'queued' as const }, { token: 'timeline-extra-token' })],
  };
  const privateJob: JobHistoryEntry = { ...job, id: 'private-job', projectId: 'private', bundleId: 'com.example.private' };
  const log: LogEntry = {
    id: 'log-1',
    ts: 3,
    level: 'error',
    scope: 'scheduler',
    message: 'Authorization: Bearer log-token password=log-password access_token=log-access at https://private.example/path',
    meta: { projectId: 'default', authorization: 'Bearer metadata-token', password: 'private-value', token: 'private-value', access_token: 'metadata-access' },
  };
  const privateLog: LogEntry = { ...log, id: 'private-log', meta: { projectId: 'private' } };
  const transportLog: LogEntry = {
    id: 'transport-log',
    ts: 4,
    level: 'warn',
    scope: 'idevice',
    message: 'USB reconnect completed',
    meta: { projectId: 'default', deviceId: 'ipad-1', operation: 'reconnect', correlationId: 'correlation-transport-1' },
  };
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardReportingRoutes({
    getAllJobHistory: () => [job, privateJob],
    getStateDatabaseStatus: () => ({ path: '/state/dkrypt.sqlite', schemaVersion: LATEST_SQLITE_SCHEMA_VERSION, integrity: 'ok' }),
    verifyLatestDatabaseBackup: () => ({ ok: true, detail: 'verified' }),
    getDiskUsage: () => ({ totalBytes: 100, freeBytes: 50, usedBytes: 50, usedPercent: 0.5 }),
    getAppCatalogStats: () => ({ entries: 1, icons: 1 }),
    getEffectiveDevices: () => [device],
    getRecentLogs: () => ({ logs: [log, privateLog, transportLog], total: 3 }),
  }));

  try {
    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/support-bundle', headers: { cookie: sessionCookie(PermissionFlag.viewAutomation) } });
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/support-bundle',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
    });
    const bundle = JSON.parse(response.body);

    expect(denied.statusCode).toBe(403);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="dkrypt-support-bundle.json"');
    expect(bundle.deployment).toMatchObject({ id: expect.any(String), ref: expect.any(String), node: expect.any(String) });
    expect(bundle.devices).toEqual([{ id: 'ipad-1', name: 'iPad', enabled: true, isPrimary: true }]);
    expect(bundle).not.toHaveProperty('watches');
    expect(bundle).not.toHaveProperty('watchHealth');
    expect(bundle).not.toHaveProperty('schedulerRuns');
    expect(bundle.logs).toHaveLength(3);
    expect(bundle.jobs).toHaveLength(2);
    expect(bundle.logs.find((entry: LogEntry) => entry.id === 'log-1')).toMatchObject({
      message: 'Authorization: Bearer [redacted] password=[redacted] access_token=[redacted] at [redacted-url]',
      meta: { authorization: '[redacted]', password: '[redacted]', token: '[redacted]', access_token: '[redacted]' },
    });
    expect(bundle.transportTimeline).toEqual([{
      id: 'transport-log',
      at: 4,
      level: 'warn',
      message: 'USB reconnect completed',
      deviceId: 'ipad-1',
      operation: 'reconnect',
      correlationId: 'correlation-transport-1',
    }]);
    expect(bundle.correlationIds).toEqual(['correlation-job-1', 'correlation-transport-1']);
    expect(bundle.jobs[0].error).toBe('Authorization: Bearer [redacted] password=[redacted] access_token=[redacted] at [redacted-url]');
    expect(bundle.jobs[0]).toMatchObject({
      queueReason: 'Waiting for a compatible device · password=[redacted]',
      deadlineAt: 3,
      deadlineExceeded: true,
      failureClass: 'queue',
      deviceId: 'ipad-1',
      transport: 'usb',
      attempt: 2,
      retryCount: 1,
    });
    expect(bundle.jobs[0].timeline).toEqual([{ at: 1, label: 'Queued password=[redacted]', status: 'queued' }]);
    expect(dashboardRouter.routes.map((route) => `${route.method} ${route.path}`)).not.toContain('GET /v1/dashboard/support-bundle');
  } finally {
    await server.close();
  }
});
