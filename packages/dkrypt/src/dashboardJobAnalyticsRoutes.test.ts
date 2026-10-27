import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Response } from '#http.js';
import type { Job } from '#jobs/types.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { createDashboardJobAnalyticsRoutes } from '#routes/dashboardJobAnalyticsRoutes.js';
import { setSessionCookie } from '#session.js';
import { buildTestServer } from '#testServer.js';
import type { JobHistoryEntry } from '#store/state.js';

function sessionCookie(permissions = PermissionFlag.viewDevices): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

test('job analytics routes are not registered through the legacy dashboard router', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/jobs/eta/:bundleId');
  expect(routes).not.toContain('GET /v1/dashboard/jobs/stats/:bundleId');
  expect(routes).not.toContain('GET /v1/dashboard/jobs/slo');
  expect(routes).not.toContain('GET /v1/dashboard/jobs/volume');
});

test('job statistics and daily volume use shared account data', async () => {
  const calls: Array<[string, number, string]> = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardJobAnalyticsRoutes({
    getBundleStats: (bundleId, _projectId) => ({
      bundleId,
      totalRuns: 2,
      doneCount: 1,
      failedCount: 1,
      successRate: 0.5,
      avgDurationMs: 1_250,
      lastRunAt: 200,
      failureBreakdown: [{ category: 'storage', count: 1 }],
    }),
    getDailyVolume: (days, projectId) => {
      calls.push(['volume', days, projectId ?? '']);
      return [{ date: '2026-09-24', count: 2 }];
    },
  }));

  try {
    const headers = { cookie: sessionCookie() };
    const stats = await server.inject({ method: 'GET', url: '/v1/dashboard/jobs/stats/com.example.app', headers });
    const volume = await server.inject({ method: 'GET', url: '/v1/dashboard/jobs/volume?days=3', headers });

    expect(stats.statusCode).toBe(200);
    expect(JSON.parse(stats.body)).toMatchObject({ bundleId: 'com.example.app', totalRuns: 2, successRate: 0.5 });
    expect(volume.statusCode).toBe(200);
    expect(JSON.parse(volume.body)).toEqual({ days: [{ date: '2026-09-24', count: 2 }] });
    expect(calls).toEqual([['volume', 3, '']]);
  } finally {
    await server.close();
  }
});

test('queue SLO data remains manager-gated and includes the active queue objective', async () => {
  const now = Date.now();
  const completed: JobHistoryEntry[] = [{
    id: 'completed-job',
    projectId: 'default',
    bundleId: 'com.example.app',
    status: 'done',
    source: 'manual',
    createdAt: now - 20,
    startedAt: now - 10,
    finishedAt: now,
  }, {
    id: 'other-project-completed-job',
    projectId: 'another-project',
    bundleId: 'com.example.app',
    status: 'done',
    source: 'manual',
    createdAt: now - 20,
    startedAt: now - 10,
    finishedAt: now,
  }];
  const active: Job[] = [{
    id: 'active-job',
    projectId: 'default',
    bundleId: 'com.example.app',
    source: 'manual',
    priority: 0,
    status: 'queued',
    progress: 'queued',
    createdAt: now,
    waiters: [],
  }];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardJobAnalyticsRoutes({
    getAllJobHistory: () => completed,
    getActiveJobs: () => active,
    getQueueInfo: () => ({ position: 1, total: 1 }),
    queueSloMinutes: 5,
  }));

  try {
    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/jobs/slo', headers: { cookie: sessionCookie(0n) } });
    const allowed = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs/slo?projectId=default',
      headers: { cookie: sessionCookie(PermissionFlag.viewAutomation) },
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(JSON.parse(allowed.body)).toMatchObject({
      targetMs: 300_000,
      historicalP95Ms: 10,
      jobs: [{ id: 'active-job', bundleId: 'com.example.app', status: 'queued', objective: 'within' }],
    });
  } finally {
    await server.close();
  }
});

test('job ETA uses the shared account history', async () => {
  const calls: Array<[string, string]> = [];
  const now = Date.now();
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardJobAnalyticsRoutes({
    getAllJobHistory: () => [
      { bundleId: 'com.example.app', projectId: 'default', status: 'done', startedAt: now - 100, finishedAt: now },
      { bundleId: 'com.example.app', projectId: 'default', status: 'done', startedAt: now - 200, finishedAt: now },
      { bundleId: 'com.example.app', projectId: 'default', status: 'failed', startedAt: now - 5_000, finishedAt: now },
      { bundleId: 'com.example.app', projectId: 'another-project', status: 'done', startedAt: now - 9_000, finishedAt: now },
    ] as JobHistoryEntry[],
    getAverageJobDurationMs: (bundleId, projectId) => {
      calls.push([bundleId, projectId ?? '']);
      return 1_250;
    },
  }));

  try {
    const headers = { cookie: sessionCookie() };
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs/eta/com.example.app',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ avgMs: 1_250, p50Ms: 100, p95Ms: 200, sampleCount: 2, confidence: 'low' });
    expect(calls).toEqual([['com.example.app', 'default']]);
  } finally {
    await server.close();
  }
});

test('job analytics endpoints are mounted by the API server', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs/volume?days=2',
      headers: { cookie: sessionCookie() },
    });

    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as { days: unknown[] }).days).toHaveLength(2);
  } finally {
    await server.close();
  }
});
