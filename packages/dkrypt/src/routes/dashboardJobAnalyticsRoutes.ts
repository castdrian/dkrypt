import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardJobEtaRoute, DashboardJobSloRoute, DashboardJobStatsRoute, DashboardJobVolumeRoute } from '#dashboardJobContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { config } from '#config.js';
import { getRouteContract } from '#contracts.js';
import { getActiveJobs, getJobEligibleDeviceCount, getQueueInfo } from '#jobs/store.js';
import { assessQueueServiceObjective, projectCompletedJobDurationP95Ms, queueServiceObjectiveMs } from '#jobs/slo.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession } from '#session.js';
import { DEFAULT_PROJECT_ID, getAllJobHistory, getAverageJobDurationMs, getBundleStats, getDailyVolume } from '#store/state.js';

interface DashboardJobAnalyticsServices {
  getActiveJobs: typeof getActiveJobs;
  getAllJobHistory: typeof getAllJobHistory;
  getAverageJobDurationMs: typeof getAverageJobDurationMs;
  getBundleStats: typeof getBundleStats;
  getDailyVolume: typeof getDailyVolume;
  getQueueInfo: typeof getQueueInfo;
  queueSloMinutes: number;
}

const defaultServices: DashboardJobAnalyticsServices = {
  getActiveJobs,
  getAllJobHistory,
  getAverageJobDurationMs,
  getBundleStats,
  getDailyVolume,
  getQueueInfo,
  queueSloMinutes: config.queueSloMinutes,
};

const canViewJobSlo = fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation);

export function createDashboardJobAnalyticsRoutes(overrides: Partial<DashboardJobAnalyticsServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardJobEtaRoute>('/v1/dashboard/jobs/eta/:bundleId', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/eta/:bundleId'),
    }, (request) => {
      return { avgMs: services.getAverageJobDurationMs(request.params.bundleId, DEFAULT_PROJECT_ID) ?? null };
    });

    server.get<DashboardJobStatsRoute>('/v1/dashboard/jobs/stats/:bundleId', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/stats/:bundleId'),
    }, (request) => {
      return services.getBundleStats(request.params.bundleId);
    });

    server.get<DashboardJobVolumeRoute>('/v1/dashboard/jobs/volume', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/volume'),
    }, (request) => {
      return { days: services.getDailyVolume(request.query.days ?? 14) };
    });

    server.get<DashboardJobSloRoute>('/v1/dashboard/jobs/slo', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/slo'),
      preHandler: canViewJobSlo,
    }, () => {
      const now = Date.now();
      const historicalP95Ms = projectCompletedJobDurationP95Ms(services.getAllJobHistory(), DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID);
      const targetMs = queueServiceObjectiveMs(services.queueSloMinutes);
      const jobs = services.getActiveJobs()
        .map((job) => {
          const queue = job.status === 'queued' ? services.getQueueInfo(job.id) : undefined;
          const assessment = assessQueueServiceObjective({
            createdAt: job.createdAt,
            now,
            status: job.status,
            queuePosition: queue?.position,
            parallelism: getJobEligibleDeviceCount(job),
            objectiveMs: targetMs,
            serviceDurationP95Ms: historicalP95Ms,
          });
          return {
            id: job.id,
            bundleId: job.bundleId,
            status: job.status,
            ...assessment,
          };
        });
      return { targetMs, historicalP95Ms, jobs };
    });
  };
}

export const dashboardJobAnalyticsRoutes = createDashboardJobAnalyticsRoutes();
