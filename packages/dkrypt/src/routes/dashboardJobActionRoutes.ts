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
import { canAccessProject } from '#dashboardJobPresentation.js';
import { getRouteContract } from '#contracts.js';
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
import {
  DEFAULT_PROJECT_ID,
  getJobHistoryEntryById,
  getPrimaryDevice,
  getProject,
  getUserPriority,
  jobResolutionMessage,
  recordJobResolutionNotice,
  setJobResolutionEmailStatus,
  type JobHistoryEntry,
} from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

export interface DashboardJobActionServices {
  getJob: typeof getJob;
  cancelJob: typeof cancelJob;
  prioritizeQueuedJob: typeof prioritizeQueuedJob;
  reorderQueue: typeof reorderQueue;
  getJobHistoryEntryById: typeof getJobHistoryEntryById;
  getProject: typeof getProject;
  enqueueDecryptJob: typeof enqueueDecryptJob;
  getPrimaryDevice: typeof getPrimaryDevice;
  getUserPriority: typeof getUserPriority;
  canAccessProject: typeof canAccessProject;
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
  getProject,
  enqueueDecryptJob,
  getPrimaryDevice,
  getUserPriority,
  canAccessProject,
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

function hasProjectAccess(services: DashboardJobActionServices, userId: string, permissions: bigint, projectId: string): boolean {
  return services.canAccessProject(userId, permissions, projectId);
}

async function resolveMinimumOsVersion(
  services: DashboardJobActionServices,
  input: {
    bundleId: string;
    externalVersionId?: string;
    versionLabel?: string;
    currentMinimumOsVersion?: string;
    testflight?: boolean;
    action: 'dispatch' | 'retry';
  },
): Promise<string | undefined> {
  if (input.currentMinimumOsVersion || input.testflight || (input.externalVersionId && !input.versionLabel)) {
    return input.currentMinimumOsVersion;
  }
  try {
    return (await services.resolveDecryptTarget(input.bundleId, input.versionLabel)).minimumOsVersion;
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
      const project = services.getProject(projectId);
      if (!project || !hasProjectAccess(services, session.sub, session.permissions, projectId)) {
        reply.code(404);
        return sendJobError(request.id, 404, 'account data is unavailable');
      }
      if (project.archivedAt !== undefined) {
        reply.code(409);
        return sendJobError(request.id, 409, 'decrypt operations are unavailable');
      }
      const bundleId = request.body.bundleId.trim();
      const externalVersionId = request.body.externalVersionId && externalVersionIdPattern.test(request.body.externalVersionId)
        ? request.body.externalVersionId
        : undefined;
      const versionLabel = request.body.versionLabel?.trim().slice(0, 64) || undefined;
      const preferredDeviceId = request.body.preferPrimary ? services.getPrimaryDevice()?.id : undefined;
      const minimumOsVersion = await resolveMinimumOsVersion(services, {
        bundleId,
        externalVersionId,
        versionLabel,
        currentMinimumOsVersion: request.body.minimumOsVersion,
        action: 'dispatch',
      });
      const job = services.enqueueDecryptJob(
        bundleId,
        'manual',
        {
          externalVersionId,
          versionLabel,
          queuedBy: session.sub,
          priority: services.getUserPriority(session.sub),
          preferredDeviceId,
          projectId,
          minimumOsVersion,
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
      if (!job || !hasProjectAccess(services, session.sub, session.permissions, job.projectId ?? DEFAULT_PROJECT_ID)) {
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
      if (!job || !hasProjectAccess(services, session.sub, session.permissions, job.projectId ?? DEFAULT_PROJECT_ID)) {
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
      if (!job || !hasProjectAccess(services, session.sub, session.permissions, job.projectId ?? DEFAULT_PROJECT_ID)) {
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
      if (!job || !hasProjectAccess(services, session.sub, session.permissions, job.projectId ?? DEFAULT_PROJECT_ID)) {
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
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = DEFAULT_PROJECT_ID;
      if (!hasProjectAccess(services, session.sub, session.permissions, projectId)) {
        reply.code(404);
        return sendJobError(request.id, 404, 'account data is unavailable');
      }
      const scopedJobs = request.body.ids.every((id) => {
        const job = services.getJob(id);
        return job && (job.projectId ?? DEFAULT_PROJECT_ID) === projectId;
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
      const projectId = entry?.projectId ?? DEFAULT_PROJECT_ID;
      if (!entry || !hasProjectAccess(services, session.sub, session.permissions, projectId)) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job history entry not found');
      }
      if (services.getProject(projectId)?.archivedAt !== undefined) {
        reply.code(409);
        return sendJobError(request.id, 409, 'decrypt operations are unavailable');
      }

      const preferredDeviceId = request.body.preferPrimary ? services.getPrimaryDevice()?.id : undefined;
      const minimumOsVersion = await resolveMinimumOsVersion(services, {
        bundleId: entry.bundleId,
        externalVersionId: entry.externalVersionId,
        versionLabel: entry.versionLabel,
        currentMinimumOsVersion: entry.minimumOsVersion,
        testflight: entry.testflight !== undefined,
        action: 'retry',
      });
      const job = services.enqueueDecryptJob(
        entry.bundleId,
        'manual',
        {
          externalVersionId: entry.externalVersionId,
          testflight: entry.testflight,
          versionLabel: entry.versionLabel,
          queuedBy: session.sub,
          priority: services.getUserPriority(session.sub),
          preferredDeviceId,
          projectId,
          minimumOsVersion,
        },
      );
      reply.code(202);
      return jobSummary(job);
    });

    const resolutionNoticePreview = (id: string, userId: string, permissions: bigint) => {
      const entry = services.getJobHistoryEntryById(id);
      if (!entry || !hasProjectAccess(services, userId, permissions, entry.projectId ?? DEFAULT_PROJECT_ID)) return undefined;
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
      const session = getFastifySession(request)!;
      const preview = resolutionNoticePreview(request.params.id, session.sub, session.permissions);
      if (preview === undefined) return reply.code(404).send(sendJobError(request.id, 404, 'job not found'));
      if (preview === null) return reply.code(409).send(sendJobError(request.id, 409, 'job has no requester to notify'));
      return preview.response;
    });

    server.post<DashboardJobResolutionNoticeRoute>('/v1/dashboard/jobs/:id/resolution-notice', {
      schema: { ...getRouteContract('POST', '/v1/dashboard/jobs/:id/resolution-notice'), hide: true },
      preHandler: canNotifyFailedJobOwners,
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const preview = resolutionNoticePreview(request.params.id, session.sub, session.permissions);
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
      return resolutionNoticePreview(request.params.id, session.sub, session.permissions)!.response;
    });

    server.get<DashboardJobDiagnosticRoute>('/v1/dashboard/jobs/:id/diagnostic', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/:id/diagnostic'),
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const active = services.getJob(request.params.id);
      const entry = active ? undefined : services.getJobHistoryEntryById(request.params.id);
      const projectId = active?.projectId ?? entry?.projectId ?? DEFAULT_PROJECT_ID;
      const session = getFastifySession(request)!;
      if ((!active && !entry) || !hasProjectAccess(services, session.sub, session.permissions, projectId)) {
        reply.code(404);
        return sendJobError(request.id, 404, 'job not found');
      }
      const job: Job | JobHistoryEntry = active ?? entry!;
      reply.header('Content-Disposition', `attachment; filename="dkrypt-job-${job.id}-diagnostic.json"`);
      return {
        generatedAt: new Date().toISOString(),
        correlationId: job.correlationId ?? job.id,
        job,
        timeline: active?.timeline ?? entry?.timeline ?? [],
      };
    });
  };
}

export const dashboardJobActionRoutes = createDashboardJobActionRoutes();
