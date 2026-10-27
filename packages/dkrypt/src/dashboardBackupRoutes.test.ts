import { expect, test } from 'bun:test';
import type { Response } from '#http.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { buildTestServer } from '#testServer.js';
import { exportBackup } from '#store/state.js';
import { setSessionCookie } from '#session.js';

function createSessionCookie(permissions: bigint): string {
  let cookieHeader = '';
  const response = { setHeader: (_name: string, value: string) => { cookieHeader = value; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return cookieHeader.split(';', 1)[0];
}

test('backup management routes are absent from the legacy dashboard router', () => {
  const legacyRoutes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);

  expect(legacyRoutes).not.toContain('GET /v1/dashboard/backup/export');
  expect(legacyRoutes).not.toContain('POST /v1/dashboard/backup/import');
  expect(legacyRoutes).not.toContain('POST /v1/dashboard/backup/preview');
  expect(legacyRoutes).not.toContain('POST /v1/dashboard/backup/drill');
  expect(legacyRoutes).not.toContain('GET /v1/dashboard/backup/schedule');
  expect(legacyRoutes).not.toContain('POST /v1/dashboard/backup/schedule');
  expect(legacyRoutes).not.toContain('GET /v1/dashboard/backup/history');
  expect(legacyRoutes).not.toContain('POST /v1/dashboard/backup/history');
  expect(legacyRoutes).not.toContain('GET /v1/dashboard/backup/history/:id/download');
  expect(legacyRoutes).not.toContain('POST /v1/dashboard/backup/history/:id/drill');
  expect(legacyRoutes).not.toContain('DELETE /v1/dashboard/backup/history/:id');
});

test('backup routes validate access, versioned payloads, and restore workflows', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const viewerCookie = createSessionCookie(PermissionFlag.viewBackup);
  const managerCookie = createSessionCookie(PermissionFlag.manageBackup);
  const legacyPayload = { backupVersion: 2 };

  try {
    const unauthenticated = await server.inject({ method: 'GET', url: '/v1/dashboard/backup/schedule' });
    expect(unauthenticated.statusCode).toBe(401);

    const viewerSchedule = await server.inject({ method: 'GET', url: '/v1/dashboard/backup/schedule', headers: { cookie: viewerCookie } });
    expect(viewerSchedule.statusCode).toBe(200);
    expect(viewerSchedule.json()).toMatchObject({ enabled: expect.any(Boolean), cron: expect.any(String), retentionCount: expect.any(Number) });

    const viewerHistory = await server.inject({ method: 'GET', url: '/v1/dashboard/backup/history', headers: { cookie: viewerCookie } });
    expect(viewerHistory.statusCode).toBe(200);

    const viewerExport = await server.inject({ method: 'GET', url: '/v1/dashboard/backup/export', headers: { cookie: viewerCookie } });
    expect(viewerExport.statusCode).toBe(403);

    const viewerCreate = await server.inject({ method: 'POST', url: '/v1/dashboard/backup/history', headers: { cookie: viewerCookie } });
    expect(viewerCreate.statusCode).toBe(403);

    const exported = await server.inject({ method: 'GET', url: '/v1/dashboard/backup/export', headers: { cookie: managerCookie } });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toContain('dkrypt-backup.json');
    expect(exported.json()).toMatchObject({ backupVersion: 15, decryptQuotaLedger: expect.any(Array), apiKeyRequestHistory: expect.any(Object), decryptCreditRecords: expect.any(Array), mcpRecords: expect.any(Array) });
    expect(exported.json()).not.toHaveProperty('projects');
    expect(exported.json()).not.toHaveProperty('artifactProjectLinks');

    const invalidPreview = await server.inject({ method: 'POST', url: '/v1/dashboard/backup/preview', headers: { cookie: managerCookie }, payload: legacyPayload });
    expect(invalidPreview.statusCode).toBe(400);
    expect(invalidPreview.json()).toMatchObject({ code: 'request_error', requestId: expect.any(String), retryable: false });

    const body = exportBackup();
    const preview = await server.inject({ method: 'POST', url: '/v1/dashboard/backup/preview', headers: { cookie: managerCookie }, payload: body });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ incoming: { users: expect.any(Number), roles: expect.any(Number) }, current: { users: expect.any(Number), roles: expect.any(Number) } });

    const historyEntry = { id: 'backup-schema-test-job', bundleId: 'com.example.backup', status: 'done', finishedAt: 100, projectId: 'default' };
    const validV8Backup: Record<string, unknown> = {
      ...body,
      backupVersion: 8,
      projects: [{ id: 'default', name: 'Workspace', memberIds: [], isDefault: true, createdBy: 'system', createdAt: 1, updatedAt: 1 }],
      jobHistory: [historyEntry],
    };
    delete validV8Backup.artifactProjectLinks;
    const validV8Preview = await server.inject({ method: 'POST', url: '/v1/dashboard/backup/preview', headers: { cookie: managerCookie }, payload: validV8Backup });
    expect(validV8Preview.statusCode).toBe(200);

    const invalidV8Backup = { ...validV8Backup, jobHistory: [{ id: historyEntry.id, bundleId: historyEntry.bundleId, status: historyEntry.status, finishedAt: historyEntry.finishedAt }] };
    const invalidV8Preview = await server.inject({ method: 'POST', url: '/v1/dashboard/backup/preview', headers: { cookie: managerCookie }, payload: invalidV8Backup });
    expect(invalidV8Preview.statusCode).toBe(400);

    const invalidV9Backup = { ...validV8Backup, backupVersion: 10, artifactProjectLinks: [], jobHistory: [{ id: historyEntry.id, bundleId: historyEntry.bundleId, status: historyEntry.status, finishedAt: historyEntry.finishedAt }] };
    const invalidV9Preview = await server.inject({ method: 'POST', url: '/v1/dashboard/backup/preview', headers: { cookie: managerCookie }, payload: invalidV9Backup });
    expect(invalidV9Preview.statusCode).toBe(400);

    const invalidDeviceBackup = { ...body, devices: [{ id: 'missing-connection', name: 'Invalid device', enabled: true }] };
    const invalidDevicePreview = await server.inject({ method: 'POST', url: '/v1/dashboard/backup/preview', headers: { cookie: managerCookie }, payload: invalidDeviceBackup });
    expect(invalidDevicePreview.statusCode).toBe(400);

    const invalidRestore = structuredClone(body);
    const invalidUserName = `backup-test-user-${crypto.randomUUID()}`;
    invalidRestore.allowedUsers.push({ username: invalidUserName, addedAt: Date.now(), roleIds: ['missing-role'] });
    const invalidImport = await server.inject({ method: 'POST', url: '/v1/dashboard/backup/import', headers: { cookie: managerCookie }, payload: invalidRestore });
    expect(invalidImport.statusCode).toBe(400);
    expect(invalidImport.json().message).toContain('backup restore test failed');
    expect(exportBackup().allowedUsers).not.toContainEqual(expect.objectContaining({ username: invalidUserName }));

    const drill = await server.inject({ method: 'POST', url: '/v1/dashboard/backup/drill', headers: { cookie: managerCookie }, payload: body });
    expect(drill.statusCode).toBe(200);
    expect(drill.json()).toMatchObject({ ok: true, restoreDrillStatus: 'passed', checkedAt: expect.any(Number), checks: expect.any(Array), database: { ok: expect.any(Boolean) } });
    expect(drill.json().checks).toContainEqual(expect.objectContaining({ label: 'Temporary SQLite restore', ok: true }));
  } finally {
    await server.close();
  }
}, 30_000);

test('backup snapshots can be created, downloaded, and deleted through native routes', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const viewerCookie = createSessionCookie(PermissionFlag.viewBackup);
  const managerCookie = createSessionCookie(PermissionFlag.manageBackup);
  let snapshotId: string | undefined;

  try {
    const created = await server.inject({ method: 'POST', url: '/v1/dashboard/backup/history', headers: { cookie: managerCookie } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ restoreDrillStatus: 'passed', restoreDrillAt: expect.any(Number) });
    snapshotId = created.json().id as string;
    expect(created.json().filename).toStartWith(`snapshot-${snapshotId}/`);
    expect(created.json().databaseFilename).toStartWith(`snapshot-${snapshotId}/`);

    const download = await server.inject({ method: 'GET', url: `/v1/dashboard/backup/history/${snapshotId}/download`, headers: { cookie: viewerCookie } });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('dkrypt-backup.json');
    expect(JSON.parse(download.body)).toMatchObject({ backupVersion: 15 });

    const viewerDrill = await server.inject({ method: 'POST', url: `/v1/dashboard/backup/history/${snapshotId}/drill`, headers: { cookie: viewerCookie } });
    expect(viewerDrill.statusCode).toBe(403);

    const drilled = await server.inject({ method: 'POST', url: `/v1/dashboard/backup/history/${snapshotId}/drill`, headers: { cookie: managerCookie } });
    expect(drilled.statusCode).toBe(200);
    expect(drilled.json()).toMatchObject({ status: 'passed', checkedAt: expect.any(Number), checks: expect.any(Array) });

    const updatedHistory = await server.inject({ method: 'GET', url: '/v1/dashboard/backup/history', headers: { cookie: viewerCookie } });
    expect(updatedHistory.json()).toContainEqual(expect.objectContaining({
      id: snapshotId,
      restoreDrillStatus: 'passed',
      restoreDrillAt: expect.any(Number),
      restoreDrillChecks: expect.arrayContaining([expect.objectContaining({ label: 'Temporary SQLite restore', ok: true })]),
    }));

    const removed = await server.inject({ method: 'DELETE', url: `/v1/dashboard/backup/history/${snapshotId}`, headers: { cookie: managerCookie } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ ok: true });

    const missing = await server.inject({ method: 'GET', url: `/v1/dashboard/backup/history/${snapshotId}/download`, headers: { cookie: viewerCookie } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'request_error', message: 'backup snapshot not found' });
  } finally {
    if (snapshotId) {
      await server.inject({ method: 'DELETE', url: `/v1/dashboard/backup/history/${snapshotId}`, headers: { cookie: managerCookie } });
    }
    await server.close();
  }
}, 30_000);
