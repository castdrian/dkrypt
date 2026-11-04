import { getBillingEntitlements } from '#billing.js';
import { PermissionFlag } from '#permissions.js';
import { hasManuallyAssignedPermission } from '#store/state.js';

export function hasManualDecryptRoleAccess(userId: string): boolean {
  return hasManuallyAssignedPermission(userId, PermissionFlag.requestDecrypt);
}

export function isFreeTierForPermission(userId: string, permission: bigint): boolean {
  return getBillingEntitlements(userId).freeTier === true && !hasManuallyAssignedPermission(userId, permission);
}
