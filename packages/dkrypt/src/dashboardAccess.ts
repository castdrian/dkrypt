import { hasAnyPermission, PermissionFlag } from '#permissions.js';

const operationalPermissions = [
  PermissionFlag.viewDevices,
  PermissionFlag.manageDevices,
  PermissionFlag.viewAutomation,
  PermissionFlag.manageAutomation,
  PermissionFlag.viewScheduler,
];

export function canViewOperationalDashboard(permissions: bigint): boolean {
  return hasAnyPermission(permissions, operationalPermissions);
}

export function canViewJobForUser(job: { queuedBy?: string; billingOwnerId?: string }, userId: string, permissions: bigint): boolean {
  if (canViewOperationalDashboard(permissions)) return true;
  const ownerId = job.billingOwnerId ?? job.queuedBy;
  return ownerId?.toLowerCase() === userId.toLowerCase();
}
