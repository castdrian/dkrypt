import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import type { ArtifactRecord } from '#artifacts.js';
import { config } from '#config.js';
import { apiIdempotencyRegistry } from '#idempotency.js';
import { DailyDecryptLimitError } from '#jobs/repository.js';
import { createArtifactCatalogRoutes, createDecryptRoutes, createTestFlightCatalogRoutes } from '#routes/decrypt.js';
import type { Job } from '#jobs/types.js';
import { PermissionFlag, serializeBits } from '#permissions.js';
import { addAllowedUser, bulkSetApiKeyAllowedBundleIds, createApiKey, createProject, createRole, getEffectiveSettings, revokeApiKey, updateProject, updateSettings } from '#store/state.js';

test('TestFlight catalog routes require the internal service key and normalize bridge failures', async () => {
  let trainLookupAppId = 0;
  let buildLookup: { appId: number; trainVersion: string } | undefined;
  let shouldFailTrainLookup = false;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  server.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    const status = typeof statusCode === 'number' ? statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    reply.code(status).send({
      error: message,
      code: status === 400 ? 'validation_error' : 'internal_error',
      message,
      requestId: request.id,
      retryable: status >= 500,
    });
  });
  const deniedKey = createApiKey('TestFlight disabled route test', 'root', undefined, undefined, undefined, false);
  const allowedKey = createApiKey('TestFlight route test', 'root');

  try {
    await server.register(createTestFlightCatalogRoutes({
      listTrains: async (appId) => {
        trainLookupAppId = appId;
        if (shouldFailTrainLookup) throw new Error('device agent unavailable');
        return [{ trainVersion: '4.0', buildCount: 2 }];
      },
      listBuilds: async (appId, trainVersion) => {
        buildLookup = { appId, trainVersion };
        return [{ id: 12345, cfBundleShortVersion: '4.0', cfBundleVersion: '400', bundleId: 'com.example.app' }];
      },
    }));
    await server.ready();

    const unauthorized = await server.inject({ method: 'GET', url: '/v1/testflight/123/trains' });
    expect(unauthorized.statusCode).toBe(401);

    const denied = await server.inject({
      method: 'GET',
      url: '/v1/testflight/123/trains',
      headers: { authorization: `Bearer ${deniedKey.key}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'public_api_scope_denied', retryable: false });

    const generatedKey = await server.inject({
      method: 'GET',
      url: '/v1/testflight/123/trains',
      headers: { authorization: `Bearer ${allowedKey.key}` },
    });
    expect(generatedKey.statusCode).toBe(403);
    expect(generatedKey.json()).toMatchObject({ code: 'public_api_scope_denied', retryable: false });

    const internalHeaders = { authorization: `Bearer ${config.apiKey}` };

    const malformed = await server.inject({
      method: 'GET',
      url: '/v1/testflight/not-an-app-id/trains',
      headers: internalHeaders,
    });
    expect(malformed.statusCode).toBe(400);

    const trains = await server.inject({
      method: 'GET',
      url: '/v1/testflight/123/trains',
      headers: internalHeaders,
    });
    expect(trains.statusCode).toBe(200);
    expect(trains.json() as unknown).toEqual({ trains: [{ trainVersion: '4.0', buildCount: 2 }] });
    expect(trainLookupAppId).toBe(123);

    const builds = await server.inject({
      method: 'GET',
      url: '/v1/testflight/123/builds?trainVersion=4.0',
      headers: internalHeaders,
    });
    expect(builds.statusCode).toBe(200);
    expect(buildLookup).toEqual({ appId: 123, trainVersion: '4.0' });
    expect(builds.json() as unknown).toMatchObject({ builds: [{ id: 12345, bundleId: 'com.example.app' }] });

    shouldFailTrainLookup = true;
    const failure = await server.inject({
      method: 'GET',
      url: '/v1/testflight/123/trains',
      headers: internalHeaders,
    });
    expect(failure.statusCode).toBe(502);
    expect(failure.json()).toMatchObject({ code: 'testflight_lookup_failed', requestId: expect.any(String), retryable: true });
  } finally {
    revokeApiKey(deniedKey.id, 'root', true);
    revokeApiKey(allowedKey.id, 'root', true);
    await server.close();
  }
});

test('typed artifact routes enforce API-key bundle scopes and stream downloads', async () => {
  const artifactDirectory = mkdtempSync(join(tmpdir(), 'dkrypt-artifact-route-'));
  const artifactContents = 'ipa-test-content';
  const artifactPath = join(artifactDirectory, 'allowed.ipa');
  writeFileSync(artifactPath, artifactContents);
  const allowedArtifact: ArtifactRecord = {
    id: 'allowed-artifact',
    key: 'allowed-key',
    projectIds: ['default'],
    bundleId: 'com.example.allowed',
    channel: 'appstore',
    versionLabel: '1.0',
    filePath: artifactPath,
    fileSizeBytes: Buffer.byteLength(artifactContents),
    sha256: 'a'.repeat(64),
    createdAt: 1_700_000_000_000,
    lastAccessedAt: 1_700_000_000_000,
    accessCount: 1,
  };
  const deniedArtifact: ArtifactRecord = {
    ...allowedArtifact,
    id: 'denied-artifact',
    key: 'denied-key',
    bundleId: 'com.example.denied',
    filePath: '/unused/denied.ipa',
  };
  let listedBundleIds: string[] | undefined;
  const touchedArtifactIds: string[] = [];
  const apiKey = createApiKey('Scoped artifact metadata route test', 'root', undefined, ['com.example.allowed']);
  const emptyScopeApiKey = createApiKey('Empty-scope artifact metadata route test', 'root');
  bulkSetApiKeyAllowedBundleIds([emptyScopeApiKey.id], []);
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();

  try {
    await server.register(createArtifactCatalogRoutes({
      listArtifacts: (options) => {
        listedBundleIds = options?.bundleIds;
        return { artifacts: [allowedArtifact], total: 1, totalBytes: allowedArtifact.fileSizeBytes, maxBytes: 100 };
      },
      getArtifactById: (id) => id === allowedArtifact.id ? allowedArtifact : id === deniedArtifact.id ? deniedArtifact : undefined,
      artifactFileAvailable: (artifact) => Boolean(artifact),
      touchArtifact: async (artifact) => {
        touchedArtifactIds.push(artifact.id);
      },
    }));
    await server.ready();

    const headers = { authorization: `Bearer ${apiKey.key}` };
    const listing = await server.inject({ method: 'GET', url: '/v1/artifacts', headers });
    expect(listing.statusCode).toBe(200);
    expect(listedBundleIds).toEqual(['com.example.allowed']);
    expect(listing.json() as unknown).toMatchObject({
      artifacts: [{ bundleId: 'com.example.allowed' }],
      total: 1,
      totalBytes: Buffer.byteLength(artifactContents),
    });

    const allowed = await server.inject({ method: 'GET', url: `/v1/artifacts/${allowedArtifact.id}`, headers });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json() as unknown).toMatchObject({ id: allowedArtifact.id, bundleId: 'com.example.allowed' });

    const allowedFile = await server.inject({ method: 'GET', url: `/v1/artifacts/${allowedArtifact.id}/file`, headers });
    expect(allowedFile.statusCode).toBe(200);
    expect(allowedFile.body).toBe(artifactContents);
    expect(allowedFile.headers['content-type']).toContain('application/octet-stream');
    expect(touchedArtifactIds).toEqual([allowedArtifact.id]);

    const denied = await server.inject({ method: 'GET', url: `/v1/artifacts/${deniedArtifact.id}`, headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'bundle_scope_denied', retryable: false });

    const deniedFile = await server.inject({ method: 'GET', url: `/v1/artifacts/${deniedArtifact.id}/file`, headers });
    expect(deniedFile.statusCode).toBe(403);
    expect(deniedFile.json()).toMatchObject({ code: 'bundle_scope_denied' });
    expect(touchedArtifactIds).toEqual([allowedArtifact.id]);

    const resumedFile = await server.inject({
      method: 'GET',
      url: `/v1/artifacts/${allowedArtifact.id}/file`,
      headers: { ...headers, range: 'bytes=4-8' },
    });
    expect(resumedFile.statusCode).toBe(206);
    expect(resumedFile.body).toBe(artifactContents.slice(4, 9));
    expect(resumedFile.headers['content-range']).toBe(`bytes 4-8/${Buffer.byteLength(artifactContents)}`);
    expect(resumedFile.headers['accept-ranges']).toBe('bytes');

    const suffixFile = await server.inject({
      method: 'GET',
      url: `/v1/artifacts/${allowedArtifact.id}/file`,
      headers: { ...headers, range: 'bytes=-4' },
    });
    expect(suffixFile.statusCode).toBe(206);
    expect(suffixFile.body).toBe(artifactContents.slice(-4));

    const invalidRange = await server.inject({
      method: 'GET',
      url: `/v1/artifacts/${allowedArtifact.id}/file`,
      headers: { ...headers, range: `bytes=${Buffer.byteLength(artifactContents)}-` },
    });
    expect(invalidRange.statusCode).toBe(416);
    expect(invalidRange.headers['content-range']).toBe(`bytes */${Buffer.byteLength(artifactContents)}`);

    const missing = await server.inject({ method: 'GET', url: '/v1/artifacts/missing-artifact', headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'request_error', error: 'artifact not found' });

    const emptyScopeHeaders = { authorization: `Bearer ${emptyScopeApiKey.key}` };
    const emptyScopeListing = await server.inject({ method: 'GET', url: '/v1/artifacts', headers: emptyScopeHeaders });
    expect(emptyScopeListing.statusCode).toBe(200);
    expect(listedBundleIds).toBeUndefined();

    const emptyScopeDetail = await server.inject({ method: 'GET', url: `/v1/artifacts/${deniedArtifact.id}`, headers: emptyScopeHeaders });
    expect(emptyScopeDetail.statusCode).toBe(200);
  } finally {
    revokeApiKey(apiKey.id, 'root', true);
    revokeApiKey(emptyScopeApiKey.id, 'root', true);
    await server.close();
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
});

test('API artifact access follows project membership and keeps project selectors isolated', async () => {
  const ownerId = `api-project-owner-${crypto.randomUUID()}`;
  const outsiderId = `api-project-outsider-${crypto.randomUUID()}`;
  const role = createRole({ name: `API project role ${crypto.randomUUID()}`, color: '#3498db', permissions: serializeBits(PermissionFlag.createApiKeys) }, 'test');
  const managerId = `api-project-manager-${crypto.randomUUID()}`;
  const managerRole = createRole({ name: `API project manager ${crypto.randomUUID()}`, color: '#5865f2', permissions: serializeBits(PermissionFlag.createApiKeys | PermissionFlag.viewProjects) }, 'test');
  addAllowedUser(ownerId, [role.id], 'test');
  addAllowedUser(outsiderId, [role.id], 'test');
  addAllowedUser(managerId, [managerRole.id], 'test');
  const ownerProject = createProject({ name: `API owner project ${crypto.randomUUID()}`, memberIds: [ownerId] }, 'root').project;
  const outsiderProject = createProject({ name: `API outsider project ${crypto.randomUUID()}`, memberIds: [outsiderId] }, 'root').project;
  if (!ownerProject || !outsiderProject) throw new Error('project setup failed');
  const apiKey = createApiKey('Project-scoped API artifact access test', ownerId);
  const outsiderKey = createApiKey('Unrelated API project access test', outsiderId);
  const managerKey = createApiKey('Archived project manager access test', managerId);
  const projectJob: Job = {
    id: 'project-scoped-api-job',
    bundleId: 'com.example.project',
    projectId: ownerProject.id,
    artifactId: 'project-api-artifact',
    source: 'manual',
    priority: 0,
    status: 'queued',
    progress: 'queued',
    createdAt: Date.now(),
    waiters: [],
  };
  const enqueuedProjectIds: (string | undefined)[] = [];
  const projectArtifact: ArtifactRecord = {
    id: 'project-api-artifact',
    key: 'project-api-key',
    projectIds: [ownerProject.id],
    bundleId: 'com.example.project',
    channel: 'appstore',
    filePath: '/unused/project.ipa',
    fileSizeBytes: 12,
    sha256: 'b'.repeat(64),
    createdAt: 1_700_000_000_000,
    lastAccessedAt: 1_700_000_000_000,
    accessCount: 0,
  };
  const requestedProjectIds: (string[] | undefined)[] = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();

  try {
    await server.register(createArtifactCatalogRoutes({
      listArtifacts: (options) => {
        requestedProjectIds.push(options?.projectIds);
        const artifacts = options?.projectIds?.includes(ownerProject.id) ? [projectArtifact] : [];
        return { artifacts, total: artifacts.length, totalBytes: artifacts.reduce((sum, artifact) => sum + artifact.fileSizeBytes, 0), maxBytes: 100 };
      },
      getArtifactById: (id) => id === projectArtifact.id ? projectArtifact : undefined,
      artifactFileAvailable: () => true,
      touchArtifact: async () => {},
    }));
    await server.register(createDecryptRoutes({
      resolveDecryptTarget: async (bundleId) => ({ bundleId, selector: undefined, channel: 'appstore', externalVersionId: 'project-build', versionLabel: '1.0', artifactKey: 'project-build' }),
      enqueueDecryptJob: (...args) => {
        enqueuedProjectIds.push(args[2]?.projectId);
        return { ...projectJob, projectId: args[2]?.projectId };
      },
      getJob: (id) => id === projectJob.id ? projectJob : undefined,
      waitForJob: async (job) => job,
      getArtifactById: () => undefined,
      recordApiKeyBundleUsage: () => {},
    }));
    await server.ready();

    const headers = { authorization: `Bearer ${apiKey.key}` };
    const owned = await server.inject({ method: 'GET', url: `/v1/artifacts?projectId=${ownerProject.id}`, headers });
    expect(owned.statusCode).toBe(200);
    expect(requestedProjectIds.at(-1)).toEqual([ownerProject.id]);
    expect((owned.json() as { artifacts: { id: string }[] }).artifacts.map((artifact) => artifact.id)).toEqual([projectArtifact.id]);

    const defaultProject = await server.inject({ method: 'GET', url: '/v1/artifacts', headers });
    expect(defaultProject.statusCode).toBe(200);
    expect(requestedProjectIds.at(-1)).toEqual(['default']);

    const unrelated = await server.inject({ method: 'GET', url: `/v1/artifacts?projectId=${outsiderProject.id}`, headers });
    expect(unrelated.statusCode).toBe(404);

    const detail = await server.inject({ method: 'GET', url: `/v1/artifacts/${projectArtifact.id}?projectId=${ownerProject.id}`, headers });
    expect(detail.statusCode).toBe(200);
    const hiddenDefault = await server.inject({ method: 'GET', url: `/v1/artifacts/${projectArtifact.id}`, headers });
    expect(hiddenDefault.statusCode).toBe(404);

    const ownerJob = await server.inject({ method: 'GET', url: `/v1/jobs/${projectJob.id}`, headers });
    expect(ownerJob.statusCode).toBe(200);
    expect((ownerJob.json() as { artifactUrl?: string }).artifactUrl).toBe(`/v1/artifacts/${projectArtifact.id}/file?projectId=${ownerProject.id}`);
    const outsiderHeaders = { authorization: `Bearer ${outsiderKey.key}` };
    const hiddenJob = await server.inject({ method: 'GET', url: `/v1/jobs/${projectJob.id}`, headers: outsiderHeaders });
    expect(hiddenJob.statusCode).toBe(404);

    const queued = await server.inject({ method: 'POST', url: '/v1/decrypts', headers, payload: { bundleId: 'com.example.project', projectId: ownerProject.id } });
    expect(queued.statusCode).toBe(202);
    expect(enqueuedProjectIds).toEqual([ownerProject.id]);
    const deniedQueue = await server.inject({ method: 'POST', url: '/v1/decrypts', headers: outsiderHeaders, payload: { bundleId: 'com.example.project', projectId: ownerProject.id } });
    expect(deniedQueue.statusCode).toBe(404);
    expect(enqueuedProjectIds).toEqual([ownerProject.id]);

    updateProject(ownerProject.id, { archived: true }, 'root');
    const ownerArchivedArtifacts = await server.inject({ method: 'GET', url: `/v1/artifacts?projectId=${ownerProject.id}`, headers });
    const managerArchivedArtifacts = await server.inject({ method: 'GET', url: `/v1/artifacts?projectId=${ownerProject.id}`, headers: { authorization: `Bearer ${managerKey.key}` } });
    const managerArchivedJob = await server.inject({ method: 'GET', url: `/v1/jobs/${projectJob.id}`, headers: { authorization: `Bearer ${managerKey.key}` } });
    const managerArchivedQueue = await server.inject({ method: 'POST', url: '/v1/decrypts', headers: { authorization: `Bearer ${managerKey.key}` }, payload: { bundleId: 'com.example.project', projectId: ownerProject.id } });
    expect(ownerArchivedArtifacts.statusCode).toBe(404);
    expect(managerArchivedArtifacts.statusCode).toBe(200);
    expect(managerArchivedJob.statusCode).toBe(200);
    expect(managerArchivedQueue.statusCode).toBe(409);
    expect(managerArchivedQueue.json()).toMatchObject({ code: 'project_archived', message: 'project is archived; restore it before queuing work' });
    expect(enqueuedProjectIds).toEqual([ownerProject.id]);
  } finally {
    revokeApiKey(apiKey.id, ownerId, true);
    revokeApiKey(outsiderKey.id, outsiderId, true);
    revokeApiKey(managerKey.id, managerId, true);
    updateProject(ownerProject.id, { archived: true }, 'root');
    updateProject(outsiderProject.id, { archived: true }, 'root');
    await server.close();
  }
});

test('typed decrypt submission routes preserve API-key scopes and resolved job responses', async () => {
  const allowedKey = createApiKey('Decrypt submission route test', 'root', undefined, ['com.example.allowed']);
  const deniedKey = createApiKey('Scoped decrypt submission route test', 'root', undefined, ['com.example.other']);
  const noTestFlightKey = createApiKey('No TestFlight decrypt submission route test', 'root', undefined, undefined, undefined, false);
  const testFlightKey = createApiKey('TestFlight decrypt submission route test', 'root');
  const queuedJob: Job = {
    id: 'decrypt-submission-job',
    bundleId: 'com.example.allowed',
    source: 'manual',
    priority: 0,
    versionLabel: '2.0',
    status: 'queued',
    progress: 'queued',
    createdAt: 1_700_000_000_000,
    waiters: [],
  };
  const resolved: string[] = [];
  const enqueued: unknown[][] = [];
  const usage: unknown[][] = [];
  let quotaBlocked = false;
  let waitTimeoutMs = 0;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof DailyDecryptLimitError) {
      reply.header('Retry-After', '60').code(429).send({ error: error.message, code: error.code, message: error.message, requestId: request.id, retryable: true, remediation: { nextAvailableAt: error.nextAvailableAt } });
      return;
    }
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    const status = typeof statusCode === 'number' ? statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    reply.code(status).send({
      error: status >= 500 ? 'internal server error' : message,
      code: status >= 500 ? 'internal_error' : 'request_error',
      message: status >= 500 ? 'internal server error' : message,
      requestId: request.id,
      retryable: status >= 500,
    });
  });

  try {
    await server.register(createDecryptRoutes({
      resolveDecryptTarget: async (bundleId, selector) => {
        resolved.push(`${bundleId}:${selector ?? ''}`);
        if (selector?.includes('_')) {
          return {
            bundleId,
            selector,
            channel: 'testflight',
            testflight: { appId: 123, build: { id: 45, cfBundleShortVersion: '2.0', cfBundleVersion: '4', bundleId } },
            versionLabel: '2.0_4',
            artifactKey: 'testflight-artifact',
          };
        }
        return { bundleId, selector: selector?.replace(/^v/i, ''), channel: 'appstore', externalVersionId: '12345', versionLabel: '2.0', minimumOsVersion: '17.0', artifactKey: 'appstore-artifact' };
      },
      enqueueDecryptJob: (...args) => {
        if (quotaBlocked) throw new DailyDecryptLimitError(Date.now() + 60_000);
        enqueued.push(args);
        return queuedJob;
      },
      getJob: (id) => id === queuedJob.id ? queuedJob : undefined,
      waitForJob: async (job, timeoutMs) => {
        waitTimeoutMs = timeoutMs;
        return job;
      },
      getArtifactById: () => undefined,
      recordApiKeyBundleUsage: (...args) => {
        usage.push(args);
      },
    }));
    await server.ready();

    const unauthorized = await server.inject({ method: 'POST', url: '/v1/decrypts', payload: { bundleId: 'com.example.allowed' } });
    expect(unauthorized.statusCode).toBe(401);

    const denied = await server.inject({
      method: 'POST',
      url: '/v1/decrypts',
      headers: { authorization: `Bearer ${deniedKey.key}` },
      payload: { bundleId: 'com.example.allowed' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'request_error', error: 'this API key is not scoped to this bundleId' });
    expect(resolved).toEqual([]);

    const testFlightDenied = await server.inject({
      method: 'POST',
      url: '/v1/decrypts',
      headers: { authorization: `Bearer ${noTestFlightKey.key}` },
      payload: { bundleId: 'com.example.allowed', version: '2.0_4' },
    });
    expect(testFlightDenied.statusCode).toBe(403);
    expect(testFlightDenied.json()).toMatchObject({ code: 'request_error', error: 'this API key is not scoped for TestFlight' });

    const acceptedHeaders = {
      authorization: `Bearer ${allowedKey.key}`,
      'idempotency-key': `appstore-${crypto.randomUUID()}`,
    };
    const accepted = await server.inject({
      method: 'POST',
      url: '/v1/decrypts',
      headers: acceptedHeaders,
      payload: { bundleId: 'com.example.allowed', version: 'v2.0' },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      id: queuedJob.id,
      bundleId: 'com.example.allowed',
      selector: '2.0',
      channel: 'appstore',
      resolvedVersion: '2.0',
      cacheHit: false,
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject(['com.example.allowed', 'manual', {
      externalVersionId: '12345',
      versionLabel: '2.0',
      queuedBy: 'root',
      priority: 0,
      apiKeyId: allowedKey.id,
      projectId: 'default',
    }]);
    expect(usage).toEqual([[allowedKey.id, 'com.example.allowed']]);
    const resolvedBeforeRetry = resolved.length;

    const duplicateAppStore = await server.inject({
      method: 'POST',
      url: '/v1/decrypts',
      headers: acceptedHeaders,
      payload: { bundleId: 'com.example.allowed', version: 'v2.0' },
    });
    expect(duplicateAppStore.statusCode).toBe(202);
    expect(duplicateAppStore.json()).toMatchObject({ id: queuedJob.id, selector: '2.0', resolvedVersion: '2.0' });
    expect(enqueued).toHaveLength(1);
    expect(resolved).toHaveLength(resolvedBeforeRetry);

    const conflictingAppStore = await server.inject({
      method: 'POST',
      url: '/v1/decrypts',
      headers: acceptedHeaders,
      payload: { bundleId: 'com.example.allowed', version: '2.1' },
    });
    expect(conflictingAppStore.statusCode).toBe(409);
    expect(conflictingAppStore.json()).toMatchObject({ code: 'request_error' });
    expect(resolved).toHaveLength(resolvedBeforeRetry);

    quotaBlocked = true;
    const quotaHeaders = {
      authorization: `Bearer ${allowedKey.key}`,
      'idempotency-key': `quota-${crypto.randomUUID()}`,
    };
    const quotaBlockedResponse = await server.inject({ method: 'POST', url: '/v1/decrypts', headers: quotaHeaders, payload: { bundleId: 'com.example.allowed', version: '2.0' } });
    expect(quotaBlockedResponse.statusCode).toBe(429);
    expect(quotaBlockedResponse.headers['retry-after']).toBe('60');
    expect(quotaBlockedResponse.json()).toMatchObject({ code: 'daily_decrypt_limit', retryable: true });
    expect(enqueued).toHaveLength(1);
    quotaBlocked = false;

    const invalidIdempotencyKey = await server.inject({
      method: 'POST',
      url: '/v1/decrypts',
      headers: { authorization: `Bearer ${allowedKey.key}`, 'idempotency-key': 'invalid key' },
      payload: { bundleId: 'com.example.allowed' },
    });
    expect(invalidIdempotencyKey.statusCode).toBe(400);

    const concurrentHeaders = {
      authorization: `Bearer ${allowedKey.key}`,
      'idempotency-key': `concurrent-${crypto.randomUUID()}`,
    };
    const concurrentRetries = await Promise.all([
      server.inject({ method: 'POST', url: '/v1/decrypts', headers: concurrentHeaders, payload: { bundleId: 'com.example.allowed', version: '2.0' } }),
      server.inject({ method: 'POST', url: '/v1/decrypts', headers: concurrentHeaders, payload: { bundleId: 'com.example.allowed', version: '2.0' } }),
    ]);
    expect(concurrentRetries.map((response) => response.statusCode)).toEqual([202, 202]);
    expect(concurrentRetries.map((response) => response.json().id)).toEqual([queuedJob.id, queuedJob.id]);
    expect(enqueued).toHaveLength(2);
    expect(resolved).toHaveLength(resolvedBeforeRetry + 2);

    const jobHeaders = { authorization: `Bearer ${allowedKey.key}` };
    const jobDetail = await server.inject({ method: 'GET', url: `/v1/jobs/${queuedJob.id}`, headers: jobHeaders });
    expect(jobDetail.statusCode).toBe(200);
    expect(jobDetail.json()).toMatchObject({ id: queuedJob.id, bundleId: queuedJob.bundleId, status: 'queued' });

    const deniedJobDetail = await server.inject({ method: 'GET', url: `/v1/jobs/${queuedJob.id}`, headers: { authorization: `Bearer ${deniedKey.key}` } });
    expect(deniedJobDetail.statusCode).toBe(403);
    expect(deniedJobDetail.json()).toMatchObject({ code: 'request_error' });

    const missingJobDetail = await server.inject({ method: 'GET', url: '/v1/jobs/missing-job', headers: jobHeaders });
    expect(missingJobDetail.statusCode).toBe(404);
    expect(missingJobDetail.json()).toMatchObject({ code: 'request_error' });

    waitTimeoutMs = 0;
    const waitingJob = await server.inject({ method: 'GET', url: `/v1/jobs/${queuedJob.id}/wait?timeoutSeconds=2`, headers: jobHeaders });
    expect(waitingJob.statusCode).toBe(202);
    expect(waitingJob.json()).toMatchObject({ id: queuedJob.id, status: 'queued' });
    expect(waitTimeoutMs).toBe(2_000);
    const hiddenWait = await server.inject({ method: 'GET', url: `/v1/jobs/${queuedJob.id}/wait`, headers: { authorization: `Bearer ${deniedKey.key}` } });
    expect(hiddenWait.statusCode).toBe(404);
    expect(hiddenWait.json()).toMatchObject({ code: 'request_error' });
    const batchStatuses = await server.inject({
      method: 'POST',
      url: '/v1/jobs/status',
      headers: jobHeaders,
      payload: { ids: [queuedJob.id, 'missing-job'] },
    });
    expect(batchStatuses.statusCode).toBe(200);
    expect(batchStatuses.json()).toMatchObject({ jobs: [
      { id: queuedJob.id, state: 'found', job: { id: queuedJob.id, status: 'queued' } },
      { id: 'missing-job', state: 'not_found' },
    ] });
    const hiddenBatchStatus = await server.inject({
      method: 'POST',
      url: '/v1/jobs/status',
      headers: { authorization: `Bearer ${deniedKey.key}` },
      payload: { ids: [queuedJob.id] },
    });
    expect(hiddenBatchStatus.json()).toMatchObject({ jobs: [{ id: queuedJob.id, state: 'not_found' }] });
    const invalidBatch = await server.inject({ method: 'POST', url: '/v1/jobs/status', headers: jobHeaders, payload: { ids: [queuedJob.id, queuedJob.id] } });
    expect(invalidBatch.statusCode).toBe(400);

    const testFlightPayload = {
      bundleId: 'com.example.allowed',
      appId: '123',
      build: { id: 45, cfBundleShortVersion: '2.0', cfBundleVersion: '4', bundleId: 'com.example.allowed' },
    };
    const malformedTestFlightBuild = await server.inject({
      method: 'POST',
      url: '/v1/testflight/decrypt',
      headers: { authorization: `Bearer ${testFlightKey.key}` },
      payload: { ...testFlightPayload, build: { bundleId: 'com.example.allowed' } },
    });
    expect(malformedTestFlightBuild.statusCode).toBe(400);
    const testFlightHeaders = {
      authorization: `Bearer ${testFlightKey.key}`,
      'idempotency-key': `tf-${crypto.randomUUID()}`,
    };
    const testFlightAccepted = await server.inject({ method: 'POST', url: '/v1/testflight/decrypt', headers: testFlightHeaders, payload: testFlightPayload });
    expect(testFlightAccepted.statusCode).toBe(202);
    expect(testFlightAccepted.json()).toMatchObject({ id: queuedJob.id, bundleId: queuedJob.bundleId, status: 'queued' });
    expect(enqueued).toHaveLength(3);
    expect(enqueued[2]).toMatchObject([
      'com.example.allowed',
      'manual',
      {
        testflight: { appId: 123, build: testFlightPayload.build },
        queuedBy: 'root',
        priority: 0,
        apiKeyId: testFlightKey.id,
        projectId: 'default',
      },
    ]);

    const duplicateTestFlight = await server.inject({ method: 'POST', url: '/v1/testflight/decrypt', headers: testFlightHeaders, payload: testFlightPayload });
    expect(duplicateTestFlight.statusCode).toBe(202);
    expect(enqueued).toHaveLength(3);

    const reorderedTestFlight = await server.inject({
      method: 'POST',
      url: '/v1/testflight/decrypt',
      headers: testFlightHeaders,
      payload: {
        build: { bundleId: 'com.example.allowed', cfBundleVersion: '4', cfBundleShortVersion: '2.0', id: 45 },
        appId: '123',
        bundleId: 'com.example.allowed',
      },
    });
    expect(reorderedTestFlight.statusCode).toBe(202);
    expect(reorderedTestFlight.json().id).toBe(queuedJob.id);
    expect(enqueued).toHaveLength(3);

    const conflictingTestFlight = await server.inject({
      method: 'POST',
      url: '/v1/testflight/decrypt',
      headers: testFlightHeaders,
      payload: { ...testFlightPayload, appId: '124' },
    });
    expect(conflictingTestFlight.statusCode).toBe(409);
    expect(conflictingTestFlight.json()).toMatchObject({ code: 'request_error' });

    const legacyIdempotencyKey = `tf-legacy-${crypto.randomUUID()}`;
    const legacyFingerprint = createHash('sha256')
      .update(JSON.stringify({
        route: '/v1/testflight/decrypt',
        body: {
          bundleId: 'com.example.allowed',
          appId: 123,
          build: testFlightPayload.build,
          projectId: 'default',
        },
      }))
      .digest('hex');
    apiIdempotencyRegistry.record(testFlightKey.id, legacyIdempotencyKey, legacyFingerprint, queuedJob.id, 60_000);
    const legacyTestFlightRetry = await server.inject({
      method: 'POST',
      url: '/v1/testflight/decrypt',
      headers: { authorization: `Bearer ${testFlightKey.key}`, 'idempotency-key': legacyIdempotencyKey },
      payload: testFlightPayload,
    });
    expect(legacyTestFlightRetry.statusCode).toBe(202);
    expect(legacyTestFlightRetry.json().id).toBe(queuedJob.id);
    expect(enqueued).toHaveLength(3);

    const testFlightDisabled = await server.inject({
      method: 'POST',
      url: '/v1/testflight/decrypt',
      headers: { authorization: `Bearer ${noTestFlightKey.key}` },
      payload: testFlightPayload,
    });
    expect(testFlightDisabled.statusCode).toBe(403);
    expect(testFlightDisabled.json()).toMatchObject({ code: 'testflight_scope_denied' });

    const testFlightScopeDenied = await server.inject({
      method: 'POST',
      url: '/v1/testflight/decrypt',
      headers: { authorization: `Bearer ${deniedKey.key}` },
      payload: testFlightPayload,
    });
    expect(testFlightScopeDenied.statusCode).toBe(403);
    expect(testFlightScopeDenied.json()).toMatchObject({ code: 'request_error' });

    const legacyGetHeaders = {
      authorization: `Bearer ${allowedKey.key}`,
      'idempotency-key': `legacy-get-${crypto.randomUUID()}`,
    };
    const enqueuedBeforeLegacyGet = enqueued.length;
    const resolvedBeforeLegacyGet = resolved.length;
    const legacyGet = await server.inject({
      method: 'GET',
      url: '/v1/decrypt?bundleId=com.example.allowed&version=v2.0',
      headers: legacyGetHeaders,
    });
    expect(legacyGet.statusCode).toBe(202);
    expect(legacyGet.json()).toMatchObject({ id: queuedJob.id, bundleId: queuedJob.bundleId, status: 'queued' });

    const duplicateLegacyGet = await server.inject({
      method: 'GET',
      url: '/v1/decrypt?bundleId=com.example.allowed&version=2.0',
      headers: legacyGetHeaders,
    });
    expect(duplicateLegacyGet.statusCode).toBe(202);
    expect(enqueued).toHaveLength(enqueuedBeforeLegacyGet + 1);
    expect(resolved).toHaveLength(resolvedBeforeLegacyGet + 1);

    const conflictingLegacyGet = await server.inject({
      method: 'GET',
      url: '/v1/decrypt?bundleId=com.example.allowed&version=2.1',
      headers: legacyGetHeaders,
    });
    expect(conflictingLegacyGet.statusCode).toBe(409);
    expect(enqueued).toHaveLength(enqueuedBeforeLegacyGet + 1);

    const noSelector = await server.inject({
      method: 'GET',
      url: '/v1/decrypt?bundleId=com.example.allowed',
      headers: { authorization: `Bearer ${allowedKey.key}`, 'idempotency-key': `current-${crypto.randomUUID()}` },
    });
    expect(noSelector.statusCode).toBe(202);
    expect(enqueued.at(-1)).toMatchObject(['com.example.allowed', 'manual', { minimumOsVersion: '17.0' }]);

    const previousMaintenance = getEffectiveSettings().maintenanceMode;
    updateSettings({ maintenanceMode: true }, 'test');
    try {
      const maintenance = await server.inject({
        method: 'POST',
        url: '/v1/decrypts',
        headers: { authorization: `Bearer ${allowedKey.key}` },
        payload: { bundleId: 'com.example.allowed' },
      });
      expect(maintenance.statusCode).toBe(503);
      expect(maintenance.json()).toMatchObject({ code: 'maintenance_mode', retryable: true, remediation: { maintenance: true } });
    } finally {
      updateSettings({ maintenanceMode: previousMaintenance }, 'test');
    }
  } finally {
    revokeApiKey(allowedKey.id, 'root', true);
    revokeApiKey(deniedKey.id, 'root', true);
    revokeApiKey(noTestFlightKey.id, 'root', true);
    revokeApiKey(testFlightKey.id, 'root', true);
    await server.close();
  }
});
