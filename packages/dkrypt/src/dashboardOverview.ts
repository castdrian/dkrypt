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
import { canViewOperationalDashboard } from '#dashboardAccess.js';

const DEVICE_STATUS_FRESH_MS = 10 * 60_000;

export function buildDashboardOverview(permissions: bigint, userId: string) {
  const canViewAutomation = hasPermission(permissions, PermissionFlag.viewAutomation) || hasPermission(permissions, PermissionFlag.manageAutomation);
  const canViewDeviceData = hasPermission(permissions, PermissionFlag.viewDevices) || hasPermission(permissions, PermissionFlag.manageDevices);
  const canViewOperations = canViewOperationalDashboard(permissions);
  const entitlement = getBillingEntitlements(userId);
  const deviceRecords = canViewDeviceData ? getEffectiveDevices() : [];
  const devices = canViewDeviceData ? deviceRecords.map((device) => serializeDashboardDevice(device)) : [];
  const cachedHealthByDevice = new Map(deviceRecords.map((device) => [device.id, getCachedDeviceHealth(device.id)?.value] as const));
  const freshHealthForDevice = (deviceId: string) => {
    const health = cachedHealthByDevice.get(deviceId);
    return health && Date.now() - health.checkedAt <= DEVICE_STATUS_FRESH_MS ? health : undefined;
  };
  const statusDevices = canViewDeviceData ? deviceRecords.map((device) => {
    const health = freshHealthForDevice(device.id);
    return {
      id: device.id,
      name: device.name,
      enabled: device.enabled,
      draining: device.draining ?? false,
      isPrimary: device.isPrimary,
      reachable: health?.reachable,
    };
  }) : [];
  const enabledDevices = deviceRecords.filter((device) => device.enabled);
  const recentHealth = enabledDevices.map((device) => freshHealthForDevice(device.id))
    .filter((health): health is NonNullable<typeof health> => health !== undefined);
  const onlineDevices = recentHealth.filter((health) => health.reachable).length;
  const readyDevices = recentHealth.filter((health) => health.reachable && !getDeviceInstallBlocker(health)).length;
  const unavailableDevices = recentHealth.length - onlineDevices;
  const deviceStatus = canViewDeviceData ? {
    configured: deviceRecords.length,
    enabled: enabledDevices.length,
    online: onlineDevices,
    ready: readyDevices,
    attention: onlineDevices - readyDevices,
    checking: enabledDevices.length - recentHealth.length,
    unavailable: unavailableDevices,
    freshUntil: recentHealth.length > 0 ? Math.min(...recentHealth.map((health) => health.checkedAt + DEVICE_STATUS_FRESH_MS)) : undefined,
  } : undefined;
  const settings = getEffectiveSettings();
  const activeJobs = getActiveJobs().filter((job): job is Job & { status: 'queued' | 'running' } =>
    (job.status === 'queued' || job.status === 'running') && (canViewOperations || job.billingOwnerId?.toLowerCase() === userId.toLowerCase() || job.queuedBy?.toLowerCase() === userId.toLowerCase()));
  const queueSummaries = getJobQueueSummaries(activeJobs);
  return {
    ...(canViewAutomation ? { settings } : {}),
    devices,
    ...(canViewDeviceData ? { statusDevices, deviceStatus } : {}),
    disk: canViewOperations ? getDiskUsage(config.artifactDir) : undefined,
    isPaidPlan: entitlement.planId !== 'viewer' && !entitlement.freeTier,
    serviceStatus: getMaintenanceStatus().active ? 'maintenance' as const : 'operational' as const,
    ...(canViewOperations ? { maintenance: getMaintenanceStatus() } : {}),
    activeJobs: activeJobs.map((job) => ({
      id: job.id,
      correlationId: job.correlationId ?? job.id,
      bundleId: job.bundleId,
      source: job.source,
      status: job.status,
      progress: job.progress,
      versionLabel: job.versionLabel,
      deviceId: canViewOperations ? job.deviceId : undefined,
      preferredDeviceId: canViewOperations ? job.preferredDeviceId : undefined,
      transport: canViewOperations ? job.transport : undefined,
      warnings: job.warnings,
      testflight: job.testflight
        ? { appId: job.testflight.appId, buildId: job.testflight.build.id, version: job.testflight.build.cfBundleShortVersion, buildNumber: job.testflight.build.cfBundleVersion }
        : undefined,
      queuedBy: job.queuedBy,
      queuedByDisplayName: job.queuedBy ? getAuthProfile(job.queuedBy)?.displayName : undefined,
      priority: canViewOperations ? job.priority : undefined,
      createdAt: job.createdAt,
      queue: canViewOperations ? queueSummaries.get(job.id) : (() => {
        const summary = queueSummaries.get(job.id);
        return summary ? { position: summary.position, predictedStartMs: summary.predictedStartMs, predictedCompletionMs: summary.predictedCompletionMs } : undefined;
      })(),
      attempt: job.attempt,
      retryCount: job.retryCount,
      deadlineAt: canViewOperations ? job.deadlineAt : undefined,
      deadlineExceeded: canViewOperations ? job.deadlineExceeded : undefined,
      failureClass: canViewOperations ? job.failureClass : undefined,
      queueReason: canViewOperations ? getQueueReason(job) : undefined,
    })),
  };
}
