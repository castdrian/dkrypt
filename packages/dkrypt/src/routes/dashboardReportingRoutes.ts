import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardFailurePatternsRoute, DashboardInsightsRoute, DashboardStorageForecastRoute, DashboardSupportBundleRoute, DashboardWebhookDeliveriesRoute } from '#contracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { config } from '#config.js';
import { getRouteContract } from '#contracts.js';
import { getDeploymentMetadata } from '#deployment.js';
import { getRecentLogs } from '#logger.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession } from '#session.js';
import {
  DEFAULT_PROJECT_ID,
  getAllJobHistory,
  getAppCatalogStats,
  getEffectiveDevices,
  getInsightsSummary,
  getStateDatabaseStatus,
  getWebhookDeliveryLog,
  verifyLatestDatabaseBackup,
} from '#store/state.js';
import { getDiskUsage } from '#util/diskUsage.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

interface DashboardReportingServices {
  getInsightsSummary: (topAppsLimit: number, trendDays: number, projectId: string) => ReturnType<typeof getInsightsSummary>;
  getAllJobHistory: typeof getAllJobHistory;
  getDiskUsage: typeof getDiskUsage;
  artifactDir: string;
  getWebhookDeliveryLog: typeof getWebhookDeliveryLog;
  getStateDatabaseStatus: typeof getStateDatabaseStatus;
  verifyLatestDatabaseBackup: typeof verifyLatestDatabaseBackup;
  getAppCatalogStats: typeof getAppCatalogStats;
  getEffectiveDevices: typeof getEffectiveDevices;
  getRecentLogs: typeof getRecentLogs;
}

const defaultServices: DashboardReportingServices = {
  getInsightsSummary,
  getAllJobHistory,
  getDiskUsage,
  artifactDir: config.artifactDir,
  getWebhookDeliveryLog,
  getStateDatabaseStatus,
  verifyLatestDatabaseBackup,
  getAppCatalogStats,
  getEffectiveDevices,
  getRecentLogs,
};

function boundedQueryInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10) || fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

export function createDashboardReportingRoutes(overrides: Partial<DashboardReportingServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };
  const canViewAutomation = fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation);
  const canViewOperationalAnalytics = fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation, PermissionFlag.viewDevices, PermissionFlag.manageDevices, PermissionFlag.viewScheduler);

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardInsightsRoute>('/v1/dashboard/insights', {
      schema: getRouteContract('GET', '/v1/dashboard/insights'),
      preHandler: canViewOperationalAnalytics,
    }, (request) => {
      return services.getInsightsSummary(
        boundedQueryInteger(request.query.topApps, 5, 1, 25),
        boundedQueryInteger(request.query.trendDays, 14, 1, 90),
        DEFAULT_PROJECT_ID,
      );
    });

    server.get<DashboardFailurePatternsRoute>('/v1/dashboard/failure-patterns', {
      schema: getRouteContract('GET', '/v1/dashboard/failure-patterns'),
      preHandler: canViewAutomation,
    }, () => {
      const normalize = (message: string) => message
        .replace(/https?:\/\/\S+/g, '[url]')
        .replace(/(?:authorization:\s*bearer\s+|(?:token|secret|key|cookie)\s*[:=]\s*)[^\s,;"']+/gi, '[redacted]')
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[id]')
        .replace(/\b\d{4,}\b/g, '[number]')
        .slice(0, 180);
      const patterns = new Map<string, { count: number; firstSeen: number; lastSeen: number; bundleIds: Set<string> }>();
      for (const job of services.getAllJobHistory().filter((entry) => entry.status === 'failed' && entry.error)) {
        const key = normalize(job.error as string);
        const current = patterns.get(key) ?? { count: 0, firstSeen: job.finishedAt, lastSeen: job.finishedAt, bundleIds: new Set<string>() };
        current.count += 1;
        current.firstSeen = Math.min(current.firstSeen, job.finishedAt);
        current.lastSeen = Math.max(current.lastSeen, job.finishedAt);
        current.bundleIds.add(job.bundleId);
        patterns.set(key, current);
      }
      return {
        patterns: [...patterns.entries()]
          .map(([message, pattern]) => ({ message, count: pattern.count, firstSeen: pattern.firstSeen, lastSeen: pattern.lastSeen, bundleIds: [...pattern.bundleIds] }))
          .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
          .slice(0, 20),
      };
    });

    server.get<DashboardStorageForecastRoute>('/v1/dashboard/storage-forecast', {
      schema: getRouteContract('GET', '/v1/dashboard/storage-forecast'),
      preHandler: canViewAutomation,
    }, (request, reply) => {
      const cutoff = Date.now() - 30 * 86_400_000;
      const completed = services.getAllJobHistory().filter((entry) => entry.status === 'done' && entry.finishedAt >= cutoff && entry.sizeBytes && entry.sizeBytes > 0);
      const bytesPerDay = completed.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0) / 30;
      const disk = services.getDiskUsage(services.artifactDir);
      if (!disk) {
        reply.code(503);
        return createHttpErrorEnvelope(request.id, 503, 'output storage is unavailable');
      }
      return {
        freeBytes: disk.freeBytes,
        bytesPerDay,
        daysRemaining: bytesPerDay > 0 ? Math.floor(disk.freeBytes / bytesPerDay) : null,
        sampleCount: completed.length,
      };
    });

    server.get<DashboardWebhookDeliveriesRoute>('/v1/dashboard/webhooks', {
      schema: getRouteContract('GET', '/v1/dashboard/webhooks'),
      preHandler: fastifyRequirePermission(PermissionFlag.viewLogs),
    }, (request) => {
      const limit = Math.min(Math.max(Number.parseInt(request.query.limit ?? '100', 10) || 100, 1), 200);
      return { deliveries: services.getWebhookDeliveryLog(limit) };
    });

    server.get<DashboardSupportBundleRoute>('/v1/dashboard/support-bundle', {
      schema: getRouteContract('GET', '/v1/dashboard/support-bundle'),
      preHandler: fastifyRequirePermission(PermissionFlag.manageAutomation),
    }, (_request, reply) => {
      const redactSensitiveText = (value: string | undefined): string | undefined => value
        ?.replace(/https?:\/\/\S+/g, '[redacted-url]')
        .replace(/\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;"']+/gi, '$1[redacted]')
        .replace(/\b(authorization\s*[:=]\s*)(?!bearer\b|basic\b)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
        .replace(/\b((?:[\w-]*(?:token|secret|password|key|cookie|credential))\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]');
      const redactSensitiveData = (value: unknown): unknown => {
        if (typeof value === 'string') return redactSensitiveText(value) ?? value;
        if (Array.isArray(value)) return value.map(redactSensitiveData);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /authorization|token|secret|password|private.?key|cookie|credential|api.?key/i.test(key) ? '[redacted]' : redactSensitiveData(entry)]));
      };
      const jobs = services.getAllJobHistory()
        .slice(0, 100)
        .map(({ id, correlationId, bundleId, status, source, versionLabel, createdAt, startedAt, finishedAt, sizeBytes, error, queueReason, deadlineAt, deadlineExceeded, failureClass, deviceId, transport, attempt, retryCount, timeline }) => ({
          id,
          correlationId,
          bundleId,
          status,
          source,
          versionLabel,
          createdAt,
          startedAt,
          finishedAt,
          sizeBytes,
          error: redactSensitiveText(error),
          queueReason: redactSensitiveText(queueReason),
          deadlineAt,
          deadlineExceeded,
          failureClass,
          deviceId,
          transport,
          attempt,
          retryCount,
          timeline: timeline?.map(({ at, label, status }) => ({ at, label: redactSensitiveText(label) ?? label, status })),
        }));
      const logs = services.getRecentLogs({ limit: 200 }).logs;
      const transportTimeline = logs.filter((entry) => entry.scope === 'idevice').map((entry) => ({
        id: entry.id,
        at: entry.ts,
        level: entry.level,
        message: redactSensitiveText(entry.message) ?? entry.message,
        deviceId: typeof entry.meta?.deviceId === 'string' ? entry.meta.deviceId : undefined,
        transport: typeof entry.meta?.transport === 'string' ? entry.meta.transport : undefined,
        operation: typeof entry.meta?.operation === 'string' ? entry.meta.operation : undefined,
        correlationId: typeof entry.meta?.correlationId === 'string' ? entry.meta.correlationId : undefined,
      }));
      const correlationIds = [...new Set([
        ...jobs.flatMap((job) => typeof job.correlationId === 'string' ? [job.correlationId] : []),
        ...logs.flatMap((entry) => typeof entry.meta?.correlationId === 'string' ? [entry.meta.correlationId] : []),
      ])];
      reply.header('Content-Disposition', 'attachment; filename="dkrypt-support-bundle.json"');
      return {
        generatedAt: new Date().toISOString(),
        deployment: { ...getDeploymentMetadata(), node: process.version },
        database: services.getStateDatabaseStatus(),
        latestBackup: services.verifyLatestDatabaseBackup(),
        disk: services.getDiskUsage(services.artifactDir),
        catalog: services.getAppCatalogStats(),
        devices: services.getEffectiveDevices().map(({ id, name, enabled, isPrimary }) => ({ id, name, enabled, isPrimary })),
        logs: logs.map((entry) => ({ ...entry, message: redactSensitiveText(entry.message) ?? entry.message, meta: entry.meta ? redactSensitiveData(entry.meta) as Record<string, unknown> : undefined })),
        jobs,
        transportTimeline,
        correlationIds,
      };
    });
  };
}

export const dashboardReportingRoutes = createDashboardReportingRoutes();
