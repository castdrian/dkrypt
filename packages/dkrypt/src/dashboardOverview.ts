import { getBillingEntitlements } from '#billing.js';
import { getAuthProfile } from '#identity.js';
import { config } from '#config.js';
import { getMaintenanceStatus } from '#maintenance.js';
import { getActiveJobs, getJobQueueSummaries, getQueueReason } from '#jobs/store.js';
import type { Job } from '#jobs/types.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { serializeDashboardDevice } from '#dashboardDevicePresentation.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { effectiveTimeZone } from '#util/timezone.js';
import { nextRunnableCronOccurrence } from '#util/maintenanceWindow.js';
import { getDiskUsage } from '#util/diskUsage.js';
import {
  DEFAULT_PROJECT_ID,
  getEffectiveDevices,
  getEffectiveSettings,
  getEffectiveWatches,
  getSchedulerRunHistory,
  getWatchConfigIssues,
  isWatchSchedulable,
} from '#store/state.js';

export function buildDashboardOverview(permissions: bigint, userId: string, projectId = DEFAULT_PROJECT_ID) {
  const canViewAutomation = hasPermission(permissions, PermissionFlag.viewAutomation) || hasPermission(permissions, PermissionFlag.manageAutomation);
  const canViewDeviceData = hasPermission(permissions, PermissionFlag.viewDevices) || hasPermission(permissions, PermissionFlag.manageDevices);
  const watches = canViewAutomation ? getEffectiveWatches().filter((watch) =>
    (watch.projectId ?? DEFAULT_PROJECT_ID) === projectId && canAccessProject(userId, permissions, watch.projectId ?? DEFAULT_PROJECT_ID),
  ).map((watch) => {
    const publicWatch = { ...watch };
    delete publicWatch.lastScheduledAt;
    return {
      ...publicWatch,
      timezone: effectiveTimeZone(watch.timezone),
      missedRunPolicy: watch.missedRunPolicy ?? 'skip',
      nextRunAt: isWatchSchedulable(watch)
        ? nextRunnableCronOccurrence(watch.pollCron, effectiveTimeZone(watch.timezone), watch.maintenanceWindow, Date.now(), Date.now() + 366 * 24 * 60 * 60 * 1000)?.at
        : undefined,
      schedulable: isWatchSchedulable(watch),
      configIssues: getWatchConfigIssues(watch),
    };
  }) : [];
  const schedulerRunHistory = canViewAutomation
    ? getSchedulerRunHistory(200).filter((run) => watches.some((watch) => watch.id === run.watchId)).slice(0, 10)
    : [];
  const devices = canViewDeviceData ? getEffectiveDevices().map((device) => serializeDashboardDevice(device)) : [];
  const settings = getEffectiveSettings();
  const activeJobs = getActiveJobs().filter((job): job is Job & { status: 'queued' | 'running' } =>
    (job.status === 'queued' || job.status === 'running') && (job.projectId ?? DEFAULT_PROJECT_ID) === projectId,
  );
  const queueSummaries = getJobQueueSummaries(activeJobs);
  return {
    schedulerEnabled: watches.some((watch) => watch.schedulable),
    settings: canViewAutomation ? settings : { ...settings, notifyWebhookUrl: '' },
    watches,
    devices,
    lastSchedulerRunAt: schedulerRunHistory[0]?.ts,
    schedulerRunHistory,
    disk: getDiskUsage(config.artifactDir),
    isPaidPlan: getBillingEntitlements(userId).planId !== 'viewer',
    maintenance: getMaintenanceStatus(),
    projectId,
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
