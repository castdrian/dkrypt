import { Response } from '#http.js';
import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { config } from '#config.js';
import { fastifyRequireApiKey, fastifyRequireTestFlightScope, getFastifyApiKeyContext } from '#auth.js';
import { fastifyBlockDuringMaintenance, fastifyBlockManualMaintenance } from '#maintenance.js';
import { jobFileAvailable, jobSummary, streamFilePath, streamJobFile } from '#jobs/http.js';
import { enqueueDecryptJob, getJob, waitForJob } from '#jobs/store.js';
import { DailyDecryptLimitError } from '#jobs/repository.js';
import { DEFAULT_PROJECT_ID, recordApiKeyBundleUsage } from '#store/state.js';
import { isBundleIdAllowed } from '#apiKeyAccess.js';
import { listBuilds, listTrains, type TFBuild } from '#testflight.js';
import { apiIdempotencyRegistry } from '#idempotency.js';
import { artifactDownloadName, artifactFileAvailable, getArtifactById, getArtifactByKey, listArtifacts, touchArtifact } from '#artifacts.js';
import { normalizeVersionSelector, resolveDecryptTarget, resolveLatestTestFlightTarget, VERSION_SELECTOR_RE, type ResolvedDecryptTarget } from '#decryptTarget.js';
import { getRouteContract } from '#contracts.js';
import { scopedLogger } from '#logger.js';

interface TestFlightCatalogServices {
  listTrains: typeof listTrains;
  listBuilds: typeof listBuilds;
}

interface ArtifactCatalogServices {
  listArtifacts: typeof listArtifacts;
  getArtifactById: typeof getArtifactById;
  artifactFileAvailable: typeof artifactFileAvailable;
  touchArtifact: typeof touchArtifact;
}

interface DecryptSubmissionServices {
  resolveDecryptTarget: typeof resolveDecryptTarget;
  resolveLatestTestFlightTarget: typeof resolveLatestTestFlightTarget;
  enqueueDecryptJob: typeof enqueueDecryptJob;
  getJob: typeof getJob;
  waitForJob: typeof waitForJob;
  getArtifactById: typeof getArtifactById;
  getArtifactByKey: typeof getArtifactByKey;
  recordApiKeyBundleUsage: typeof recordApiKeyBundleUsage;
}

const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;
const EXTERNAL_VERSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const idempotencyLocks = new Map<string, Promise<void>>();
const log = scopedLogger('decrypt');

class IdempotencyRequestError extends Error {
  constructor(readonly statusCode: 403 | 409 | 410, message: string) {
    super(message);
  }
}

class DecryptTargetRequestError extends Error {}

function artifactSummary(artifact: ReturnType<typeof getArtifactById>) {
  if (!artifact) return undefined;
  return {
    id: artifact.id,
    bundleId: artifact.bundleId,
    channel: artifact.channel,
    externalVersionId: artifact.externalVersionId,
    testflightBuildId: artifact.testflightBuildId,
    versionLabel: artifact.versionLabel,
    buildNumber: artifact.buildNumber,
    sizeBytes: artifact.fileSizeBytes,
    sha256: artifact.sha256,
    createdAt: new Date(artifact.createdAt).toISOString(),
    lastAccessedAt: new Date(artifact.lastAccessedAt).toISOString(),
    accessCount: artifact.accessCount,
    fileUrl: `/v1/artifacts/${artifact.id}/file`,
  };
}

function idempotencyJobId(
  key: string | undefined,
  apiKeyId: string | undefined,
  fingerprint: string,
  legacyFingerprint?: string,
): { jobId?: string; error?: string; key?: string } {
  if (!key) return {};
  if (!IDEMPOTENCY_KEY_RE.test(key)) return { error: 'Idempotency-Key must be 1-200 URL-safe characters' };
  if (!apiKeyId) return { error: 'API key identity is unavailable' };
  const existing = apiIdempotencyRegistry.lookup(apiKeyId, key, fingerprint);
  if (existing.conflict && legacyFingerprint) {
    const legacy = apiIdempotencyRegistry.lookup(apiKeyId, key, legacyFingerprint);
    if (legacy.jobId) return { jobId: legacy.jobId, key };
  }
  if (existing.conflict) return { error: 'Idempotency-Key was already used with a different request' };
  return { jobId: existing.jobId, key };
}

async function withIdempotencyLock<T>(scope: string, key: string, operation: () => Promise<T>): Promise<T> {
  const lockKey = `${scope}:${key}`;
  const previous = idempotencyLocks.get(lockKey) ?? Promise.resolve();
  let releaseLock = () => {};
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  idempotencyLocks.set(lockKey, current);
  await previous;
  try {
    return await operation();
  } finally {
    releaseLock();
    if (idempotencyLocks.get(lockKey) === current) idempotencyLocks.delete(lockKey);
  }
}

async function resolveIdempotentJob<T extends { id: string }>(options: {
  key?: string;
  scope?: string;
  fingerprint: string;
  legacyFingerprint?: string;
  getJob: (id: string) => T | undefined;
  createJob: () => Promise<T>;
}): Promise<T> {
  const { key, scope, fingerprint, legacyFingerprint, getJob, createJob } = options;
  if (!key) return createJob();
  if (!scope) throw new IdempotencyRequestError(409, 'API key identity is unavailable');

  return withIdempotencyLock(scope, key, async () => {
    const idempotency = idempotencyJobId(key, scope, fingerprint, legacyFingerprint);
    if (idempotency.error) throw new IdempotencyRequestError(409, idempotency.error);
    if (idempotency.jobId) {
      const existingJob = getJob(idempotency.jobId);
      if (!existingJob) throw new IdempotencyRequestError(410, 'the result for this Idempotency-Key is no longer retained');
      return existingJob;
    }

    const job = await createJob();
    apiIdempotencyRegistry.record(scope, key, fingerprint, job.id, IDEMPOTENCY_TTL_MS);
    return job;
  });
}

function requestFingerprint(route: string, body: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({ route, body })).digest('hex');
}

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeFingerprintValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nestedValue]) => [key, canonicalizeFingerprintValue(nestedValue)]),
  );
}

function canonicalRequestFingerprint(route: string, body: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeFingerprintValue({ route, body })))
    .digest('hex');
}

function idempotencyKeyFromHeader(header: string | string[] | undefined): string | undefined {
  return typeof header === 'string' ? header : undefined;
}

function normalizeBundleScope(scope: string[] | undefined): string[] | undefined {
  return scope && scope.length > 0 ? scope : undefined;
}

function isTestFlightBuild(value: unknown): value is TFBuild {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const build = value as Record<string, unknown>;
  return typeof build.id === 'number'
    && Number.isSafeInteger(build.id)
    && typeof build.cfBundleShortVersion === 'string'
    && typeof build.cfBundleVersion === 'string'
    && typeof build.bundleId === 'string';
}

function apiErrorEnvelope(message: string, code: string, requestId: string, retryable = false) {
  return { error: message, code, message, requestId, retryable };
}

function testFlightLookupFailure(error: unknown, requestId: string) {
  const message = error instanceof Error ? error.message : String(error);
  return { error: message, code: 'testflight_lookup_failed', message, requestId, retryable: true };
}

function jobEventSnapshot(job: NonNullable<ReturnType<typeof getJob>>) {
  const snapshot = { job: jobSummary(job), events: job.timeline ?? [] };
  const id = createHash('sha256').update(JSON.stringify(snapshot)).digest('base64url');
  return { id, snapshot };
}

function writeJobEvent(response: NodeJS.WritableStream, id: string, snapshot: unknown): void {
  response.write(`id: ${id}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
}

export function createDecryptRoutes(
  overrides: Partial<DecryptSubmissionServices> = {},
): FastifyPluginAsyncTypebox {
  const services: DecryptSubmissionServices = {
    resolveDecryptTarget,
    resolveLatestTestFlightTarget,
    enqueueDecryptJob,
    getJob,
    waitForJob,
    getArtifactById,
    getArtifactByKey,
    recordApiKeyBundleUsage,
    ...overrides,
  };
  return async (server) => {
    server.get(
      '/v1/decrypt',
      {
        schema: getRouteContract('GET', '/v1/decrypt'),
        preHandler: [fastifyRequireApiKey, fastifyBlockManualMaintenance],
      },
      async (request, reply) => {
        const query = request.query as Record<string, unknown>;
        const bundleId = typeof query?.bundleId === 'string' ? query.bundleId : '';
        const externalVersionId = query?.externalVersionId;
        const versionId = typeof externalVersionId === 'string' && EXTERNAL_VERSION_ID_RE.test(externalVersionId) ? externalVersionId : undefined;
        const selector = typeof query?.version === 'string' ? query.version.trim() : undefined;
        const apiKey = getFastifyApiKeyContext(request);

        if (!BUNDLE_ID_RE.test(bundleId)) {
          reply.code(400);
          return apiErrorEnvelope('query param bundleId is required and must look like a bundle identifier', 'request_error', request.id);
        }
        if (!apiKey) {
          reply.code(401);
          return apiErrorEnvelope('unauthorized', 'unauthorized', request.id);
        }
        const projectId = DEFAULT_PROJECT_ID;
        if (!isBundleIdAllowed(apiKey.allowedBundleIds, bundleId)) {
          reply.code(403);
          return apiErrorEnvelope('this API key is not scoped to this bundleId', 'request_error', request.id);
        }
        if (selector && !VERSION_SELECTOR_RE.test(selector)) {
          reply.code(400);
          return apiErrorEnvelope('version must match a release tag such as 240, 234.2, or 240_109440', 'request_error', request.id);
        }

        const fingerprint = requestFingerprint('/v1/decrypt', { bundleId, externalVersionId: versionId ?? null, version: normalizeVersionSelector(selector) ?? null, projectId });
        try {
          const job = await resolveIdempotentJob({
            key: idempotencyKeyFromHeader(request.headers['idempotency-key']),
            scope: apiKey.keyId,
            fingerprint,
            getJob: services.getJob,
            createJob: async () => {
              if (apiKey.keyId) services.recordApiKeyBundleUsage(apiKey.keyId, bundleId);
              if (!selector) {
                let minimumOsVersion: string | undefined;
                if (!versionId) {
                  try {
                    minimumOsVersion = (await services.resolveDecryptTarget(bundleId)).minimumOsVersion;
                  } catch (error) {
                    log.warn('App Store minimum iOS lookup failed before API decrypt dispatch', { bundleId, error: String(error) });
                  }
                }
                return services.enqueueDecryptJob(
                  bundleId,
                  'manual',
                  {
                    externalVersionId: versionId,
                    queuedBy: apiKey.ownerId,
                    priority: apiKey.priority ?? 0,
                    apiKeyId: apiKey.keyId,
                    projectId,
                    minimumOsVersion,
                  },
                );
              }

              let target;
              try {
                target = await services.resolveDecryptTarget(bundleId, selector);
              } catch (error) {
                throw new DecryptTargetRequestError(error instanceof Error ? error.message : String(error));
              }
              if (target.channel === 'testflight' && apiKey.allowTestFlight === false) {
                throw new IdempotencyRequestError(403, 'this API key is not scoped for TestFlight');
              }
              return services.enqueueDecryptJob(
                bundleId,
                'manual',
                {
                  externalVersionId: target.externalVersionId,
                  testflight: target.testflight,
                  versionLabel: target.versionLabel,
                  queuedBy: apiKey.ownerId,
                  priority: apiKey.priority ?? 0,
                  apiKeyId: apiKey.keyId,
                  projectId,
                  minimumOsVersion: target.minimumOsVersion,
                },
              );
            },
          });

          if (job.testflight && apiKey.allowTestFlight === false) {
            reply.code(403);
            return apiErrorEnvelope('this API key is not scoped for TestFlight', 'request_error', request.id);
          }
          if (job.status === 'done' && !jobFileAvailable(job)) {
            reply.code(410);
            return apiErrorEnvelope('the result for this Idempotency-Key is no longer retained', 'request_error', request.id);
          }

          const finished = await services.waitForJob(job, config.jobMaxWaitSeconds * 1000);
          if (finished.status === 'queued' || finished.status === 'running') return reply.code(202).send(jobSummary(finished));
          if (finished.status === 'failed') return reply.code(500).send(jobSummary(finished));

          await streamJobFile(finished, request.raw, new Response(reply));
          return;
        } catch (error) {
          if (error instanceof IdempotencyRequestError) {
            reply.code(error.statusCode);
            return apiErrorEnvelope(error.message, 'request_error', request.id);
          }
          if (error instanceof DecryptTargetRequestError) {
            reply.code(404);
            return apiErrorEnvelope(error.message, 'request_error', request.id);
          }
          throw error;
        }
      },
    );

    server.get(
      '/v1/jobs/:id/events',
      { schema: getRouteContract('GET', '/v1/jobs/:id/events'), preHandler: fastifyRequireApiKey },
      async (request, reply) => {
        const apiKey = getFastifyApiKeyContext(request);
        const { id } = request.params as { id: string };
        const query = request.query as { timeoutSeconds?: number };
        const job = services.getJob(id);
        if (!job || !isBundleIdAllowed(apiKey?.allowedBundleIds, job.bundleId)) {
          reply.code(404);
          return apiErrorEnvelope('job not found (finished jobs are pruned after retention window)', 'request_error', request.id);
        }

        const timeoutMs = Math.max(1, Math.min(25, query.timeoutSeconds ?? 25)) * 1000;
        const deadline = Date.now() + timeoutMs;
        const lastEventId = request.headers['last-event-id'];
        let latest = jobEventSnapshot(job);
        let sentId = typeof lastEventId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(lastEventId) ? lastEventId : undefined;

        reply.header('Content-Type', 'text/event-stream; charset=utf-8');
        reply.header('Cache-Control', 'no-cache, no-transform');
        reply.header('Connection', 'keep-alive');
        reply.header('X-Accel-Buffering', 'no');
        reply.hijack();
        reply.raw.writeHead(200, reply.getHeaders() as unknown as import('node:http').OutgoingHttpHeaders);
        reply.raw.write('retry: 2000\n\n');

        while (!reply.raw.destroyed && !reply.raw.writableEnded) {
          if (latest.id !== sentId) {
            writeJobEvent(reply.raw, latest.id, latest.snapshot);
            sentId = latest.id;
          }
          if (latest.snapshot.job.status === 'done' || latest.snapshot.job.status === 'failed' || Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 750));
          const refreshed = services.getJob(id);
          if (!refreshed) break;
          latest = jobEventSnapshot(refreshed);
        }

        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
        return reply;
      },
    );

    server.get(
      '/v1/jobs/:id/wait',
      { schema: getRouteContract('GET', '/v1/jobs/:id/wait'), preHandler: fastifyRequireApiKey },
      async (request, reply) => {
        const apiKey = getFastifyApiKeyContext(request);
        const { id } = request.params as { id: string };
        const query = request.query as { timeoutSeconds?: number };
        const job = services.getJob(id);
        if (!job || !isBundleIdAllowed(apiKey?.allowedBundleIds, job.bundleId)) {
          reply.code(404);
          return apiErrorEnvelope('job not found (finished jobs are pruned after retention window)', 'request_error', request.id);
        }
        const finished = await services.waitForJob(job, Math.max(1, Math.min(25, query.timeoutSeconds ?? 20)) * 1000);
        if (finished.status === 'queued' || finished.status === 'running') return reply.code(202).send(jobSummary(finished));
        return jobSummary(finished);
      },
    );

    server.post(
      '/v1/jobs/status',
      { schema: getRouteContract('POST', '/v1/jobs/status'), preHandler: fastifyRequireApiKey },
      async (request) => {
        const apiKey = getFastifyApiKeyContext(request);
        const { ids } = request.body as { ids: string[] };
        return {
          jobs: ids.map((id) => {
            const job = services.getJob(id);
            if (!job || !isBundleIdAllowed(apiKey?.allowedBundleIds, job.bundleId)) {
              return { id, state: 'not_found' as const };
            }
            return { id, state: 'found' as const, job: jobSummary(job) };
          }),
        };
      },
    );

    server.get(
      '/v1/jobs/:id',
      { schema: getRouteContract('GET', '/v1/jobs/:id'), preHandler: fastifyRequireApiKey },
      async (request, reply) => {
        const apiKey = getFastifyApiKeyContext(request);
        const params = request.params as { id: string };
        const job = services.getJob(params.id);
        if (!job) {
          reply.code(404);
          return apiErrorEnvelope('job not found (finished jobs are pruned after retention window)', 'request_error', request.id);
        }
        if (!isBundleIdAllowed(apiKey?.allowedBundleIds, job.bundleId)) {
          reply.code(403);
          return apiErrorEnvelope('this API key is not scoped to this bundleId', 'request_error', request.id);
        }
        return jobSummary(job);
      },
    );

    server.post(
      '/v1/decrypts',
      {
        schema: getRouteContract('POST', '/v1/decrypts'),
        preHandler: [fastifyRequireApiKey, fastifyBlockManualMaintenance],
      },
      async (request, reply) => {
        const body = request.body as Record<string, unknown>;
        const bundleId = typeof body?.bundleId === 'string' ? body.bundleId.trim() : '';
        const selector = typeof body?.version === 'string' ? body.version.trim() : undefined;
        const requestedChannel = body?.channel;
        const resolveOnly = body?.resolveOnly === true;
        const apiKey = getFastifyApiKeyContext(request);

        if (!BUNDLE_ID_RE.test(bundleId)) {
          reply.code(400);
          return apiErrorEnvelope('bundleId is required and must look like a bundle identifier', 'request_error', request.id);
        }
        if (selector && !VERSION_SELECTOR_RE.test(selector)) {
          reply.code(400);
          return apiErrorEnvelope('version must match a release tag such as 240, 234.2, or 240_109440', 'request_error', request.id);
        }
        if (!apiKey) {
          reply.code(401);
          return apiErrorEnvelope('unauthorized', 'unauthorized', request.id);
        }
        if (requestedChannel !== undefined && requestedChannel !== 'appstore' && requestedChannel !== 'testflight') {
          reply.code(400);
          return apiErrorEnvelope('channel must be appstore or testflight', 'request_error', request.id);
        }
        if (requestedChannel === 'testflight' && apiKey.allowTestFlight === false) {
          reply.code(403);
          return apiErrorEnvelope('this API key is not scoped for TestFlight', 'request_error', request.id);
        }
        if (requestedChannel === 'testflight' && selector && !selector.includes('_')) {
          reply.code(400);
          return apiErrorEnvelope('TestFlight versions must include a build number such as 352.0_118977', 'request_error', request.id);
        }
        if (requestedChannel === 'appstore' && selector?.includes('_')) {
          reply.code(400);
          return apiErrorEnvelope('App Store versions cannot include a TestFlight build number', 'request_error', request.id);
        }
        const projectId = DEFAULT_PROJECT_ID;
        if (!isBundleIdAllowed(apiKey.allowedBundleIds, bundleId)) {
          reply.code(403);
          return apiErrorEnvelope('this API key is not scoped to this bundleId', 'request_error', request.id);
        }

        try {
          if (resolveOnly) {
            let target: ResolvedDecryptTarget;
            try {
              target = requestedChannel === 'testflight' && !selector
                ? await services.resolveLatestTestFlightTarget(bundleId)
                : await services.resolveDecryptTarget(bundleId, selector);
            } catch (error) {
              throw new DecryptTargetRequestError(error instanceof Error ? error.message : String(error));
            }
            if (requestedChannel && target.channel !== requestedChannel) {
              throw new DecryptTargetRequestError(`no ${requestedChannel} release matched the request`);
            }
            if (target.channel === 'testflight' && apiKey.allowTestFlight === false) {
              throw new IdempotencyRequestError(403, 'this API key is not scoped for TestFlight');
            }
            const cachedArtifact = services.getArtifactByKey(target.artifactKey);
            return reply.code(200).send({
              resolveOnly: true,
              bundleId,
              selector: target.selector,
              channel: target.channel,
              resolvedVersion: target.versionLabel,
              isTestFlight: target.channel === 'testflight',
              build: target.testflight?.build.cfBundleVersion,
              cacheHit: Boolean(cachedArtifact),
              artifact: cachedArtifact ? artifactSummary(cachedArtifact) : undefined,
            });
          }

          const fingerprint = requestFingerprint('/v1/decrypts', {
            bundleId,
            version: normalizeVersionSelector(selector) ?? null,
            ...(requestedChannel === 'testflight' ? { channel: requestedChannel } : {}),
            projectId,
          });
          const key = idempotencyKeyFromHeader(request.headers['idempotency-key']);
          const job = await resolveIdempotentJob({
            key,
            scope: apiKey.keyId,
            fingerprint,
            getJob: services.getJob,
            createJob: async () => {
              let target: ResolvedDecryptTarget;
              try {
                target = requestedChannel === 'testflight' && !selector
                  ? await services.resolveLatestTestFlightTarget(bundleId)
                  : await services.resolveDecryptTarget(bundleId, selector);
              } catch (error) {
                throw new DecryptTargetRequestError(error instanceof Error ? error.message : String(error));
              }
              if (requestedChannel && target.channel !== requestedChannel) {
                throw new DecryptTargetRequestError(`no ${requestedChannel} release matched the request`);
              }
              if (target.channel === 'testflight' && apiKey.allowTestFlight === false) {
                throw new IdempotencyRequestError(403, 'this API key is not scoped for TestFlight');
              }
              if (apiKey.keyId) services.recordApiKeyBundleUsage(apiKey.keyId, bundleId);
              return services.enqueueDecryptJob(
                bundleId,
                'manual',
                {
                  externalVersionId: target.externalVersionId,
                  testflight: target.testflight,
                  versionLabel: target.versionLabel,
                  queuedBy: apiKey.ownerId,
                  priority: apiKey.priority ?? 0,
                  apiKeyId: apiKey.keyId,
                  projectId,
                  minimumOsVersion: target.minimumOsVersion,
                },
              );
            },
          });
          if (job.testflight && apiKey.allowTestFlight === false) {
            reply.code(403);
            return apiErrorEnvelope('this API key is not scoped for TestFlight', 'request_error', request.id);
          }
          const payload = {
            ...jobSummary(job),
            selector: normalizeVersionSelector(selector),
            channel: job.testflight ? 'testflight' : 'appstore',
            resolvedVersion: job.versionLabel,
            cacheHit: job.cacheHit === true,
            artifact: job.artifactId ? artifactSummary(services.getArtifactById(job.artifactId)) : undefined,
          };
          return reply.code(job.status === 'done' ? 200 : 202).send(payload);
        } catch (error) {
          if (error instanceof IdempotencyRequestError) {
            reply.code(error.statusCode);
            return apiErrorEnvelope(error.message, 'request_error', request.id);
          }
          if (error instanceof DailyDecryptLimitError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          const status = message.includes('version') || message.includes('build') || message.includes('train') ? 404 : 502;
          reply.code(status);
          return apiErrorEnvelope(message, status >= 500 ? 'internal_error' : 'request_error', request.id, status >= 500);
        }
      },
    );

    server.post(
      '/v1/testflight/decrypt',
      {
        schema: getRouteContract('POST', '/v1/testflight/decrypt'),
        preHandler: [fastifyRequireApiKey, fastifyRequireTestFlightScope, fastifyBlockDuringMaintenance],
      },
      async (request, reply) => {
        const body = request.body as Record<string, unknown>;
        const bundleId = typeof body?.bundleId === 'string' ? body.bundleId.trim() : '';
        const rawAppId = body?.appId;
        const appId = Number(typeof rawAppId === 'string' || typeof rawAppId === 'number' ? String(rawAppId) : '');
        const build = body?.build;
        const apiKey = getFastifyApiKeyContext(request);

        if (!BUNDLE_ID_RE.test(bundleId) || !Number.isSafeInteger(appId) || appId <= 0 || !isTestFlightBuild(build)) {
          reply.code(400);
          return apiErrorEnvelope('bundleId, appId, and build are required', 'request_error', request.id);
        }
        if (!isBundleIdAllowed(apiKey?.allowedBundleIds, bundleId)) {
          reply.code(403);
          return apiErrorEnvelope('this API key is not scoped to this bundleId', 'request_error', request.id);
        }
        if (build.bundleId !== bundleId) {
          reply.code(400);
          return apiErrorEnvelope('build.bundleId does not match bundleId', 'request_error', request.id);
        }
        if (!apiKey) {
          reply.code(401);
          return apiErrorEnvelope('unauthorized', 'unauthorized', request.id);
        }
        const projectId = DEFAULT_PROJECT_ID;

        const fingerprintInput = { bundleId, appId, build, projectId };
        const fingerprint = canonicalRequestFingerprint('/v1/testflight/decrypt', fingerprintInput);
        const legacyFingerprint = requestFingerprint('/v1/testflight/decrypt', fingerprintInput);
        try {
          const job = await resolveIdempotentJob({
            key: idempotencyKeyFromHeader(request.headers['idempotency-key']),
            scope: apiKey.keyId,
            fingerprint,
            legacyFingerprint,
            getJob: services.getJob,
            createJob: async () => {
              if (apiKey.keyId) services.recordApiKeyBundleUsage(apiKey.keyId, bundleId);
              return services.enqueueDecryptJob(
                bundleId,
                'manual',
                {
                  testflight: { appId, build },
                  queuedBy: apiKey.ownerId,
                  priority: apiKey.priority ?? 0,
                  apiKeyId: apiKey.keyId,
                  projectId,
                },
              );
            },
          });
          return reply.code(202).send(jobSummary(job));
        } catch (error) {
          if (error instanceof IdempotencyRequestError) {
            reply.code(error.statusCode);
            return apiErrorEnvelope(error.message, 'request_error', request.id);
          }
          throw error;
        }
      },
    );
  };
}

export const decryptRoutes = createDecryptRoutes();

export function createArtifactCatalogRoutes(
  services: ArtifactCatalogServices = { listArtifacts, getArtifactById, artifactFileAvailable, touchArtifact },
): FastifyPluginAsyncTypebox {
  return async (server) => {
    server.get(
      '/v1/artifacts',
      { schema: getRouteContract('GET', '/v1/artifacts'), preHandler: fastifyRequireApiKey },
      async (request) => {
        const query = request.query as {
          cursor?: string;
          offset?: string | number;
          limit?: string | number;
          q?: string;
          channel?: 'appstore' | 'testflight';
        };
        const apiKey = getFastifyApiKeyContext(request);
        const projectId = DEFAULT_PROJECT_ID;
        const offset = query.cursor ? 0 : Number.parseInt(String(query.offset ?? '0'), 10);
        const limit = Number.parseInt(String(query.limit ?? '50'), 10);
        const result = services.listArtifacts({
          offset: Number.isFinite(offset) ? offset : 0,
          limit: Number.isFinite(limit) ? limit : 50,
          cursor: query.cursor,
          query: query.q,
          channel: query.channel,
          bundleIds: normalizeBundleScope(apiKey?.allowedBundleIds),
          projectIds: [projectId],
        });
        return {
          ...result,
          artifacts: result.artifacts.map((artifact) => artifactSummary(artifact)),
        };
      },
    );

    server.get(
      '/v1/artifacts/:id',
      { schema: getRouteContract('GET', '/v1/artifacts/:id'), preHandler: fastifyRequireApiKey },
      async (request, reply) => {
        const params = request.params as { id: string };
        const apiKey = getFastifyApiKeyContext(request);
        const artifact = services.getArtifactById(params.id);
        if (!artifact || !services.artifactFileAvailable(artifact)) {
          reply.code(404);
          return apiErrorEnvelope('artifact not found', 'request_error', request.id);
        }
        if (!isBundleIdAllowed(apiKey?.allowedBundleIds, artifact.bundleId)) {
          reply.code(403);
          return apiErrorEnvelope('this API key is not scoped to this bundleId', 'bundle_scope_denied', request.id);
        }
        return artifactSummary(artifact);
      },
    );

    server.get(
      '/v1/artifacts/:id/file',
      { schema: getRouteContract('GET', '/v1/artifacts/:id/file'), preHandler: fastifyRequireApiKey },
      async (request, reply) => {
        const params = request.params as { id: string };
        const apiKey = getFastifyApiKeyContext(request);
        const artifact = services.getArtifactById(params.id);
        if (!artifact || !services.artifactFileAvailable(artifact)) {
          reply.code(404);
          return apiErrorEnvelope('artifact not found', 'request_error', request.id);
        }
        if (!isBundleIdAllowed(apiKey?.allowedBundleIds, artifact.bundleId)) {
          reply.code(403);
          return apiErrorEnvelope('this API key is not scoped to this bundleId', 'bundle_scope_denied', request.id);
        }
        await services.touchArtifact(artifact);
        await streamFilePath(artifact.filePath, request.raw, new Response(reply), artifactDownloadName(artifact), artifact.fileSizeBytes, artifact.id, artifact.sha256);
        return;
      },
    );
  };
}

export const artifactCatalogRoutes = createArtifactCatalogRoutes();

export function createTestFlightCatalogRoutes(
  services: TestFlightCatalogServices = { listTrains, listBuilds },
): FastifyPluginAsyncTypebox {
  return async (server) => {
    server.get(
      '/v1/testflight/:appId/trains',
      {
        schema: getRouteContract('GET', '/v1/testflight/:appId/trains'),
        preHandler: [fastifyRequireApiKey, fastifyRequireTestFlightScope],
      },
      async (request, reply) => {
        try {
          const params = request.params as { appId: string };
          return { trains: await services.listTrains(Number.parseInt(params.appId, 10)) };
        } catch (error) {
          reply.code(502);
          return testFlightLookupFailure(error, request.id);
        }
      },
    );

    server.get(
      '/v1/testflight/:appId/builds',
      {
        schema: getRouteContract('GET', '/v1/testflight/:appId/builds'),
        preHandler: [fastifyRequireApiKey, fastifyRequireTestFlightScope],
      },
      async (request, reply) => {
        try {
          const params = request.params as { appId: string };
          const query = request.query as { trainVersion: string };
          return { builds: await services.listBuilds(Number.parseInt(params.appId, 10), query.trainVersion) };
        } catch (error) {
          reply.code(502);
          return testFlightLookupFailure(error, request.id);
        }
      },
    );
  };
}

export const testFlightCatalogRoutes = createTestFlightCatalogRoutes();
