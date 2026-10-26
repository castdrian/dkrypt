import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Response } from '#http.js';
import type { AppVersionEntry } from '#versions.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { createDashboardAppRoutes } from '#routes/dashboardAppRoutes.js';
import { setSessionCookie } from '#session.js';
import type { AppCatalogEntry } from '#store/state.js';
import type { ArtifactRecord } from '#artifacts.js';

function sessionCookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0];
}

test('app search and metadata endpoints are not registered through the legacy router', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/search');
  expect(routes).not.toContain('GET /v1/dashboard/apps/metadata');
  expect(routes).not.toContain('GET /v1/dashboard/apps/cache');
  expect(routes).not.toContain('POST /v1/dashboard/apps/metadata/refresh');
  expect(routes).not.toContain('GET /v1/dashboard/versions/:bundleId');
});

test('App Store links resolve track IDs only for dashboard sessions', async () => {
  const lookups: number[] = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardAppRoutes({
    lookupAppMetadataByTrackId: async (trackId) => {
      lookups.push(trackId);
      return { bundleId: 'com.example.linked', trackId, trackName: 'Linked app', version: '1.0', sellerName: 'Seller', artworkUrl: '', price: 0 };
    },
  }));
  try {
    const anonymous = await server.inject({ method: 'GET', url: '/v1/dashboard/apps/lookup-track?trackId=12345' });
    const invalid = await server.inject({ method: 'GET', url: '/v1/dashboard/apps/lookup-track?trackId=-1', headers: { cookie: sessionCookie(0n) } });
    const resolved = await server.inject({ method: 'GET', url: '/v1/dashboard/apps/lookup-track?trackId=12345', headers: { cookie: sessionCookie(0n) } });
    expect(anonymous.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(400);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json() as Record<string, unknown>).toEqual({ bundleId: 'com.example.linked', trackName: 'Linked app', trackId: 12345 });
    expect(lookups).toEqual([12345]);
  } finally {
    await server.close();
  }
});

test('App Store versions include matching artifact IDs and preserve force semantics', async () => {
  const versions: AppVersionEntry[] = [
    { externalVersionId: 'version-3', isLatest: true, displayVersion: '3.0' },
    { externalVersionId: 'version-2', isLatest: false, displayVersion: '2.0', releaseDate: '2026-01-01' },
    { isLatest: false, bundleVersion: '1.9' },
  ];
  const artifact: ArtifactRecord = {
    id: 'artifact-version-2',
    key: 'cached-version-2',
    projectIds: ['default'],
    bundleId: 'com.example.versions',
    channel: 'appstore',
    externalVersionId: 'version-2',
    filePath: '/tmp/version-2.ipa',
    fileSizeBytes: 1,
    sha256: 'a'.repeat(64),
    createdAt: 1,
    lastAccessedAt: 1,
    accessCount: 1,
  };
  const versionCalls: Array<[string, boolean]> = [];
  const artifactKeys: string[] = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardAppRoutes({
    listAppVersions: async (bundleId, force) => {
      versionCalls.push([bundleId, force === true]);
      return versions;
    },
    artifactKeyForAppStoreVersion: (bundleId, label, externalVersionId) => `${bundleId}:${label}:${externalVersionId ?? ''}`,
    getArtifactByKey: (key) => {
      artifactKeys.push(key);
      return key === 'com.example.versions:2.0:version-2' ? artifact : undefined;
    },
  }));

  try {
    const headers = { cookie: sessionCookie(0n) };
    const response = await server.inject({ method: 'GET', url: '/v1/dashboard/versions/com.example.versions?force=true', headers });
    const nonForced = await server.inject({ method: 'GET', url: '/v1/dashboard/versions/com.example.versions?force=invalid', headers });
    const repeatedForce = await server.inject({ method: 'GET', url: '/v1/dashboard/versions/com.example.versions?force=true&force=true', headers });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ versions: [
      { externalVersionId: 'version-3', isLatest: true, displayVersion: '3.0' },
      { externalVersionId: 'version-2', isLatest: false, displayVersion: '2.0', releaseDate: '2026-01-01', artifactId: 'artifact-version-2' },
      { isLatest: false, bundleVersion: '1.9' },
    ] });
    expect(versionCalls).toEqual([
      ['com.example.versions', true],
      ['com.example.versions', false],
      ['com.example.versions', false],
    ]);
    expect(artifactKeys.slice(0, 3)).toEqual([
      'com.example.versions:3.0:version-3',
      'com.example.versions:2.0:version-2',
      'com.example.versions:latest:',
    ]);
    expect(nonForced.statusCode).toBe(200);
    expect(repeatedForce.statusCode).toBe(200);
  } finally {
    await server.close();
  }
});

test('App Store version lookup failures use the standard retryable API envelope', async () => {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardAppRoutes({ listAppVersions: async () => { throw new Error('private upstream detail'); } }));

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/versions/com.example.versions',
      headers: { cookie: sessionCookie(0n) },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: 'internal server error',
      code: 'internal_error',
      message: 'internal server error',
      retryable: true,
    });
    expect(response.body).not.toContain('private upstream detail');
  } finally {
    await server.close();
  }
});

test('app search caches discovery data and metadata requests hydrate app details', async () => {
  const catalog = new Map<string, AppCatalogEntry>();
  const lookups: string[] = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardAppRoutes({
    searchApps: async (term) => {
      expect(term).toBe('Example app');
      return [{
        bundleId: 'com.example.app',
        trackId: 12345,
        trackName: 'Example app',
        version: '1.0',
        sellerName: 'Example seller',
        artworkUrl: 'https://example.com/icon.png',
        price: 0,
        category: 'Utilities',
        minimumOsVersion: '17.0',
      }];
    },
    decorateSearchResults: async (results) => results.map((result) => ({
      ...result,
      testflight: { appId: result.trackId, devices: [{ id: 'ipad', name: 'iPad', verifiedAt: 123 }], lastVerifiedAt: 123 },
    })),
    lookupAppMetadata: async (bundleId) => {
      lookups.push(bundleId);
      return {
        bundleId,
        trackId: 56789,
        trackName: 'Cached metadata',
        sellerName: 'Example seller',
        artworkUrl: 'https://example.com/metadata.png',
        version: '2.0',
        category: 'Utilities',
        description: 'App description',
        screenshots: ['https://example.com/screenshot.png'],
        releaseNotes: 'What is new',
        price: 0,
      };
    },
    getAppCatalogEntries: (bundleIds) => bundleIds.flatMap((bundleId) => catalog.get(bundleId) ?? []),
    getAppCatalogStats: () => ({ entries: catalog.size, icons: catalog.size, oldestUpdatedAt: 123, newestUpdatedAt: 456 }),
    upsertAppCatalogEntries: (entries) => entries.map((entry) => {
      const stored = { ...entry, metadataFetchedAt: entry.releaseNotes ? Date.now() : undefined, updatedAt: Date.now() };
      catalog.set(entry.bundleId, stored);
      return stored;
    }),
  }));

  try {
    const cookie = sessionCookie(0n);
    const search = await server.inject({ method: 'GET', url: '/v1/dashboard/search?q=%20Example%20app%20', headers: { cookie } });
    const metadata = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/apps/metadata?bundleIds=com.example.app,com.example.missing,com.example.missing,bad!',
      headers: { cookie },
    });
    const refresh = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/apps/metadata/refresh',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
      payload: { bundleIds: ['com.example.refresh', 'com.example.refresh'] },
    });

    expect(search.statusCode).toBe(200);
    expect(JSON.parse(search.body)).toMatchObject({ results: [{ minimumOsVersion: '17.0', testflight: { appId: 12345, devices: [{ id: 'ipad', verifiedAt: 123 }] } }] });
    expect(metadata.statusCode).toBe(200);
    expect(JSON.parse(metadata.body)).toMatchObject({ entries: [
      { bundleId: 'com.example.app', displayName: 'Cached metadata', releaseNotes: 'What is new' },
      { bundleId: 'com.example.missing', displayName: 'Cached metadata' },
    ] });
    expect(refresh.statusCode).toBe(200);
    expect(JSON.parse(refresh.body)).toMatchObject({ entries: [{ bundleId: 'com.example.refresh' }] });
    expect(lookups).toEqual(['com.example.app', 'com.example.missing', 'com.example.refresh']);
  } finally {
    await server.close();
  }
});

test('app catalog cache and refresh routes retain their manager permissions', async () => {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardAppRoutes({ getAppCatalogStats: () => ({ entries: 9, icons: 8 }) }));

  try {
    const deniedCache = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/apps/cache',
      headers: { cookie: sessionCookie(0n) },
    });
    const allowedCache = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/apps/cache',
      headers: { cookie: sessionCookie(PermissionFlag.viewAutomation) },
    });
    const deniedRefresh = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/apps/metadata/refresh',
      headers: { cookie: sessionCookie(0n) },
      payload: { bundleIds: ['com.example.app'] },
    });

    expect(deniedCache.statusCode).toBe(403);
    expect(allowedCache.statusCode).toBe(200);
    expect(allowedCache.json()).toMatchObject({ entries: 9, icons: 8 });
    expect(deniedRefresh.statusCode).toBe(403);
  } finally {
    await server.close();
  }
});

test('metadata requests refresh cached non-English app names for regular dashboard users', async () => {
  const staleEntry: AppCatalogEntry = {
    bundleId: 'com.example.stale',
    displayName: 'Beispiel-App',
    releaseNotes: 'Old notes',
    metadataFetchedAt: Date.now(),
    updatedAt: Date.now(),
  };
  const catalog = new Map([[staleEntry.bundleId, staleEntry]]);
  const lookups: string[] = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardAppRoutes({
    lookupAppMetadata: async (bundleId) => {
      lookups.push(bundleId);
      return {
        bundleId,
        trackId: 12345,
        trackName: 'Example app',
        sellerName: 'Example seller',
        artworkUrl: 'https://example.com/icon.png',
        version: '2.0',
        releaseNotes: 'Current notes',
      };
    },
    getAppCatalogEntries: (bundleIds) => bundleIds.flatMap((bundleId) => catalog.get(bundleId) ?? []),
    upsertAppCatalogEntries: (entries) => entries.map((entry) => {
      const stored = { ...entry, updatedAt: Date.now() };
      catalog.set(entry.bundleId, stored);
      return stored;
    }),
  }));

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/apps/metadata?bundleIds=com.example.stale',
      headers: { cookie: sessionCookie(0n) },
    });

    expect(response.statusCode).toBe(200);
    expect(lookups).toEqual(['com.example.stale']);
    expect(response.json().entries).toMatchObject([{ displayName: 'Example app', displayNameLanguage: 'en', releaseNotes: 'Current notes' }]);
    expect(response.json().entries[0].metadataFetchedAt).toBeGreaterThanOrEqual(staleEntry.metadataFetchedAt!);
  } finally {
    await server.close();
  }
});

test('metadata refresh filters malformed IDs and caps work at forty unique apps', async () => {
  const catalog = new Map<string, AppCatalogEntry>();
  const lookups: string[] = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardAppRoutes({
    lookupAppMetadata: async (bundleId) => {
      lookups.push(bundleId);
      return {
        bundleId,
        trackId: 12345,
        trackName: bundleId,
        sellerName: 'Example seller',
        artworkUrl: 'https://example.com/icon.png',
        version: '1.0',
      };
    },
    getAppCatalogEntries: (bundleIds) => bundleIds.flatMap((bundleId) => catalog.get(bundleId) ?? []),
    upsertAppCatalogEntries: (entries) => entries.map((entry) => {
      const stored = { ...entry, updatedAt: 123 };
      catalog.set(entry.bundleId, stored);
      return stored;
    }),
  }));

  try {
    const bundleIds = [
      ...Array.from({ length: 42 }, (_, index) => `com.example.app${index}`),
      'not a bundle id',
      null,
    ];
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/apps/metadata/refresh',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
      payload: { bundleIds },
    });

    expect(response.statusCode).toBe(200);
    expect(lookups).toHaveLength(40);
    expect(lookups[0]).toBe('com.example.app0');
    expect(lookups.at(-1)).toBe('com.example.app39');
    expect(JSON.parse(response.body).entries).toHaveLength(40);
  } finally {
    await server.close();
  }
});

test('metadata refresh does not return stale cached entries after a lookup fails', async () => {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardAppRoutes({
    lookupAppMetadata: async () => { throw new Error('lookup unavailable'); },
    getAppCatalogEntries: () => [{
      bundleId: 'com.example.stale',
      displayName: 'Old name',
      updatedAt: 123,
    }],
    upsertAppCatalogEntries: () => [],
  }));

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/apps/metadata/refresh',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
      payload: { bundleIds: ['com.example.stale'] },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ entries: [] });
  } finally {
    await server.close();
  }
});

test('metadata refresh rejects batches with no valid bundle IDs', async () => {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardAppRoutes());

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/apps/metadata/refresh',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
      payload: { bundleIds: ['invalid bundle id', null] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'at least one valid bundle ID is required' });
  } finally {
    await server.close();
  }
});
