import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import type { DashboardManualDecryptPreflightRoute } from '#dashboardJobContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getDeviceHealth, getDeviceInstallBlocker, getDeviceReadiness } from '#deviceHealth.js';
import { getRouteContract } from '#contracts.js';
import { getActiveJobs } from '#jobs/store.js';
import { getBillingEntitlements } from '#billing.js';
import { getDecryptQuotaUsage } from '#jobs/repository.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import {
  DEFAULT_PROJECT_ID,
  getAverageJobDurationMs,
  getDevice,
  getEffectiveDevices,
} from '#store/state.js';
import { getVerifiedTestFlightCatalog, TestFlightCatalogUnavailableError } from '#testflightSubscriptions.js';
import { recentlyVerifiedTestFlightDevices } from '#testflightPolicy.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { resolveWithin } from '#util/resolveWithin.js';

export interface DashboardDecryptPreflightServices {
  getActiveJobs: typeof getActiveJobs;
  getAverageJobDurationMs: typeof getAverageJobDurationMs;
  getDevice: typeof getDevice;
  getDeviceHealth: typeof getDeviceHealth;
  getDeviceInstallBlocker: typeof getDeviceInstallBlocker;
  getDeviceReadiness: typeof getDeviceReadiness;
  getEffectiveDevices: typeof getEffectiveDevices;
  getVerifiedTestFlightCatalog: typeof getVerifiedTestFlightCatalog;
}

const defaultServices: DashboardDecryptPreflightServices = {
  getActiveJobs,
  getAverageJobDurationMs,
  getDevice,
  getDeviceHealth,
  getDeviceInstallBlocker,
  getDeviceReadiness,
  getEffectiveDevices,
  getVerifiedTestFlightCatalog,
};

const canRequestDecrypt = fastifyRequirePermission(PermissionFlag.requestDecrypt);

function sendPreflightError(requestId: string, reply: FastifyReply, statusCode: 400 | 404 | 409, message: string) {
  reply.code(statusCode);
  return createHttpErrorEnvelope(requestId, statusCode, message);
}

export function createDashboardDecryptPreflightRoutes(overrides: Partial<DashboardDecryptPreflightServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.post<DashboardManualDecryptPreflightRoute>('/v1/dashboard/decrypt/preflight', {
      schema: getRouteContract('POST', '/v1/dashboard/decrypt/preflight'),
      preHandler: canRequestDecrypt,
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const entitlement = getBillingEntitlements(session.sub);
      const projectId = DEFAULT_PROJECT_ID;

      const bundleId = request.body.bundleId.trim();
      const testflight = request.body.testflight === true;
      const versionLabel = request.body.versionLabel?.trim().slice(0, 64) || undefined;
      const installSizeBytes = request.body.installSizeBytes;
      const requestedDeviceId = request.body.deviceId?.trim() ?? '';
      const requestedDevice = requestedDeviceId ? services.getDevice(requestedDeviceId) : undefined;
      if (requestedDeviceId && (!requestedDevice || !requestedDevice.enabled || requestedDevice.draining)) {
        return sendPreflightError(request.id, reply, 400, 'deviceId must refer to an enabled device accepting jobs');
      }

      let verifiedCatalog: Awaited<ReturnType<typeof getVerifiedTestFlightCatalog>> = [];
      if (testflight) {
        try {
          verifiedCatalog = await services.getVerifiedTestFlightCatalog({ requireAllDevices: false });
        } catch (error) {
          if (error instanceof TestFlightCatalogUnavailableError) {
            reply.code(503);
            return {
              error: error.message,
              code: 'testflight_catalog_unavailable',
              message: error.message,
              requestId: request.id,
              retryable: true,
            };
          }
          throw error;
        }
      }

      const verifiedTestFlightApp = testflight ? verifiedCatalog.find((entry) => entry.bundleId === bundleId) : undefined;
      if (testflight && !verifiedTestFlightApp) {
        return sendPreflightError(request.id, reply, 409, 'TestFlight access must be verified on an enabled device before queueing');
      }
      const recentlyVerifiedDevices = recentlyVerifiedTestFlightDevices(verifiedTestFlightApp?.devices ?? []);
      if (testflight && recentlyVerifiedDevices.length === 0) {
        return sendPreflightError(request.id, reply, 409, 'TestFlight access is not recently verified on an enabled device');
      }

      if (requestedDevice && verifiedTestFlightApp && !recentlyVerifiedDevices.some((device) => device.id === requestedDevice.id)) {
        return sendPreflightError(request.id, reply, 409, 'TestFlight access is not recently verified on the selected device');
      }

      const verifiedDeviceIds = verifiedTestFlightApp ? new Set(recentlyVerifiedDevices.map((device) => device.id)) : undefined;
      const installSource = testflight ? 'testflight' : 'appstore';
      const devices = requestedDevice
        ? [requestedDevice]
        : services.getEffectiveDevices().filter((device) => device.enabled && !device.draining && (!verifiedDeviceIds || verifiedDeviceIds.has(device.id)));
      const primary = devices.find((device) => device.isPrimary) ?? devices[0];
      const checks = await Promise.all(devices.map(async (device) => {
        try {
          const snapshot = await resolveWithin(services.getDeviceHealth(device.id), 1_000);
          if (!snapshot.completed) {
            return {
              id: device.id,
              name: device.name,
              isPrimary: device.id === primary?.id,
              ready: false,
              checking: true,
              blockers: ['Device health check is still running. Try again shortly.'],
            };
          }
          const health = snapshot.value;
          const readiness = services.getDeviceReadiness(health, installSource);
          const blockers: string[] = [];
          if (!health.reachable) blockers.push(health.error ?? 'device is unreachable');
          if (health.internetAccess === false) blockers.push('device cannot reach Apple services');
          const installBlocker = services.getDeviceInstallBlocker(health, installSizeBytes, installSource);
          if (installBlocker) blockers.push(installBlocker);
          if (readiness.state === 'blocked') blockers.push(...(readiness.reasons.length > 0 ? readiness.reasons : ['device readiness is blocked']));
          const warnings: string[] = [];
          if (health.batteryPercent !== undefined && !health.batteryCharging && health.batteryPercent >= 15 && health.batteryPercent < 25) warnings.push(`battery is ${health.batteryPercent}% and may fall below the 15% minimum before this job starts`);
          if (installSizeBytes && health.storageFreeBytes !== undefined && health.storageFreeBytes >= installSizeBytes * 2 && health.storageFreeBytes < installSizeBytes * 2.5) warnings.push('free storage is close to the 2× install-size minimum');
          return {
            id: device.id,
            name: device.name,
            isPrimary: device.id === primary?.id,
            ready: blockers.length === 0,
            blockers: [...new Set(blockers)],
            warnings,
            readiness,
            reachable: health.reachable,
            storageFreeBytes: health.storageFreeBytes,
            batteryPercent: health.batteryPercent,
          };
        } catch (error) {
          return {
            id: device.id,
            name: device.name,
            isPrimary: device.id === primary?.id,
            ready: false,
            blockers: [error instanceof Error ? error.message : 'device health check failed'],
            reachable: false,
          };
        }
      }));

      return {
        bundleId,
        versionLabel,
        testflight,
        installSizeBytes,
        estimatedDurationMs: services.getAverageJobDurationMs(bundleId, projectId),
        queueLength: services.getActiveJobs().filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === projectId).length,
        canQueue: checks.some((check) => check.ready),
        quota: { ...getDecryptQuotaUsage(session.sub, entitlement.dailyDecryptLimit), legacy: entitlement.legacy ?? false, apiRatePerMinute: entitlement.apiRatePerMinute },
        devices: checks,
      };
    });
  };
}

export const dashboardDecryptPreflightRoutes = createDashboardDecryptPreflightRoutes();
