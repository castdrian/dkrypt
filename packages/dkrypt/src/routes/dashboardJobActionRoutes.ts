import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type {
  DashboardJobCancelRoute,
  DashboardJobDiagnosticRoute,
  DashboardJobPrioritizeRoute,
  DashboardJobReorderRoute,
  DashboardJobResolutionNoticeRoute,
  DashboardJobRetryRoute,
  DashboardManualDecryptRoute,
} from '#dashboardJobContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getRouteContract } from '#contracts.js';
import { getBillingEntitlements } from '#billing.js';
import { requestAbuseContext } from '#abuseProtection.js';
import { fastifyBlockDuringMaintenance, fastifyBlockManualMaintenance } from '#maintenance.js';
import { jobSummary } from '#jobs/http.js';
import {
  cancelJob,
  enqueueDecryptJob,
  getJob,
  pauseQueuedJob,
  prioritizeQueuedJob,
  reorderQueue,
  resumePausedJob,
} from '#jobs/store.js';
import type { Job } from '#jobs/types.js';
import { PermissionFlag } from '#permissions.js';
import { getAuthProfile } from '#identity.js';
import { canSendDirectMailToUser, sendDirectMailToUser } from '#mail.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { scopedLogger } from '#logger.js';
import { resolveDecryptTarget } from '#decryptTarget.js';
import type { AppStorePlatform } from '#platform.js';
import {
  DEFAULT_PROJECT_ID,
  getJobHistoryEntryById,
  getPrimaryDevice,
  getUserPriority,
  jobResolutionMessage,
  recordJobResolutionNotice,
  setJobResolutionEmailStatus,
  type JobHistoryEntry,
} from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { canViewJobForUser, canViewOperationalDashboard } from '#dashboardAccess.js';

export interface DashboardJobActionServices {
  getJob: typeof getJob;
  cancelJob: typeof cancelJob;
  prioritizeQueuedJob: typeof prioritizeQueuedJob;
  reorderQueue: typeof reorderQueue;
  getJobHistoryEntryById: typeof getJobHistoryEntryById;
  enqueueDecryptJob: typeof enqueueDecryptJob;
  getPrimaryDevice: typeof getPrimaryDevice;
  getUserPriority: typeof getUserPriority;
  resolveDecryptTarget: typeof resolveDecryptTarget;
  getAuthProfile: typeof getAuthProfile;
  canSendDirectMailToUser: typeof canSendDirectMailToUser;
  sendDirectMailToUser: typeof sendDirectMailToUser;
  recordJobResolutionNotice: typeof recordJobResolutionNotice;
  setJobResolutionEmailStatus: typeof setJobResolutionEmailStatus;
}

const defaultServices: DashboardJobActionServices = {
  getJob,
  cancelJob,
  prioritizeQueuedJob,
  reorderQueue,
  getJobHistoryEntryById,
  enqueueDecryptJob,
  getPrimaryDevice,
  getUserPriority,
  resolveDecryptTarget,
  getAuthProfile,
  canSendDirectMailToUser,
  sendDirectMailToUser,
  recordJobResolutionNotice,
  setJobResolutionEmailStatus,
};

const canRequestDecrypt = fastifyRequirePermission(PermissionFlag.requestDecrypt);
const canNotifyFailedJobOwners = fastifyRequirePermission(PermissionFlag.notifyFailedJobOwners);
const externalVersionIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const log = scopedLogger('jobs');

function sendJobError(requestId: string, statusCode: number, message: string) {
  return createHttpErrorEnvelope(requestId, statusCode, message);
}

async function resolveMinimumOsVersion(
  services: DashboardJobActionServices,
  input: {
    bundleId: string;
    externalVersionId?: string;
    versionLabel?: string;
    currentMinimumOsVersion?: string;
    testflight?: boolean;
    platform?: AppStorePlatform;
    action: 'dispatch' | 'retry';
  },
): Promise<string | undefined> {
  if (input.platform && input.platform !== 'ios') return input.currentMinimumOsVersion;
  if (input.currentMinimumOsVersion || input.testflight || (input.externalVersionId && !input.versionLabel)) {
    return input.currentMinimumOsVersion;
  }
  try {
    return (await services.resolveDecryptTarget(input.bundleId, input.versionLabel, input.platform)).minimumOsVersion;
  } catch (error) {
    log.warn(`App Store minimum iOS lookup failed before ${input.action}`, {
      bundleId: input.bundleId,
      versionLabel: input.versionLabel,
      error: String(error),
    });
    return undefined;
  }
}

export function createDashboardJobActionRoutes(overrides: Partial<DashboardJobActionServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.post<DashboardManualDecryptRoute>('/v1/dashboard/decrypt', {
      schema: getRouteContract('POST', '/v1/dashboard/decrypt'),
      preHandler: [canRequestDecrypt, fastifyBlockManualMaintenance],
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = DEFAULT_PROJECT_ID;
      const bundleId = request.body.bundleId.trim();
      const platform: AppStorePlatform = request.body.platform ?? 'ios';
      let externalVersionId = request.body.externalVersionId && externalVersionIdPattern.test(request.body.externalVersionId)
        ? request.body.externalVersionId
        : undefined;
      let versionLabel = request.body.versionLabel?.trim().slice(0, 64) || undefined;
      let minimumOsVersion: string | undefined;
      if (platform !== 'ios') {
        try {
          const target = await services.resolveDecryptTarget(bundleId, versionLabel, platform);
          if (externalVersionId && externalVersionId !== target.externalVersionId) {
            reply.code(409);
            return createHttpErrorEnvelope(request.id, 409, 'the selected platform release changed; check the release again before queueing');
          }
          externalVersionId = target.externalVersionId;
          versionLabel = target.versionLabel;
          minimumOsVersion = target.minimumOsVersion;
        } catch (error) {
          reply.code(404);
          return createHttpErrorEnvelope(request.id, 404, error instanceof Error ? error.message : 'no matching platform release was found');
        }
      } else {
        minimumOsVersion = await resolveMinimumOsVersion(services, {
          bundleId,
          externalVersionId,
          versionLabel,
          currentMinimumOsVersion: request.body.minimumOsVersion,
          action: 'dispatch',
        });
      }
      const preferredDeviceId = platform === 'ios' && request.body.preferPrimary ? services.getPrimaryDevice()?.id : undefined;
      const abuse = requestAbuseContext(request.ip, request.headers.cookie, getBillingEntitlements(session.sub).freeTier);
      const job = services.enqueueDecryptJob(
        bundleId,
        'manual',
        {
          externalVersionId,
          platform,
          versionLabel,
          queuedBy: session.sub,
          priority: services.getUserPriority(session.sub),
          preferredDeviceId,
          projectId,
          minimumOsVersion,
          abuseNetworkHash: abuse.networkHash,
          abuseAddressHash: abuse.addressHash,
          abuseBrowserHash: abuse.browserHash,
          abuseTurnstileHash: abuse.turnstileHash,
          abuseNetworkDecryptLimit: abuse.networkDecryptLimit,
          abuseAddressDecryptLimit: abuse.addressDecryptLimit,
        },
      );
      reply.code(202);
      return jobSummary(job);
    });

    server.post<DashboardJobCancelRoute>('/v1/dashboard/jobs/:id/cancel', {
      schema: getRouteContract('POST', '/v1/dashboard/jobs/:id/cancel'),
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const job = services.getJob(request.params.id);
      if (!job) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job not found');
      }
      if (!canViewJobForUser(job, session.sub, session.permissions)) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job not found');
      }
      if (!services.cancelJob(request.params.id, session.sub)) {
        reply.code(409);
        return sendJobError(request.id, 409, 'job is not queued or running (already finished, or not found)');
      }
      return { ok: true };
    });

    server.post<DashboardJobCancelRoute>('/v1/dashboard/jobs/:id/pause', {
      schema: getRouteContract('POST', '/v1/dashboard/jobs/:id/pause'),
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const job = services.getJob(request.params.id);
      if (!job) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job not found');
      }
      if (!canViewJobForUser(job, session.sub, session.permissions)) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job not found');
      }
      if (!pauseQueuedJob(job.id, session.sub)) {
        reply.code(409);
        return sendJobError(request.id, 409, 'only an unpaused queued job can be paused');
      }
      return { ok: true };
    });

    server.post<DashboardJobCancelRoute>('/v1/dashboard/jobs/:id/resume', {
      schema: getRouteContract('POST', '/v1/dashboard/jobs/:id/resume'),
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const job = services.getJob(request.params.id);
      if (!job) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job not found');
      }
      if (!canViewJobForUser(job, session.sub, session.permissions)) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job not found');
      }
      if (!resumePausedJob(job.id, session.sub)) {
        reply.code(409);
        return sendJobError(request.id, 409, 'only a paused queued job can be resumed');
      }
      return { ok: true };
    });

    server.post<DashboardJobPrioritizeRoute>('/v1/dashboard/jobs/:id/prioritize', {
      schema: getRouteContract('POST', '/v1/dashboard/jobs/:id/prioritize'),
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const job = services.getJob(request.params.id);
      if (!job) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job not found');
      }
      if (!canViewJobForUser(job, session.sub, session.permissions)) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job not found');
      }
      if (!services.prioritizeQueuedJob(request.params.id, job.projectId ?? DEFAULT_PROJECT_ID)) {
        reply.code(409);
        return sendJobError(request.id, 409, 'job is not queued (already running, finished, or not found)');
      }
      return { ok: true };
    });

    server.post<DashboardJobReorderRoute>('/v1/dashboard/jobs/reorder', {
      schema: getRouteContract('POST', '/v1/dashboard/jobs/reorder'),
      preHandler: canRequestDecrypt,
    }, (request) => {
      const session = getFastifySession(request)!;
      const projectId = DEFAULT_PROJECT_ID;
      const scopedJobs = request.body.ids.every((id) => {
        const job = services.getJob(id);
        return job && (job.projectId ?? DEFAULT_PROJECT_ID) === projectId && canViewJobForUser(job, session.sub, session.permissions);
      });
      return { ok: scopedJobs && services.reorderQueue(request.body.ids, projectId) };
    });

    server.post<DashboardJobRetryRoute>('/v1/dashboard/jobs/:id/retry', {
      schema: getRouteContract('POST', '/v1/dashboard/jobs/:id/retry'),
      preValidation: (request, _reply, done) => {
        if (request.body === undefined) request.body = {};
        done();
      },
      preHandler: [canRequestDecrypt, fastifyBlockDuringMaintenance],
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const entry = services.getJobHistoryEntryById(request.params.id);
      if (!entry) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job history entry not found');
      }
      if (!canViewJobForUser(entry, session.sub, session.permissions)) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job history entry not found');
      }
      const projectId = DEFAULT_PROJECT_ID;
      const platform = entry.platform ?? 'ios';
      const preferredDeviceId = platform === 'ios' && request.body.preferPrimary ? services.getPrimaryDevice()?.id : undefined;
      const minimumOsVersion = await resolveMinimumOsVersion(services, {
        bundleId: entry.bundleId,
        externalVersionId: entry.externalVersionId,
        versionLabel: entry.versionLabel,
        currentMinimumOsVersion: entry.minimumOsVersion,
        testflight: entry.testflight !== undefined,
        platform,
        action: 'retry',
      });
      const abuse = requestAbuseContext(request.ip, request.headers.cookie, getBillingEntitlements(session.sub).freeTier);
      const job = services.enqueueDecryptJob(
        entry.bundleId,
        'manual',
        {
          externalVersionId: entry.externalVersionId,
          platform,
          testflight: entry.testflight,
          versionLabel: entry.versionLabel,
          queuedBy: session.sub,
          priority: services.getUserPriority(session.sub),
          preferredDeviceId,
          projectId,
          minimumOsVersion,
          abuseNetworkHash: abuse.networkHash,
          abuseAddressHash: abuse.addressHash,
          abuseBrowserHash: abuse.browserHash,
          abuseTurnstileHash: abuse.turnstileHash,
          abuseNetworkDecryptLimit: abuse.networkDecryptLimit,
          abuseAddressDecryptLimit: abuse.addressDecryptLimit,
        },
      );
      reply.code(202);
      return jobSummary(job);
    });

    const resolutionNoticePreview = (id: string) => {
      const entry = services.getJobHistoryEntryById(id);
      if (!entry) return undefined;
      if (entry.status !== 'failed' || entry.source !== 'manual' || !entry.queuedBy) return null;
      const recipient = services.getAuthProfile(entry.queuedBy);
      if (!recipient) return null;
      return {
        entry,
        recipient,
        response: {
          requester: recipient.displayName,
          emailAvailable: services.canSendDirectMailToUser(recipient.userId),
          message: jobResolutionMessage(entry),
          notice: entry.resolutionNotice,
        },
      };
    };

    server.get<DashboardJobResolutionNoticeRoute>('/v1/dashboard/jobs/:id/resolution-notice', {
      schema: { ...getRouteContract('GET', '/v1/dashboard/jobs/:id/resolution-notice'), hide: true },
      preHandler: canNotifyFailedJobOwners,
    }, async (request, reply) => {
      const preview = resolutionNoticePreview(request.params.id);
      if (preview === undefined) return reply.code(404).send(sendJobError(request.id, 404, 'job not found'));
      if (preview === null) return reply.code(409).send(sendJobError(request.id, 409, 'job has no requester to notify'));
      return preview.response;
    });

    server.post<DashboardJobResolutionNoticeRoute>('/v1/dashboard/jobs/:id/resolution-notice', {
      schema: { ...getRouteContract('POST', '/v1/dashboard/jobs/:id/resolution-notice'), hide: true },
      preHandler: canNotifyFailedJobOwners,
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const preview = resolutionNoticePreview(request.params.id);
      if (preview === undefined) return reply.code(404).send(sendJobError(request.id, 404, 'job not found'));
      if (preview === null) return reply.code(409).send(sendJobError(request.id, 409, 'job has no requester to notify'));
      if (preview.entry.resolutionNotice) return preview.response;
      const notice = services.recordJobResolutionNotice(request.params.id, session.sub, preview.recipient.userId, preview.response.emailAvailable);
      if (!notice) return reply.code(409).send(sendJobError(request.id, 409, 'job notice could not be created'));
      if (notice.emailStatus === 'pending') {
        try {
          await services.sendDirectMailToUser(preview.recipient.userId, {
            subject: `You can retry ${preview.entry.bundleId} on dkrypt`,
            text: `${preview.response.message}\n\nOpen dkrypt and retry this job from your history.`,
          });
          services.setJobResolutionEmailStatus(request.params.id, 'sent');
        } catch (error) {
          services.setJobResolutionEmailStatus(request.params.id, 'failed');
          log.warn('failed-job resolution email could not be delivered', { jobId: request.params.id, error: String(error) });
        }
      }
      return resolutionNoticePreview(request.params.id)!.response;
    });

    server.get<DashboardJobDiagnosticRoute>('/v1/dashboard/jobs/:id/diagnostic', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/:id/diagnostic'),
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const active = services.getJob(request.params.id);
      const entry = active ? undefined : services.getJobHistoryEntryById(request.params.id);
      if (!active && !entry) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job not found');
      }
      const job: Job | JobHistoryEntry = active ?? entry!;
      const session = getFastifySession(request)!;
      if (!canViewJobForUser(job, session.sub, session.permissions)) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job not found');
      }
      const operationalView = canViewOperationalDashboard(session.permissions);
      const timeline = active?.timeline ?? entry?.timeline ?? [];
      reply.header('Content-Disposition', `attachment; filename="dkrypt-job-${job.id}-diagnostic.json"`);
      return {
        generatedAt: new Date().toISOString(),
        correlationId: job.correlationId ?? job.id,
        job: operationalView ? job : {
          id: job.id,
          correlationId: job.correlationId ?? job.id,
          bundleId: job.bundleId,
          externalVersionId: job.externalVersionId,
          testflight: job.testflight,
          versionLabel: job.versionLabel,
          source: job.source,
          status: job.status,
          progress: 'progress' in job ? job.progress : undefined,
          warnings: job.warnings,
          error: job.error,
          retryCount: job.retryCount,
          attempt: job.attempt,
          cacheHit: job.cacheHit,
          fileSizeBytes: 'fileSizeBytes' in job ? job.fileSizeBytes : 'sizeBytes' in job ? job.sizeBytes : undefined,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          ipaMetadata: job.ipaMetadata,
          ipaInfoPlist: job.ipaInfoPlist,
        },
        timeline: operationalView ? timeline : timeline.map((event) => ({
          at: event.at,
          status: event.status,
          durationMs: event.durationMs,
          label: event.status === 'queued' ? 'Queued' : event.status === 'running' ? 'Decrypt in progress' : event.status === 'done' ? 'Finished' : 'Failed',
        })),
      };
    });
  };
}

export const dashboardJobActionRoutes = createDashboardJobActionRoutes();
