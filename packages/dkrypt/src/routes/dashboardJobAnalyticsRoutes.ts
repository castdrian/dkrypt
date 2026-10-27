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
const canViewOperationalAnalytics = fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation, PermissionFlag.viewDevices, PermissionFlag.manageDevices, PermissionFlag.viewScheduler);

export function createDashboardJobAnalyticsRoutes(overrides: Partial<DashboardJobAnalyticsServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardJobEtaRoute>('/v1/dashboard/jobs/eta/:bundleId', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/eta/:bundleId'),
      preHandler: canViewOperationalAnalytics,
    }, (request) => {
      const samples = services.getAllJobHistory()
        .filter((job) => job.bundleId === request.params.bundleId && (job.projectId ?? DEFAULT_PROJECT_ID) === DEFAULT_PROJECT_ID && job.status === 'done' && typeof job.startedAt === 'number' && job.finishedAt > job.startedAt)
        .map((job) => job.finishedAt - (job.startedAt as number))
        .sort((left, right) => left - right);
      const percentile = (value: number): number | null => samples.length ? samples[Math.max(0, Math.ceil(samples.length * value) - 1)] ?? null : null;
      const sampleCount = samples.length;
      return {
        avgMs: services.getAverageJobDurationMs(request.params.bundleId, DEFAULT_PROJECT_ID) ?? null,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        sampleCount,
        confidence: sampleCount === 0 ? 'none' as const : sampleCount < 5 ? 'low' as const : sampleCount < 20 ? 'medium' as const : 'high' as const,
      };
    });

    server.get<DashboardJobStatsRoute>('/v1/dashboard/jobs/stats/:bundleId', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/stats/:bundleId'),
      preHandler: canViewOperationalAnalytics,
    }, (request) => {
      return services.getBundleStats(request.params.bundleId);
    });

    server.get<DashboardJobVolumeRoute>('/v1/dashboard/jobs/volume', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/volume'),
      preHandler: canViewOperationalAnalytics,
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
