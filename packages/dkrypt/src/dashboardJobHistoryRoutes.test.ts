import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { getRouteContract } from '#contracts.js';
import type { Response } from '#http.js';
import type { Job } from '#jobs/types.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { createDashboardJobHistoryRoutes, type DashboardJobHistoryServices } from '#routes/dashboardJobHistoryRoutes.js';
import { setSessionCookie } from '#session.js';
import { buildTestServer } from '#testServer.js';
import type { JobHistoryEntry } from '#store/state.js';

function sessionCookie(permissions = 0n): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

function historyEntry(overrides: Partial<JobHistoryEntry> = {}): JobHistoryEntry {
  return {
    id: 'history-1',
    projectId: 'default',
    bundleId: 'com.example.app',
    externalVersionId: 'version-1',
    versionLabel: '2.0',
    queuedBy: 'tester',
    status: 'done',
    source: 'manual',
    createdAt: 100,
    finishedAt: 200,
    sizeBytes: 4096,
    ...overrides,
  };
}

function build(overrides: Partial<DashboardJobHistoryServices> = {}) {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  void server.register(createDashboardJobHistoryRoutes({
    ...overrides,
  }));
  return server;
}

test('job history export, bulk preview, and diff are not registered through the legacy router', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/jobs/export');
  expect(routes).not.toContain('POST /v1/dashboard/jobs/bulk-preview');
  expect(routes).not.toContain('GET /v1/dashboard/jobs/diff');
});

test('job history route contracts are explicit and routes are mounted by the API server', async () => {
  expect(getRouteContract('GET', '/v1/dashboard/jobs/export')).toHaveProperty('response.200.content.application/json.schema.items');
  expect(getRouteContract('GET', '/v1/dashboard/jobs/export')).toHaveProperty('response.200.content.text/csv.schema.type', 'string');
  expect(getRouteContract('POST', '/v1/dashboard/jobs/bulk-preview')).toHaveProperty('body.properties.ids.description');
  expect(getRouteContract('POST', '/v1/dashboard/jobs/bulk-preview')).toHaveProperty('response.200.properties.items.items.properties.action');
  expect(getRouteContract('GET', '/v1/dashboard/jobs/diff')).toHaveProperty('response.200.properties.a.properties.buildNumber');
  expect(getRouteContract('GET', '/v1/dashboard/jobs/diff')).toHaveProperty('response.200.properties.a.properties.cacheHit');
  expect(getRouteContract('GET', '/v1/dashboard/jobs/diff')).toHaveProperty('response.200.properties.plistDiff.items.properties.key');

  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>;
    };
    const exportContent = document.paths?.['/v1/dashboard/jobs/export']?.get?.responses?.['200']?.content ?? {};
    expect(Object.keys(exportContent).sort()).toEqual(['application/json', 'text/csv']);
    expect(exportContent['text/csv']?.schema).toMatchObject({ type: 'string' });

    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs/export?projectId=default',
      headers: { cookie: sessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="dkrypt-job-history.json"');
  } finally {
    await server.close();
  }
});

test('attempt comparison rejects records without stable build identity', async () => {
  const first = historyEntry({ id: 'attempt-a', externalVersionId: undefined, versionLabel: undefined });
  const second = historyEntry({ id: 'attempt-b', externalVersionId: undefined, versionLabel: undefined });
  const server = build({ getJobHistoryEntryById: (id) => id === first.id ? first : id === second.id ? second : undefined });
  try {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/jobs/attempt-diff?a=${first.id}&b=${second.id}&projectId=default`,
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices) },
    });
    expect(response.statusCode).toBe(400);
  } finally {
    await server.close();
  }
});

test('job history export combines shared account history and omits internal scope identifiers', async () => {
  const entries = [
    historyEntry({ queuedBy: 'Doe, "A"', queueReason: 'Waiting for a compatible device' }),
    historyEntry({ id: 'other-job', projectId: 'other-project' }),
  ];
  const server = build({ getAllJobHistory: () => entries });

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.viewDevices) };
    const json = await server.inject({ method: 'GET', url: '/v1/dashboard/jobs/export?projectId=default', headers });
    const csv = await server.inject({ method: 'GET', url: '/v1/dashboard/jobs/export?format=csv&projectId=default', headers });
    const unsupportedFormat = await server.inject({ method: 'GET', url: '/v1/dashboard/jobs/export?format=other&projectId=default', headers });
    const sharedHistory = await server.inject({ method: 'GET', url: '/v1/dashboard/jobs/export', headers });
    const unauthenticated = await server.inject({ method: 'GET', url: '/v1/dashboard/jobs/export' });

    expect(json.statusCode).toBe(200);
    expect(json.headers['content-disposition']).toBe('attachment; filename="dkrypt-job-history.json"');
    const exported = JSON.parse(json.body) as Array<Record<string, unknown>>;
    expect(exported).toHaveLength(2);
    expect(exported[0]).toMatchObject({ id: entries[0]!.id, bundleId: entries[0]!.bundleId, status: entries[0]!.status });
    expect(exported[0]).not.toHaveProperty('projectId');
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="dkrypt-job-history.csv"');
    expect(csv.body).toContain('"Doe, ""A"""');
    expect(csv.body).toContain('queueReason');
    expect(csv.body).toContain('Waiting for a compatible device');
    expect(unsupportedFormat.statusCode).toBe(200);
    expect(unsupportedFormat.headers['content-disposition']).toBe('attachment; filename="dkrypt-job-history.json"');
    expect(sharedHistory.statusCode).toBe(200);
    expect(JSON.parse(sharedHistory.body)).toHaveLength(2);
    expect(unauthenticated.statusCode).toBe(401);
  } finally {
    await server.close();
  }
});

test('bulk preview deduplicates ids in shared account history', async () => {
  const entry = historyEntry();
  const activeJob = {
    id: 'active-job-12345678',
    projectId: 'default',
    bundleId: entry.bundleId,
    externalVersionId: entry.externalVersionId,
    status: 'queued',
  } as Job;
  const server = build({
    getJobHistoryEntryById: (id) => id === entry.id ? entry : undefined,
    getActiveJobs: () => [activeJob],
    getAverageJobDurationMs: () => 1200,
  });

  try {
    const denied = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/bulk-preview',
      headers: { cookie: sessionCookie() },
      payload: { ids: [entry.id], projectId: 'default' },
    });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/bulk-preview',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices) },
      payload: { ids: [entry.id, 17, entry.id, ...Array.from({ length: 100 }, (_, index) => `missing-${index}`)], projectId: 'default' },
    });
    const nonArrayIds = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/bulk-preview',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices) },
      payload: { ids: 'ignored', projectId: 'default' },
    });
    const bodyless = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/bulk-preview',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices) },
    });

    expect(denied.statusCode).toBe(403);
    expect(response.statusCode).toBe(200);
    expect(nonArrayIds.statusCode).toBe(200);
    expect(JSON.parse(nonArrayIds.body)).toMatchObject({ requested: 0, eligible: 0 });
    expect(bodyless.statusCode).toBe(200);
    expect(JSON.parse(bodyless.body)).toMatchObject({ requested: 0, eligible: 0 });
    expect(JSON.parse(response.body)).toEqual({
      requested: 100,
      eligible: 1,
      projectedQueueAdds: 0,
      estimatedDurationMs: 0,
      previousSizeBytes: 4096,
      items: [{
        id: entry.id,
        bundleId: entry.bundleId,
        versionLabel: entry.versionLabel,
        status: entry.status,
        action: 'join-existing',
        reason: 'Already active as active-j',
        estimatedDurationMs: 1200,
      }],
    });
  } finally {
    await server.close();
  }
});

test('job diff validates bundle ownership and returns sorted plist changes', async () => {
  const first = historyEntry({
    id: 'history-a',
    ipaInfoPlist: { CFBundleName: 'Old', CFBundleVersion: '1', unchanged: true },
    ipaMetadata: { shortVersion: '1.0', bundleVersion: '100' },
    cacheHit: true,
  });
  const second = historyEntry({
    id: 'history-b',
    versionLabel: '2.1',
    sizeBytes: 8192,
    finishedAt: 300,
    ipaInfoPlist: { CFBundleName: 'New', CFBundleVersion: '2', added: 'value', unchanged: true },
    ipaMetadata: { shortVersion: '2.0' },
    testflight: {
      appId: 123,
      build: { id: 42, cfBundleShortVersion: '2.0', cfBundleVersion: '200', bundleId: 'com.example.app', whatsNew: 'TestFlight changes' },
    },
  });
  const server = build({ getJobHistoryEntryById: (id) => id === first.id ? first : id === second.id ? second : undefined });

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.viewDevices) };
    const response = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/jobs/diff?bundleId=${first.bundleId}&a=${first.id}&b=${second.id}&projectId=default`,
      headers,
    });
    const mismatchedBundle = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/jobs/diff?bundleId=com.other.app&a=${first.id}&b=${second.id}&projectId=default`,
      headers,
    });
    const missingEntry = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/jobs/diff?bundleId=${first.bundleId}&a=${first.id}&b=foreign-job&projectId=default`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      a: { id: first.id, versionLabel: first.versionLabel, buildNumber: '100', channel: 'appstore', cacheHit: true, metadata: first.ipaMetadata },
      b: { id: second.id, versionLabel: second.versionLabel, buildNumber: '200', releaseNotes: 'TestFlight changes', channel: 'testflight', metadata: second.ipaMetadata },
      sizeDeltaBytes: 4096,
      plistDiff: [
        { key: 'added', after: 'value' },
        { key: 'CFBundleName', before: 'Old', after: 'New' },
        { key: 'CFBundleVersion', before: '1', after: '2' },
      ],
    });
    expect(mismatchedBundle.statusCode).toBe(400);
    expect(missingEntry.statusCode).toBe(404);
  } finally {
    await server.close();
  }
});
