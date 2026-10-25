import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { config } from '#config.js';
import {
  exportBillingSnapshot,
  getBillingCustomerId,
  getBillingEntitlements,
  listBillingEntitlementHistory,
  listBillingSubscriptions,
  replaceBillingSnapshot,
  upsertBillingCustomer,
  upsertBillingSubscription,
} from '#billing.js';
import { exportIdentitySnapshot, getAuthProfile, replaceIdentitySnapshot, upsertAuthProfile } from '#identity.js';
import { hasPermission, PermissionFlag, serializeBits } from '#permissions.js';
import { createApiKeyRepository } from '#store/apiKeyRepository.js';
import { createBackupRepository } from '#store/backupRepository.js';
import {
  addAllowedUser,
  addPasskey,
  areNewBillingCheckoutsPaused,
  createApiKey,
  createBackupSnapshot,
  createDevice,
  createDiscordRolePerk,
  createRole,
  createSessionRecord,
  createTestFlightSubscription,
  deleteDevice,
  deletePasskey,
  deleteBackupSnapshot,
  exportBackup,
  drillBackupSnapshot,
  getAuditLog,
  getAllJobHistory,
  getBackupSchedule,
  getJobHistoryPage,
  getJobHistoryEntryById,
  getDeviceHealthHourlyBuckets,
  getConsecutiveDeviceHealthFailures,
  getDeviceUptimePercent,
  getDiscordGuildIds,
  getDiscordRolePerks,
  getInsightsSummary,
  getEffectiveSettings,
  getProject,
  getUserEffectivePermissions,
  getRole,
  getEffectiveDevices,
  getTestFlightSubscription,
  isSessionRecordActive,
  listSessionsForUser,
  getWebhookDeliveryLog,
  importBackup,
  listAllowedUsers,
  listDeviceAlertRecipients,
  listProjectsForUser,
  listNotifications,
  listNotificationsPage,
  listAllApiKeysPage,
  listPasskeysForUser,
  recordDeploymentReadyNotifications,
  recordDeviceHealthCheck,
  getDeviceSubsystemDetails,
  recordDeviceAlertNotification,
  recordAudit,
  recordApiKeyBundleUsage,
  recordJobHistory,
  recordJobResolutionNotice,
  recordNotification,
  setJobResolutionEmailStatus,
  revokeSessionRecord,
  revokeApiKey,
  recordWebhookDelivery,
  removeAllowedUser,
  setDiscordGuildIds,
  setBackupSchedule,
  setNewBillingCheckoutsPaused,
  syncDiscordPerkRoles,
  updateAllowedUserRoles,
  userCanAccessProject,
  updateDevice,
  updateSettings,
  upsertAppCatalogEntry,
  touchSessionRecord,
  verifyApiKey,
  markNotificationsRead,
  approveTestFlightSubscription,
  denyTestFlightSubscription,
  previewJobHistoryRetention,
  simulateJobHistoryRetention,
  updateTestFlightSubscriptionDevice,
  type AppWatch,
} from '#store/state.js';
import { openStateCollectionDatabase, openStateDatabase, readStateCollection, replaceStateCollection } from '#store/sqlite.js';

function legacyAppWatch(overrides: Partial<AppWatch> = {}): AppWatch {
  const now = Date.now();
  return {
    id: `legacy-watch-${randomUUID()}`,
    bundleId: `com.example.legacy-watch.${randomUUID()}`,
    repo: 'owner/repo',
    ghWorkflowFile: 'release.yml',
    pollCron: '0 * * * *',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('app catalog search updates preserve richer App Store metadata', () => {
  const bundleId = `com.example.catalog-${randomUUID()}`;
  const first = upsertAppCatalogEntry({
    bundleId,
    displayName: 'Original app name',
    description: 'Full description',
    releaseNotes: 'Release notes',
    metadataFetchedAt: 123,
  });
  const updated = upsertAppCatalogEntry({
    bundleId,
    displayName: 'Current app name',
    trackId: 12345,
  });

  expect(updated).toMatchObject({
    bundleId,
    displayName: 'Current app name',
    description: 'Full description',
    releaseNotes: 'Release notes',
    metadataFetchedAt: 123,
    trackId: 12345,
  });
  expect(updated.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
});

describe('dashboard notifications', () => {
  test('records a failed-job resolution notice once with its in-app destination and delivery outcome', () => {
    const jobId = randomUUID();
    const requester = `discord:${randomUUID()}`;
    recordJobHistory({ id: jobId, bundleId: 'com.example.retry', queuedBy: requester, status: 'failed', source: 'manual', createdAt: 1, finishedAt: 2 });

    const first = recordJobResolutionNotice(jobId, 'operator', requester, true);
    expect(first?.emailStatus).toBe('pending');
    expect(recordJobResolutionNotice(jobId, 'operator', requester, true)).toBeUndefined();
    setJobResolutionEmailStatus(jobId, 'sent');
    expect(getJobHistoryEntryById(jobId)?.resolutionNotice?.emailStatus).toBe('sent');
    const messages = listNotifications(requester).notifications.filter((notification) => notification.jobId === jobId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.href).toContain(`job=${jobId}`);
    expect(messages[0]?.message).toContain('try the job again');
  });
  test('stores notifications per user and marks selected entries read', () => {
    const userId = `notifications-${randomUUID()}`;
    const first = recordNotification({ userId, title: 'Finished', message: 'Ready', severity: 'success' });
    recordNotification({ userId, title: 'Failed', message: 'Needs attention', severity: 'error' });
    recordNotification({ userId: `other-${randomUUID()}`, title: 'Hidden', message: 'Not yours', severity: 'info' });

    expect(listNotifications(userId)).toMatchObject({ unread: 2, notifications: expect.arrayContaining([expect.objectContaining({ id: first.id })]) });
    const firstPage = listNotificationsPage(userId, 0, 1);
    const secondPage = listNotificationsPage(userId, 0, 1, firstPage.nextCursor);
    expect(firstPage.notifications).toHaveLength(1);
    expect(secondPage.notifications).toHaveLength(1);
    expect(secondPage.notifications[0]?.id).not.toBe(firstPage.notifications[0]?.id);
    expect(secondPage.total).toBe(2);
    expect(markNotificationsRead(userId, [first.id])).toBe(1);
    expect(listNotifications(userId)).toMatchObject({ unread: 1 });
  });

  test('groups repeated notifications, refreshes their unread state, and retains their destination', () => {
    const originalNow = Date.now;
    let now = originalNow();
    const userId = `grouped-notifications-${randomUUID()}`;
    const groupKey = `device-offline:${randomUUID()}`;

    try {
      Date.now = () => now;
      const first = recordNotification({
        userId,
        title: 'Device unavailable',
        message: 'The device stopped responding.',
        severity: 'error',
        groupKey,
        href: '/?tab=settings&stab=devices',
      });

      expect(first).toMatchObject({ occurrenceCount: 1, firstOccurredAt: now, lastOccurredAt: now });
      expect(markNotificationsRead(userId, [first.id])).toBe(1);

      now += 30_000;
      const repeated = recordNotification({
        userId,
        title: 'Device unavailable',
        message: 'The device is still not responding.',
        severity: 'error',
        groupKey,
        href: '/?tab=settings&stab=devices',
      });

      expect(repeated).toMatchObject({
        id: first.id,
        message: 'The device is still not responding.',
        occurrenceCount: 2,
        firstOccurredAt: first.createdAt,
        lastOccurredAt: now,
        createdAt: now,
        href: '/?tab=settings&stab=devices',
      });
      expect(repeated.readAt).toBeUndefined();
      expect(listNotificationsPage(userId)).toMatchObject({ total: 1, unread: 1 });

      now += 16 * 60_000;
      const later = recordNotification({
        userId,
        title: 'Device unavailable',
        message: 'The device stopped responding again.',
        severity: 'error',
        groupKey,
        href: '/?tab=settings&stab=devices',
      });

      expect(later.id).not.toBe(first.id);
      expect(listNotificationsPage(userId)).toMatchObject({ total: 2, unread: 2 });
      expect(listNotifications(userId).notifications[0]).not.toHaveProperty('groupKey');
    } finally {
      Date.now = originalNow;
    }
  });

  test('keeps a recently repeated notification when the history reaches its retention limit', () => {
    const originalNow = Date.now;
    let now = originalNow();
    const userId = `retained-grouped-notifications-${randomUUID()}`;
    const groupKey = `device-offline:${randomUUID()}`;

    try {
      Date.now = () => now;
      const first = recordNotification({
        userId,
        title: 'Device unavailable',
        message: 'The device stopped responding.',
        severity: 'error',
        groupKey,
      });

      for (let index = 0; index < 499; index += 1) {
        now += 1;
        recordNotification({
          userId,
          title: `New notification ${index}`,
          message: 'A newer notification.',
          severity: 'info',
        });
      }

      now += 1;
      const repeated = recordNotification({
        userId,
        title: 'Device unavailable',
        message: 'The device is still not responding.',
        severity: 'error',
        groupKey,
      });

      now += 1;
      recordNotification({
        userId,
        title: 'The newest notification',
        message: 'This should not evict the recently repeated alert.',
        severity: 'info',
      });

      expect(repeated.id).toBe(first.id);
      expect(listNotifications(userId).notifications).toContainEqual(expect.objectContaining({
        id: first.id,
        occurrenceCount: 2,
      }));
    } finally {
      Date.now = originalNow;
    }
  }, 20_000);

  test('sends device alerts to device viewers with a device-page link', () => {
    const role = createRole({
      name: `Device alert role ${randomUUID()}`,
      color: '#3498db',
      permissions: serializeBits(PermissionFlag.viewDevices),
    }, 'root');
    const viewer = `device-alert-viewer-${randomUUID()}`;
    const outsider = `device-alert-outsider-${randomUUID()}`;
    addAllowedUser(viewer, [role.id], 'root');
    addAllowedUser(outsider, [], 'root');
    const deviceId = `device-${randomUUID()}`;

    expect(listDeviceAlertRecipients()).toEqual(expect.arrayContaining(['root', viewer]));
    expect(listDeviceAlertRecipients()).not.toContain(outsider);

    recordDeviceAlertNotification({
      deviceId,
      groupKey: `device-unreachable:${deviceId}`,
      title: 'Device unreachable',
      message: 'The device did not respond.',
      severity: 'error',
    });

    expect(listNotifications(viewer).notifications[0]).toMatchObject({
      deviceId,
      href: `/?tab=settings&stab=devices#device-${encodeURIComponent(deviceId)}`,
    });
    expect(listNotifications(outsider).notifications).toHaveLength(0);
  });

  test('notifies device managers once when a deployment becomes live', () => {
    const role = createRole({
      name: `Deployment alert role ${randomUUID()}`,
      color: '#3498db',
      permissions: serializeBits(PermissionFlag.manageDevices),
    }, 'root');
    const manager = `deployment-alert-manager-${randomUUID()}`;
    const outsider = `deployment-alert-outsider-${randomUUID()}`;
    addAllowedUser(manager, [role.id], 'root');
    addAllowedUser(outsider, [], 'root');
    const deployment = { id: `run-${randomUUID()}`, ref: 'abcdef0123456789' };

    expect(recordDeploymentReadyNotifications(deployment)).toBe(2);
    expect(recordDeploymentReadyNotifications(deployment)).toBe(0);
    expect(listNotifications(manager).notifications[0]).toMatchObject({
      title: 'dkrypt deployment is live',
      deploymentId: deployment.id,
      href: `/?tab=settings&stab=doctor#deployment-${encodeURIComponent(deployment.id)}`,
    });
    expect(listNotifications(outsider).notifications).toHaveLength(0);
  });
});

test('expired sessions do not trigger new-context risk audits', () => {
  const originalNow = Date.now;
  let now = originalNow();
  const userId = `session-risk-${randomUUID()}`;
  let firstId = '';
  let secondId = '';

  try {
    Date.now = () => now;
    const first = createSessionRecord(userId, 'browser-a', '198.51.100.17');
    firstId = first.id;
    now += 13 * 60 * 60 * 1000;
    const second = createSessionRecord(userId, 'browser-b', '203.0.113.29');
    secondId = second.id;

    expect(second.risk).toBeUndefined();
    expect(getAuditLog()).not.toContainEqual(expect.objectContaining({
      actor: userId,
      action: 'auth.session.new_context',
      target: second.id,
    }));
  } finally {
    Date.now = originalNow;
    if (firstId) revokeSessionRecord(firstId, userId);
    if (secondId) revokeSessionRecord(secondId, userId);
  }
});

test('session repository reads stay active across snapshot writes and revocation', () => {
  const userId = `session-repository-${randomUUID()}`;
  const session = createSessionRecord(userId, 'browser', '198.51.100.8');

  expect(isSessionRecordActive(session.id)).toBe(true);
  expect(listSessionsForUser(userId)).toContainEqual(session);
  recordAudit(userId, 'auth.session.new_context', session.id, 'repository persistence check');
  expect(isSessionRecordActive(session.id)).toBe(true);
  expect(revokeSessionRecord(session.id, userId)).toBe(true);
  expect(isSessionRecordActive(session.id)).toBe(false);
  expect(listSessionsForUser(userId)).toEqual([]);
});

test('audit targets redact external URLs before persistence', () => {
  const userId = `audit-target-${randomUUID()}`;
  recordAudit(userId, 'billing.webhook.sync', 'https://example.com/webhook?secret=value', 'endpoint updated');
  expect(getAuditLog().find((entry) => entry.actor === userId)).toMatchObject({ target: '[redacted-url]' });
});

test('billing checkout pause audit records the safe before and after state', () => {
  const actor = `checkout-pause-audit-${randomUUID()}`;
  const before = areNewBillingCheckoutsPaused();

  try {
    setNewBillingCheckoutsPaused(!before, actor);

    expect(getAuditLog().find((entry) => entry.actor === actor)).toMatchObject({
      action: 'billing.checkouts.pause',
      changes: [{ field: 'newCheckoutsPaused', before, after: !before }],
    });
  } finally {
    setNewBillingCheckoutsPaused(before, actor);
  }
});

test('session inventory reflects a recent session touch immediately', () => {
  const originalNow = Date.now;
  let now = originalNow();
  const userId = `session-touch-${randomUUID()}`;

  try {
    Date.now = () => now;
    const session = createSessionRecord(userId, 'browser', '198.51.100.9');
    now += 60_001;
    touchSessionRecord(session.id);

    expect(listSessionsForUser(userId)).toMatchObject([{ id: session.id, lastSeenAt: now }]);
  } finally {
    Date.now = originalNow;
  }
});

describe('shared account scope', () => {
  test('every authorized user uses the same account workspace', () => {
    const firstUser = `github:project-first-${randomUUID()}`;
    const secondUser = `github:project-second-${randomUUID()}`;
    addAllowedUser(firstUser, [], 'tester');
    addAllowedUser(secondUser, [], 'tester');
    expect(listProjectsForUser(firstUser).map((entry) => entry.id)).toEqual(['default']);
    expect(listProjectsForUser(secondUser).map((entry) => entry.id)).toEqual(['default']);
    expect(userCanAccessProject(firstUser, 'legacy-workspace')).toBe(true);
    expect(userCanAccessProject(secondUser, 'legacy-workspace')).toBe(true);
    expect(getProject('legacy-workspace')?.id).toBe('default');
  });

  test('merges historical records from legacy workspace partitions', () => {
    const sharedBundleId = `com.example.workspace-history.${randomUUID()}`;
    const finishedAt = Date.now();
    recordJobHistory({ id: `workspace-a-${randomUUID()}`, projectId: 'legacy-a', bundleId: sharedBundleId, status: 'done', source: 'manual', createdAt: finishedAt, finishedAt });
    recordJobHistory({ id: `workspace-b-${randomUUID()}`, projectId: 'legacy-b', bundleId: sharedBundleId, status: 'done', source: 'manual', createdAt: finishedAt, finishedAt });

    expect(getJobHistoryPage(0, 20, { projectId: 'legacy-a', bundleIdSearch: sharedBundleId }).entries).toHaveLength(2);
  });
});

describe('performance anomalies', () => {
  test('flags a completed job that is much slower and larger than its baseline', () => {
    const bundleId = `com.example.anomaly.${randomUUID()}`;
    const start = Date.now() - 4 * 60 * 60 * 1000;
    for (let index = 0; index < 3; index += 1) {
      const finishedAt = start + index * 60 * 60 * 1000;
      recordJobHistory({
        id: `${bundleId}-${index}`,
        bundleId,
        status: 'done',
        source: 'manual',
        createdAt: finishedAt - 12_000,
        startedAt: finishedAt - 10_000,
        finishedAt,
        sizeBytes: 10 * 1024 * 1024,
      });
    }
    const anomalousId = `${bundleId}-outlier`;
    const finishedAt = Date.now();
    recordJobHistory({
      id: anomalousId,
      bundleId,
      status: 'done',
      source: 'manual',
      createdAt: finishedAt - 130_000,
      startedAt: finishedAt - 120_000,
      finishedAt,
      sizeBytes: 20 * 1024 * 1024,
    });

    expect(getInsightsSummary().anomalies).toContainEqual(expect.objectContaining({ jobId: anomalousId, kind: 'duration-and-size' }));
  });
});

describe('Discord role perks', () => {
  test('syncs guild-scoped perks from multiple guilds', () => {
    const userId = `discord:${randomUUID()}`;
    const firstGuildId = randomUUID();
    const secondGuildId = randomUUID();
    const firstDiscordRoleId = randomUUID();
    const secondDiscordRoleId = randomUUID();
    const firstAppRole = createRole({ name: `First perk ${randomUUID()}`, color: '#5865f2', permissions: '0' }, 'tester');
    const secondAppRole = createRole({ name: `Second perk ${randomUUID()}`, color: '#57f287', permissions: '0' }, 'tester');

    addAllowedUser(userId, [], 'tester');
    setDiscordGuildIds([firstGuildId, secondGuildId], 'tester');
    createDiscordRolePerk(
      { id: firstGuildId, name: 'First guild', icon: 'first-icon' },
      { id: firstDiscordRoleId, name: 'First Discord role', color: 0x5865f2 },
      firstAppRole.id,
      'tester',
    );
    createDiscordRolePerk(
      { id: secondGuildId, name: 'Second guild', icon: null },
      { id: secondDiscordRoleId, name: 'Second Discord role', color: 0x57f287 },
      secondAppRole.id,
      'tester',
    );

    expect(getDiscordGuildIds()).toEqual([firstGuildId, secondGuildId]);
    expect(getDiscordRolePerks()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ guildId: firstGuildId, guildName: 'First guild', guildIcon: 'first-icon', discordRoleColor: 0x5865f2 }),
        expect.objectContaining({ guildId: secondGuildId, guildName: 'Second guild', guildIcon: null, discordRoleColor: 0x57f287 }),
      ]),
    );

    syncDiscordPerkRoles(userId, [
      { guildId: firstGuildId, roleIds: [firstDiscordRoleId] },
      { guildId: secondGuildId, roleIds: [] },
    ]);
    expect(listAllowedUsers().find((user) => user.username === userId)?.roleIds).toContain(firstAppRole.id);
    expect(listAllowedUsers().find((user) => user.username === userId)?.roleIds).not.toContain(secondAppRole.id);

    syncDiscordPerkRoles(userId, [
      { guildId: firstGuildId, roleIds: [] },
      { guildId: secondGuildId, roleIds: [secondDiscordRoleId] },
    ]);
    expect(listAllowedUsers().find((user) => user.username === userId)?.roleIds).not.toContain(firstAppRole.id);
    expect(listAllowedUsers().find((user) => user.username === userId)?.roleIds).toContain(secondAppRole.id);
  });
});

describe('exportBackup / importBackup', () => {
  test('restoring legacy app watches preserves them as disabled compatibility records', () => {
    const watch = legacyAppWatch();
    const backup = exportBackup();
    backup.watches = [watch];

    expect(importBackup(backup, 'tester').ok).toBe(true);
    expect(exportBackup().watches.find((entry) => entry.id === watch.id)).toMatchObject({ enabled: false });
  });

  test('round-trips public TestFlight subscriptions with per-device state', () => {
    const userId = `testflight-${randomUUID()}`;
    const subscription = createTestFlightSubscription({
      url: 'https://testflight.apple.com/join/AbC123',
      inviteCode: 'AbC123',
      requestedBy: userId,
      status: 'pending',
      appId: 123,
      bundleId: 'com.example.testflight',
      displayName: 'TestFlight app',
    }, userId);
    expect(denyTestFlightSubscription(subscription.id, 'manager')).toMatchObject({ status: 'denied' });
    expect(approveTestFlightSubscription(subscription.id, 'manager')).toBeUndefined();

    const second = createTestFlightSubscription({
      url: 'https://testflight.apple.com/join/ZyX987',
      inviteCode: 'ZyX987',
      requestedBy: userId,
      status: 'pending',
      appId: 456,
      bundleId: 'com.example.second',
      displayName: 'Second app',
    }, userId);
    updateTestFlightSubscriptionDevice(second.id, 'device-for-backup', {
      status: 'active',
      appleMembership: 'accepted',
      lastVerifiedAt: Date.now(),
    });
    const backup = exportBackup();
    expect(backup.testFlightSubscriptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: second.id, devices: [expect.objectContaining({ deviceId: 'device-for-backup', status: 'active' })] }),
    ]));

    expect(importBackup(backup, 'tester').ok).toBe(true);
    expect(getTestFlightSubscription(second.id)).toMatchObject({ status: 'pending', devices: [expect.objectContaining({ deviceId: 'device-for-backup', status: 'active' })] });
  });

  test('round-trips passkey credentials without exposing their public key in account listings', () => {
    const userId = `passkey-${randomUUID()}`;
    const credential = addPasskey({
      id: Buffer.from(randomUUID()).toString('base64url'),
      userId,
      publicKey: Buffer.from(`public-key-${randomUUID()}`).toString('base64url'),
      counter: 7,
      transports: ['internal'],
      name: 'Test device',
      createdAt: Date.now(),
    });
    const backup = exportBackup();
    expect(backup.passkeys).toContainEqual(expect.objectContaining({ id: credential.id, userId, counter: 7 }));
    expect(listPasskeysForUser(userId)).toContainEqual(expect.objectContaining({ id: credential.id, publicKey: credential.publicKey }));
    expect(deletePasskey(userId, credential.id)).toBe(true);
    expect(importBackup(backup, 'tester').ok).toBe(true);
    expect(listPasskeysForUser(userId)).toContainEqual(expect.objectContaining({ id: credential.id, counter: 7 }));
  });

  test('round-trips the allowlist through export and import', () => {
    const role = createRole({ name: 'Roundtrip Role', color: '#5865f2', permissions: serializeBits(PermissionFlag.requestDecrypt) }, 'tester');
    addAllowedUser('roundtrip-user', [role.id], 'tester');
    const backup = exportBackup();

    expect(backup.backupVersion).toBe(11);
    expect(backup.allowedUsers.some((u) => u.username === 'roundtrip-user')).toBe(true);
    expect(backup).not.toHaveProperty('projects');

    const result = importBackup(backup, 'tester');
    expect(result.ok).toBe(true);
    expect(listAllowedUsers().some((u) => u.username === 'roundtrip-user')).toBe(true);
    expect(getRole(role.id)).toMatchObject({ id: role.id, name: 'Roundtrip Role' });
    expect(listProjectsForUser('roundtrip-user')).toEqual([expect.objectContaining({ id: 'default', name: 'dkrypt', memberIds: [] })]);
  });

  test('restoring an older backup does not carry quota usage from the current installation', () => {
    const database = openStateCollectionDatabase({
      stateDir: config.stateDir,
      filename: config.stateDatabaseFile,
      busyTimeoutMs: config.stateDbBusyTimeoutMs,
    }, ['decrypt_quota_ledger']);
    const previousRows = database.query('SELECT job_id, owner_id, admitted_at, state FROM decrypt_quota_ledger').all() as Array<{ job_id: string; owner_id: string; admitted_at: number; state: string }>;
    const insert = database.query('INSERT INTO decrypt_quota_ledger (job_id, owner_id, admitted_at, state) VALUES (?, ?, ?, ?)');

    try {
      database.exec('DELETE FROM decrypt_quota_ledger');
      insert.run('quota-from-current-installation', 'quota-owner', Date.now(), 'consumed');
      const currentBackup = exportBackup();
      const olderBackup = {
        ...currentBackup,
        backupVersion: 9,
        projects: [{ id: 'default', name: 'Workspace', memberIds: [], isDefault: true, createdBy: 'system', createdAt: 1, updatedAt: 1 }],
        artifactProjectLinks: [],
        jobHistory: currentBackup.jobHistory.map((entry) => ({ ...entry, projectId: 'default' })),
      } as Record<string, unknown>;
      delete olderBackup.decryptQuotaLedger;

      expect(importBackup(olderBackup, 'tester').ok).toBe(true);
      expect(exportBackup().decryptQuotaLedger).toEqual([]);
    } finally {
      database.exec('DELETE FROM decrypt_quota_ledger');
      for (const row of previousRows) insert.run(row.job_id, row.owner_id, row.admitted_at, row.state);
      database.close();
    }
  });

  test('rejects backup watches with invalid recurring quiet hours', () => {
    const backup = exportBackup();
    backup.watches = [legacyAppWatch({ maintenanceWindow: { start: '22:00', end: '22:00' } })];

    const result = importBackup(backup, 'tester');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/watches/);
  });

  test('rejects backup watches with an unsupported missed-run policy', () => {
    const backup = exportBackup();
    backup.watches = [legacyAppWatch({ missedRunPolicy: 'replayAll' as unknown as 'skip' })];

    const result = importBackup(backup, 'tester');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/watches/);
  });

  test('restores legacy project data into the shared account scope', () => {
    const legacyProjectId = `legacy-${randomUUID()}`;
    const database = openStateCollectionDatabase({
      stateDir: config.stateDir,
      filename: config.stateDatabaseFile,
      busyTimeoutMs: config.stateDbBusyTimeoutMs,
    }, ['jobs']);
    const previousJobs = readStateCollection(database, 'jobs');
    const previousRows = previousJobs.flatMap((value) => {
      if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).id !== 'string') return [];
      const row = value as Record<string, unknown>;
      return [{ id: row.id as string, payload: value, updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now() }];
    });
    const jobId = `backup-job-${randomUUID()}`;

    try {
      replaceStateCollection(database, 'jobs', [
        ...previousRows,
        { id: jobId, payload: { id: jobId, projectId: legacyProjectId, status: 'queued' }, updatedAt: Date.now() },
      ]);
      const backup = {
        ...exportBackup(),
        backupVersion: 10,
        projects: [
          { id: 'default', name: 'dkrypt', memberIds: [], isDefault: true, createdBy: 'root', createdAt: Date.now(), updatedAt: Date.now() },
          { id: legacyProjectId, name: 'Legacy', memberIds: [], isDefault: false, createdBy: 'root', createdAt: Date.now(), updatedAt: Date.now() },
        ],
        jobHistory: [{ id: jobId, projectId: legacyProjectId, bundleId: 'com.example.legacy', status: 'done', finishedAt: Date.now() }],
        artifactProjectLinks: [],
      } as unknown as ReturnType<typeof exportBackup>;

      expect(importBackup(backup, 'tester').ok).toBe(true);
      expect(listProjectsForUser('tester')).toEqual([expect.objectContaining({ id: 'default', name: 'dkrypt' })]);
      expect(getJobHistoryEntryById(jobId)).toMatchObject({ id: jobId, projectId: 'default' });
    } finally {
      replaceStateCollection(database, 'jobs', previousRows);
      database.close();
    }
  });

  test('rejects a backup with the wrong version', () => {
    const backup = exportBackup();
    const result = importBackup({ ...backup, backupVersion: 99 }, 'tester');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/version/);
  });

  test('rejects backups that try to restore an obsolete connection directory', () => {
    const backup = exportBackup();
    const result = importBackup({
      ...backup,
      devices: [{ id: 'legacy-device', name: 'legacy', rootDir: '/root/.ipadecrypt', enabled: true }],
    }, 'tester');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/devices/);
  });

  test('rejects a backup with a malformed allowedUsers entry', () => {
    const backup = exportBackup();
    const result = importBackup({ ...backup, allowedUsers: [{ username: 'bad' }] }, 'tester');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/allowedUsers/);
  });

  test('rejects case-colliding account names before restoring any data', () => {
    const backup = exportBackup();
    const username = `backup-user-${randomUUID()}`;
    const allowedUsers = [
      { username, roleIds: [], addedAt: Date.now() },
      { username: username.toUpperCase(), roleIds: [], addedAt: Date.now() },
    ];
    const before = exportBackup();

    const result = importBackup({ ...backup, allowedUsers }, 'tester');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/duplicate usernames/);
    expect(exportBackup().allowedUsers).toEqual(before.allowedUsers);
  });

  test('rejects multiple default roles before restoring any data', () => {
    const backup = exportBackup();
    const defaultRole = backup.roles.find((role) => role.isDefault)!;
    const tampered = {
      ...backup,
      roles: [...backup.roles, { ...defaultRole, id: randomUUID() }],
    };
    const before = exportBackup();

    const result = importBackup(tampered, 'tester');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/at most one default role/);
    expect(exportBackup().roles).toEqual(before.roles);
  });

  test('rejects a non-object payload', () => {
    expect(importBackup(null, 'tester').ok).toBe(false);
    expect(importBackup('not json', 'tester').ok).toBe(false);
  });

  test('strips any plaintext pendingReveal from imported API keys', () => {
    const backup = exportBackup();
    const tampered = {
      ...backup,
      apiKeys: [
        {
          id: 'k1',
          name: 'sneaky',
          ownerId: 'root',
          status: 'approved' as const,
          createdAt: Date.now(),
          pendingReveal: 'should-not-survive-import',
        },
      ],
    };
    const result = importBackup(tampered, 'tester');
    expect(result.ok).toBe(true);
    const reExported = exportBackup();
    const key = reExported.apiKeys.find((k) => k.id === 'k1');
    expect(key?.pendingReveal).toBeUndefined();
  });

  test('round-trips OAuth profiles and Stripe subscriptions', () => {
    const userId = `github:${randomUUID()}`;
    upsertAuthProfile({
      userId,
      provider: 'github',
      providerId: randomUUID(),
      username: 'billing-user',
      displayName: 'Billing User',
      email: 'billing@example.com',
      updatedAt: new Date().toISOString(),
    });
    upsertBillingCustomer({
      provider: 'stripe',
      customerId: 'ctm_backup',
      email: 'billing@example.com',
      userId,
      updatedAt: new Date().toISOString(),
    });
    upsertBillingSubscription({
      provider: 'stripe',
      subscriptionId: 'sub_backup',
      customerId: 'ctm_backup',
      userId,
      status: 'active',
      planId: 'api',
      priceId: 'pri_backup',
      productId: 'pro_backup',
      occurredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const backup = exportBackup();

    replaceIdentitySnapshot({ profiles: [] });
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    expect(importBackup(backup, 'tester').ok).toBe(true);

    expect(getAuthProfile(userId)?.email).toBe('billing@example.com');
    expect(getBillingCustomerId(userId)).toBe('ctm_backup');
    expect(listBillingSubscriptions()).toContainEqual(expect.objectContaining({ subscriptionId: 'sub_backup', userId }));
    expect(listBillingEntitlementHistory('sub_backup')).toContainEqual(expect.objectContaining({ subscriptionId: 'sub_backup', kind: 'grant' }));
    const stateMirror = JSON.parse(readFileSync(path.join(config.stateDir, 'state.json'), 'utf8')) as { auditLog: Array<{ action: string }> };
    const billingMirror = JSON.parse(readFileSync(path.join(config.stateDir, 'billing.json'), 'utf8')) as { subscriptions: Array<{ subscriptionId: string }> };
    const identityMirror = JSON.parse(readFileSync(path.join(config.stateDir, 'identities.json'), 'utf8')) as { profiles: Array<{ userId: string }> };
    expect(stateMirror.auditLog[0]?.action).toBe('state.import');
    expect(billingMirror.subscriptions).toContainEqual(expect.objectContaining({ subscriptionId: 'sub_backup' }));
    expect(identityMirror.profiles).toContainEqual(expect.objectContaining({ userId }));
  });

  test('keeps the live state, billing, and identities unchanged when the restore transaction fails', () => {
    const database = openStateCollectionDatabase({
      stateDir: config.stateDir,
      filename: config.stateDatabaseFile,
      busyTimeoutMs: config.stateDbBusyTimeoutMs,
    }, ['billing_records']);
    const trigger = `fail_backup_import_${randomUUID().replaceAll('-', '')}`;
    const before = exportBackup();
    const incoming = structuredClone(before);
    const rejectedUser = `atomic-restore-${randomUUID()}`;
    incoming.allowedUsers.push({ username: rejectedUser, addedAt: Date.now(), roleIds: [] });

    try {
      database.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON billing_records BEGIN SELECT RAISE(ABORT, 'forced restore failure'); END;`);
      const result = importBackup(incoming, 'tester');

      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('forced restore failure') });
      expect(exportBackup().allowedUsers).toEqual(before.allowedUsers);
      expect(exportBillingSnapshot()).toEqual(before.billing);
      expect(exportIdentitySnapshot()).toEqual(before.identities);
      const storedState = database.query('SELECT payload FROM state_snapshots WHERE id = 1').get() as { payload: string };
      expect((JSON.parse(storedState.payload) as { allowedUsers: Array<{ username: string }> }).allowedUsers).not.toContainEqual(expect.objectContaining({ username: rejectedUser }));
    } finally {
      database.exec(`DROP TRIGGER IF EXISTS ${trigger};`);
      database.close();
    }
  });

  test('backup integrity survives dashboard session-secret rotation', () => {
    const entry = createBackupSnapshot('manual', 'backup-rotation-test');
    const originalSecret = config.sessionSigningSecret;

    try {
      config.sessionSigningSecret = `${originalSecret}-rotated`;
      expect(drillBackupSnapshot(entry.id, 'backup-rotation-test')?.status).toBe('passed');
    } finally {
      config.sessionSigningSecret = originalSecret;
      deleteBackupSnapshot(entry.id, 'backup-rotation-test');
    }
  });

  test('backup integrity survives manifest-key rotation while the previous key is retained', () => {
    const entry = createBackupSnapshot('manual', 'backup-key-rotation-test');
    const originalCurrent = config.backupManifestSecret;
    const originalPrevious = config.backupManifestSecretPrevious;

    try {
      config.backupManifestSecret = `${originalCurrent}-rotated`;
      config.backupManifestSecretPrevious = [originalCurrent, ...originalPrevious];
      expect(drillBackupSnapshot(entry.id, 'backup-key-rotation-test')?.status).toBe('passed');
    } finally {
      config.backupManifestSecret = originalCurrent;
      config.backupManifestSecretPrevious = originalPrevious;
      deleteBackupSnapshot(entry.id, 'backup-key-rotation-test');
    }
  });

  test('snapshot JSON and SQLite include state mutations pending the periodic flush', () => {
    const usageKey = `backup-consistency-${randomUUID()}`;
    recordApiKeyBundleUsage(usageKey, 'com.example.pending');
    const entry = createBackupSnapshot('manual', 'backup-consistency-test');
    const jsonPath = path.join(config.stateDir, 'backups', entry.filename);
    const databasePath = path.join(config.stateDir, 'backups', entry.databaseFilename!);
    const payload = JSON.parse(readFileSync(jsonPath, 'utf8')) as { apiKeyBundleUsage: Record<string, Record<string, number>> };
    const database = openStateDatabase({ stateDir: path.dirname(databasePath), filename: path.basename(databasePath) });

    try {
      const stored = database.readState() as { apiKeyBundleUsage: Record<string, Record<string, number>> };
      expect(payload.apiKeyBundleUsage[usageKey]).toEqual({ 'com.example.pending': 1 });
      expect(stored.apiKeyBundleUsage[usageKey]).toEqual(payload.apiKeyBundleUsage[usageKey]);
      expect(entry.restoreDrillStatus).toBe('passed');
    } finally {
      database.close();
      deleteBackupSnapshot(entry.id, 'backup-consistency-test');
    }
  });

  test('backup snapshot and restore drill metadata stay available through the typed repository', () => {
    const entry = createBackupSnapshot('manual', 'backup-repository-test');
    const database = openStateDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile });

    try {
      const repository = createBackupRepository(database.db);
      expect(repository.findById(entry.id)).toEqual(entry);
      expect(drillBackupSnapshot(entry.id, 'backup-repository-test')?.status).toBe('passed');
      expect(repository.findById(entry.id)).toMatchObject({
        id: entry.id,
        restoreDrillStatus: 'passed',
        restoreDrillAt: expect.any(Number),
      });
    } finally {
      database.close();
      deleteBackupSnapshot(entry.id, 'backup-repository-test');
    }
  });

  test('snapshot creation keeps its committed history when a legacy state mirror cannot be written', () => {
    const mirrorPath = path.join(config.stateDir, 'state.json');
    const preservedMirrorPath = `${mirrorPath}.${randomUUID()}.saved`;
    const hadMirror = existsSync(mirrorPath);
    if (hadMirror) renameSync(mirrorPath, preservedMirrorPath);
    mkdirSync(mirrorPath);
    let entry: ReturnType<typeof createBackupSnapshot> | undefined;

    try {
      entry = createBackupSnapshot('manual', 'backup-mirror-failure-test');
      expect(entry.restoreDrillStatus).toBe('passed');
      expect(readFileSync(path.join(config.stateDir, 'backups', entry.filename), 'utf8')).toContain('backupVersion');
      expect(readdirSync(config.stateDir).some((filename) => filename.startsWith('state.json.') && filename.endsWith('.tmp'))).toBe(false);
    } finally {
      rmSync(mirrorPath, { recursive: true, force: true });
      if (hadMirror) renameSync(preservedMirrorPath, mirrorPath);
      if (entry) deleteBackupSnapshot(entry.id, 'backup-mirror-failure-test');
    }
  });
});

describe('API subscription entitlement', () => {
  test('rejects a stored user key until the owner has API permission', () => {
    const username = `api-viewer-${randomUUID()}`;
    addAllowedUser(username, [], 'tester');
    const created = createApiKey('subscription-gated', username);

    expect(verifyApiKey(created.key)).toBeUndefined();

    const role = createRole({
      name: `API ${randomUUID()}`,
      color: '#5865f2',
      permissions: serializeBits(PermissionFlag.createApiKeys),
    }, 'tester');
    updateAllowedUserRoles(username, [role.id], 'tester');

    expect(verifyApiKey(created.key)).toMatchObject({ ownerId: username });
  });

  test('created API keys and last-used details are available through the persistent key repository', () => {
    const name = `repository-key-${randomUUID()}`;
    const created = createApiKey(name, 'root');
    const hash = createHash('sha256').update(created.key).digest('hex');
    const database = openStateDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile });

    try {
      const repository = createApiKeyRepository(database.db);
      expect(repository.findApprovedByHash(hash, Date.now())).toMatchObject({ id: created.id, name });
      expect(verifyApiKey(created.key, '192.0.2.15')).toMatchObject({ keyId: created.id });
      expect(repository.findApprovedByHash(hash, Date.now())).toMatchObject({ lastUsedIp: '192.0.2.15' });
      expect(listAllApiKeysPage(0, 10, name).keys.map((key) => key.id)).toContain(created.id);
    } finally {
      database.close();
      revokeApiKey(created.id, 'root', true);
    }
  });
});

describe('paid dashboard entitlement', () => {
  test('grants Regular decrypt access without assigning a named role', () => {
    const username = `paid-member-${randomUUID()}`;
    const now = new Date().toISOString();
    const previousBilling = exportBillingSnapshot();
    replaceBillingSnapshot({ customers: [], subscriptions: [] });

    try {
      const user = addAllowedUser(username, [], 'tests');
      upsertBillingSubscription({
        provider: 'stripe',
        subscriptionId: `sub_${randomUUID()}`,
        customerId: `cus_${randomUUID()}`,
        userId: username,
        status: 'active',
        planId: 'regular',
        priceId: 'price_regular_test',
        productId: 'prod_regular_test',
        occurredAt: now,
        updatedAt: now,
      });

      expect(user.roleIds).toEqual([]);
      expect(getBillingEntitlements(username)).toMatchObject({ planId: 'regular', decrypt: true, api: false, priority: 0 });
      expect(hasPermission(getUserEffectivePermissions(username), PermissionFlag.requestDecrypt)).toBeTrue();
    } finally {
      replaceBillingSnapshot(previousBilling);
      removeAllowedUser(username, 'tests');
    }
  });
});

describe('device CRUD primary invariant', () => {
  test('device updates audit safe structured changes without recording connection identifiers', () => {
    const actor = `device-audit-${randomUUID()}`;
    const udid = randomUUID();
    const device = createDevice({ name: 'Audit iPad', transport: 'usb', udid }, actor);

    try {
      updateDevice(device.id, { name: 'Renamed iPad', iosVersion: '18.1' }, actor);

      expect(getAuditLog().find((entry) => entry.actor === actor && entry.action === 'device.update')).toMatchObject({
        target: device.id,
        changes: [
          { field: 'name', before: 'Audit iPad', after: 'Renamed iPad' },
          { field: 'iosVersion', before: null, after: '18.1' },
        ],
      });
      expect(JSON.stringify(getAuditLog().find((entry) => entry.actor === actor && entry.action === 'device.update'))).not.toContain(udid);
    } finally {
      deleteDevice(device.id, actor);
    }
  });

  test('exactly one enabled device stays primary through add/update/delete', () => {
    const a = createDevice({ name: 'device-a', transport: 'wifi', host: '192.168.1.10' }, 'tester');
    expect(a.isPrimary).toBe(true);
    expect(getEffectiveDevices()).toEqual([expect.objectContaining({ id: a.id, host: '192.168.1.10' })]);

    const b = createDevice({ name: 'device-b', transport: 'wifi', host: '192.168.1.11' }, 'tester');
    expect(b.isPrimary).toBeFalsy();

    updateDevice(b.id, { isPrimary: true }, 'tester');
    const afterPromote = getEffectiveDevices();
    expect(afterPromote.find((d) => d.id === a.id)?.isPrimary).toBeFalsy();
    expect(afterPromote.find((d) => d.id === b.id)?.isPrimary).toBe(true);

    deleteDevice(b.id, 'tester');
    expect(getEffectiveDevices().some((d) => d.isPrimary)).toBe(true);

    deleteDevice(a.id, 'tester');
    expect(getEffectiveDevices()).toEqual([]);
  });

  test('primary selection ignores disabled devices, falls back on disable, and survives a process restart', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-primary-'));
    const createDevices = `
      import { createDevice, getEffectiveDevices, updateDevice } from './src/store/state.ts';
      createDevice({ name: 'disabled-first', transport: 'wifi', host: '192.168.1.10', enabled: false }, 'tester');
      const second = createDevice({ name: 'enabled-second', transport: 'wifi', host: '192.168.1.11', enabled: true }, 'tester');
      createDevice({ name: 'enabled-third', transport: 'wifi', host: '192.168.1.12', enabled: true }, 'tester');
      createDevice({ name: 'enabled-fourth', transport: 'wifi', host: '192.168.1.13', enabled: true }, 'tester');
      updateDevice(second.id, { enabled: false }, 'tester');
      console.log(JSON.stringify(getEffectiveDevices()));
    `;
    const deletePrimary = `
      import { deleteDevice, getEffectiveDevices } from './src/store/state.ts';
      const primary = getEffectiveDevices().find((device) => device.isPrimary);
      if (!primary || !deleteDevice(primary.id, 'tester')) throw new Error('primary device could not be deleted');
      console.log(JSON.stringify(getEffectiveDevices()));
    `;
    const reloadDevices = `
      import { getEffectiveDevices } from './src/store/state.ts';
      console.log(JSON.stringify(getEffectiveDevices()));
    `;

    async function runStateProcess(source: string): Promise<Array<{ id: string; name: string; enabled: boolean; isPrimary?: boolean }>> {
      const child = Bun.spawn([process.execPath, '-e', source], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          API_KEY: 'device-primary-api-key',
          SESSION_SIGNING_SECRET: 'device-primary-session-secret',
          ADMIN_PASSWORD: 'device-primary-admin-password',
          STATE_DIR: stateDir,
          STATE_DATABASE_FILE: 'state.sqlite',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`device state process failed: ${stderr}`);
      return JSON.parse(stdout) as Array<{ id: string; name: string; enabled: boolean; isPrimary?: boolean }>;
    }

    try {
      const created = await runStateProcess(createDevices);
      const afterDelete = await runStateProcess(deletePrimary);
      const reloaded = await runStateProcess(reloadDevices);

      expect(created.filter((device) => device.enabled && device.isPrimary).map((device) => device.name)).toEqual(['enabled-third']);
      expect(created.filter((device) => !device.enabled && device.isPrimary)).toEqual([]);
      expect(afterDelete.find((device) => device.name === 'enabled-third')).toBeUndefined();
      expect(afterDelete.filter((device) => device.enabled && device.isPrimary).map((device) => device.name)).toEqual(['enabled-fourth']);
      expect(reloaded).toEqual(afterDelete);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test('settings mutations persist through the typed SQLite settings collection', () => {
  const previousRetentionDays = getEffectiveSettings().jobHistoryRetentionDays;
  const database = openStateDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile });

  try {
    updateSettings({ jobHistoryRetentionDays: 37 });
    expect(readStateCollection(database.db, 'settings')).toContainEqual({ key: 'jobHistoryRetentionDays', value: 37 });
  } finally {
    database.close();
    updateSettings({ jobHistoryRetentionDays: previousRetentionDays });
  }
});

test('backup schedule mutations persist through the typed SQLite collection', () => {
  const previousSchedule = getBackupSchedule();
  const schedule = { enabled: true, cron: '15 4 * * *', retentionCount: 9 };
  const database = openStateDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile });

  try {
    setBackupSchedule(schedule, 'repository-test');
    expect(readStateCollection(database.db, 'backup_schedule')).toEqual([schedule]);
  } finally {
    database.close();
    setBackupSchedule(previousSchedule, 'repository-test');
  }
});

describe('job history retention', () => {
  test('updates an existing history record by job ID without creating duplicate rows', () => {
    const id = randomUUID();
    const initial = { id, bundleId: 'com.example.history-update', status: 'done' as const, source: 'manual' as const, createdAt: Date.now(), finishedAt: Date.now() };
    recordJobHistory(initial);
    recordJobHistory({ ...initial, status: 'failed', error: 'job deadline exceeded', finishedAt: Date.now() + 1 });

    expect(getAllJobHistory().filter((entry) => entry.id === id)).toHaveLength(1);
    expect(getJobHistoryEntryById(id)).toMatchObject({ status: 'failed', error: 'job deadline exceeded' });
  });

  test('jobHistoryRetentionDays filters out entries older than the window on the next write', () => {
    updateSettings({ jobHistoryRetentionDays: 1 });
    try {
      const old = { id: randomUUID(), bundleId: 'com.example.old', status: 'done' as const, source: 'manual' as const, createdAt: 0, finishedAt: Date.now() - 2 * 86_400_000 };
      recordJobHistory(old);
      const fresh = { id: randomUUID(), bundleId: 'com.example.fresh', status: 'done' as const, source: 'manual' as const, createdAt: Date.now(), finishedAt: Date.now() };
      recordJobHistory(fresh);

      const all = getAllJobHistory();
      expect(all.some((e) => e.id === old.id)).toBe(false);
      expect(all.some((e) => e.id === fresh.id)).toBe(true);
    } finally {
      updateSettings({ jobHistoryRetentionDays: 0 });
    }
  });

  test('previews job history pruning without mutating the current history', () => {
    const now = Date.now();
    updateSettings({ jobHistoryRetentionDays: 0 });
    const old = {
      id: randomUUID(),
      bundleId: 'com.example.preview-old',
      status: 'done' as const,
      source: 'manual' as const,
      createdAt: now - 90 * 86_400_000,
      finishedAt: now - 90 * 86_400_000,
    };
    const fresh = {
      id: randomUUID(),
      bundleId: 'com.example.preview-fresh',
      status: 'done' as const,
      source: 'manual' as const,
      createdAt: now,
      finishedAt: now,
    };
    recordJobHistory(old);
    recordJobHistory(fresh);

    const before = getAllJobHistory().map((entry) => entry.id);
    const preview = previewJobHistoryRetention(30, now);
    const cutoff = now - 30 * 86_400_000;
    const expectedRemoved = getAllJobHistory().filter((entry) => entry.finishedAt < cutoff).length;
    const expectedRetained = getAllJobHistory().length - expectedRemoved;

    expect(preview).toMatchObject({ retentionDays: 30, cutoff, removed: expectedRemoved, retained: expectedRetained });
    expect(getAllJobHistory().map((entry) => entry.id)).toEqual(before);
  });

  test('simulates both age pruning and the 100-entry cap on the next write', () => {
    const now = Date.now();
    const entries = Array.from({ length: 100 }, (_, index) => ({
      id: `retention-preview-${index}`,
      bundleId: 'com.example.retention-preview',
      status: 'done' as const,
      source: 'manual' as const,
      createdAt: index >= 95 ? now - 40 * 86_400_000 : now - index * 1_000,
      finishedAt: index >= 95 ? now - 40 * 86_400_000 : now - index * 1_000,
    }));

    expect(simulateJobHistoryRetention(entries, 30, now)).toMatchObject({
      currentEntries: 100,
      retained: 95,
      removed: 5,
      agePruned: 4,
      capacityPruned: 1,
      afterNextWrite: 96,
      maxEntries: 100,
    });
    expect(simulateJobHistoryRetention(entries, 0, now)).toMatchObject({
      retained: 99,
      removed: 1,
      agePruned: 0,
      capacityPruned: 1,
      afterNextWrite: 100,
    });
  });
});

describe('webhook delivery log', () => {
  test('records deliveries newest-first and exposes kind/event/targetHost', () => {
    recordWebhookDelivery({ kind: 'scheduler', event: 'dispatchSuccess', targetHost: 'discord.com', ok: true, status: 200, durationMs: 12 });
    recordWebhookDelivery({ kind: 'job', event: 'job.completed', targetHost: 'example.com', ok: false, error: 'timeout', durationMs: 500 });

    const log = getWebhookDeliveryLog(2);
    expect(log[0].kind).toBe('job');
    expect(log[0].ok).toBe(false);
    expect(log[1].kind).toBe('scheduler');
    expect(log[1].targetHost).toBe('discord.com');
  });
});

describe('device health history', () => {
  test('counts repeated reachability changes within a time bucket', () => {
    const deviceId = `flap-${crypto.randomUUID()}`;
    recordDeviceHealthCheck(deviceId, true);
    recordDeviceHealthCheck(deviceId, false);
    recordDeviceHealthCheck(deviceId, true);
    expect(getDeviceHealthHourlyBuckets(deviceId, 1)[0]?.transitions).toBe(2);
  });
  test('returns undefined uptime before any check has ever been recorded', () => {
    expect(getDeviceUptimePercent('unused-device')).toBeUndefined();
  });

  test('buckets checks by hour and computes an overall uptime percent', () => {
    recordDeviceHealthCheck('device-a', true);
    recordDeviceHealthCheck('device-a', true);
    recordDeviceHealthCheck('device-a', false);

    const buckets = getDeviceHealthHourlyBuckets('device-a', 2);
    expect(buckets).toHaveLength(2);
    expect(buckets.some((b) => b.reachablePercent !== null)).toBe(true);

    const uptime = getDeviceUptimePercent('device-a', 2);
    expect(uptime).toBeCloseTo(2 / 3);
  });

  test('restores the consecutive failure count from persisted history', () => {
    recordDeviceHealthCheck('device-persisted-failures', false);
    recordDeviceHealthCheck('device-persisted-failures', false);
    expect(getConsecutiveDeviceHealthFailures('device-persisted-failures')).toBe(2);
    recordDeviceHealthCheck('device-persisted-failures', true);
    expect(getConsecutiveDeviceHealthFailures('device-persisted-failures')).toBe(0);
  });

  test('stores subsystem transitions, carries stable timestamps, and treats first observations as baselines', () => {
    const deviceId = `device-transitions-${crypto.randomUUID()}`;
    let now = 10_000;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      recordDeviceHealthCheck(deviceId, true, undefined, undefined, undefined, {
        states: { usb: 'ready', agent: 'ready' },
        reasons: { agent: 'Agent responded to the health check.' },
      });
      expect(getDeviceSubsystemDetails(deviceId, { usb: 'ready', agent: 'ready' })).toMatchObject({
        usb: { state: 'ready' },
        agent: { state: 'ready', reason: 'Agent responded to the health check.' },
      });
      expect(getDeviceSubsystemDetails(deviceId, { usb: 'ready' })?.usb?.lastChangedAt).toBeUndefined();

      now = 20_000;
      recordDeviceHealthCheck(deviceId, true, undefined, undefined, undefined, {
        states: { usb: 'ready', agent: 'offline' },
        reasons: { agent: 'device agent is unavailable' },
      });
      expect(getDeviceSubsystemDetails(deviceId, { agent: 'offline' })?.agent).toEqual({
        state: 'offline',
        lastChangedAt: 20_000,
        reason: 'device agent is unavailable',
      });

      now = 30_000;
      recordDeviceHealthCheck(deviceId, true, undefined, undefined, undefined, {
        states: { usb: 'ready', agent: 'offline' },
      });
      expect(getDeviceSubsystemDetails(deviceId, { agent: 'offline' })?.agent).toEqual({
        state: 'offline',
        lastChangedAt: 20_000,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test('old health samples remain valid and do not manufacture transition times', () => {
    const deviceId = `device-old-health-${crypto.randomUUID()}`;
    recordDeviceHealthCheck(deviceId, true);
    recordDeviceHealthCheck(deviceId, true, undefined, undefined, undefined, { states: { appStore: 'idle' } });
    expect(getDeviceSubsystemDetails(deviceId, { appStore: 'idle' })?.appStore?.lastChangedAt).toBeUndefined();
  });
});
