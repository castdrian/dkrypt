import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type {
  DashboardJobBulkPreviewRoute,
  DashboardJobAttemptDiffRoute,
  DashboardJobDiffRoute,
  DashboardJobHistoryExportRoute,
} from '#dashboardJobContracts.js';
import { dashboardJobAttemptDiffQuerySchema, dashboardJobAttemptDiffResponseSchema } from '#dashboardJobContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getRouteContract } from '#contracts.js';
import { redactMemberJobHistoryEntry } from '#dashboardJobPresentation.js';
import { getActiveJobs } from '#jobs/store.js';
import type { Job } from '#jobs/types.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import {
  DEFAULT_PROJECT_ID,
  getAllJobHistory,
  getAverageJobDurationMs,
  getJobHistoryEntryById,
  type JobHistoryEntry,
} from '#store/state.js';
import { FixedWindowRateLimiter, fastifyRateLimitPerUser } from '#util/rateLimit.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { csvCell } from '#util/csv.js';
import { canViewJobForUser, canViewOperationalDashboard } from '#dashboardAccess.js';

export interface DashboardJobHistoryServices {
  getActiveJobs: typeof getActiveJobs;
  getAllJobHistory: typeof getAllJobHistory;
  getAverageJobDurationMs: typeof getAverageJobDurationMs;
  getJobHistoryEntryById: typeof getJobHistoryEntryById;
}

const defaultServices: DashboardJobHistoryServices = {
  getActiveJobs,
  getAllJobHistory,
  getAverageJobDurationMs,
  getJobHistoryEntryById,
};

const canRequestDecrypt = fastifyRequirePermission(PermissionFlag.requestDecrypt);
const jobDiffRateLimiter = new FixedWindowRateLimiter(30, 60_000);
const limitJobDiff = fastifyRateLimitPerUser(
  jobDiffRateLimiter,
  (request) => getFastifySession(request)?.sub ?? request.ip,
  { code: 'rate_limited', retryable: true },
);
const historyCsvColumns = [
  'id',
  'bundleId',
  'externalVersionId',
  'versionLabel',
  'queuedBy',
  'status',
  'error',
  'queueReason',
  'sizeBytes',
  'source',
  'deviceId',
  'createdAt',
  'startedAt',
  'finishedAt',
] as const satisfies ReadonlyArray<keyof JobHistoryEntry>;

function hasMatchingActiveJob(activeJobs: Job[], entry: JobHistoryEntry): Job | undefined {
  return activeJobs.find((job) =>
    job.bundleId === entry.bundleId &&
    job.externalVersionId === entry.externalVersionId &&
    job.testflight?.build.id === entry.testflight?.build.id,
  );
}

function summarizeComparedJob(entry: JobHistoryEntry) {
  return {
    id: entry.id,
    versionLabel: entry.versionLabel,
    buildNumber: entry.ipaMetadata?.bundleVersion ?? entry.testflight?.build.cfBundleVersion,
    releaseNotes: entry.testflight?.build.whatsNew,
    channel: entry.testflight ? 'testflight' as const : 'appstore' as const,
    cacheHit: entry.cacheHit,
    sizeBytes: entry.sizeBytes,
    finishedAt: entry.finishedAt,
    metadata: entry.ipaMetadata,
  };
}

function sameBuild(first: JobHistoryEntry, second: JobHistoryEntry): boolean {
  if (first.bundleId !== second.bundleId) return false;
  if (first.testflight || second.testflight) {
    const firstAppId = first.testflight?.appId;
    const secondAppId = second.testflight?.appId;
    const firstBuildId = first.testflight?.build.id;
    const secondBuildId = second.testflight?.build.id;
    return Boolean(firstAppId && secondAppId && firstBuildId && secondBuildId && firstAppId === secondAppId && firstBuildId === secondBuildId);
  }
  if (first.externalVersionId || second.externalVersionId) return Boolean(first.externalVersionId && second.externalVersionId && first.externalVersionId === second.externalVersionId);
  return Boolean(first.versionLabel && second.versionLabel && first.versionLabel === second.versionLabel);
}

function summarizeAttempt(entry: JobHistoryEntry, memberView = false) {
  return {
    id: entry.id,
    status: entry.status,
    attempt: entry.attempt,
    retryCount: entry.retryCount,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    durationMs: entry.startedAt === undefined ? undefined : Math.max(0, entry.finishedAt - entry.startedAt),
    deviceId: memberView ? undefined : entry.deviceId,
    transport: memberView ? undefined : entry.transport,
    cacheHit: entry.cacheHit,
    deadlineExceeded: entry.deadlineExceeded,
    error: entry.error,
    warnings: entry.warnings,
    artifactId: entry.artifactId,
  };
}

export function createDashboardJobHistoryRoutes(overrides: Partial<DashboardJobHistoryServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardJobHistoryExportRoute>('/v1/dashboard/jobs/export', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/export'),
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const operationalView = canViewOperationalDashboard(session.permissions);
      const entries = services.getAllJobHistory()
        .filter((entry) => canViewJobForUser(entry, session.sub, session.permissions))
        .map((entry) => {
          const { projectId: _projectId, ...visible } = operationalView ? entry : redactMemberJobHistoryEntry(entry);
          return visible;
        });
      if (request.query.format !== 'csv') {
        reply.header('Content-Disposition', 'attachment; filename="dkrypt-job-history.json"');
        return entries;
      }
      const rows = [historyCsvColumns.join(',')];
      for (const entry of entries) rows.push(historyCsvColumns.map((column) => csvCell(entry[column])).join(','));
      reply.header('Content-Disposition', 'attachment; filename="dkrypt-job-history.csv"');
      reply.type('text/csv');
      return rows.join('\n');
    });

    server.post<DashboardJobBulkPreviewRoute>('/v1/dashboard/jobs/bulk-preview', {
      schema: getRouteContract('POST', '/v1/dashboard/jobs/bulk-preview'),
      preValidation: (request, _reply, done) => {
        if (request.body === undefined) request.body = {};
        done();
      },
      preHandler: canRequestDecrypt,
    }, (request) => {
      const session = getFastifySession(request)!;
      const rawIds: string[] = Array.isArray(request.body.ids)
        ? request.body.ids.filter((id): id is string => typeof id === 'string')
        : [];
      const ids = [...new Set(rawIds)].slice(0, 100);
      const activeJobs = services.getActiveJobs();
      const entries = ids.flatMap((id) => {
        const entry = services.getJobHistoryEntryById(id);
        if (!entry || !canViewJobForUser(entry, session.sub, session.permissions)) return [];
        const active = hasMatchingActiveJob(activeJobs, entry);
        return [{
          entry,
          item: {
            id: entry.id,
            bundleId: entry.bundleId,
            versionLabel: entry.versionLabel,
            status: entry.status,
            action: active ? 'join-existing' as const : 'queue' as const,
            reason: active ? `Already active as ${active.id.slice(0, 8)}` : undefined,
            estimatedDurationMs: services.getAverageJobDurationMs(entry.bundleId, DEFAULT_PROJECT_ID),
          },
        }];
      });
      const items = entries.map(({ item }) => item);
      return {
        requested: ids.length,
        eligible: items.length,
        projectedQueueAdds: items.filter((item) => item.action === 'queue').length,
        estimatedDurationMs: items.filter((item) => item.action === 'queue').reduce((sum, item) => sum + (item.estimatedDurationMs ?? 0), 0),
        previousSizeBytes: entries.reduce((sum, { entry }) => sum + (entry.sizeBytes ?? 0), 0),
        items,
      };
    });

    server.get<DashboardJobDiffRoute>('/v1/dashboard/jobs/diff', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/diff'),
      preHandler: limitJobDiff,
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const first = services.getJobHistoryEntryById(request.query.a);
      const second = services.getJobHistoryEntryById(request.query.b);
      if (!first || !second || !canViewJobForUser(first, session.sub, session.permissions) || !canViewJobForUser(second, session.sub, session.permissions)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'one or both job history entries not found');
      }
      if (first.bundleId !== request.query.bundleId || second.bundleId !== request.query.bundleId) {
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, 'both entries must belong to bundleId');
      }

      const firstPlist = first.ipaInfoPlist ?? {};
      const secondPlist = second.ipaInfoPlist ?? {};
      const keys = new Set([...Object.keys(firstPlist), ...Object.keys(secondPlist)]);
      const plistDiff = [...keys]
        .filter((key) => JSON.stringify(firstPlist[key]) !== JSON.stringify(secondPlist[key]))
        .map((key) => ({ key, before: firstPlist[key], after: secondPlist[key] }))
        .sort((left, right) => left.key.localeCompare(right.key));

      return {
        a: summarizeComparedJob(first),
        b: summarizeComparedJob(second),
        sizeDeltaBytes: (second.sizeBytes ?? 0) - (first.sizeBytes ?? 0),
        plistDiff,
      };
    });

    server.get<DashboardJobAttemptDiffRoute>('/v1/dashboard/jobs/attempt-diff', {
      schema: { hide: true, querystring: dashboardJobAttemptDiffQuerySchema, response: { 200: dashboardJobAttemptDiffResponseSchema } },
      preHandler: [canRequestDecrypt, limitJobDiff],
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const first = services.getJobHistoryEntryById(request.query.a);
      const second = services.getJobHistoryEntryById(request.query.b);
      if (!first || !second || !canViewJobForUser(first, session.sub, session.permissions) || !canViewJobForUser(second, session.sub, session.permissions)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'one or both job attempts were not found');
      }
      if (!sameBuild(first, second)) {
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, 'job attempts must belong to the same app build');
      }
      const memberView = !canViewOperationalDashboard(session.permissions);
      const a = summarizeAttempt(first, memberView);
      const b = summarizeAttempt(second, memberView);
      const fields = memberView
        ? ['status', 'attempt', 'retryCount', 'durationMs', 'cacheHit', 'deadlineExceeded', 'error', 'warnings'] as const
        : ['status', 'attempt', 'retryCount', 'durationMs', 'deviceId', 'transport', 'cacheHit', 'deadlineExceeded', 'error', 'warnings', 'artifactId'] as const;
      const changedFields = fields.filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]));
      return { a, b, durationDeltaMs: (b.durationMs ?? 0) - (a.durationMs ?? 0), changedFields: [...changedFields] };
    });
  };
}

export const dashboardJobHistoryRoutes = createDashboardJobHistoryRoutes();
