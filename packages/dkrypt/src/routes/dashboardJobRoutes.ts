import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardJobListRoute, DashboardJobStatusRoute, DashboardJobTimelineRoute } from '#dashboardJobContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { canAccessProject, dashboardHistoryEntry } from '#dashboardJobPresentation.js';
import { getRouteContract } from '#contracts.js';
import { jobSummary } from '#jobs/http.js';
import { getJob } from '#jobs/store.js';
import type { Job, JobExecutionStage } from '#jobs/types.js';
import type { DeviceTransport } from '#apiCommonContracts.js';
import { getFailureGuidance } from '#util/failureGuidance.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { DEFAULT_PROJECT_ID, getJobHistoryEntryById, getJobHistoryPage } from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { getOfflineAppStoreReadiness } from '#offlineAppStore.js';

type TimelineSource = {
  id: string;
  correlationId?: string;
  bundleId: string;
  testflight?: Job['testflight'];
  status: Job['status'];
  executionStage?: JobExecutionStage;
  executionPath?: Job['executionPath'];
  offlineAttemptedAt?: number;
  offlineAttemptDurationMs?: number;
  offlineDeviceFallbackStartedAt?: number;
  deviceFallbackDurationMs?: number;
  offlineFailureReason?: string;
  offlineCompatibility?: Job['offlineCompatibility'];
  shutdownRecoveryAt?: number;
  versionLabel?: string;
  deviceId?: string;
  transport?: DeviceTransport;
  fileSizeBytes?: number;
  sizeBytes?: number;
  warnings?: string[];
  artifactId?: string;
  queueReason?: string;
  ipaMetadata?: Job['ipaMetadata'];
  ipaInfoPlist?: Job['ipaInfoPlist'];
  timeline?: Job['timeline'];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  filePath?: string;
};

function dashboardJobTimeline(source: TimelineSource) {
  const events = source.timeline ?? [
    { at: source.createdAt, label: 'Queued', status: 'queued' as const },
    ...(source.startedAt !== undefined ? [{ at: source.startedAt, label: `Started on ${source.deviceId ?? 'unknown device'}`, status: 'running' as const }] : []),
    ...(source.finishedAt !== undefined
      ? [{ at: source.finishedAt, label: source.status === 'done' ? 'Finished' : `Failed: ${source.error ?? 'unknown error'}`, status: source.status === 'done' ? 'done' as const : 'failed' as const }]
      : []),
  ];
  const dependencies = source.testflight
    ? [
      { id: 'testflight', label: 'TestFlight build access', state: source.status === 'failed' ? 'failed' as const : source.deviceId ? 'ready' as const : source.status === 'queued' ? 'waiting' as const : 'active' as const, detail: source.deviceId ? 'Build access was verified through the selected device' : 'TestFlight installation and decryption require an available device' },
      { id: 'device-agent', label: 'Device agent', state: source.deviceId ? source.status === 'running' ? 'active' as const : 'ready' as const : source.status === 'failed' ? 'failed' as const : 'waiting' as const, detail: source.deviceId ? `Assigned device ${source.deviceId}` : source.queueReason ?? 'Waiting for an eligible device' },
      { id: 'artifact-storage', label: 'IPA artifact storage', state: source.status === 'done' ? 'ready' as const : source.status === 'failed' ? 'not_applicable' as const : 'waiting' as const, detail: source.status === 'done' ? 'Decrypted IPA was stored in the library' : source.status === 'failed' ? 'No artifact was produced' : 'Storage is used after decryption completes' },
    ]
    : (() => {
      const readiness = getOfflineAppStoreReadiness();
      const fallbackState = source.executionPath === 'device_fallback'
        ? source.status === 'running' ? 'active' as const : source.status === 'done' ? 'ready' as const : source.status === 'failed' ? 'failed' as const : 'waiting' as const
        : source.status === 'done' && source.executionPath === 'appstore_offline' ? 'not_applicable' as const : source.status === 'failed' ? 'failed' as const : 'waiting' as const;
      return [
        { id: 'app-store-session', label: 'Apple Account session', state: readiness.vault.authenticatedAt ? 'ready' as const : 'blocked' as const, detail: readiness.vault.authenticatedAt ? 'Session is verified for server-side App Store downloads' : 'Server-side App Store downloads need a verified Apple Account session' },
        { id: 'app-store-downloader', label: 'App Store downloader', state: readiness.downloaderAvailable ? source.status === 'running' && source.executionPath === 'appstore_offline' ? 'active' as const : 'ready' as const : 'blocked' as const, detail: readiness.downloaderAvailable ? 'Downloader is available in this deployment' : 'Downloader is unavailable in this deployment' },
        { id: 'fairplay', label: 'FairPlay decryptor and key', state: readiness.decryptorAvailable && readiness.vault.credentialConfigured ? 'ready' as const : 'blocked' as const, detail: readiness.decryptorAvailable && readiness.vault.credentialConfigured ? 'Decryptor and encrypted key vault are ready' : readiness.blockers.filter((blocker) => blocker.includes('FairPlay') || blocker.includes('decryptor') || blocker.includes('vault')).join('; ') || 'FairPlay processing is not ready' },
        { id: 'device-fallback', label: 'Connected device fallback', state: fallbackState, detail: source.offlineFailureReason ? `Server-side attempt failed: ${source.offlineFailureReason}` : source.deviceId ? `Assigned device ${source.deviceId}` : source.status === 'done' && source.executionPath === 'appstore_offline' ? 'Not needed; server-side processing completed' : source.queueReason ?? 'An eligible device will be used if server-side processing cannot finish' },
        { id: 'artifact-storage', label: 'IPA artifact storage', state: source.status === 'done' ? source.artifactId || source.filePath ? 'ready' as const : 'unknown' as const : source.status === 'failed' ? 'not_applicable' as const : 'waiting' as const, detail: source.status === 'done' ? source.artifactId || source.filePath ? 'Artifact is available after verification' : 'Artifact storage result is unavailable' : source.status === 'failed' ? 'No artifact was produced' : 'Storage is used after decryption completes' },
      ];
    })();
  return {
    id: source.id,
    correlationId: source.correlationId ?? source.id,
    bundleId: source.bundleId,
    testflight: source.testflight,
    status: source.status,
    executionStage: source.status === 'running' ? source.executionStage : undefined,
    executionPath: source.executionPath,
    offlineAttemptedAt: source.offlineAttemptedAt,
    offlineAttemptDurationMs: source.offlineAttemptDurationMs,
    offlineDeviceFallbackStartedAt: source.offlineDeviceFallbackStartedAt,
    deviceFallbackDurationMs: source.deviceFallbackDurationMs,
    offlineFailureReason: source.offlineFailureReason,
    offlineCompatibility: source.offlineCompatibility,
    shutdownRecoveryAt: source.shutdownRecoveryAt,
    versionLabel: source.versionLabel,
    deviceId: source.deviceId,
    transport: source.transport,
    sizeBytes: source.fileSizeBytes ?? source.sizeBytes,
    warnings: source.warnings,
    queueReason: source.queueReason,
    ipaMetadata: source.ipaMetadata,
    ipaInfoPlist: source.ipaInfoPlist,
    events,
    dependencies,
    guidance: source.status === 'failed' ? getFailureGuidance(source.error, source.queueReason) : undefined,
  };
}

export const dashboardJobRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardJobListRoute>('/v1/dashboard/jobs', { schema: getRouteContract('GET', '/v1/dashboard/jobs') }, async (request, reply) => {
    const session = getFastifySession(request)!;
    const query = request.query;
    const projectId = DEFAULT_PROJECT_ID;
    if (!canAccessProject(session.sub, session.permissions, projectId)) {
      return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'account data is unavailable'));
    }
    const limit = Math.min(query.limit ?? 15, 100);
    const cursor = query.cursor;
    const offset = cursor ? 0 : query.offset ?? 0;
    const q = query.q?.trim().slice(0, 200) || undefined;
    const queuedBy = query.queuedBy?.trim().slice(0, 120) || undefined;
    const deviceId = query.deviceId?.trim().slice(0, 64) || undefined;
    const errorQ = query.errorQ?.trim().slice(0, 200) || undefined;
    const failureCategory = query.failureCategory?.trim().slice(0, 64) || undefined;
    const { entries, total, nextCursor } = getJobHistoryPage(offset, limit, {
      projectId,
      bundleIdSearch: q,
      source: query.source,
      status: query.status,
      queuedBy,
      deviceId,
      errorSearch: errorQ,
      failureCategory,
      fromTs: query.fromTs,
      toTs: query.toTs,
    }, cursor);
    return { history: entries.map(dashboardHistoryEntry), total, nextCursor };
  });

  server.get<DashboardJobStatusRoute>('/v1/dashboard/jobs/:id/status', { schema: getRouteContract('GET', '/v1/dashboard/jobs/:id/status') }, async (request, reply) => {
    const session = getFastifySession(request)!;
    const job = getJob(request.params.id);
    if (!job || !canAccessProject(session.sub, session.permissions, job.projectId ?? DEFAULT_PROJECT_ID)) {
      return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'job not found (finished jobs are pruned after retention window)'));
    }
    return jobSummary(job);
  });

  server.get<DashboardJobTimelineRoute>('/v1/dashboard/jobs/:id/timeline', { schema: getRouteContract('GET', '/v1/dashboard/jobs/:id/timeline') }, async (request, reply) => {
    const session = getFastifySession(request)!;
    const active = getJob(request.params.id);
    if (active && canAccessProject(session.sub, session.permissions, active.projectId ?? DEFAULT_PROJECT_ID)) {
      return dashboardJobTimeline(active);
    }

    const entry = getJobHistoryEntryById(request.params.id);
    if (!entry || !canAccessProject(session.sub, session.permissions, entry.projectId ?? DEFAULT_PROJECT_ID)) {
      return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'job not found'));
    }
    return dashboardJobTimeline(entry);
  });
};
