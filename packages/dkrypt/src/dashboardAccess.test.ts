import { expect, test } from 'bun:test';
import { canViewOperationalDashboard, canViewJobForUser } from '#dashboardAccess.js';
import { PermissionFlag } from '#permissions.js';

test('default log access does not expose operational dashboard data', () => {
  expect(canViewOperationalDashboard(PermissionFlag.viewLogs)).toBe(false);
  expect(canViewOperationalDashboard(PermissionFlag.viewDevices)).toBe(true);
  expect(canViewOperationalDashboard(PermissionFlag.viewScheduler)).toBe(true);
});

test('members can view only their own jobs without operational access', () => {
  expect(canViewJobForUser({ queuedBy: 'Member@Example.test' }, 'member@example.test', PermissionFlag.requestDecrypt)).toBe(true);
  expect(canViewJobForUser({ queuedBy: 'other@example.test' }, 'member@example.test', PermissionFlag.requestDecrypt)).toBe(false);
  expect(canViewJobForUser({ queuedBy: 'other@example.test' }, 'member@example.test', PermissionFlag.viewDevices)).toBe(true);
});
