import { getBillingEntitlements } from '#billing.js';
import { getAuthProfile } from '#identity.js';
import { config } from '#config.js';
import { getMaintenanceStatus } from '#maintenance.js';
import { getActiveJobs, getJobQueueSummaries, getQueueReason } from '#jobs/store.js';
import type { Job } from '#jobs/types.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { getCachedDeviceHealth } from '#deviceHealthCache.js';
import { getDeviceInstallBlocker } from '#deviceInstallEligibility.js';
import { serializeDashboardDevice } from '#dashboardDevicePresentation.js';
import { getDiskUsage } from '#util/diskUsage.js';
import { getEffectiveDevices, getEffectiveSettings } from '#store/state.js';

const DEVICE_STATUS_FRESH_MS = 10 * 60_000;

export function buildDashboardOverview(permissions: bigint, userId: string) {
  const canViewAutomation = hasPermission(permissions, PermissionFlag.viewAutomation) || hasPermission(permissions, PermissionFlag.manageAutomation);
  const canViewDeviceData = hasPermission(permissions, PermissionFlag.viewDevices) || hasPermission(permissions, PermissionFlag.manageDevices);
  const deviceRecords = getEffectiveDevices();
  const devices = canViewDeviceData ? deviceRecords.map((device) => serializeDashboardDevice(device)) : [];
  const cachedHealthByDevice = new Map(deviceRecords.map((device) => [device.id, getCachedDeviceHealth(device.id)?.value] as const));
  const freshHealthForDevice = (deviceId: string) => {
    const health = cachedHealthByDevice.get(deviceId);
    return health && Date.now() - health.checkedAt <= DEVICE_STATUS_FRESH_MS ? health : undefined;
  };
  const statusDevices = deviceRecords.map((device) => {
    const health = freshHealthForDevice(device.id);
    return {
      id: device.id,
      name: device.name,
      enabled: device.enabled,
      draining: device.draining ?? false,
      isPrimary: device.isPrimary,
      reachable: health?.reachable,
    };
  });
  const enabledDevices = deviceRecords.filter((device) => device.enabled);
  const recentHealth = enabledDevices.map((device) => freshHealthForDevice(device.id))
    .filter((health): health is NonNullable<typeof health> => health !== undefined);
  const onlineDevices = recentHealth.filter((health) => health.reachable).length;
  const readyDevices = recentHealth.filter((health) => health.reachable && !getDeviceInstallBlocker(health)).length;
  const unavailableDevices = recentHealth.length - onlineDevices;
  const deviceStatus = {
    configured: deviceRecords.length,
    enabled: enabledDevices.length,
    online: onlineDevices,
    ready: readyDevices,
    attention: onlineDevices - readyDevices,
    checking: enabledDevices.length - recentHealth.length,
    unavailable: unavailableDevices,
    freshUntil: recentHealth.length > 0 ? Math.min(...recentHealth.map((health) => health.checkedAt + DEVICE_STATUS_FRESH_MS)) : undefined,
  };
  const settings = getEffectiveSettings();
  const activeJobs = getActiveJobs().filter((job): job is Job & { status: 'queued' | 'running' } => job.status === 'queued' || job.status === 'running');
  const queueSummaries = getJobQueueSummaries(activeJobs);
  return {
    settings: canViewAutomation ? settings : { ...settings, notifyWebhookUrl: '' },
    devices,
    statusDevices,
    deviceStatus,
    disk: getDiskUsage(config.artifactDir),
    isPaidPlan: getBillingEntitlements(userId).planId !== 'viewer',
    maintenance: getMaintenanceStatus(),
    activeJobs: activeJobs.map((job) => ({
      id: job.id,
      correlationId: job.correlationId ?? job.id,
      bundleId: job.bundleId,
      source: job.source,
      status: job.status,
      progress: job.progress,
      versionLabel: job.versionLabel,
      deviceId: job.deviceId,
      preferredDeviceId: job.preferredDeviceId,
      transport: job.transport,
      warnings: job.warnings,
      testflight: job.testflight
        ? { appId: job.testflight.appId, buildId: job.testflight.build.id, version: job.testflight.build.cfBundleShortVersion, buildNumber: job.testflight.build.cfBundleVersion }
        : undefined,
      queuedBy: job.queuedBy,
      queuedByDisplayName: job.queuedBy ? getAuthProfile(job.queuedBy)?.displayName : undefined,
      priority: job.priority,
      createdAt: job.createdAt,
      queue: queueSummaries.get(job.id),
      attempt: job.attempt,
      retryCount: job.retryCount,
      deadlineAt: job.deadlineAt,
      deadlineExceeded: job.deadlineExceeded,
      failureClass: job.failureClass,
      queueReason: getQueueReason(job),
    })),
  };
}
