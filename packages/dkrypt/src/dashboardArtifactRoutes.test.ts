import { expect, test } from 'bun:test';
import AdmZip from 'adm-zip';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Response } from '#http.js';
import type { ArtifactRecord } from '#artifacts.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { createDashboardArtifactRoutes } from '#routes/dashboardArtifactRoutes.js';
import { setSessionCookie } from '#session.js';

function sessionCookie(permissions = 0n): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'artifact-1',
    key: 'com.example.app|appstore|1.0',
    projectIds: ['default'],
    bundleId: 'com.example.app',
    channel: 'appstore',
    filePath: '/tmp/app.ipa',
    fileSizeBytes: 4,
    sha256: 'a'.repeat(64),
    createdAt: 1,
    lastAccessedAt: 2,
    accessCount: 3,
    ...overrides,
  };
}

test('artifact listing and pinning use native dashboard routes', async () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/artifacts');
  expect(routes).not.toContain('PUT /v1/dashboard/artifacts/:id/pin');
  expect(routes).not.toContain('PUT /v1/dashboard/artifacts/:id/archive');
  expect(routes).not.toContain('POST /v1/dashboard/artifacts/bulk-archive');
  expect(routes).not.toContain('GET /v1/dashboard/artifacts/:id/file');
  expect(routes).not.toContain('GET /v1/dashboard/artifacts/:id');

  const record = artifact({ pinnedAt: 3, sourceJobId: 'job-1', warnings: ['extension remains encrypted'] });
  const listCalls: unknown[] = [];
  const audits: Array<[string, string, string, string?, Array<{ field: string; before: unknown; after: unknown }> ?]> = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardArtifactRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    listArtifacts: (options) => {
      listCalls.push(options);
      return { artifacts: [record], total: 1, totalBytes: 4, maxBytes: 10, nextCursor: 'next-page' };
    },
    artifactFileAvailable: () => true,
    getArtifactById: () => record,
    setArtifactPinned: async (_id, pinned) => ({ artifact: artifact({ ...record, pinnedAt: pinned ? 4 : undefined }), changed: true }),
    recordAudit: (...entry) => { audits.push(entry); },
  }));

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.manageAutomation) };
    const listed = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/artifacts?projectId=default&limit=5&offset=2&q=example&channel=appstore&archived=true',
      headers,
    });
    const pinned = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/artifacts/artifact-1/pin',
      headers,
      payload: { pinned: true },
    });
    const detail = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts/artifact-1?projectId=default', headers });

    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body)).toEqual({
      artifacts: [{
        ...record,
        filePath: undefined,
        fileUrl: '/v1/dashboard/artifacts/artifact-1/file',
        createdAt: '1970-01-01T00:00:00.001Z',
        lastAccessedAt: '1970-01-01T00:00:00.002Z',
        pinnedAt: '1970-01-01T00:00:00.003Z',
      }],
      total: 1,
      totalBytes: 4,
      maxBytes: 10,
      nextCursor: 'next-page',
    });
    expect(listCalls).toEqual([{
      offset: 2,
      limit: 5,
      cursor: undefined,
      query: 'example',
      channel: 'appstore',
      archived: true,
      projectIds: ['default'],
    }]);
    expect(pinned.statusCode).toBe(200);
    expect(JSON.parse(pinned.body)).toEqual({ ok: true, changed: true, artifactId: 'artifact-1', pinned: true, pinnedAt: '1970-01-01T00:00:00.004Z' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: 'artifact-1', fileUrl: '/v1/dashboard/artifacts/artifact-1/file' });
    expect(detail.body).not.toContain('filePath');
    expect(audits).toEqual([['root', 'artifact.pin', 'artifact-1']]);
  } finally {
    await server.close();
  }
});

test('artifact package contents are paginated, filterable, and project-scoped', async () => {
  const record = artifact({ projectIds: ['default'] });
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardArtifactRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    artifactFileAvailable: () => true,
    getArtifactById: () => record,
    readIpaStructure: () => [
      { path: 'Payload/App.app/App', compressedSize: 4, uncompressedSize: 8, crc32: 1 },
      { path: 'Payload/App.app/Info.plist', compressedSize: 2, uncompressedSize: 3, crc32: 2 },
      { path: 'Payload/App.app/Frameworks/Kit', compressedSize: 6, uncompressedSize: 10, crc32: 3 },
    ],
  }));

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.requestDecrypt) };
    const firstPage = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts/artifact-1/contents?projectId=default&limit=1', headers });
    const filtered = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts/artifact-1/contents?projectId=default&q=info', headers });
    const hidden = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts/artifact-1/contents?projectId=private', headers });

    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({ total: 3, nextOffset: 1, entries: [{ path: 'Payload/App.app/App' }] });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({ total: 1, entries: [{ path: 'Payload/App.app/Info.plist' }] });
    expect(hidden.statusCode).toBe(404);
  } finally {
    await server.close();
  }
});

test('artifact listing and pinning keep their permission and project boundaries', async () => {
  const record = artifact({ projectIds: ['private'] });
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardArtifactRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    artifactFileAvailable: () => true,
    getArtifactById: () => record,
  }));

  try {
    const unauthenticated = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts' });
    const missingDecryptPermission = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts', headers: { cookie: sessionCookie() } });
    const inaccessibleProject = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/artifacts?projectId=private',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
    });
    const missingPinPermission = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/artifacts/artifact-1/pin',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { pinned: true },
    });
    const inaccessibleArtifact = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/artifacts/artifact-1/pin',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
      payload: { pinned: true },
    });
    const missingDetailPermission = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts/artifact-1', headers: { cookie: sessionCookie() } });
    const inaccessibleDetail = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts/artifact-1?projectId=private', headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) } });

    expect(unauthenticated.statusCode).toBe(401);
    expect(missingDecryptPermission.statusCode).toBe(403);
    expect(inaccessibleProject.statusCode).toBe(404);
    expect(missingPinPermission.statusCode).toBe(403);
    expect(inaccessibleArtifact.statusCode).toBe(404);
    expect(missingDetailPermission.statusCode).toBe(403);
    expect(inaccessibleDetail.statusCode).toBe(404);
  } finally {
    await server.close();
  }
});

test('single artifact mutations report no-op state so clients do not offer undo', async () => {
  const record = artifact({ pinnedAt: 3 });
  const audits: Array<[string, string, string, string?, Array<{ field: string; before: unknown; after: unknown }> ?]> = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardArtifactRoutes({
    canAccessProject: () => true,
    artifactFileAvailable: () => true,
    getArtifactById: () => record,
    setArtifactPinned: async () => ({ artifact: record, changed: false }),
    recordAudit: (...entry) => { audits.push(entry); },
  }));

  try {
    const response = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/artifacts/artifact-1/pin',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
      payload: { pinned: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, changed: false, pinned: true });
    expect(audits).toEqual([]);
  } finally {
    await server.close();
  }
});

test('bulk pinning updates only artifacts in projects the manager can access', async () => {
  const records = new Map([
    ['artifact-a', artifact({ id: 'artifact-a' })],
    ['artifact-b', artifact({ id: 'artifact-b', projectIds: ['private'] })],
  ]);
  const calls: Array<{ ids: string[]; pinned: boolean }> = [];
  const audits: Array<[string, string, string, string?, Array<{ field: string; before: unknown; after: unknown }> ?]> = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardArtifactRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    artifactFileAvailable: () => true,
    getArtifactById: (id) => records.get(id),
    setArtifactsPinned: async (ids, pinned) => {
      calls.push({ ids, pinned });
      const previousPinnedAtById = Object.fromEntries(ids.map((id) => [id, records.get(id)!.pinnedAt]));
      const updated = ids.map((id) => {
        const value = records.get(id)!;
        const next = artifact({ ...value, pinnedAt: pinned ? 4 : undefined });
        records.set(id, next);
        return next;
      });
      return { artifacts: updated, changedIds: ids, missingIds: [], previousPinnedAtById };
    },
    recordAudit: (...entry) => { audits.push(entry); },
  }));

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/artifacts/bulk-pin',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
      payload: { ids: ['artifact-a'], pinned: true },
    });
    const inaccessible = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/artifacts/bulk-pin',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
      payload: { ids: ['artifact-a', 'artifact-b'], pinned: true },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      ok: true,
      pinned: true,
      changedIds: ['artifact-a'],
      artifacts: [{ artifactId: 'artifact-a', pinned: true, pinnedAt: '1970-01-01T00:00:00.004Z' }],
    });
    expect(inaccessible.statusCode).toBe(404);
    expect(calls).toEqual([{ ids: ['artifact-a'], pinned: true }]);
    expect(audits).toEqual([['root', 'artifact.pin', 'artifact-a']]);
  } finally {
    await server.close();
  }
});

test('bulk pinning requires storage permission and rejects oversized selections', async () => {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  server.setErrorHandler((error, request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({
      error: message,
      code: statusCode === 400 ? 'request_error' : 'internal_error',
      message,
      requestId: request.id,
      retryable: statusCode >= 500,
    });
  });
  await server.register(createDashboardArtifactRoutes({
    canAccessProject: () => true,
    artifactFileAvailable: () => true,
    getArtifactById: (id) => artifact({ id }),
    setArtifactsPinned: async (ids) => ({ artifacts: ids.map((id) => artifact({ id })), changedIds: ids, missingIds: [], previousPinnedAtById: {} }),
  }));

  try {
    const denied = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/artifacts/bulk-pin',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { ids: ['artifact-a'], pinned: true },
    });
    const oversized = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/artifacts/bulk-pin',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
      payload: { ids: Array.from({ length: 101 }, (_, index) => `artifact-${index}`), pinned: true },
    });

    expect(denied.statusCode).toBe(403);
    expect(oversized.statusCode).toBe(400);
  } finally {
    await server.close();
  }
});

test('archive and restore require storage permission, project access, and record audit events', async () => {
  const records = new Map([
    ['artifact-a', artifact({ id: 'artifact-a' })],
    ['artifact-b', artifact({ id: 'artifact-b', projectIds: ['private'] })],
  ]);
  const calls: Array<{ ids: string[]; archived: boolean }> = [];
  const audits: Array<[string, string, string, string?, Array<{ field: string; before: unknown; after: unknown }> ?]> = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardArtifactRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    artifactFileAvailable: () => true,
    getArtifactById: (id) => records.get(id),
    setArtifactArchived: async (id, archived) => {
      calls.push({ ids: [id], archived });
      const value = records.get(id)!;
      const updated = artifact({ ...value, archivedAt: archived ? 4 : undefined });
      records.set(id, updated);
      return { artifact: updated, changed: true, previousArchivedAt: value.archivedAt };
    },
    setArtifactsArchived: async (ids, archived) => {
      calls.push({ ids, archived });
      const previousArchivedAtById = Object.fromEntries(ids.map((id) => [id, records.get(id)!.archivedAt]));
      const updated = ids.map((id) => {
        const value = records.get(id)!;
        const next = artifact({ ...value, archivedAt: archived ? 4 : undefined });
        records.set(id, next);
        return next;
      });
      return { artifacts: updated, changedIds: ids, missingIds: [], previousArchivedAtById };
    },
    recordAudit: (...entry) => { audits.push(entry); },
  }));

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.manageAutomation) };
    const archived = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/artifacts/artifact-a/archive',
      headers,
      payload: { archived: true },
    });
    const restored = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/artifacts/bulk-archive',
      headers,
      payload: { ids: ['artifact-a'], archived: false },
    });
    const inaccessible = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/artifacts/artifact-b/archive',
      headers,
      payload: { archived: true },
    });
    const denied = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/artifacts/artifact-a/archive',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { archived: true },
    });

    expect(archived.statusCode).toBe(200);
    expect(JSON.parse(archived.body)).toEqual({ ok: true, changed: true, artifactId: 'artifact-a', archived: true, archivedAt: '1970-01-01T00:00:00.004Z' });
    expect(restored.statusCode).toBe(200);
    expect(JSON.parse(restored.body)).toEqual({
      ok: true,
      archived: false,
      changedIds: ['artifact-a'],
      artifacts: [{ artifactId: 'artifact-a', archived: false, previousArchivedAt: 4 }],
    });
    expect(inaccessible.statusCode).toBe(404);
    expect(denied.statusCode).toBe(403);
    expect(calls).toEqual([{ ids: ['artifact-a'], archived: true }, { ids: ['artifact-a'], archived: false }]);
    expect(audits).toEqual([
      ['root', 'artifact.archive', 'artifact-a'],
      ['root', 'artifact.restore', 'artifact-a'],
    ]);
  } finally {
    await server.close();
  }
});

test('query-wide artifact pinning stays project-scoped and ZIP export uses explicit authorized IDs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dkrypt-artifact-routes-'));
  const firstPath = path.join(directory, 'first.ipa');
  const secondPath = path.join(directory, 'second.ipa');
  await writeFile(firstPath, 'first payload');
  await writeFile(secondPath, 'second payload');
  const records = [
    artifact({ id: 'artifact-a', filePath: firstPath, fileSizeBytes: 13, versionLabel: '1.0' }),
    artifact({ id: 'artifact-b', filePath: secondPath, fileSizeBytes: 14, versionLabel: '2.0' }),
  ];
  const listCalls: Array<{ cursor?: string; projectIds?: string[] }> = [];
  const pinCalls: string[][] = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardArtifactRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    artifactFileAvailable: () => true,
    getArtifactById: (id) => records.find((record) => record.id === id),
    listArtifacts: (options) => {
      listCalls.push({ cursor: options?.cursor, projectIds: options?.projectIds });
      return options?.cursor
        ? { artifacts: [records[1]!], total: 2, totalBytes: 27, maxBytes: 100 }
        : { artifacts: [records[0]!], total: 2, totalBytes: 27, maxBytes: 100, nextCursor: 'next-page' };
    },
    setArtifactsPinned: async (ids, pinned) => {
      pinCalls.push(ids);
      return {
        artifacts: ids.map((id) => artifact({ ...records.find((record) => record.id === id)!, pinnedAt: pinned ? 10 : undefined, pinnedStateChangedAt: 11 })),
        changedIds: ids,
        missingIds: [],
        previousPinnedAtById: Object.fromEntries(ids.map((id) => [id, undefined])),
      };
    },
    touchArtifact: async () => undefined,
  }));

  try {
    const managerHeaders = { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.manageAutomation) };
    const pinned = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/artifacts/bulk-pin-query',
      headers: managerHeaders,
      payload: { filter: { projectId: 'default', q: 'example', archived: false }, pinned: true },
    });
    const zipped = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/artifacts/export.zip',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { ids: ['artifact-a', 'artifact-b'] },
    });

    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().changedIds).toEqual(['artifact-a', 'artifact-b']);
    expect(listCalls).toEqual([{ cursor: undefined, projectIds: ['default'] }, { cursor: 'next-page', projectIds: ['default'] }]);
    expect(pinCalls).toEqual([['artifact-a', 'artifact-b']]);
    expect(zipped.statusCode).toBe(200);
    const archive = new AdmZip(zipped.rawPayload);
    expect(archive.getEntries().map((entry) => entry.entryName)).toEqual(['com.example.app-1.0.ipa', 'com.example.app-2.0.ipa']);
    expect(archive.getEntry('com.example.app-1.0.ipa')?.getData().toString()).toBe('first payload');
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
