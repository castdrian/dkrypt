import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateVAPIDKeys, type VapidKeys } from 'web-push';
import { config } from '#config.js';
import type { DeviceTransport } from '#apiCommonContracts.js';
import {
  exportBillingSnapshot,
  getBillingEntitlements,
  isBillingSnapshot,
  replaceBillingSnapshot,
  billingSnapshotCollections,
  writeBillingSnapshotMirror,
  type BillingSnapshot,
} from '#billing.js';
import { emitHistoryAdded } from '#events.js';
import {
  exportIdentitySnapshot,
  isIdentitySnapshot,
  replaceIdentitySnapshot,
  identitySnapshotCollections,
  writeIdentitySnapshotMirror,
  type IdentitySnapshot,
} from '#identity.js';
import { log } from '#logger.js';
import type { JobExecutionPath, JobTimelineEvent, TestFlightJobSource } from '#jobs/types.js';
import { exportDecryptQuotaLedger } from '#jobs/repository.js';
import { createAccountRepository, isAllowedUserRecord, isRoleRecord, isUserMfaRecord, validateAccountCollections, type AccountCollections } from '#store/accountRepository.js';
import { createBillingRepository } from '#store/billingRepository.js';
import { createApiKeyRepository, isApiKeyRecordShape } from '#store/apiKeyRepository.js';
import { createBackupRepository } from '#store/backupRepository.js';
import { createBackupScheduleRepository } from '#store/backupScheduleRepository.js';
import { categorizeFailure, type JobFailureClass } from '#util/failureCategory.js';
import { combineBits, hasPermission, parseBits, PermissionFlag, serializeBits } from '#permissions.js';
import { createDeviceRepository } from '#store/deviceRepository.js';
import { createProjectRepository, isProjectRecordShape } from '#store/projectRepository.js';
import { createSchedulerRunRepository } from '#store/schedulerRunRepository.js';
import { createDeviceHistoryRepository } from '#store/deviceHistoryRepository.js';
import { createDeviceHealthRepository } from '#store/deviceHealthRepository.js';
import { createNotificationRepository } from '#store/notificationRepository.js';
import { createAuditRepository } from '#store/auditRepository.js';
import { createTestFlightSubscriptionRepository } from '#store/testFlightSubscriptionRepository.js';
import { createJobHistoryRepository } from '#store/jobHistoryRepository.js';
import { createSessionRepository } from '#store/sessionRepository.js';
import { createSettingsRepository } from '#store/settingsRepository.js';
import { createWatchRepository, isAppWatchRecord } from '#store/watchRepository.js';
import { firstStateOwnedCollectionMismatch, openStateDatabase, readStateCollection, stableJson, verifyDatabaseBackup, writeStateMirror, type StateCollectionReplacement, type StateDatabase } from '#store/sqlite.js';
import { paginateCursor } from '#util/cursor.js';
import type { MaintenanceWindow } from '#util/maintenanceWindow.js';

export type ApiKeyStatus = 'pending' | 'approved' | 'denied';

export interface ApiKeyOutcomeUsage {
  route: string;
  success: number;
  clientError: number;
  serverError: number;
  lastAt: number;
}

export interface Role {
  id: string;
  name: string;
  color: string;

  permissions: string;
  position: number;

  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description?: string;
  memberIds: string[];
  isDefault: boolean;
  archivedAt?: number;
  storageQuotaBytes?: number;
  dailyJobQuota?: number;
  maxConcurrentJobs?: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_PROJECT_ID = 'default';

function createDefaultProject(now = Date.now()): ProjectRecord {
  return {
    id: DEFAULT_PROJECT_ID,
    name: 'dkrypt',
    memberIds: [],
    isDefault: true,
    createdBy: 'system',
    createdAt: now,
    updatedAt: now,
  };
}

export const DEFAULT_ROLE_ID = 'everyone';

const DEFAULT_ROLE_COLOR = '#99aab5';
export const ROLE_COLOR_PRESETS = ['#99aab5', '#1abc9c', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#5865f2', '#2ecc71'];

function seedDefaultRole(now: number): Role {

  return {
    id: DEFAULT_ROLE_ID,
    name: '@everyone',
    color: DEFAULT_ROLE_COLOR,
    permissions: serializeBits(PermissionFlag.viewLogs),
    position: 0,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function effectiveBitsForRoleIds(roleIds: string[], roles: Role[]): bigint {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const held = roleIds.map((id) => byId.get(id)).filter((r): r is Role => !!r);
  const defaultRole = roles.find((r) => r.isDefault);
  return combineBits([...(defaultRole ? [parseBits(defaultRole.permissions)] : []), ...held.map((r) => parseBits(r.permissions))]);
}

export interface AllowedUser {
  username: string;
  roleIds: string[];
  addedAt: number;
  sessionVersion?: number;
  lastActiveAt?: number;
  priority?: number;

  discordPerkRoleIds?: string[];
  mfa?: UserMfaRecord;
}

export interface UserMfaRecord {
  enabled: boolean;
  secretCiphertext?: string;
  pendingSecretCiphertext?: string;
  recoveryCodeHashes?: string[];
  updatedAt?: number;
}

export interface PasskeyCredential {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  name?: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface DiscordRolePerk {
  id: string;
  guildId: string;
  guildName?: string;
  guildIcon: string | null;
  discordRoleId: string;
  discordRoleName?: string;
  discordRoleColor: number;
  appRoleId: string;
  createdAt: number;
}

export interface DiscordGuildConfiguration {
  id: string;
  name: string;
  icon: string | null;
}

export interface DiscordGuildRoleConfiguration {
  id: string;
  name: string;
  color: number;
}

export interface DiscordGuildMembership {
  guildId: string;
  roleIds: string[] | undefined;
}

export interface BackupScheduleSettings {
  enabled: boolean;
  cron: string;
  retentionCount: number;
}

export interface BackupHistoryEntry {
  id: string;
  createdAt: number;
  sizeBytes: number;
  filename: string;
  trigger: 'scheduled' | 'manual';
  databaseFilename?: string;
  manifestFilename?: string;
  schemaVersion?: number;
  integrity?: 'verified' | 'failed' | 'unavailable';
  encryptedManifest?: boolean;
  restoreDrillStatus: 'not_run' | 'passed' | 'failed';
  restoreDrillAt?: number;
  restoreDrillChecks?: BackupRestoreDrillCheck[];
}

export interface BackupRestoreDrillCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface ActiveSessionRecord {
  id: string;
  sub: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
  ip?: string;
  risk?: 'new_context';
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  ownerId: string;
  status: ApiKeyStatus;
  hash?: string;
  pendingReveal?: string;
  previousHash?: string;
  previousHashExpiresAt?: number;
  createdAt: number;
  approvedAt?: number;
  lastUsedAt?: number;
  lastUsedIp?: string;
  expiresAt?: number;
  allowedBundleIds?: string[];
  dailyLimit?: number;
  maxConcurrent?: number;
  allowTestFlight?: boolean;
  expiryNotifiedAt?: number;
  priority?: number;
}

export interface ApiKeyAuthResult {
  projectId?: string;

  allowedBundleIds?: string[];

  ownerId?: string;
  priority?: number;

  keyId?: string;

  allowTestFlight?: boolean;
}

export interface DashboardSettings {
  notifyWebhookUrl: string;
  notifyFormat: 'embed' | 'plain';
  notifySuccessMode: 'instant' | 'daily' | 'weekly';
  notifyQuietHoursStart: string;
  notifyQuietHoursEnd: string;
  notifyOnKeyRequest: boolean;
  notifyOnAutomationSuccess: boolean;
  notifyOnAutomationFailure: boolean;
  notifyOnKeyExpiringSoon: boolean;
  notifyOnDeviceOffline: boolean;
  notifyOnDeviceBatteryHot: boolean;
  notifyOnDeviceBatteryLow: boolean;
  notifyOnDiskFull: boolean;
  notifyOnDeviceStorageLow: boolean;
  notifyOnTestFlightBridgeDown: boolean;
  notifyOnJobCompleted: boolean;
  notifyOnQueueSloBreach: boolean;
  deviceOfflineAlertMinutes: number;
  batteryHotAlertC: number;
  batteryLowAlertPercent: number;
  diskFullAlertPercent: number;
  deviceStorageAlertPercent: number;
  testFlightBridgeAlertMinutes: number;
  jobHistoryRetentionDays: number;
  maintenanceMode: boolean;
}

export interface PersistedSettings extends Partial<DashboardSettings> {
  billingCheckoutsPaused?: boolean;
  schedulerRetryCount?: number;
}

export interface AppWatch {
  id: string;
  billingOwnerId?: string;
  billingOwnerTransfer?: { userId: string; requestedBy: string; requestedAt: number };
  projectId?: string;
  bundleId: string;
  repo: string;
  ghWorkflowFile: string;
  dispatchTargets?: DispatchTarget[];
  pollCron: string;
  timezone?: string;
  maintenanceWindow?: MaintenanceWindow;
  missedRunPolicy?: 'skip' | 'runOnce';
  lastScheduledAt?: number;
  enabled: boolean;
  webhookUrl?: string;
  testFlightPolicy?: 'latest' | 'latestNonExpired' | 'train';
  testFlightTrain?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DispatchTarget {
  repo: string;
  ghWorkflowFile: string;
  mode?: 'repository_dispatch' | 'workflow_dispatch';
  ref?: string;
  inputs?: Record<string, string>;
}

export interface DeviceRecord {
  id: string;
  name: string;
  transport?: DeviceTransport;
  host?: string;
  port?: number;
  user?: string;
  udid?: string;
  usbmuxNetwork?: boolean;
  productType?: string;
  keyPath?: string;
  iosVersion?: string;
  toolchain?: string;
  notes?: string;
  enabled: boolean;
  draining?: boolean;
  isPrimary?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type WebhookDeliveryKind = 'automation' | 'scheduler' | 'job';

export interface WebhookDeliveryEntry {
  id: string;
  ts: number;
  kind: WebhookDeliveryKind;
  event: string;
  targetHost: string;
  ok: boolean;
  status?: number;
  error?: string;
  durationMs: number;
}

export interface IpaMetadata {
  bundleVersion?: string;
  shortVersion?: string;
  minOsVersion?: string;
  executable?: string;
  architectures?: string[];
  entitlementKeys?: string[];
  embeddedFrameworks?: string[];
  fileCount?: number;
  compressedSizeBytes?: number;
  uncompressedSizeBytes?: number;
  codeSignaturePresent?: boolean;
}

export interface JobHistoryEntry {
  id: string;
  correlationId?: string;
  projectId?: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: TestFlightJobSource;
  versionLabel?: string;
  minimumOsVersion?: string;
  queuedBy?: string;
  status: 'done' | 'failed';
  warnings?: string[];
  error?: string;
  queueReason?: string;
  artifactId?: string;
  sizeBytes?: number;
  sha256?: string;
  source: 'manual' | 'scheduler';
  createdAt: number;
  startedAt?: number;
  finishedAt: number;
  deviceId?: string;
  transport?: DeviceTransport;
  executionPath?: JobExecutionPath;
  offlineAttemptedAt?: number;
  offlineFailureReason?: string;
  ipaMetadata?: IpaMetadata;
  ipaInfoPlist?: Record<string, unknown>;
  timeline?: JobTimelineEvent[];
  attempt?: number;
  retryCount?: number;
  cacheHit?: boolean;
  deadlineAt?: number;
  deadlineExceeded?: boolean;
  failureClass?: JobFailureClass;
  resolutionNotice?: { sentAt: number; sentBy: string; emailStatus: 'pending' | 'sent' | 'unavailable' | 'failed' };
}

export interface AppCatalogEntry {
  bundleId: string;
  displayName: string;
  iconUrl?: string;
  trackId?: number;
  sellerName?: string;
  category?: string;
  description?: string;
  screenshots?: string[];
  releaseNotes?: string;
  price?: number;
  metadataFetchedAt?: number;
  latestAppStoreVersion?: string;
  latestAppStoreExternalId?: string;
  appStoreReleaseCheckedAt?: number;
  latestTestFlightVersion?: string;
  latestTestFlightBuildId?: number;
  testFlightReleaseCheckedAt?: number;
  updatedAt: number;
}

export interface TestFlightCatalogCacheApp {
  appId: number;
  bundleId: string;
  displayName: string;
  iconUrl?: string;
  sellerName?: string;
  category?: string;
  devices: Array<{ id: string; name: string; verifiedAt?: number }>;
  lastVerifiedAt: number;
  deviceSource: true;
}

export interface TestFlightCatalogCache {
  fetchedAt: number;
  deviceIds: string[];
  apps: TestFlightCatalogCacheApp[];
  complete?: boolean;
}

export type TestFlightSubscriptionStatus = 'pending' | 'approved' | 'denied' | 'withdrawn';
export type TestFlightSubscriptionDeviceStatus = 'pending' | 'syncing' | 'active' | 'unavailable' | 'unsupported' | 'error' | 'unsubscribed';
export const IMMUTABLE_TESTFLIGHT_BUNDLE_ID = 'com.hammerandchisel.discord';

export interface TestFlightSubscriptionDevice {
  deviceId: string;
  status: TestFlightSubscriptionDeviceStatus;
  appleMembership?: 'accepted' | 'pending' | 'unknown';
  lastVerifiedAt?: number;
  lastSyncedAt?: number;
  lastError?: string;
}

export interface TestFlightSubscription {
  id: string;
  url: string;
  inviteCode: string;
  requestedBy: string;
  status: TestFlightSubscriptionStatus;
  appId?: number;
  bundleId?: string;
  displayName?: string;
  iconUrl?: string;
  sellerName?: string;
  category?: string;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  approvedBy?: string;
  deniedAt?: number;
  deniedBy?: string;
  withdrawnAt?: number;
  withdrawnBy?: string;
  devices: TestFlightSubscriptionDevice[];
  devicePolicy: 'all-enabled';
}

export interface UserPrefs {
  artifactFilenameTemplate?: string;
  shortcutBindings?: Record<string, string>;
  formattingLocale?: 'system' | 'en' | 'de';
  interfaceLanguage?: 'system' | 'en' | 'de';
  theme?: 'dark' | 'light' | 'auto';
  density?: 'comfortable' | 'compact';
  sidebarWidth?: number;
  sidebarCollapsed?: boolean;
  homeLayouts?: HomeLayoutPreference[];
  activeHomeLayoutId?: string;
  viewModes?: HomeViewModes;
  settingsMode?: 'basic' | 'advanced';
  displayTimeZone?: string;
  appFavorites?: Array<{ bundleId: string; trackName: string }>;
  navigationOrder?: Array<'home' | 'billing' | 'keys' | 'logs' | 'insights' | 'docs' | 'settings'>;
  pinnedNavigation?: Array<'home' | 'billing' | 'keys' | 'logs' | 'insights' | 'docs' | 'settings'>;
  artifactLibrary?: {
    groupByApp: boolean;
    columns: Array<'app' | 'bundleId' | 'version' | 'source' | 'size' | 'created'>;
    layouts?: Array<{ id: string; name: string; groupByApp: boolean; columns: Array<'app' | 'bundleId' | 'version' | 'source' | 'size' | 'created'> }>;
    activeLayoutId?: string;
  };
  largeTargets?: boolean;
  oneThumbMode?: boolean;
  decryptUsageAlertThresholds?: number[];
  accent?: string;
  highContrast?: boolean;
  sound?: boolean;
  pushOnSuccess?: boolean;
  pushOnFailure?: boolean;
  pushOnAlerts?: boolean;
  pushOnKeyExpiry?: boolean;
  emailOnSuccess?: boolean;
  emailOnFailure?: boolean;
  emailOnAlerts?: boolean;
  emailOnKeyExpiry?: boolean;
  notifyEmail?: string;
  preferPrimaryDevice?: boolean;
}

export type HomeModuleId = 'artifacts' | 'activeJobs' | 'jobHistory';

export interface HomeLayoutPreference {
  id: string;
  name: string;
  order: HomeModuleId[];
  hidden: HomeModuleId[];
  collapsed: HomeModuleId[];
}

export interface HomeViewModes {
  artifacts?: 'list' | 'cards';
  jobHistory?: 'list' | 'cards';
  devices?: 'list' | 'cards';
}

export type AuditAction =
  | 'user.add'
  | 'user.update'
  | 'user.remove'
  | 'state.import'
  | 'settings.update'
  | 'watch.add'
  | 'watch.update'
  | 'watch.remove'
  | 'watch.import'
  | 'watch.billing-owner-request'
  | 'watch.billing-owner-accept'
  | 'device.add'
  | 'device.update'
  | 'device.remove'
  | 'role.add'
  | 'role.update'
  | 'role.remove'
  | 'backup.schedule-update'
  | 'backup.create'
  | 'backup.drill'
  | 'backup.delete'
  | 'testflight-subscription.add'
  | 'testflight-subscription.approve'
  | 'testflight-subscription.deny'
  | 'testflight-subscription.sync'
  | 'testflight-subscription.remove'
  | 'billing.checkout'
  | 'billing.access_code.create'
  | 'billing.access_code.redeem'
  | 'billing.access_code.revoke'
  | 'billing.activated'
  | 'billing.charge'
  | 'billing.charge-failed'
  | 'billing.refund'
  | 'billing.cancel'
  | 'billing.webhook'
  | 'billing.webhook.sync'
  | 'billing.webhook.replay'
  | 'billing.webhook.quarantine'
  | 'billing.checkouts.pause'
  | 'privacy.export'
  | 'privacy.delete'
  | 'auth.passkey.add'
  | 'auth.passkey.remove'
  | 'auth.passkey.login'
  | 'auth.passkey.reauthenticate'
  | 'auth.session.new_context'
  | 'project.add'
  | 'project.update'
  | 'project.archive'
  | 'project.restore'
  | 'artifact.pin'
  | 'artifact.unpin'
  | 'artifact.archive'
  | 'artifact.restore'
  | 'incident.update'
  | 'job.resolution-notice'
  | 'integration.create'
  | 'integration.rotate'
  | 'integration.revoke'
  | 'integration.billing-owner-request'
  | 'integration.billing-owner-accept'
  | 'auth.account.link'
  | 'auth.account.merge';

export interface AuditLogEntry {
  id: string;
  ts: number;
  actor: string;
  action: AuditAction;
  target: string;
  detail?: string;
  changes?: Array<{ field: string; before: string | number | boolean | null; after: string | number | boolean | null }>;
}

export type SchedulerRunStatus = 'dispatched' | 'succeeded' | 'failed' | 'timed_out';

export interface SchedulerRunOutcome {
  ok: boolean;
  triggered: boolean;
  reason: string;
  failureClass?: JobFailureClass;
  retryable?: boolean;
  runUrl?: string;
  failureSummary?: string;
  destinationFailureSummary?: string;
  runStatus?: SchedulerRunStatus;
  observedVersion?: string;
  installMode?: 'pinned' | 'current';
  versionLabel?: string;
  dispatchTargetKeys?: string[];
}

export interface SchedulerRunEntry {
  id: string;
  ts: number;
  watchId?: string;
  bundleId?: string;
  appStore: SchedulerRunOutcome;
  testflight: SchedulerRunOutcome;
}

export interface ApiKeyUsageBucket {
  date: string;
  count: number;
}

export interface DeviceHealthCheck {
  ts: number;
  reachable: boolean;
  batteryPercent?: number;
  batteryTemperatureC?: number;
  storageUsedPercent?: number;
  subsystems?: Partial<Record<DeviceSubsystemId, DeviceSubsystemState>>;
  subsystemDetails?: Partial<Record<DeviceSubsystemId, DeviceSubsystemDetail>>;
}

export type DeviceSubsystemId = 'usb' | 'mux' | 'agent' | 'jailbreak' | 'appStore' | 'testFlight' | 'sshTunnel' | 'storage' | 'battery' | 'thermal';
export type DeviceSubsystemState = 'ready' | 'idle' | 'degraded' | 'offline' | 'unsupported' | 'unknown';

export interface DeviceSubsystemDetail {
  state: DeviceSubsystemState;
  lastChangedAt?: number;
  reason?: string;
}

export interface DeviceActivityEntry {
  id: string;
  ts: number;
  deviceId: string;
  kind: 'health' | 'bridge' | 'job';
  message: string;
  bundleId?: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface NotificationRecord {
  id: string;
  userId: string;
  title: string;
  message: string;
  severity: NotificationSeverity;
  createdAt: number;
  firstOccurredAt?: number;
  lastOccurredAt?: number;
  occurrenceCount?: number;
  readAt?: number;
  jobId?: string;
  deviceId?: string;
  deploymentId?: string;
  groupKey?: string;
  href?: string;
}

interface PersistedState {
  version: number;
  apiKeys: ApiKeyRecord[];
  allowedUsers: AllowedUser[];
  roles: Role[];
  projects: ProjectRecord[];
  settings: PersistedSettings;
  watches: AppWatch[];
  devices: DeviceRecord[];
  jobHistory: JobHistoryEntry[];
  lastSchedulerRunAt?: number;
  userPrefs: Record<string, UserPrefs>;
  auditLog: AuditLogEntry[];
  schedulerRunHistory: SchedulerRunEntry[];
  rootSessionVersion: number;
  apiKeyUsage: Record<string, ApiKeyUsageBucket[]>;
  deviceHealthHistory: Record<string, DeviceHealthCheck[]>;
  deviceActivity: DeviceActivityEntry[];
  pushSubscriptions: Record<string, PushSubscriptionRecord[]>;
  vapidKeys?: VapidKeys;
  apiKeyBundleUsage: Record<string, Record<string, number>>;
  apiKeyOutcomeUsage: Record<string, Record<string, ApiKeyOutcomeUsage>>;
  webhookDeliveryLog: WebhookDeliveryEntry[];
  discordRolePerks: DiscordRolePerk[];
  discordGuilds: DiscordGuildConfiguration[];
  backupSchedule: BackupScheduleSettings;
  backupHistory: BackupHistoryEntry[];
  activeSessions: ActiveSessionRecord[];
  appCatalog: Record<string, AppCatalogEntry>;
  testFlightCatalog?: TestFlightCatalogCache;
  notifications: NotificationRecord[];
  testFlightSubscriptions: TestFlightSubscription[];
  rootMfa?: UserMfaRecord;
  passkeys: PasskeyCredential[];
}

const MAX_HISTORY = 100;
const MAX_AUDIT_LOG = 200;
const MAX_LEGACY_SCHEDULER_RUNS = 20;
const MAX_USAGE_DAYS = 30;
const MAX_DEVICE_HEALTH_CHECKS = 288;
const DEVICE_OFFLINE_CONFIRMATION_CHECKS = 3;
const DEVICE_OFFLINE_CONFIRMATION_WINDOW_MS = 15 * 60_000;
const DEVICE_OFFLINE_CONFIRMATION_SPAN_MS = 10 * 60_000;
const MAX_DEVICE_ACTIVITY = 300;
const MAX_WEBHOOK_LOG = 200;
const MAX_NOTIFICATIONS = 500;
const NOTIFICATION_GROUP_WINDOW_MS = 15 * 60_000;
const statePath = path.join(config.stateDir, 'state.json');
const backupsDir = path.join(config.stateDir, 'backups');
const stateDatabase: StateDatabase = openStateDatabase({
  stateDir: config.stateDir,
  filename: config.stateDatabaseFile,
  busyTimeoutMs: config.stateDbBusyTimeoutMs,
  migrationDryRun: config.stateDbMigrationDryRun,
});
const apiKeyRepository = createApiKeyRepository(stateDatabase.db);
const accountRepository = createAccountRepository(stateDatabase.db);
const deviceHistoryRepository = createDeviceHistoryRepository(stateDatabase.db);
const deviceHealthRepository = createDeviceHealthRepository(stateDatabase.db);
const notificationRepository = createNotificationRepository(stateDatabase.db);
const auditRepository = createAuditRepository(stateDatabase.db);
const testFlightSubscriptionRepository = createTestFlightSubscriptionRepository(stateDatabase.db);
const jobHistoryRepository = createJobHistoryRepository(stateDatabase.db);
const sessionRepository = createSessionRepository(stateDatabase.db);
const settingsRepository = createSettingsRepository(stateDatabase.db);
const watchRepository = createWatchRepository(stateDatabase.db);
const schedulerRunRepository = createSchedulerRunRepository(stateDatabase.db);
const backupRepository = createBackupRepository(stateDatabase.db);
const backupScheduleRepository = createBackupScheduleRepository(stateDatabase.db);
const deviceRepository = createDeviceRepository(stateDatabase.db);
const projectRepository = createProjectRepository(stateDatabase.db);

export function getStateDatabaseStatus(): { path: string; schemaVersion: number; integrity: 'ok' } {
  return { path: stateDatabase.path, schemaVersion: stateDatabase.schemaVersion, integrity: stateDatabase.integrityStatus() };
}

export function closeStateDatabase(): void {
  stateDatabase.close();
}

function defaultState(): PersistedState {
  return {
    version: 18,
    apiKeys: [],
    allowedUsers: [],
    roles: [seedDefaultRole(Date.now())],
    projects: [createDefaultProject()],
    settings: {},
    watches: [],
    devices: [],
    jobHistory: [],
    userPrefs: {},
    auditLog: [],
    schedulerRunHistory: [],
    rootSessionVersion: 0,
    apiKeyUsage: {},
    deviceHealthHistory: {},
    deviceActivity: [],
    pushSubscriptions: {},
    apiKeyBundleUsage: {},
    apiKeyOutcomeUsage: {},
    webhookDeliveryLog: [],
    discordRolePerks: [],
    discordGuilds: [],
    backupSchedule: { enabled: false, cron: '0 3 * * *', retentionCount: 14 },
    backupHistory: [],
    activeSessions: [],
    appCatalog: {},
    notifications: [],
    testFlightSubscriptions: [],
    rootMfa: undefined,
    passkeys: [],
  };
}

interface LegacyPermissions {
  decrypt: boolean;
  viewApiKeys: boolean;
  approveApiKeys: boolean;
  revokeApiKeys: boolean;
  manageScheduler: boolean;
  triggerDispatch: boolean;
  viewLogs: boolean;
  viewUsers: boolean;
  manageUsers: boolean;
}

const LEGACY_VIEWER_PERMISSIONS: LegacyPermissions = {
  decrypt: false,
  viewApiKeys: false,
  approveApiKeys: false,
  revokeApiKeys: false,
  manageScheduler: false,
  triggerDispatch: false,
  viewLogs: false,
  viewUsers: false,
  manageUsers: false,
};

const LEGACY_ADMIN_PERMISSIONS: LegacyPermissions = {
  decrypt: true,
  viewApiKeys: true,
  approveApiKeys: true,
  revokeApiKeys: true,
  manageScheduler: true,
  triggerDispatch: true,
  viewLogs: true,
  viewUsers: true,
  manageUsers: true,
};

function isLegacyPermissionsRecord(value: unknown): value is LegacyPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const permissions = value as Record<string, unknown>;
  const permissionKeys = Object.keys(LEGACY_VIEWER_PERMISSIONS) as Array<keyof LegacyPermissions>;
  return Object.keys(permissions).length === permissionKeys.length
    && permissionKeys.every((key) => Object.hasOwn(permissions, key) && typeof permissions[key] === 'boolean');
}

function isLegacyV6AccountRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const user = value as Record<string, unknown>;
  return typeof user.username === 'string'
    && typeof user.addedAt === 'number'
    && (user.permissions === undefined || isLegacyPermissionsRecord(user.permissions))
    && (user.sessionVersion === undefined || typeof user.sessionVersion === 'number')
    && (user.lastActiveAt === undefined || typeof user.lastActiveAt === 'number')
    && (user.priority === undefined || typeof user.priority === 'number');
}

function legacyRoleToPermissions(role: string): LegacyPermissions {
  switch (role) {
    case 'admin':
      return { ...LEGACY_ADMIN_PERMISSIONS };
    case 'operator':
      return { ...LEGACY_VIEWER_PERMISSIONS, decrypt: true, viewApiKeys: true, approveApiKeys: true, revokeApiKeys: true, viewLogs: true };
    case 'member':
      return { ...LEGACY_VIEWER_PERMISSIONS, decrypt: true, viewLogs: true };
    default:
      return { ...LEGACY_VIEWER_PERMISSIONS, viewLogs: true };
  }
}

interface LegacyV3Permissions {
  decrypt: boolean;
  manageKeys: boolean;
  manageSettings: boolean;
  manageUsers: boolean;
}

function migratePermissionsV3(old: LegacyV3Permissions): LegacyPermissions {
  return {
    decrypt: old.decrypt,
    viewApiKeys: old.manageKeys,
    approveApiKeys: old.manageKeys,
    revokeApiKeys: old.manageKeys,
    manageScheduler: old.manageSettings,
    triggerDispatch: old.manageSettings,
    viewLogs: true,
    viewUsers: old.manageUsers,
    manageUsers: old.manageUsers,
  };
}

interface LegacyV4Permissions {
  decrypt: boolean;
  viewApiKeys: boolean;
  approveApiKeys: boolean;
  revokeApiKeys: boolean;
  manageScheduler: boolean;
  viewUsers: boolean;
  manageUsers: boolean;
}

function migratePermissionsV4(old: LegacyV4Permissions): LegacyPermissions {
  return {
    decrypt: old.decrypt,
    viewApiKeys: old.viewApiKeys,
    approveApiKeys: old.approveApiKeys,
    revokeApiKeys: old.revokeApiKeys,
    manageScheduler: old.manageScheduler,
    triggerDispatch: old.manageScheduler,
    viewLogs: true,
    viewUsers: old.viewUsers,
    manageUsers: old.manageUsers,
  };
}

function legacyBooleansToBits(p: LegacyPermissions): bigint {
  if (Object.values(p).every(Boolean)) return PermissionFlag.administrator;
  let bits = 0n;
  if (p.decrypt) bits |= PermissionFlag.requestDecrypt | PermissionFlag.accessApi;
  if (p.viewApiKeys) bits |= PermissionFlag.viewApiKeys;
  if (p.approveApiKeys) bits |= PermissionFlag.approveApiKeys | PermissionFlag.manageApiKeyLimits;
  if (p.revokeApiKeys) bits |= PermissionFlag.revokeApiKeys;
  if (p.manageScheduler) bits |= PermissionFlag.manageWatches | PermissionFlag.manageDevices | PermissionFlag.manageSchedulerSettings;
  if (p.triggerDispatch) bits |= PermissionFlag.triggerDispatch;
  if (p.viewLogs) bits |= PermissionFlag.viewLogs;
  if (p.viewUsers) bits |= PermissionFlag.viewUsers;
  if (p.manageUsers) bits |= PermissionFlag.manageUsers | PermissionFlag.manageRoles | PermissionFlag.manageBackup;
  return bits;
}

const PRESET_ROLE_BITS: Record<string, bigint> = {
  Member: PermissionFlag.requestDecrypt | PermissionFlag.accessApi,
  'Key Manager': combineBits([
    PermissionFlag.requestDecrypt,
    PermissionFlag.accessApi,
    PermissionFlag.viewApiKeys,
    PermissionFlag.approveApiKeys,
    PermissionFlag.manageApiKeyLimits,
    PermissionFlag.revokeApiKeys,
  ]),
  'Ops Admin': combineBits([
    PermissionFlag.requestDecrypt,
    PermissionFlag.accessApi,
    PermissionFlag.manageWatches,
    PermissionFlag.manageDevices,
    PermissionFlag.manageSchedulerSettings,
    PermissionFlag.triggerDispatch,
  ]),
};

function presetNameForBits(bits: bigint): string | undefined {
  if (bits === PermissionFlag.administrator) return 'Admin';
  return Object.entries(PRESET_ROLE_BITS).find(([, presetBits]) => presetBits === bits)?.[0];
}

function migrateV5ToV6(v5: Record<string, unknown>): Record<string, unknown> {
  const legacyHealthHistory = v5.deviceHealthHistory;
  return {
    ...v5,
    version: 6,
    watches: Array.isArray(v5.watches) ? (v5.watches as AppWatch[]) : [],
    devices: Array.isArray(v5.devices) ? (v5.devices as DeviceRecord[]) : [],
    webhookDeliveryLog: Array.isArray(v5.webhookDeliveryLog) ? (v5.webhookDeliveryLog as WebhookDeliveryEntry[]) : [],
    deviceHealthHistory: Array.isArray(legacyHealthHistory)
      ? { default: (legacyHealthHistory as DeviceHealthCheck[]).slice(-MAX_DEVICE_HEALTH_CHECKS) }
      : typeof legacyHealthHistory === 'object' && legacyHealthHistory !== null
        ? (legacyHealthHistory as Record<string, DeviceHealthCheck[]>)
        : {},
  };
}

function assertLegacyCollectionArray(raw: Record<string, unknown>, key: string, collectionName: string): void {
  if (Object.hasOwn(raw, key) && !Array.isArray(raw[key])) throw new Error(`persistent ${collectionName} data is malformed`);
}

function migrateV6ToV8(v6: Record<string, unknown>): Record<string, unknown> {
  assertLegacyCollectionArray(v6, 'allowedUsers', 'account');
  const now = Date.now();
  const roles: Role[] = [seedDefaultRole(now)];
  const roleIdByBits = new Map<string, string>();
  let position = 1;

  function roleIdForBits(bits: bigint): string[] {
    if (bits === 0n) return [];
    const key = bits.toString();
    const existing = roleIdByBits.get(key);
    if (existing) return [existing];
    const role: Role = {
      id: randomUUID(),
      name: presetNameForBits(bits) ?? `Migrated role ${roleIdByBits.size + 1}`,
      color: ROLE_COLOR_PRESETS[position % ROLE_COLOR_PRESETS.length],
      permissions: key,
      position: position++,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    roles.push(role);
    roleIdByBits.set(key, role.id);
    return [role.id];
  }

  const legacyUsers = Object.hasOwn(v6, 'allowedUsers') ? v6.allowedUsers as Record<string, unknown>[] : [];
  if (!legacyUsers.every(isLegacyV6AccountRecord)) throw new Error('persistent account data is malformed');
  const allowedUsers: AllowedUser[] = legacyUsers.map((u) => ({
    username: u.username as string,
    roleIds: roleIdForBits(legacyBooleansToBits(u.permissions === undefined ? LEGACY_VIEWER_PERMISSIONS : u.permissions as LegacyPermissions)),
    addedAt: u.addedAt as number,
    sessionVersion: u.sessionVersion as number | undefined,
    lastActiveAt: u.lastActiveAt as number | undefined,
    priority: u.priority as number | undefined,
  }));

  return { ...defaultState(), ...v6, version: 8, roles, allowedUsers };
}

function migrateV7ToV8(v7: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(v7, 'roles') && (!Array.isArray(v7.roles) || !v7.roles.every(isRoleRecord))) throw new Error('persistent role data is malformed');
  const roles = Object.hasOwn(v7, 'roles')
    ? (v7.roles as Role[]).map((role) => {
        const permissions = parseBits(role.permissions);
        const migratedPermissions = hasPermission(permissions, PermissionFlag.requestDecrypt)
          ? permissions | PermissionFlag.accessApi
          : permissions;
        return { ...role, permissions: serializeBits(migratedPermissions) };
      })
    : [seedDefaultRole(Date.now())];
  return { ...defaultState(), ...v7, version: 8, roles };
}

function migrateV8ToV9(v8: Record<string, unknown>): Record<string, unknown> {
  const legacyGuildId = typeof v8.discordGuildId === 'string' ? v8.discordGuildId : undefined;
  const { discordGuildId: _legacyGuildId, ...rest } = v8;
  const discordGuilds = legacyGuildId ? [{ id: legacyGuildId, name: legacyGuildId, icon: null }] : [];
  const discordRolePerks = Array.isArray(v8.discordRolePerks) && legacyGuildId
    ? (v8.discordRolePerks as Omit<DiscordRolePerk, 'guildId' | 'guildName' | 'guildIcon' | 'discordRoleColor'>[]).map((perk) => ({
        ...perk,
        guildId: legacyGuildId,
        guildName: legacyGuildId,
        guildIcon: null,
        discordRoleColor: 0,
      }))
    : [];
  return { ...defaultState(), ...rest, version: 9, discordGuilds, discordRolePerks };
}

function upgradePermissionBits(bits: bigint): bigint {
  let migrated = bits;
  if ((bits & PermissionFlag.viewUsers) !== 0n) migrated |= PermissionFlag.viewRoles;
  if ((bits & PermissionFlag.manageUsers) !== 0n) migrated |= PermissionFlag.viewUsers;
  if ((bits & PermissionFlag.manageRoles) !== 0n) migrated |= PermissionFlag.viewRoles | PermissionFlag.viewDiscordPerks | PermissionFlag.manageDiscordPerks;
  if ((bits & PermissionFlag.manageWatches) !== 0n || (bits & PermissionFlag.manageSchedulerSettings) !== 0n || (bits & PermissionFlag.triggerDispatch) !== 0n) migrated |= PermissionFlag.viewScheduler;
  if ((bits & PermissionFlag.manageDevices) !== 0n) migrated |= PermissionFlag.viewDevices;
  if ((bits & PermissionFlag.manageBackup) !== 0n) migrated |= PermissionFlag.viewBackup;
  if ((bits & (PermissionFlag.viewApiKeys | PermissionFlag.accessApi)) !== 0n) migrated |= PermissionFlag.viewApiKeyUsage;
  if ((bits & PermissionFlag.manageApiKeyLimits) !== 0n) {
    migrated |= PermissionFlag.manageApiKeyExpiry | PermissionFlag.manageApiKeyDailyLimits | PermissionFlag.manageApiKeyConcurrency | PermissionFlag.manageApiKeyTestFlight | PermissionFlag.manageApiKeyPriority;
  }
  return migrated;
}

function consolidatePermissionBits(bits: bigint): bigint {
  let migrated = bits;
  if ((bits & PermissionFlag.accessApi) !== 0n) migrated |= PermissionFlag.requestApiKeys | PermissionFlag.createApiKeys;
  const legacyManagesAllApiKeys = (bits & (PermissionFlag.approveApiKeys | PermissionFlag.revokeApiKeys | PermissionFlag.manageApiKeyLimits)) === (PermissionFlag.approveApiKeys | PermissionFlag.revokeApiKeys | PermissionFlag.manageApiKeyLimits);
  if (legacyManagesAllApiKeys) migrated |= PermissionFlag.manageApiKeys;
  if ((bits & (PermissionFlag.viewScheduler | PermissionFlag.manageWatches | PermissionFlag.manageSchedulerSettings | PermissionFlag.triggerDispatch)) !== 0n) migrated |= PermissionFlag.viewAutomation;
  const legacyManagesAllAutomation = (bits & (PermissionFlag.manageWatches | PermissionFlag.manageSchedulerSettings | PermissionFlag.triggerDispatch)) === (PermissionFlag.manageWatches | PermissionFlag.manageSchedulerSettings | PermissionFlag.triggerDispatch);
  if (legacyManagesAllAutomation) migrated |= PermissionFlag.manageAutomation;
  return migrated;
}

function migrateV9ToV10(v9: Record<string, unknown> | PersistedState): Record<string, unknown> {
  if (Object.hasOwn(v9, 'roles') && (!Array.isArray(v9.roles) || !v9.roles.every(isRoleRecord))) throw new Error('persistent role data is malformed');
  const roles = Object.hasOwn(v9, 'roles')
    ? (v9.roles as Role[]).map((role) => ({ ...role, permissions: serializeBits(upgradePermissionBits(parseBits(role.permissions))) }))
    : [seedDefaultRole(Date.now())];
  return { ...defaultState(), ...v9, version: 10, roles };
}

function migrateV10ToV11(v10: Record<string, unknown>): Record<string, unknown> {
  const v10State = migrateV9ToV10(v10);
  return {
    ...v10State,
    version: 11,
    roles: (v10State.roles as Role[]).map((role) => ({ ...role, permissions: serializeBits(consolidatePermissionBits(parseBits(role.permissions))) })),
  };
}

function migrateV11ToV12(v11: Record<string, unknown>): Record<string, unknown> {
  return { ...defaultState(), ...v11, version: 12 };
}

function migrateV12ToV13(v12: Record<string, unknown>): Record<string, unknown> {
  return {
    ...defaultState(),
    ...v12,
    version: 13,
    notifications: Array.isArray(v12.notifications) ? (v12.notifications as NotificationRecord[]) : [],
  };
}

function migrateV13ToV14(v13: Record<string, unknown>): PersistedState {
  if (Object.hasOwn(v13, 'roles') && (!Array.isArray(v13.roles) || !v13.roles.every(isRoleRecord))) throw new Error('persistent role data is malformed');
  if (Object.hasOwn(v13, 'allowedUsers') && (!Array.isArray(v13.allowedUsers) || !v13.allowedUsers.every(isAllowedUserRecord))) throw new Error('persistent account data is malformed');
  const migrated = {
    ...defaultState(),
    ...v13,
    version: 17,
  } as PersistedState & { shareLinks?: unknown };
  delete migrated.shareLinks;
  migrated.projects = Array.isArray(v13.projects) ? v13.projects as ProjectRecord[] : [createDefaultProject()];
  migrated.jobHistory = Array.isArray(v13.jobHistory)
    ? (v13.jobHistory as JobHistoryEntry[]).map((entry) => ({ ...entry, projectId: entry.projectId ?? DEFAULT_PROJECT_ID }))
    : [];
  migrated.testFlightSubscriptions = Array.isArray(v13.testFlightSubscriptions)
    ? (v13.testFlightSubscriptions as TestFlightSubscription[])
    : [];
  migrated.roles = Object.hasOwn(v13, 'roles')
    ? (v13.roles as Role[]).map((role) => ({ ...role, permissions: serializeBits(parseBits(role.permissions)) }))
    : [seedDefaultRole(Date.now())];
  return migrated;
}

function migrateV16ToV17(v16: PersistedState): PersistedState {
  const migrated = { ...v16, version: 17 } as PersistedState;
  migrated.projects = Array.isArray(v16.projects) ? v16.projects as ProjectRecord[] : [createDefaultProject()];
  migrated.jobHistory = Array.isArray(v16.jobHistory)
    ? (v16.jobHistory as JobHistoryEntry[]).map((entry) => ({ ...entry, projectId: entry.projectId ?? DEFAULT_PROJECT_ID }))
    : [];
  return migrated;
}

function migrateToV17(raw: Record<string, unknown>): PersistedState {
  if (raw.version === 17) return raw as unknown as PersistedState;
  if (raw.version === 16) return migrateV16ToV17(migrateV13ToV14(raw));
  if (raw.version === 15) return migrateV16ToV17(migrateV13ToV14(raw));
  if (raw.version === 14) return migrateV16ToV17(migrateV13ToV14(raw));
  if (raw.version === 13) return migrateV16ToV17(migrateV13ToV14(raw));
  if (raw.version === 12) return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(raw)));
  if (raw.version === 11) return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(raw))));
  if (raw.version === 10) return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(raw)))));
  if (raw.version === 9) return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(raw)))));
  if (raw.version === 8) return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(raw))))));
  if (raw.version === 7) return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV7ToV8(raw)))))));
  if (raw.version === 6) return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(raw)))))));
  if (raw.version === 5) return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(migrateV5ToV6(raw))))))));

  if (raw.version === 4) {
    assertLegacyCollectionArray(raw, 'allowedUsers', 'account');
    const v4Users = Object.hasOwn(raw, 'allowedUsers') ? raw.allowedUsers as Record<string, unknown>[] : [];
    return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
      migrateV5ToV6({
        ...raw,
        version: 5,
        allowedUsers: v4Users.map((u) => ({
          username: u.username as string,
          permissions: migratePermissionsV4(u.permissions as LegacyV4Permissions),
          addedAt: u.addedAt as number,
        })),
      }),
    )))))));
  }

  if (raw.version === 3) {
    assertLegacyCollectionArray(raw, 'allowedUsers', 'account');
    const v3Users = Object.hasOwn(raw, 'allowedUsers') ? raw.allowedUsers as Record<string, unknown>[] : [];
    return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
      migrateV5ToV6({
        ...raw,
        version: 5,
        allowedUsers: v3Users.map((u) => ({
          username: u.username as string,
          permissions: migratePermissionsV3(u.permissions as LegacyV3Permissions),
          addedAt: u.addedAt as number,
        })),
      }),
    )))))));
  }

  if (raw.version === 2) {
    assertLegacyCollectionArray(raw, 'allowedUsers', 'account');
    const legacyUsers = Object.hasOwn(raw, 'allowedUsers') ? raw.allowedUsers as Record<string, unknown>[] : [];
    return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
      migrateV5ToV6({
        ...raw,
        version: 5,
        allowedUsers: legacyUsers.map((u) => ({
          username: u.username as string,
          permissions: legacyRoleToPermissions(String(u.role ?? '')),
          addedAt: u.addedAt as number,
        })),
      }),
    )))))));
  }

  assertLegacyCollectionArray(raw, 'allowedUsers', 'account');
  assertLegacyCollectionArray(raw, 'roles', 'role');
  if (Array.isArray(raw.allowedUsers) && raw.allowedUsers.length > 0) throw new Error('persistent account data has no supported migration');
  if (Array.isArray(raw.roles) && raw.roles.length > 0) throw new Error('persistent role data has no supported migration');
  const legacyKeys = Array.isArray(raw.apiKeys) ? (raw.apiKeys as Record<string, unknown>[]) : [];
  return migrateV16ToV17(migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
    migrateV5ToV6({
      apiKeys: legacyKeys.map((k) => ({
        id: k.id as string,
        name: k.name as string,
        ownerId: 'root',
        status: 'approved',
        hash: k.hash as string,
        createdAt: k.createdAt as number,
        approvedAt: k.createdAt as number,
        lastUsedAt: k.lastUsedAt as number | undefined,
      })),
      settings: (raw.settings as PersistedSettings) ?? {},
      jobHistory: (raw.jobHistory as JobHistoryEntry[]) ?? [],
    }),
  )))))));
}

function migrateV17ToV18(v17: PersistedState): PersistedState {
  const migrated = { ...v17, version: 18 };
  const history = Array.isArray(v17.backupHistory) ? v17.backupHistory : [];
  migrated.backupHistory = history.map((entry) => normalizeBackupHistoryEntry(entry));
  return migrated;
}

function migrate(raw: Record<string, unknown>): PersistedState {
  if (raw.version === 18) return raw as unknown as PersistedState;
  return migrateV17ToV18(migrateToV17(raw));
}

function normalizeLegacySchedulerRunOutcome(raw: unknown): SchedulerRunOutcome {
  const o = (raw ?? {}) as Partial<SchedulerRunOutcome>;
  const failureClasses: JobFailureClass[] = ['device_transport', 'app_store', 'testflight', 'network', 'storage', 'decrypt', 'queue', 'cancelled', 'unknown'];
  return {
    ok: typeof o.ok === 'boolean' ? o.ok : true,
    triggered: Boolean(o.triggered),
    reason: o.reason ?? '',
    failureClass: failureClasses.includes(o.failureClass as JobFailureClass) ? o.failureClass : undefined,
    retryable: typeof o.retryable === 'boolean' ? o.retryable : undefined,
    runUrl: o.runUrl,
    failureSummary: typeof o.failureSummary === 'string' ? o.failureSummary : undefined,
    destinationFailureSummary: typeof o.destinationFailureSummary === 'string' ? o.destinationFailureSummary : undefined,
    runStatus: o.runStatus,
    observedVersion: o.observedVersion,
    installMode: o.installMode,
    versionLabel: typeof o.versionLabel === 'string' ? o.versionLabel : undefined,
    dispatchTargetKeys: Array.isArray(o.dispatchTargetKeys) ? o.dispatchTargetKeys.filter((key): key is string => typeof key === 'string') : undefined,
  };
}

function normalizeLegacySchedulerRunHistory(entries: unknown): SchedulerRunEntry[] {
  if (!Array.isArray(entries)) return [];
  return (entries as Record<string, unknown>[]).map((e) => ({
    id: typeof e.id === 'string' ? e.id : randomUUID(),
    ts: e.ts as number,
    ...(typeof e.watchId === 'string' ? { watchId: e.watchId } : {}),
    ...(typeof e.bundleId === 'string' ? { bundleId: e.bundleId } : {}),
    appStore: normalizeLegacySchedulerRunOutcome(e.appStore),
    testflight: normalizeLegacySchedulerRunOutcome(e.testflight),
  }));
}

function normalizeBackupHistoryEntry(raw: unknown): BackupHistoryEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('persistent backup history entry is malformed');
  const entry = raw as Record<string, unknown>;
  const restoreDrillStatus = entry.restoreDrillStatus === 'passed' || entry.restoreDrillStatus === 'failed' || entry.restoreDrillStatus === 'not_run'
    ? entry.restoreDrillStatus
    : 'not_run';
  const restoreDrillChecks = Array.isArray(entry.restoreDrillChecks)
    ? entry.restoreDrillChecks.filter((check): check is BackupRestoreDrillCheck =>
      typeof check === 'object'
      && check !== null
      && typeof (check as Record<string, unknown>).label === 'string'
      && typeof (check as Record<string, unknown>).ok === 'boolean'
      && typeof (check as Record<string, unknown>).detail === 'string')
    : undefined;
  return {
    ...(entry as unknown as BackupHistoryEntry),
    integrity: entry.integrity === 'verified' || entry.integrity === 'failed' || entry.integrity === 'unavailable' ? entry.integrity : undefined,
    encryptedManifest: typeof entry.encryptedManifest === 'boolean' ? entry.encryptedManifest : undefined,
    restoreDrillStatus,
    restoreDrillAt: typeof entry.restoreDrillAt === 'number' ? entry.restoreDrillAt : undefined,
    restoreDrillChecks,
  };
}

function load(): PersistedState {
  mkdirSync(config.stateDir, { recursive: true });
  const stored = stateDatabase.readState({ legacyMirrorAvailable: existsSync(statePath) });
  if (stored !== undefined) {
    const storedRecord = asStateRecord(stored);
    const migrated = normalizeLoadedState(migrate(structuredClone(storedRecord)));
    if (JSON.stringify(stored) !== JSON.stringify(migrated)) {
      assertStructuredIndexesMatchSnapshot(storedRecord, migrated);
      stateDatabase.writeState(migrated, statePath);
    }
    return migrated;
  }
  try {
    const migrated = normalizeLoadedState(existsSync(statePath) ? migrate(asStateRecord(JSON.parse(readFileSync(statePath, 'utf8')))) : defaultState());
    stateDatabase.writeState(migrated, statePath);
    return migrated;
  } catch (error) {
    throw new Error(`could not initialize persistent state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertStructuredIndexesMatchSnapshot(stored: Record<string, unknown>, migrated: PersistedState): void {
  const collectionMatches = (table: string, candidates: unknown[][]): boolean => {
    const persisted = readStateCollection(stateDatabase.db, table);
    return candidates.some((candidate) => sameCollectionPayloads(candidate, persisted));
  };
  const recordCollection = (value: unknown, key: string): unknown[] => {
    const records = (value as Record<string, unknown>)[key];
    return Array.isArray(records) ? records : [];
  };
  const settingsCollection = (value: unknown): unknown[] => {
    const settings = (value as Record<string, unknown>).settings;
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return [];
    return Object.entries(settings).map(([key, settingValue]) => ({ key, value: settingValue }));
  };
  const assertCollection = (table: string, candidates: unknown[][], label: string): void => {
    if (!collectionMatches(table, candidates)) throw new Error(`persistent ${label} repository does not match state snapshot`);
  };

  assertCollection('settings', [settingsCollection(stored), settingsCollection(migrated)], 'settings');
  assertCollection('scheduler_runs', [recordCollection(stored, 'schedulerRunHistory'), migrated.schedulerRunHistory], 'scheduler run');
  assertCollection('watches', [recordCollection(stored, 'watches'), migrated.watches], 'watch');
  assertCollection('users', [recordCollection(stored, 'allowedUsers'), migrated.allowedUsers], 'account');
  assertCollection('roles', [recordCollection(stored, 'roles'), migrated.roles], 'account and role');
  assertCollection('projects', [recordCollection(stored, 'projects'), migrated.projects], 'project');

  const persistedSessions = sessionRepository.listAll();
  if (![recordCollection(stored, 'activeSessions'), migrated.activeSessions].some((candidate) => reconcileSessionLastSeen(candidate, persistedSessions))) {
    throw new Error('persistent session repository does not match state snapshot');
  }
  const reconciledSessions = reconcileSessionLastSeen(migrated.activeSessions, persistedSessions);
  if (reconciledSessions) migrated.activeSessions = reconciledSessions;

  const persistedApiKeys = readStateCollection(stateDatabase.db, 'api_keys');
  if (![
    recordCollection(stored, 'apiKeys'),
    migrated.apiKeys,
  ].some((candidate) => sameApiKeyRecordsExceptUsage(candidate, persistedApiKeys))) {
    throw new Error('persistent API key repository does not match state snapshot');
  }
  const reconciledApiKeys = reconcileApiKeyUsage(migrated.apiKeys, apiKeyRepository.listAll());
  if (reconciledApiKeys) migrated.apiKeys = reconciledApiKeys;

  const mismatch = firstStateOwnedCollectionMismatch(stateDatabase.db, [stored, migrated], [
    'settings',
    'scheduler_runs',
    'watches',
    'users',
    'roles',
    'projects',
    'sessions',
    'api_keys',
  ]);
  if (mismatch) throw new Error(`persistent ${mismatch} index does not match state snapshot`);
}

function asStateRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('persistent state must be a JSON object');
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && typeof record.version !== 'number') throw new Error('persistent state version must be a number');
  return record;
}

function normalizeLoadedState(migrated: PersistedState): PersistedState {
  if (!Array.isArray(migrated.allowedUsers) || !Array.isArray(migrated.roles)) throw new Error('persistent account or role data is malformed');
  validateAccountCollections({ users: migrated.allowedUsers, roles: migrated.roles });
  migrated.allowedUsers = migrated.allowedUsers.map((user) => ({ ...user, username: user.username.toLowerCase() }));
  migrated.devices = migrated.devices.map(normalizeLoadedDevice);
  migrated.backupHistory = Array.isArray(migrated.backupHistory) ? migrated.backupHistory.map(normalizeBackupHistoryEntry) : [];
  migrated.schedulerRunHistory = normalizeLegacySchedulerRunHistory(migrated.schedulerRunHistory);
  migrated.appCatalog = migrated.appCatalog ?? {};
  migrated.testFlightCatalog = isTestFlightCatalogCacheShape(migrated.testFlightCatalog) ? migrated.testFlightCatalog : undefined;
  migrated.notifications = Array.isArray(migrated.notifications) ? migrated.notifications.slice(0, MAX_NOTIFICATIONS) : [];
  migrated.testFlightSubscriptions = Array.isArray(migrated.testFlightSubscriptions) ? migrated.testFlightSubscriptions : [];
  migrated.projects = [projectRepository.findById(DEFAULT_PROJECT_ID) ?? createDefaultProject()];
  migrated.jobHistory = migrated.jobHistory.map((entry) => ({ ...entry, projectId: DEFAULT_PROJECT_ID }));
  migrated.watches = migrated.watches.map((watch) => ({ ...watch, projectId: DEFAULT_PROJECT_ID }));
  validateProjectCollection(migrated.projects);
  return migrated;
}

function validateProjectCollection(projects: ProjectRecord[]): void {
  if (!Array.isArray(projects) || !projects.every(isProjectRecordShape)) throw new Error('persistent project data is malformed');
  const projectIds = new Set(projects.map((project) => project.id));
  if (projectIds.size !== projects.length || projects.filter((project) => project.isDefault).length !== 1 || projects.filter((project) => project.isDefault && project.id === DEFAULT_PROJECT_ID).length !== 1) {
    throw new Error('persistent project data must contain unique ids and one default workspace');
  }
}

function normalizeLoadedDevice(device: DeviceRecord): DeviceRecord {
  const { rootDir: _rootDir, ...normalized } = device as DeviceRecord & { rootDir?: string };
  if (!normalized.host && !normalized.udid) throw new Error(`device ${normalized.id} requires direct USB or Wi-Fi setup`);
  return normalized;
}

export function getAppCatalogEntry(bundleId: string): AppCatalogEntry | undefined {
  return state.appCatalog[bundleId];
}

export function getAppCatalogEntries(bundleIds: string[]): AppCatalogEntry[] {
  const unique = new Set(bundleIds.filter((bundleId) => !!bundleId));
  const entries: AppCatalogEntry[] = [];
  for (const bundleId of unique) {
    const entry = state.appCatalog[bundleId];
    if (entry) entries.push(entry);
  }
  return entries;
}

export function searchAppCatalogEntries(query: string, limit = 8): AppCatalogEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];
  return Object.values(state.appCatalog)
    .filter((entry) => entry.bundleId.toLowerCase().includes(normalizedQuery) || entry.displayName.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => {
      const leftPrefix = Number(left.displayName.toLowerCase().startsWith(normalizedQuery) || left.bundleId.toLowerCase().startsWith(normalizedQuery));
      const rightPrefix = Number(right.displayName.toLowerCase().startsWith(normalizedQuery) || right.bundleId.toLowerCase().startsWith(normalizedQuery));
      return rightPrefix - leftPrefix || left.displayName.localeCompare(right.displayName);
    })
    .slice(0, Math.max(0, Math.min(20, limit)));
}

export function getAppCatalogStats(): { entries: number; icons: number; oldestUpdatedAt?: number; newestUpdatedAt?: number } {
  const entries = Object.values(state.appCatalog);
  const updatedAt = entries.map((entry) => entry.updatedAt).filter(Number.isFinite);
  return {
    entries: entries.length,
    icons: entries.filter((entry) => Boolean(entry.iconUrl)).length,
    oldestUpdatedAt: updatedAt.length ? Math.min(...updatedAt) : undefined,
    newestUpdatedAt: updatedAt.length ? Math.max(...updatedAt) : undefined,
  };
}

export function getTestFlightCatalogCache(): TestFlightCatalogCache | undefined {
  const cache = state.testFlightCatalog;
  if (!cache) return undefined;
  return {
    fetchedAt: cache.fetchedAt,
    deviceIds: [...cache.deviceIds],
    apps: cache.apps.map((app) => ({ ...app, devices: app.devices.map((device) => ({ ...device })) })),
    complete: cache.complete,
  };
}

export function setTestFlightCatalogCache(cache: TestFlightCatalogCache): void {
  state.testFlightCatalog = {
    fetchedAt: cache.fetchedAt,
    deviceIds: [...new Set(cache.deviceIds)],
    apps: cache.apps.map((app) => ({ ...app, devices: app.devices.map((device) => ({ ...device })) })),
    complete: cache.complete,
  };
  persistNow();
}

export function upsertAppCatalogEntry(entry: Omit<AppCatalogEntry, 'updatedAt'>): AppCatalogEntry {
  const bundleId = entry.bundleId.trim();
  const previous = state.appCatalog[bundleId];
  const normalized: AppCatalogEntry = {
    ...previous,
    ...entry,
    bundleId,
    displayName: entry.displayName.trim(),
    iconUrl: entry.iconUrl ?? previous?.iconUrl,
    trackId: entry.trackId ?? previous?.trackId,
    sellerName: entry.sellerName ?? previous?.sellerName,
    category: entry.category ?? previous?.category,
    description: entry.description ?? previous?.description,
    screenshots: entry.screenshots ?? previous?.screenshots,
    releaseNotes: entry.releaseNotes ?? previous?.releaseNotes,
    price: entry.price ?? previous?.price,
    metadataFetchedAt: entry.metadataFetchedAt ?? previous?.metadataFetchedAt,
    latestAppStoreVersion: entry.latestAppStoreVersion ?? previous?.latestAppStoreVersion,
    latestAppStoreExternalId: entry.latestAppStoreExternalId ?? previous?.latestAppStoreExternalId,
    appStoreReleaseCheckedAt: entry.appStoreReleaseCheckedAt ?? previous?.appStoreReleaseCheckedAt,
    latestTestFlightVersion: entry.latestTestFlightVersion ?? previous?.latestTestFlightVersion,
    latestTestFlightBuildId: entry.latestTestFlightBuildId ?? previous?.latestTestFlightBuildId,
    testFlightReleaseCheckedAt: entry.testFlightReleaseCheckedAt ?? previous?.testFlightReleaseCheckedAt,
    updatedAt: Date.now(),
  };
  if (!normalized.bundleId || !normalized.displayName) {
    throw new Error('bundleId and displayName are required');
  }
  state.appCatalog[normalized.bundleId] = normalized;
  dirty = true;
  return normalized;
}

export function upsertAppCatalogEntries(entries: Array<Omit<AppCatalogEntry, 'updatedAt'>>): AppCatalogEntry[] {
  const updated: AppCatalogEntry[] = [];
  for (const entry of entries) {
    if (!entry.bundleId?.trim() || !entry.displayName?.trim()) continue;
    updated.push(
      upsertAppCatalogEntry({
        bundleId: entry.bundleId,
        displayName: entry.displayName,
        iconUrl: entry.iconUrl,
        trackId: entry.trackId,
        sellerName: entry.sellerName,
        category: entry.category,
        description: entry.description,
        screenshots: entry.screenshots?.slice(0, 10),
        releaseNotes: entry.releaseNotes,
        price: entry.price,
        metadataFetchedAt: entry.metadataFetchedAt,
        latestAppStoreVersion: entry.latestAppStoreVersion,
        latestAppStoreExternalId: entry.latestAppStoreExternalId,
        appStoreReleaseCheckedAt: entry.appStoreReleaseCheckedAt,
        latestTestFlightVersion: entry.latestTestFlightVersion,
        latestTestFlightBuildId: entry.latestTestFlightBuildId,
        testFlightReleaseCheckedAt: entry.testFlightReleaseCheckedAt,
      }),
    );
  }
  if (updated.length > 0) persistNow();
  return updated;
}

let dirty = false;
const state: PersistedState = load();
const persistedBackups = backupRepository.listAll();
if (!sameRecordsByKey(state.backupHistory, persistedBackups, (entry) => entry.id)) {
  throw new Error('persistent backup repository does not match state snapshot');
}
if (JSON.stringify(state.backupHistory) !== JSON.stringify(persistedBackups)) {
  state.backupHistory = persistedBackups;
  dirty = true;
}
const persistedBackupSchedule = backupScheduleRepository.get();
if (!persistedBackupSchedule || JSON.stringify(state.backupSchedule) !== JSON.stringify(persistedBackupSchedule)) {
  throw new Error('persistent backup schedule repository does not match state snapshot');
}
const persistedSchedulerRuns = schedulerRunRepository.listAll();
if (!sameRecordsByKey(state.schedulerRunHistory, persistedSchedulerRuns, (entry) => entry.id)) {
  throw new Error('persistent scheduler run repository does not match state snapshot');
}
const persistedWatches = watchRepository.listAll();
if (!sameRecordsByKey(state.watches, persistedWatches, (watch) => watch.id)) {
  throw new Error('persistent watch repository does not match state snapshot');
}
const persistedSettings = settingsRepository.listAll();
if (!sameObjectEntries(state.settings, persistedSettings)) {
  throw new Error('persistent settings repository does not match state snapshot');
}
let persistedAllowedUsers = accountRepository.listUsers();
let persistedRoles = accountRepository.listRoles();
if (!accountRepository.hasNormalizedUsernameRowIds()) {
  if (!sameRecordsByKey(state.allowedUsers, persistedAllowedUsers, (user) => user.username) || !sameRecordsByKey(state.roles, persistedRoles, (role) => role.id)) {
    throw new Error('persistent account and role repositories do not match the state snapshot');
  }
  accountRepository.replaceAll({ users: persistedAllowedUsers, roles: persistedRoles });
  persistedAllowedUsers = accountRepository.listUsers();
  persistedRoles = accountRepository.listRoles();
}
if (JSON.stringify(state.allowedUsers) !== JSON.stringify(persistedAllowedUsers) || JSON.stringify(state.roles) !== JSON.stringify(persistedRoles)) {
  throw new Error('persistent account and role repositories do not match the state snapshot');
}
validateAccountCollections({ users: state.allowedUsers, roles: state.roles });
const persistedApiKeys = apiKeyRepository.listAll();
const reconciledApiKeys = reconcileApiKeyUsage(state.apiKeys, persistedApiKeys);
if (!reconciledApiKeys) {
  throw new Error('persistent API key repository does not match state snapshot');
}
if (JSON.stringify(state.apiKeys) !== JSON.stringify(reconciledApiKeys)) {
  state.apiKeys = reconciledApiKeys;
  dirty = true;
}
const persistedProjects = projectRepository.listAll();
validateProjectCollection(persistedProjects);
if (!sameRecordsByKey(state.projects, persistedProjects, (project) => project.id)) {
  throw new Error('persistent project repository does not match state snapshot');
}
const persistedDevices = deviceRepository.listAll();
if (JSON.stringify(state.devices) !== JSON.stringify(persistedDevices)) {
  state.devices = persistedDevices;
  dirty = true;
}
const persistedSessions = sessionRepository.listAll();
const reconciledSessions = reconcileSessionLastSeen(state.activeSessions, persistedSessions);
if (!reconciledSessions) throw new Error('persistent session repository does not match state snapshot');
if (JSON.stringify(state.activeSessions) !== JSON.stringify(reconciledSessions)) {
  state.activeSessions = reconciledSessions;
  dirty = true;
}
cleanupBackupSnapshotDirectories(state.backupHistory);
const unavailableLegacyMirrors = new Set<string>();

function fsyncPath(filePath: string): void {
  const descriptor = openSync(filePath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function persistNow(additionalCollections: readonly StateCollectionReplacement[] = [], afterCollections?: (database: StateDatabase['db']) => void): void {
  const collections = [...additionalCollections];
  for (const replacement of accountRepository.collectionReplacements({ users: state.allowedUsers, roles: state.roles })) {
    if (!collections.some((collection) => collection.table === replacement.table)) collections.push(replacement);
  }
  if (!collections.some((collection) => collection.table === 'api_keys')) {
    collections.push(apiKeyRepository.collectionReplacement(state.apiKeys));
  }
  if (!collections.some((collection) => collection.table === 'projects')) {
    collections.push(projectCollectionReplacement(state.projects));
  }
  if (!collections.some((collection) => collection.table === 'settings')) {
    collections.push(settingsRepository.collectionReplacement(state.settings));
  }
  if (!collections.some((collection) => collection.table === 'watches')) {
    collections.push(watchRepository.collectionReplacement(state.watches));
  }
  if (!collections.some((collection) => collection.table === 'scheduler_runs')) {
    collections.push(schedulerRunRepository.collectionReplacement(state.schedulerRunHistory));
  }
  if (!collections.some((collection) => collection.table === 'backups')) {
    collections.push(backupRepository.collectionReplacement(state.backupHistory));
  }
  if (!collections.some((collection) => collection.table === 'backup_schedule')) {
    collections.push(backupScheduleRepository.collectionReplacement(state.backupSchedule));
  }
  stateDatabase.writeState(state, undefined, collections, afterCollections);
  dirty = false;
  syncLegacyStateMirror('state', () => writeStateMirror(statePath, state));
}

function projectCollectionReplacement(projects: ProjectRecord[]): StateCollectionReplacement {
  return { table: 'projects', rows: projects.map((project) => ({ id: project.id, payload: project, updatedAt: project.updatedAt })) };
}

function syncLegacyStateMirror(name: string, sync: () => void): void {
  try {
    sync();
    if (unavailableLegacyMirrors.delete(name)) log.info('legacy state mirror sync recovered', { name });
  } catch (error) {
    if (unavailableLegacyMirrors.has(name)) return;
    unavailableLegacyMirrors.add(name);
    log.warn('failed to sync a legacy state mirror', { name, error: String(error) });
  }
}

function encryptedBackupManifest(value: Record<string, unknown>): string {
  const key = createHash('sha256').update(config.backupManifestSecret || config.sessionSigningSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64url'), tag: tag.toString('base64url'), ciphertext: ciphertext.toString('base64url') });
}

function verifyEncryptedBackupManifest(manifestPath: string, jsonPath: string, databasePath: string): void {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: number; algorithm?: string; iv?: string; tag?: string; ciphertext?: string };
  if (manifest.version !== 1 || manifest.algorithm !== 'aes-256-gcm' || !manifest.iv || !manifest.tag || !manifest.ciphertext) throw new Error('backup manifest is malformed');
  let payload: { jsonSha256?: string; databaseSha256?: string } | undefined;
  const secrets = [
    config.backupManifestSecret,
    ...config.backupManifestSecretPrevious,
    config.sessionSigningSecret,
    config.sessionSigningSecretPrevious,
  ].filter((secret, index, candidates): secret is string => Boolean(secret) && candidates.indexOf(secret) === index);
  for (const secret of secrets) {
    try {
      const key = createHash('sha256').update(secret).digest();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(manifest.tag, 'base64url'));
      payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(manifest.ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as { jsonSha256?: string; databaseSha256?: string };
      break;
    } catch {
      continue;
    }
  }
  if (!payload) throw new Error('backup manifest encryption key did not match a configured current or previous key');
  const jsonSha256 = createHash('sha256').update(readFileSync(jsonPath)).digest('hex');
  const databaseSha256 = createHash('sha256').update(readFileSync(databasePath)).digest('hex');
  if (payload.jsonSha256 !== jsonSha256 || payload.databaseSha256 !== databaseSha256) throw new Error('backup manifest checksum verification failed');
}

export function startStateFlusher(): void {
  stateFlushTimer ??= setInterval(() => {
    if (dirty) persistNow();
  }, 30_000).unref();
}

let stateFlushTimer: NodeJS.Timeout | undefined;
let sessionSweepTimer: NodeJS.Timeout | undefined;
let apiKeySweepTimer: NodeJS.Timeout | undefined;

export function stopStateBackgroundServices(): void {
  if (stateFlushTimer) clearInterval(stateFlushTimer);
  if (sessionSweepTimer) clearInterval(sessionSweepTimer);
  if (apiKeySweepTimer) clearInterval(apiKeySweepTimer);
  stateFlushTimer = undefined;
  sessionSweepTimer = undefined;
  apiKeySweepTimer = undefined;
  if (dirty) persistNow();
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function findGeneratedApiKeyRecord(candidate: string): ApiKeyRecord | undefined {
  const hash = hashKey(candidate);
  const record = apiKeyRepository.findApprovedByHash(hash, Date.now());
  return record ? state.apiKeys.find((candidateRecord) => candidateRecord.id === record.id) ?? record : undefined;
}

export function isGeneratedApiKey(candidate: string): boolean {
  return !!findGeneratedApiKeyRecord(candidate);
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function listAllowedUsers(): AllowedUser[] {
  return state.allowedUsers.map((user) => structuredClone(user));
}

export function getUserMfa(username: string): UserMfaRecord | undefined {
  if (username === 'root') return state.rootMfa ? { ...state.rootMfa, recoveryCodeHashes: state.rootMfa.recoveryCodeHashes ? [...state.rootMfa.recoveryCodeHashes] : undefined } : undefined;
  const user = state.allowedUsers.find((entry) => entry.username === username.toLowerCase());
  return user?.mfa ? { ...user.mfa, recoveryCodeHashes: user.mfa.recoveryCodeHashes ? [...user.mfa.recoveryCodeHashes] : undefined } : undefined;
}

export function setUserMfa(username: string, mfa: UserMfaRecord | undefined): boolean {
  if (username === 'root') {
    state.rootMfa = mfa ? { ...mfa, recoveryCodeHashes: mfa.recoveryCodeHashes ? [...mfa.recoveryCodeHashes] : undefined } : undefined;
    persistNow();
    return true;
  }
  const user = state.allowedUsers.find((entry) => entry.username === username.toLowerCase());
  if (!user) return false;
  user.mfa = mfa ? { ...mfa, recoveryCodeHashes: mfa.recoveryCodeHashes ? [...mfa.recoveryCodeHashes] : undefined } : undefined;
  persistNow();
  return true;
}

export function listPasskeysForUser(userId: string): PasskeyCredential[] {
  const normalized = userId === 'root' ? 'root' : userId.toLowerCase();
  return state.passkeys.filter((credential) => credential.userId === normalized).map((credential) => ({ ...credential, transports: credential.transports ? [...credential.transports] : undefined }));
}

export function getPasskeyById(id: string): PasskeyCredential | undefined {
  const credential = state.passkeys.find((candidate) => candidate.id === id);
  return credential ? { ...credential, transports: credential.transports ? [...credential.transports] : undefined } : undefined;
}

export function addPasskey(credential: PasskeyCredential): PasskeyCredential {
  if (state.passkeys.some((candidate) => candidate.id === credential.id)) throw new Error('passkey credential already exists');
  const normalized = { ...credential, userId: credential.userId === 'root' ? 'root' : credential.userId.toLowerCase(), transports: credential.transports ? [...credential.transports] : undefined };
  state.passkeys.push(normalized);
  persistNow();
  return { ...normalized, transports: normalized.transports ? [...normalized.transports] : undefined };
}

export function updatePasskey(id: string, patch: Partial<Pick<PasskeyCredential, 'counter' | 'lastUsedAt' | 'name'>>): PasskeyCredential | undefined {
  const credential = state.passkeys.find((candidate) => candidate.id === id);
  if (!credential) return undefined;
  Object.assign(credential, patch);
  persistNow();
  return { ...credential, transports: credential.transports ? [...credential.transports] : undefined };
}

export function deletePasskey(userId: string, id: string): boolean {
  const normalized = userId === 'root' ? 'root' : userId.toLowerCase();
  const index = state.passkeys.findIndex((credential) => credential.id === id && credential.userId === normalized);
  if (index === -1) return false;
  state.passkeys.splice(index, 1);
  persistNow();
  return true;
}

export function listRoles(): Role[] {
  return state.roles.map((role) => structuredClone(role)).sort((a, b) => a.position - b.position);
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  memberIds?: string[];
  storageQuotaBytes?: number;
  dailyJobQuota?: number;
  maxConcurrentJobs?: number;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  memberIds?: string[];
  storageQuotaBytes?: number | null;
  dailyJobQuota?: number | null;
  maxConcurrentJobs?: number | null;
  archived?: boolean;
}

export function getProject(_id: string): ProjectRecord | undefined {
  return projectRepository.findById(DEFAULT_PROJECT_ID);
}

export function listProjectsForUser(_userId: string, _includeAll = false): ProjectRecord[] {
  const account = projectRepository.findById(DEFAULT_PROJECT_ID) ?? createDefaultProject();
  return [{ ...account, name: 'dkrypt', memberIds: [] }];
}

export function userCanAccessProject(_userId: string, _projectId: string): boolean {
  return true;
}

function normalizeProjectMemberIds(memberIds: string[]): string[] {
  return [...new Set(memberIds.map((memberId) => memberId.trim().toLowerCase()).filter(Boolean))];
}

export function createProject(_input: CreateProjectInput, _actor: string): { ok: boolean; project: ProjectRecord } {
  const account = projectRepository.findById(DEFAULT_PROJECT_ID) ?? createDefaultProject();
  return { ok: true, project: { ...account, name: 'dkrypt', memberIds: [] } };
}

export function updateProject(_id: string, _patch: UpdateProjectInput, _actor: string): { ok: false; error: string } {
  return { ok: false, error: 'dkrypt uses one shared account space' };
}

export function getRole(id: string): Role | undefined {
  const role = state.roles.find((candidate) => candidate.id === id);
  return role ? structuredClone(role) : undefined;
}

export interface RoleImpactMember {
  username: string;
  beforePermissions: string;
  afterPermissions: string;
}

export function previewRoleImpact(id: string, permissions: string): { affectedCount: number; members: RoleImpactMember[]; truncated: boolean } | undefined {
  if (!state.roles.some((role) => role.id === id)) return undefined;
  const nextBits = parseBits(permissions);
  const simulatedRoles = state.roles.map((role) => role.id === id ? { ...role, permissions: serializeBits(nextBits) } : role);
  const impacted = state.allowedUsers.flatMap((user) => {
    const rawBefore = getUserEffectivePermissions(user.username);
    const billing = getBillingEntitlements(user.username.toLowerCase());
    const billingBits = (billing.decrypt ? PermissionFlag.requestDecrypt : 0n) | (billing.api ? PermissionFlag.createApiKeys : 0n);
    const rawAfter = effectiveBitsForRoleIds(user.roleIds, simulatedRoles) | billingBits;
    const before = hasPermission(rawBefore, PermissionFlag.administrator) ? PermissionFlag.administrator : rawBefore;
    const after = hasPermission(rawAfter, PermissionFlag.administrator) ? PermissionFlag.administrator : rawAfter;
    return before === after ? [] : [{ username: user.username, beforePermissions: serializeBits(before), afterPermissions: serializeBits(after) }];
  });
  return { affectedCount: impacted.length, members: impacted.slice(0, 100), truncated: impacted.length > 100 };
}

export function getUserEffectivePermissions(username: string): bigint {
  const user = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  const billing = getBillingEntitlements(username.toLowerCase());
  const billingBits =
    (billing.decrypt ? PermissionFlag.requestDecrypt : 0n) |
    (billing.api ? PermissionFlag.createApiKeys : 0n);
  return effectiveBitsForRoleIds(user?.roleIds ?? [], state.roles) | billingBits;
}

export function listDeviceAlertRecipients(): string[] {
  const recipients = state.allowedUsers
    .filter((user) => hasPermission(getUserEffectivePermissions(user.username), PermissionFlag.viewDevices | PermissionFlag.manageDevices))
    .map((user) => user.username);
  return [...new Set(['root', ...recipients])];
}

export function recordDeploymentReadyNotifications(deployment: { id: string; ref: string }): number {
  if (deployment.id === 'local' || deployment.ref === 'development') return 0;
  const recipients = state.allowedUsers
    .filter((user) => hasPermission(getUserEffectivePermissions(user.username), PermissionFlag.manageDevices))
    .map((user) => user.username);
  const groupKey = `deployment-ready:${deployment.id}`;
  let created = 0;
  for (const userId of new Set(['root', ...recipients])) {
    const alreadyNotified = state.notifications.some((notification) =>
      notification.userId.toLowerCase() === userId.toLowerCase() && notification.deploymentId === deployment.id,
    );
    if (alreadyNotified) continue;
    recordNotification({
      userId,
      title: 'dkrypt deployment is live',
      message: `Build ${deployment.ref.slice(0, 12)} is serving traffic.`,
      severity: 'success',
      deploymentId: deployment.id,
      groupKey,
      href: `/?tab=settings&stab=doctor#deployment-${encodeURIComponent(deployment.id)}`,
    });
    created += 1;
  }
  return created;
}

export function getSessionVersion(username: string): number {
  if (username === 'root') return state.rootSessionVersion;
  return state.allowedUsers.find((u) => u.username === username.toLowerCase())?.sessionVersion ?? 0;
}

export function bumpSessionVersion(username: string): void {
  if (username === 'root') {
    state.rootSessionVersion += 1;
    revokeUserSessions(username);
    persistNow();
    return;
  }
  const user = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  if (!user) return;
  user.sessionVersion = (user.sessionVersion ?? 0) + 1;
  revokeUserSessions(user.username);
  persistNow();
}

function revokeUserSessions(userId: string): number {
  const revoked = sessionRepository.revokeUser(userId);
  if (revoked > 0) state.activeSessions = sessionRepository.listAll();
  return revoked;
}

const SESSION_RECORD_THROTTLE_MS = 60_000;
const MAX_SESSIONS_PER_USER = 20;
const SESSION_RECORD_TTL_MS = 12 * 60 * 60 * 1000;

export function createSessionRecord(sub: string, userAgent: string | undefined, ip: string | undefined): ActiveSessionRecord {
  const now = Date.now();
  const newContext = userAgent !== undefined && ip !== undefined && state.activeSessions.some((session) =>
    session.sub === sub &&
    now - session.lastSeenAt < SESSION_RECORD_TTL_MS &&
    session.userAgent !== undefined &&
    session.ip !== undefined &&
    session.userAgent !== userAgent &&
    session.ip !== ip,
  );
  const record: ActiveSessionRecord = {
    id: randomUUID(),
    sub,
    createdAt: now,
    lastSeenAt: now,
    userAgent,
    ip,
    ...(newContext ? { risk: 'new_context' as const } : {}),
  };
  sessionRepository.create(record, MAX_SESSIONS_PER_USER);
  state.activeSessions = sessionRepository.listAll();
  if (newContext) recordAudit(sub, 'auth.session.new_context', record.id, 'new browser and network context while another session was active');
  else persistNow();
  return record;
}

export function isSessionRecordActive(id: string): boolean {
  return sessionRepository.isActive(id);
}

export function touchSessionRecord(id: string): void {
  const record = state.activeSessions.find((s) => s.id === id);
  if (!record) return;
  const now = Date.now();
  if (now - record.lastSeenAt < SESSION_RECORD_THROTTLE_MS) return;
  if (!sessionRepository.touch(id, now)) return;
  state.activeSessions = sessionRepository.listAll();
  dirty = true;
}

export function listSessionsForUser(sub: string): ActiveSessionRecord[] {
  return sessionRepository.listByUser(sub);
}

export function revokeSessionRecord(id: string, sub: string): boolean {
  if (!sessionRepository.revoke(id, sub)) return false;
  state.activeSessions = sessionRepository.listAll();
  persistNow();
  return true;
}

export function revokeOtherSessionRecords(sub: string, keepId: string): number {
  const removed = sessionRepository.revokeOthers(sub, keepId);
  if (removed > 0) {
    state.activeSessions = sessionRepository.listAll();
    persistNow();
  }
  return removed;
}

export function startSessionSweeper(): void {
  sessionSweepTimer ??= setInterval(() => {
    const now = Date.now();
    const expired = sessionRepository.deleteExpiredBefore(now - SESSION_RECORD_TTL_MS);
    if (expired > 0) {
      state.activeSessions = sessionRepository.listAll();
      persistNow();
    }
  }, 60_000).unref();
}

const ACTIVITY_THROTTLE_MS = 60_000;

export function recordUserActivity(username: string): void {
  if (username === 'root') return;
  const user = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  if (!user) return;
  const now = Date.now();
  if (user.lastActiveAt && now - user.lastActiveAt < ACTIVITY_THROTTLE_MS) return;
  user.lastActiveAt = now;
  dirty = true;
}

export function wouldOrphanPermission(username: string, flag: bigint, hypotheticalRoleIds: string[] | null): boolean {
  const lower = username.toLowerCase();
  const currentBits = getUserEffectivePermissions(lower);
  if (!currentBits || !hasPermission(currentBits, flag)) return false;
  const othersHaveIt = state.allowedUsers.some(
    (u) => u.username !== lower && hasPermission(effectiveBitsForRoleIds(u.roleIds, state.roles), flag),
  );
  if (othersHaveIt) return false;
  const newBits = effectiveBitsForRoleIds(hypotheticalRoleIds ?? [], state.roles);
  return !hasPermission(newBits, flag);
}

function wouldOrphanManageUsersViaRole(roleId: string, newBits: bigint | null): boolean {
  const before = state.allowedUsers.some((u) => hasPermission(effectiveBitsForRoleIds(u.roleIds, state.roles), PermissionFlag.manageUsers));
  if (!before) return false;
  const simulatedRoles =
    newBits === null
      ? state.roles.filter((r) => r.id !== roleId)
      : state.roles.map((r) => (r.id === roleId ? { ...r, permissions: serializeBits(newBits) } : r));
  const after = state.allowedUsers.some((u) => hasPermission(effectiveBitsForRoleIds(u.roleIds, simulatedRoles), PermissionFlag.manageUsers));
  return !after;
}

function roleAssignmentDiff(before: string[], after: string[]): string {
  const added = after.filter((id) => !before.includes(id)).map((id) => getRole(id)?.name ?? id);
  const removed = before.filter((id) => !after.includes(id)).map((id) => getRole(id)?.name ?? id);
  const parts = [...added.map((n) => `+${n}`), ...removed.map((n) => `-${n}`)];
  return parts.length > 0 ? parts.join(', ') : '(no change)';
}

function safeAuditValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;"']+/gi, '$1[redacted]')
    .replace(/\b((?:token|secret|password|cookie|credential|api[-_ ]?key)\s*[:=]\s*)[^\s,;"']+/gi, '$1[redacted]')
    .slice(0, 240);
}

export function recordAudit(
  actor: string,
  action: AuditAction,
  target: string,
  detail?: string,
  changes?: Array<{ field: string; before: unknown; after: unknown }>,
): void {
  const safeChanges = changes?.flatMap((change) => {
    if (/secret|password|token|cookie|credential|private.?key|api.?key|email|host|udid/i.test(change.field)) return [];
    const before = safeAuditValue(change.before);
    const after = safeAuditValue(change.after);
    return before === undefined || after === undefined ? [] : [{ field: change.field.slice(0, 80), before, after }];
  });
  state.auditLog.unshift({ id: randomUUID(), ts: Date.now(), actor, action, target: String(safeAuditValue(target) ?? '[redacted]'), detail: safeAuditValue(detail) as string | undefined, changes: safeChanges?.length ? safeChanges : undefined });
  if (state.auditLog.length > MAX_AUDIT_LOG) state.auditLog.length = MAX_AUDIT_LOG;
  persistNow();
}

export function areNewBillingCheckoutsPaused(): boolean {
  return state.settings.billingCheckoutsPaused === true;
}

export function setNewBillingCheckoutsPaused(paused: boolean, actor: string): boolean {
  const before = areNewBillingCheckoutsPaused();
  if (before === paused) return paused;
  state.settings = { ...state.settings, billingCheckoutsPaused: paused };
  recordAudit(actor, 'billing.checkouts.pause', 'new-checkouts', paused ? 'paused' : 'resumed', [
    { field: 'newCheckoutsPaused', before, after: paused },
  ]);
  return paused;
}

export function getAuditLog(limit = 100): AuditLogEntry[] {
  return auditRepository.listRecent(MAX_AUDIT_LOG).slice(0, limit);
}

export function getAuditLogByTarget(target: string, limit = 5): AuditLogEntry[] {
  return auditRepository.listByTarget(target, limit);
}

export function getAuditLogPage(offset = 0, limit = 100, cursor?: string): { entries: AuditLogEntry[]; total: number; nextCursor?: string } {
  const page = paginateCursor(auditRepository.listRecent(MAX_AUDIT_LOG), {
    cursor,
    offset,
    limit,
    keyOf: (entry) => [entry.ts, entry.id],
    order: 'desc',
  });
  return { entries: page.items, total: auditRepository.count(), nextCursor: page.nextCursor };
}

function sanitizeRoleIds(roleIds: string[]): string[] {
  return [...new Set(roleIds)].filter((id) => state.roles.some((r) => r.id === id && !r.isDefault));
}

export function addAllowedUser(username: string, roleIds: string[], actor: string): AllowedUser {
  const lower = username.toLowerCase();
  const sanitized = sanitizeRoleIds(roleIds);
  const existing = state.allowedUsers.find((u) => u.username === lower);
  if (existing) {
    const detail = roleAssignmentDiff(existing.roleIds, sanitized);
    existing.roleIds = sanitized;
    persistNow();
    recordAudit(actor, 'user.update', lower, detail);
    return existing;
  }
  const record: AllowedUser = { username: lower, roleIds: sanitized, addedAt: Date.now() };
  state.allowedUsers.push(record);
  persistNow();
  recordAudit(actor, 'user.add', lower, roleAssignmentDiff([], sanitized));
  return record;
}

export function getDiscordGuilds(): DiscordGuildConfiguration[] {
  return state.discordGuilds;
}

export function getDiscordGuildIds(): string[] {
  return state.discordGuilds.map((guild) => guild.id);
}

export function setDiscordGuilds(guilds: DiscordGuildConfiguration[], actor: string): void {
  state.discordGuilds = [...new Map(guilds.filter((guild) => guild.id).map((guild) => [guild.id, guild])).values()];
  const selectedGuildIds = new Set(state.discordGuilds.map((guild) => guild.id));
  state.discordRolePerks = state.discordRolePerks.filter((perk) => selectedGuildIds.has(perk.guildId));
  persistNow();
  recordAudit(actor, 'role.update', 'discord-guilds', state.discordGuilds.length ? `set to ${state.discordGuilds.map((guild) => guild.id).join(', ')}` : 'cleared');
}

export function setDiscordGuildIds(guildIds: string[], actor: string): void {
  setDiscordGuilds(guildIds.map((id) => ({ id, name: id, icon: null })), actor);
}

export function getDiscordRolePerks(): DiscordRolePerk[] {
  return state.discordRolePerks;
}

export function createDiscordRolePerk(
  guild: DiscordGuildConfiguration,
  discordRole: DiscordGuildRoleConfiguration,
  appRoleId: string,
  actor: string,
): DiscordRolePerk {
  const perk: DiscordRolePerk = {
    id: randomUUID(),
    guildId: guild.id,
    guildName: guild.name,
    guildIcon: guild.icon,
    discordRoleId: discordRole.id,
    discordRoleName: discordRole.name,
    discordRoleColor: discordRole.color,
    appRoleId,
    createdAt: Date.now(),
  };
  state.discordRolePerks.push(perk);
  persistNow();
  recordAudit(actor, 'role.update', appRoleId, `Discord role perk added: ${discordRole.name}`);
  return perk;
}

export function deleteDiscordRolePerk(id: string, actor: string): boolean {
  const before = state.discordRolePerks.length;
  state.discordRolePerks = state.discordRolePerks.filter((p) => p.id !== id);
  const changed = state.discordRolePerks.length !== before;
  if (changed) {
    persistNow();
    recordAudit(actor, 'role.update', id, 'Discord role perk removed');
  }
  return changed;
}

export function syncDiscordPerkRoles(userId: string, memberships: DiscordGuildMembership[]): void {
  let user = state.allowedUsers.find((u) => u.username === userId.toLowerCase());
  if (!user) {
    user = { username: userId.toLowerCase(), roleIds: [], addedAt: Date.now() };
    state.allowedUsers.push(user);
  }

  const roleIdsByGuild = new Map(memberships.map((membership) => [membership.guildId, membership.roleIds]));
  const grantedAppRoleIds = [
    ...new Set(
      state.discordRolePerks
        .filter((perk) => roleIdsByGuild.get(perk.guildId)?.includes(perk.discordRoleId))
        .map((perk) => perk.appRoleId),
    ),
  ];
  const unverifiedAppRoleIds = new Set(
    state.discordRolePerks
      .filter((perk) => roleIdsByGuild.get(perk.guildId) === undefined)
      .map((perk) => perk.appRoleId),
  );
  const previouslyGranted = user.discordPerkRoleIds ?? [];
  if (grantedAppRoleIds.length === 0 && previouslyGranted.length === 0) return;

  const retainedAppRoleIds = previouslyGranted.filter((id) => unverifiedAppRoleIds.has(id));
  const nextDiscordPerkRoleIds = [...new Set([...grantedAppRoleIds, ...retainedAppRoleIds])];
  const withoutStalePerks = user.roleIds.filter((id) => !previouslyGranted.includes(id) || nextDiscordPerkRoleIds.includes(id));
  user.roleIds = sanitizeRoleIds([...withoutStalePerks, ...nextDiscordPerkRoleIds]);
  user.discordPerkRoleIds = nextDiscordPerkRoleIds;
  persistNow();
}

export function mergeUserAccounts(targetUsername: string, sourceUsername: string, actor: string): boolean {
  const targetId = targetUsername.toLowerCase();
  const sourceId = sourceUsername.toLowerCase();
  if (targetId === sourceId) return false;

  const source = state.allowedUsers.find((user) => user.username === sourceId);
  if (!source) return false;
  const target = state.allowedUsers.find((user) => user.username === targetId);

  if (target) {
    target.roleIds = sanitizeRoleIds([...target.roleIds, ...source.roleIds]);
    target.addedAt = Math.min(target.addedAt, source.addedAt);
    target.lastActiveAt = Math.max(target.lastActiveAt ?? 0, source.lastActiveAt ?? 0) || undefined;
    target.priority = Math.max(target.priority ?? 0, source.priority ?? 0);
    target.sessionVersion = Math.max(target.sessionVersion ?? 0, source.sessionVersion ?? 0) + 1;
    state.allowedUsers = state.allowedUsers.filter((user) => user !== source);
  } else {
    source.username = targetId;
    source.sessionVersion = (source.sessionVersion ?? 0) + 1;
  }

  for (const key of state.apiKeys) {
    if (key.ownerId === sourceId) key.ownerId = targetId;
  }
  for (const entry of state.jobHistory) {
    if (entry.queuedBy === sourceId) entry.queuedBy = targetId;
  }
  for (const project of state.projects) {
    if (project.memberIds.includes(sourceId)) project.memberIds = normalizeProjectMemberIds([...project.memberIds.filter((id) => id !== sourceId), targetId]);
  }
  for (const subscription of state.testFlightSubscriptions) {
    if (subscription.requestedBy === sourceId) subscription.requestedBy = targetId;
  }
  for (const watch of state.watches) {
    if (watch.billingOwnerId === sourceId) watch.billingOwnerId = targetId;
    if (watch.billingOwnerTransfer?.userId === sourceId) watch.billingOwnerTransfer.userId = targetId;
    if (watch.billingOwnerTransfer?.requestedBy === sourceId) watch.billingOwnerTransfer.requestedBy = targetId;
  }
  const sourcePrefs = state.userPrefs[sourceId];
  const targetPrefs = state.userPrefs[targetId];
  if (sourcePrefs || targetPrefs) state.userPrefs[targetId] = { ...(sourcePrefs ?? {}), ...(targetPrefs ?? {}) };
  delete state.userPrefs[sourceId];

  const subscriptions = [...(state.pushSubscriptions[targetId] ?? []), ...(state.pushSubscriptions[sourceId] ?? [])];
  if (subscriptions.length > 0) {
    state.pushSubscriptions[targetId] = subscriptions.filter(
      (subscription, index, all) => all.findIndex((candidate) => candidate.endpoint === subscription.endpoint) === index,
    );
  }
  delete state.pushSubscriptions[sourceId];

  recordAudit(actor, 'user.update', targetId, `merged account ${sourceId}`);
  return true;
}

export function updateAllowedUserRoles(username: string, roleIds: string[], actor: string): AllowedUser | undefined {
  const existing = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  if (!existing) return undefined;
  const sanitized = sanitizeRoleIds(roleIds);
  const previousRoleIds = [...existing.roleIds];
  const detail = roleAssignmentDiff(previousRoleIds, sanitized);
  existing.roleIds = sanitized;
  persistNow();
  recordAudit(actor, 'user.update', existing.username, detail, [{ field: 'roleIds', before: previousRoleIds.join(', '), after: sanitized.join(', ') }]);
  return existing;
}

export interface CreateRoleInput {
  name: string;
  color: string;
  permissions: string;
}

export function createRole(input: CreateRoleInput, actor: string): Role {
  const now = Date.now();
  const position = Math.max(0, ...state.roles.map((r) => r.position)) + 1;
  const role: Role = {
    id: randomUUID(),
    name: input.name,
    color: input.color,
    permissions: serializeBits(parseBits(input.permissions)),
    position,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };
  state.roles.push(role);
  persistNow();
  recordAudit(actor, 'role.add', role.id, role.name);
  return role;
}

export interface UpdateRoleInput {
  name?: string;
  color?: string;
  permissions?: string;
}

export function updateRole(id: string, patch: UpdateRoleInput, actor: string): { ok: boolean; role?: Role; error?: string } {
  const role = state.roles.find((r) => r.id === id);
  if (!role) return { ok: false, error: 'role not found' };
  const before = { name: role.name, color: role.color, permissions: role.permissions };
  if (patch.permissions !== undefined) {
    const newBits = parseBits(patch.permissions);
    if (wouldOrphanManageUsersViaRole(id, newBits)) {
      return { ok: false, error: 'this would leave nobody able to manage users - grant it to someone else first' };
    }
    role.permissions = serializeBits(newBits);
  }
  if (patch.name !== undefined && !role.isDefault) role.name = patch.name;
  if (patch.color !== undefined) role.color = patch.color;
  role.updatedAt = Date.now();
  persistNow();
  recordAudit(actor, 'role.update', role.id, role.name, Object.keys(before).flatMap((field) => {
    const key = field as keyof typeof before;
    return before[key] === role[key] ? [] : [{ field, before: before[key], after: role[key] }];
  }));
  return { ok: true, role };
}

export function deleteRole(id: string, actor: string): { ok: boolean; error?: string } {
  const role = state.roles.find((r) => r.id === id);
  if (!role) return { ok: false, error: 'role not found' };
  if (role.isDefault) return { ok: false, error: "the @everyone role can't be deleted" };
  if (wouldOrphanManageUsersViaRole(id, null)) {
    return { ok: false, error: 'this would leave nobody able to manage users - grant it to someone else first' };
  }
  state.roles = state.roles.filter((r) => r.id !== id);
  for (const u of state.allowedUsers) u.roleIds = u.roleIds.filter((rid) => rid !== id);
  persistNow();
  recordAudit(actor, 'role.remove', id, role.name);
  return { ok: true };
}

export function reorderRoles(orderedIds: string[], actor: string): boolean {
  const nonDefaultIds = orderedIds.filter((id) => id !== DEFAULT_ROLE_ID);
  const nonDefaultRoles = state.roles.filter((r) => !r.isDefault);
  if (nonDefaultIds.length !== nonDefaultRoles.length || !nonDefaultRoles.every((r) => nonDefaultIds.includes(r.id))) return false;
  nonDefaultIds.forEach((id, idx) => {
    const role = state.roles.find((r) => r.id === id);
    if (role) role.position = idx + 1;
  });
  persistNow();
  recordAudit(actor, 'role.update', 'reorder', 'positions changed');
  return true;
}

export function removeAllowedUser(username: string, actor: string): boolean {
  const lower = username.toLowerCase();
  const user = state.allowedUsers.find((u) => u.username === lower);
  if (!user) return false;
  const changed = user.roleIds.length > 0 || (user.priority ?? 0) !== 0 || (user.discordPerkRoleIds?.length ?? 0) > 0;
  user.roleIds = [];
  user.discordPerkRoleIds = [];
  user.priority = 0;
  if (changed) {
    persistNow();
    recordAudit(actor, 'user.remove', lower, 'role assignments cleared');
  }
  return changed;
}

export function deleteUserPersonalData(username: string): boolean {
  const lower = username.toLowerCase();
  const existed = state.allowedUsers.some((user) => user.username === lower);
  if (!existed || lower === 'root') return false;
  state.allowedUsers = state.allowedUsers.filter((user) => user.username !== lower);
  revokeUserSessions(lower);
  state.passkeys = state.passkeys.filter((credential) => credential.userId !== lower);
  state.apiKeys = state.apiKeys.filter((key) => key.ownerId !== lower);
  state.jobHistory = state.jobHistory.filter((entry) => entry.queuedBy?.toLowerCase() !== lower);
  for (const project of state.projects) project.memberIds = project.memberIds.filter((memberId) => memberId !== lower);
  state.userPrefs = Object.fromEntries(Object.entries(state.userPrefs).filter(([userId]) => userId !== lower));
  state.pushSubscriptions = Object.fromEntries(Object.entries(state.pushSubscriptions).filter(([userId]) => userId !== lower));
  state.notifications = state.notifications.filter((notification) => notification.userId.toLowerCase() !== lower);
  state.testFlightSubscriptions = state.testFlightSubscriptions.filter(
    (subscription) => subscription.requestedBy !== lower || subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID,
  );
  for (const keyId of Object.keys(state.apiKeyUsage)) {
    if (!state.apiKeys.some((key) => key.id === keyId)) delete state.apiKeyUsage[keyId];
  }
  for (const keyId of Object.keys(state.apiKeyBundleUsage)) {
    if (!state.apiKeys.some((key) => key.id === keyId)) delete state.apiKeyBundleUsage[keyId];
  }
  for (const keyId of Object.keys(state.apiKeyOutcomeUsage)) {
    if (!state.apiKeys.some((key) => key.id === keyId)) delete state.apiKeyOutcomeUsage[keyId];
  }
  state.auditLog = state.auditLog.map((entry) => ({
    ...entry,
    actor: entry.actor.toLowerCase() === lower ? 'deleted-user' : entry.actor,
    target: entry.target.toLowerCase() === lower ? 'deleted-user' : entry.target,
  }));
  persistNow();
  return true;
}

function redact(k: ApiKeyRecord) {
  return {
    id: k.id,
    name: k.name,
    ownerId: k.ownerId,
    status: k.status,
    createdAt: k.createdAt,
    approvedAt: k.approvedAt,
    lastUsedAt: k.lastUsedAt,
    expiresAt: k.expiresAt,
    hasUnrevealedSecret: !!k.pendingReveal,
    lastUsedIp: k.lastUsedIp,
    allowedBundleIds: k.allowedBundleIds,
    dailyLimit: k.dailyLimit,
    maxConcurrent: k.maxConcurrent,
    allowTestFlight: k.allowTestFlight ?? true,
    priority: k.priority ?? 0,
    previousKeyValidUntil: k.previousHash && k.previousHashExpiresAt && k.previousHashExpiresAt > Date.now() ? k.previousHashExpiresAt : undefined,
  };
}

function expiresAtFromDays(expiresInDays?: number): number | undefined {
  return expiresInDays ? Date.now() + expiresInDays * 86_400_000 : undefined;
}

function sanitizeBundleIds(allowedBundleIds?: string[]): string[] | undefined {
  return allowedBundleIds && allowedBundleIds.length > 0 ? allowedBundleIds : undefined;
}

export function createApiKey(
  name: string,
  ownerId: string,
  expiresInDays?: number,
  allowedBundleIds?: string[],
  dailyLimit?: number,
  allowTestFlight?: boolean,
): { id: string; name: string; key: string; createdAt: number; expiresAt?: number } {
  const key = randomBytes(32).toString('hex');
  const record: ApiKeyRecord = {
    id: randomUUID(),
    name,
    ownerId,
    status: 'approved',
    hash: hashKey(key),
    pendingReveal: key,
    createdAt: Date.now(),
    approvedAt: Date.now(),
    expiresAt: expiresAtFromDays(expiresInDays),
    allowedBundleIds: sanitizeBundleIds(allowedBundleIds),
    dailyLimit,
    allowTestFlight,
  };
  state.apiKeys.push(record);
  persistNow();
  return { id: record.id, name: record.name, key, createdAt: record.createdAt, expiresAt: record.expiresAt };
}

export function requestApiKey(
  name: string,
  ownerId: string,
  expiresInDays?: number,
  allowedBundleIds?: string[],
  dailyLimit?: number,
  allowTestFlight?: boolean,
) {
  const record: ApiKeyRecord = {
    id: randomUUID(),
    name,
    ownerId,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: expiresAtFromDays(expiresInDays),
    allowedBundleIds: sanitizeBundleIds(allowedBundleIds),
    dailyLimit,
    allowTestFlight,
  };
  state.apiKeys.push(record);
  persistNow();
  return redact(record);
}

export function approveApiKey(id: string): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.status !== 'pending') return false;
  const key = randomBytes(32).toString('hex');
  record.status = 'approved';
  record.hash = hashKey(key);
  record.pendingReveal = key;
  record.approvedAt = Date.now();
  persistNow();
  return true;
}

export function bulkApproveApiKeys(ids: string[]): string[] {
  return ids.filter((id) => approveApiKey(id));
}

export function denyApiKey(id: string): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.status !== 'pending') return false;
  record.status = 'denied';
  persistNow();
  return true;
}

export function regenerateApiKey(id: string, requesterId: string, graceMinutes = 0): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.status !== 'approved' || record.ownerId !== requesterId) return false;
  if (record.hash && graceMinutes > 0) {
    record.previousHash = record.hash;
    record.previousHashExpiresAt = Date.now() + graceMinutesToMs(graceMinutes);
  } else {
    record.previousHash = undefined;
    record.previousHashExpiresAt = undefined;
  }
  const key = randomBytes(32).toString('hex');
  record.hash = hashKey(key);
  record.pendingReveal = key;
  persistNow();
  return true;
}

function graceMinutesToMs(graceMinutes: number): number {
  return Math.min(graceMinutes, 24 * 60) * 60_000;
}

export function revealApiKeySecret(id: string, requesterId: string): string | undefined {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.ownerId !== requesterId || !record.pendingReveal) return undefined;
  const secret = record.pendingReveal;
  record.pendingReveal = undefined;
  persistNow();
  return secret;
}

export function getApiKeyById(id: string): ReturnType<typeof redact> | undefined {
  const record = apiKeyRepository.findById(id);
  return record ? redact(record) : undefined;
}

export function listApiKeysForOwner(ownerId: string) {
  return apiKeyRepository.listByOwner(ownerId).map(redact);
}

export function listAllApiKeys() {
  return apiKeyRepository.listAll().map(redact);
}

export function listAllApiKeysPage(offset: number, limit: number, search?: string): { keys: ReturnType<typeof redact>[]; total: number } {
  const page = apiKeyRepository.listPage(offset, limit, search);
  return { keys: page.records.map(redact), total: page.total };
}

export function listPendingApiKeys() {
  return apiKeyRepository.listPending().map(redact);
}

export function revokeApiKey(id: string, requesterId: string, requesterIsAdmin: boolean): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record) return false;
  if (!requesterIsAdmin && record.ownerId !== requesterId) return false;

  state.apiKeys = state.apiKeys.filter((k) => k.id !== id);
  delete state.apiKeyUsage[id];
  delete state.apiKeyBundleUsage[id];
  delete state.apiKeyOutcomeUsage[id];
  persistNow();
  return true;
}

export function bulkExtendApiKeyExpiry(ids: string[], days: number): string[] {
  const extended: string[] = [];
  const newExpiresAt = Date.now() + days * 86_400_000;
  for (const id of ids) {
    const record = state.apiKeys.find((k) => k.id === id);
    if (!record) continue;
    record.expiresAt = newExpiresAt;
    record.expiryNotifiedAt = undefined;
    extended.push(id);
  }
  if (extended.length > 0) persistNow();
  return extended;
}

export function bulkSetApiKeyDailyLimit(ids: string[], dailyLimit: number | undefined): string[] {
  const updated: string[] = [];
  for (const id of ids) {
    const record = state.apiKeys.find((k) => k.id === id);
    if (!record) continue;
    record.dailyLimit = dailyLimit;
    updated.push(id);
  }
  if (updated.length > 0) persistNow();
  return updated;
}

export function bulkSetApiKeyAllowedBundleIds(ids: string[], allowedBundleIds: string[] | undefined): string[] {
  const updated: string[] = [];
  for (const id of ids) {
    const record = state.apiKeys.find((k) => k.id === id);
    if (!record) continue;
    record.allowedBundleIds = allowedBundleIds;
    updated.push(id);
  }
  if (updated.length > 0) persistNow();
  return updated;
}

function todayUsageCount(id: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const buckets = state.apiKeyUsage[id] ?? [];
  return buckets[buckets.length - 1]?.date === today ? buckets[buckets.length - 1].count : 0;
}

function recordApiKeyUsage(id: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const buckets = state.apiKeyUsage[id] ?? [];
  const last = buckets[buckets.length - 1];
  if (last && last.date === today) {
    last.count += 1;
  } else {
    buckets.push({ date: today, count: 1 });
    if (buckets.length > MAX_USAGE_DAYS) buckets.shift();
  }
  state.apiKeyUsage[id] = buckets;
  dirty = true;
}

export function getApiKeyUsage(id: string, days: number): ApiKeyUsageBucket[] {
  const buckets = new Map((state.apiKeyUsage[id] ?? []).map((b) => [b.date, b.count]));
  const now = new Date();
  const out: ApiKeyUsageBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    out.push({ date, count: buckets.get(date) ?? 0 });
  }
  return out;
}

export function verifyApiKey(candidate: string, ip?: string): ApiKeyAuthResult | undefined | 'rate-limited' {
  if (safeEqualStr(candidate, config.apiKey)) return {};

  const record = findGeneratedApiKeyRecord(candidate);
  if (!record) return undefined;
  if (record.ownerId !== 'root') {
    const permissions = getUserEffectivePermissions(record.ownerId);
    if (!hasPermission(permissions, PermissionFlag.createApiKeys)) return undefined;
  }
  if (record.dailyLimit && todayUsageCount(record.id) >= record.dailyLimit) return 'rate-limited';

  const lastUsedAt = Date.now();
  record.lastUsedAt = lastUsedAt;
  if (ip) record.lastUsedIp = ip;
  apiKeyRepository.touchLastUsed(record.id, lastUsedAt, ip);
  recordApiKeyUsage(record.id);
  dirty = true;
  const billingPriority = record.ownerId === 'root' ? 0 : getBillingEntitlements(record.ownerId).priority;
  return {
    allowedBundleIds: record.allowedBundleIds,
    ownerId: record.ownerId,
    priority: billingPriority > 0 ? Math.max(record.priority ?? 0, billingPriority) : (record.priority ?? 0),
    keyId: record.id,
    allowTestFlight: record.allowTestFlight ?? true,
  };
}

const MAX_TRACKED_BUNDLES_PER_KEY = 100;

export function recordApiKeyBundleUsage(id: string, bundleId: string): void {
  const perKey = state.apiKeyBundleUsage[id] ?? {};
  perKey[bundleId] = (perKey[bundleId] ?? 0) + 1;
  if (Object.keys(perKey).length > MAX_TRACKED_BUNDLES_PER_KEY) {
    const leastUsed = Object.entries(perKey).sort((a, b) => a[1] - b[1])[0]?.[0];
    if (leastUsed) delete perKey[leastUsed];
  }
  state.apiKeyBundleUsage[id] = perKey;
  dirty = true;
}

export function getApiKeyBundleUsage(id: string, limit = 10): { bundleId: string; count: number }[] {
  const perKey = state.apiKeyBundleUsage[id] ?? {};
  return Object.entries(perKey)
    .map(([bundleId, count]) => ({ bundleId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

const MAX_TRACKED_OUTCOMES_PER_KEY = 30;

export function recordApiKeyOutcome(id: string, method: string, path: string, status: number): void {
  const route = `${method} ${path}`;
  const perKey = state.apiKeyOutcomeUsage[id] ?? {};
  const outcome = perKey[route] ?? { route, success: 0, clientError: 0, serverError: 0, lastAt: Date.now() };
  if (status < 400) outcome.success += 1;
  else if (status < 500) outcome.clientError += 1;
  else outcome.serverError += 1;
  outcome.lastAt = Date.now();
  perKey[route] = outcome;
  if (Object.keys(perKey).length > MAX_TRACKED_OUTCOMES_PER_KEY) {
    const oldest = Object.values(perKey).sort((a, b) => a.lastAt - b.lastAt)[0]?.route;
    if (oldest) delete perKey[oldest];
  }
  state.apiKeyOutcomeUsage[id] = perKey;
  dirty = true;
}

export function getApiKeyOutcomeUsage(id: string, limit = 10): ApiKeyOutcomeUsage[] {
  return Object.values(state.apiKeyOutcomeUsage[id] ?? {})
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit);
}

export function getUserPriority(username: string): number {
  if (username === 'root') return 0;
  const manualPriority = state.allowedUsers.find((u) => u.username === username.toLowerCase())?.priority ?? 0;
  const billingPriority = getBillingEntitlements(username.toLowerCase()).priority;
  return billingPriority > 0 ? Math.max(manualPriority, billingPriority) : manualPriority;
}

const MIN_PRIORITY = -5;
const MAX_PRIORITY = 5;

export function clampPriority(value: number): number {
  return Math.min(Math.max(Math.round(value), MIN_PRIORITY), MAX_PRIORITY);
}

export function setUserPriority(username: string, priority: number, actor: string): AllowedUser | undefined {
  const user = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  if (!user) return undefined;
  const clamped = clampPriority(priority);
  if (user.priority === clamped) return user;
  const before = user.priority ?? 0;
  user.priority = clamped;
  persistNow();
  recordAudit(actor, 'user.update', user.username, `priority: ${before} -> ${clamped}`);
  return user;
}

export function setApiKeyPriority(id: string, priority: number): ApiKeyRecord | undefined {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record) return undefined;
  record.priority = clampPriority(priority);
  persistNow();
  return record;
}

export function setApiKeyMaxConcurrent(id: string, maxConcurrent: number | undefined): ApiKeyRecord | undefined {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record) return undefined;
  record.maxConcurrent = maxConcurrent && maxConcurrent > 0 ? Math.floor(maxConcurrent) : undefined;
  persistNow();
  return record;
}

export function setApiKeyAllowTestFlight(id: string, allowTestFlight: boolean): ApiKeyRecord | undefined {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record) return undefined;
  record.allowTestFlight = allowTestFlight;
  persistNow();
  return record;
}

const KEY_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

export function claimExpiringApiKeysToNotify(): { id: string; name: string; ownerId: string; expiresAt: number }[] {
  const now = Date.now();
  const due = state.apiKeys.filter(
    (k) => k.status === 'approved' && k.expiresAt && k.expiresAt - now <= KEY_EXPIRY_WARNING_MS && k.expiresAt > now && !k.expiryNotifiedAt,
  );
  for (const k of due) k.expiryNotifiedAt = now;
  if (due.length > 0) persistNow();
  return due.map((k) => ({ id: k.id, name: k.name, ownerId: k.ownerId, expiresAt: k.expiresAt as number }));
}

export function startApiKeySweeper(): void {
  apiKeySweepTimer ??= setInterval(() => {
    const now = Date.now();
    const before = state.apiKeys.length;
    state.apiKeys = state.apiKeys.filter((k) => !(k.expiresAt && now > k.expiresAt));
    if (state.apiKeys.length !== before) persistNow();
  }, 60_000).unref();
}

export function getEffectiveSettings(): DashboardSettings {
  const legacySettings = state.settings as Record<string, unknown>;
  const legacyAutomationSuccess = [legacySettings.notifyOnAppStoreAutomationSuccess, legacySettings.notifyOnTestFlightAutomationSuccess]
    .filter((value): value is boolean => typeof value === 'boolean')
    .some(Boolean);
  const legacyAutomationFailure = [legacySettings.notifyOnAppStoreAutomationFailure, legacySettings.notifyOnTestFlightAutomationFailure]
    .filter((value): value is boolean => typeof value === 'boolean')
    .some(Boolean);
  return {
    notifyWebhookUrl: state.settings.notifyWebhookUrl ?? config.notifyWebhookUrl,
    notifyFormat: state.settings.notifyFormat ?? 'embed',
    notifySuccessMode:
      state.settings.notifySuccessMode === 'daily' || state.settings.notifySuccessMode === 'weekly'
        ? state.settings.notifySuccessMode
        : 'instant',
    notifyQuietHoursStart:
      typeof state.settings.notifyQuietHoursStart === 'string' && /^\d{2}:\d{2}$/.test(state.settings.notifyQuietHoursStart)
        ? state.settings.notifyQuietHoursStart
        : '',
    notifyQuietHoursEnd:
      typeof state.settings.notifyQuietHoursEnd === 'string' && /^\d{2}:\d{2}$/.test(state.settings.notifyQuietHoursEnd)
        ? state.settings.notifyQuietHoursEnd
        : '',
    notifyOnKeyRequest: state.settings.notifyOnKeyRequest ?? true,
    notifyOnAutomationSuccess: state.settings.notifyOnAutomationSuccess ?? legacyAutomationSuccess ?? true,
    notifyOnAutomationFailure: state.settings.notifyOnAutomationFailure ?? legacyAutomationFailure ?? true,
    notifyOnKeyExpiringSoon: state.settings.notifyOnKeyExpiringSoon ?? true,
    notifyOnDeviceOffline: state.settings.notifyOnDeviceOffline ?? true,
    notifyOnDeviceBatteryHot: state.settings.notifyOnDeviceBatteryHot ?? true,
    notifyOnDeviceBatteryLow: state.settings.notifyOnDeviceBatteryLow ?? true,
    notifyOnDiskFull: state.settings.notifyOnDiskFull ?? true,
    notifyOnDeviceStorageLow: state.settings.notifyOnDeviceStorageLow ?? true,
    notifyOnTestFlightBridgeDown: state.settings.notifyOnTestFlightBridgeDown ?? true,
    notifyOnJobCompleted: state.settings.notifyOnJobCompleted ?? false,
    notifyOnQueueSloBreach: state.settings.notifyOnQueueSloBreach ?? true,
    deviceOfflineAlertMinutes: state.settings.deviceOfflineAlertMinutes ?? 15,
    batteryHotAlertC: state.settings.batteryHotAlertC ?? 45,
    batteryLowAlertPercent: state.settings.batteryLowAlertPercent ?? 10,
    diskFullAlertPercent: state.settings.diskFullAlertPercent ?? 90,
    deviceStorageAlertPercent: state.settings.deviceStorageAlertPercent ?? 90,
    testFlightBridgeAlertMinutes: state.settings.testFlightBridgeAlertMinutes ?? 15,
    jobHistoryRetentionDays: state.settings.jobHistoryRetentionDays ?? 0,
    maintenanceMode: state.settings.maintenanceMode ?? false,
  };
}

function diffSettings(before: DashboardSettings, after: DashboardSettings): string {
  const changed = (Object.keys(after) as (keyof DashboardSettings)[]).filter((k) => before[k] !== after[k]);
  return changed.map((k) => `${k}: ${String(before[k])} -> ${String(after[k])}`).join(', ');
}

export function updateSettings(patch: Partial<DashboardSettings>, actor?: string): DashboardSettings {
  const before = getEffectiveSettings();
  state.settings = { ...state.settings, ...patch };
  persistNow();
  const after = getEffectiveSettings();
  if (actor) {
    const detail = diffSettings(before, after);
    if (detail) recordAudit(actor, 'settings.update', 'settings', detail);
  }
  return after;
}

export function disableLegacyAppWatches(): number {
  const enabled = state.watches.filter((watch) => watch.enabled);
  if (enabled.length === 0) return 0;
  const timestamp = Date.now();
  for (const watch of enabled) {
    watch.enabled = false;
    watch.updatedAt = Math.max(timestamp, watch.updatedAt + 1);
  }
  persistNow();
  return enabled.length;
}

export function getEffectiveDevices(): DeviceRecord[] {
  return deviceRepository.listAll();
}

export function listDevices(): DeviceRecord[] {
  return getEffectiveDevices();
}

export function getDevice(id: string): DeviceRecord | undefined {
  return deviceRepository.findById(id);
}

export function getPrimaryDevice(): DeviceRecord | undefined {
  const devices = getEffectiveDevices().filter((d) => d.enabled && !d.draining);
  return devices.find((d) => d.isPrimary) ?? devices[0];
}

export interface CreateTestFlightSubscriptionInput {
  url: string;
  inviteCode: string;
  requestedBy: string;
  status: TestFlightSubscriptionStatus;
  appId?: number;
  bundleId?: string;
  displayName?: string;
  iconUrl?: string;
  sellerName?: string;
  category?: string;
}

function cloneTestFlightSubscription(subscription: TestFlightSubscription): TestFlightSubscription {
  return { ...subscription, devices: subscription.devices.map((device) => ({ ...device })) };
}

function notificationForSubscription(userId: string, title: string, message: string, severity: NotificationSeverity, subscriptionId: string): void {
  recordNotification({ userId, title, message, severity, groupKey: `testflight-subscription:${subscriptionId}:${title}`, href: '/?tab=settings&stab=testflight' });
}

export function getTestFlightSubscriptions(): TestFlightSubscription[] {
  return testFlightSubscriptionRepository.listAll().map(cloneTestFlightSubscription);
}

export function getTestFlightSubscription(id: string): TestFlightSubscription | undefined {
  const subscription = testFlightSubscriptionRepository.findById(id);
  return subscription ? cloneTestFlightSubscription(subscription) : undefined;
}

export function listTestFlightSubscriptionsForUser(userId: string): TestFlightSubscription[] {
  return testFlightSubscriptionRepository.listByUser(userId).map(cloneTestFlightSubscription);
}

export function findTestFlightSubscriptionByInviteCode(inviteCode: string): TestFlightSubscription | undefined {
  const subscription = testFlightSubscriptionRepository.findByInviteCode(inviteCode);
  return subscription ? cloneTestFlightSubscription(subscription) : undefined;
}

export function ensureTestFlightSubscriptionDevices(id: string): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription) return undefined;
  if (subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return cloneTestFlightSubscription(subscription);
  const known = new Set(subscription.devices.map((device) => device.deviceId));
  const now = Date.now();
  for (const device of getEffectiveDevices().filter((entry) => entry.enabled)) {
    if (known.has(device.id)) continue;
    subscription.devices.push({ deviceId: device.id, status: 'pending' });
  }
  subscription.updatedAt = now;
  persistNow();
  return cloneTestFlightSubscription(subscription);
}

export function createTestFlightSubscription(input: CreateTestFlightSubscriptionInput, actor: string): TestFlightSubscription {
  if (input.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) throw new Error('Discord TestFlight access is protected and cannot be changed');
  const existing = findTestFlightSubscriptionByInviteCode(input.inviteCode);
  if (existing) return existing;
  const now = Date.now();
  const subscription: TestFlightSubscription = {
    id: randomUUID(),
    url: input.url,
    inviteCode: input.inviteCode,
    requestedBy: input.requestedBy.toLowerCase(),
    status: input.status,
    appId: input.appId,
    bundleId: input.bundleId,
    displayName: input.displayName,
    iconUrl: input.iconUrl,
    sellerName: input.sellerName,
    category: input.category,
    createdAt: now,
    updatedAt: now,
    devices: getEffectiveDevices().filter((device) => device.enabled).map((device) => ({ deviceId: device.id, status: 'pending' })),
    devicePolicy: 'all-enabled',
  };
  state.testFlightSubscriptions.unshift(subscription);
  persistNow();
  recordAudit(actor, 'testflight-subscription.add', subscription.id, `${subscription.url} (${subscription.status})`);
  notificationForSubscription(
    subscription.requestedBy,
    'TestFlight subscription submitted',
    subscription.status === 'approved' ? `${subscription.displayName ?? subscription.url} is being synchronized.` : `${subscription.displayName ?? subscription.url} is awaiting approval.`,
    subscription.status === 'approved' ? 'info' : 'success',
    subscription.id,
  );
  return cloneTestFlightSubscription(subscription);
}

export function approveTestFlightSubscription(id: string, actor: string): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription || subscription.status !== 'pending' || subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return undefined;
  const now = Date.now();
  subscription.status = 'approved';
  subscription.approvedAt = now;
  subscription.approvedBy = actor;
  subscription.deniedAt = undefined;
  subscription.deniedBy = undefined;
  subscription.updatedAt = now;
  ensureTestFlightSubscriptionDevices(id);
  persistNow();
  recordAudit(actor, 'testflight-subscription.approve', id, subscription.url);
  notificationForSubscription(subscription.requestedBy, 'TestFlight subscription approved', `${subscription.displayName ?? subscription.url} is being synchronized to enabled devices.`, 'success', subscription.id);
  return cloneTestFlightSubscription(subscription);
}

export function denyTestFlightSubscription(id: string, actor: string): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription || subscription.status !== 'pending' || subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return undefined;
  const now = Date.now();
  subscription.status = 'denied';
  subscription.deniedAt = now;
  subscription.deniedBy = actor;
  subscription.updatedAt = now;
  persistNow();
  recordAudit(actor, 'testflight-subscription.deny', id, subscription.url);
  notificationForSubscription(subscription.requestedBy, 'TestFlight subscription denied', subscription.displayName ?? subscription.url, 'warning', subscription.id);
  return cloneTestFlightSubscription(subscription);
}

export function withdrawTestFlightSubscription(id: string, actor: string, detail?: string): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription) return undefined;
  if (subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return cloneTestFlightSubscription(subscription);
  if (subscription.status === 'withdrawn') return cloneTestFlightSubscription(subscription);
  const now = Date.now();
  subscription.status = 'withdrawn';
  subscription.withdrawnAt = now;
  subscription.withdrawnBy = actor;
  subscription.updatedAt = now;
  persistNow();
  recordAudit(actor, 'testflight-subscription.remove', id, detail ?? subscription.url);
  return cloneTestFlightSubscription(subscription);
}

export function updateTestFlightSubscriptionDevice(
  id: string,
  deviceId: string,
  patch: Partial<TestFlightSubscriptionDevice>,
): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription) return undefined;
  if (subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return cloneTestFlightSubscription(subscription);
  let device = subscription.devices.find((entry) => entry.deviceId === deviceId);
  if (!device) {
    device = { deviceId, status: 'pending' };
    subscription.devices.push(device);
  }
  Object.assign(device, patch);
  subscription.updatedAt = Date.now();
  persistNow();
  return cloneTestFlightSubscription(subscription);
}

export function updateTestFlightSubscriptionMetadata(
  id: string,
  patch: Pick<TestFlightSubscription, 'appId' | 'bundleId' | 'displayName' | 'iconUrl' | 'sellerName' | 'category'>,
): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription) return undefined;
  if (subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return cloneTestFlightSubscription(subscription);
  Object.assign(subscription, patch, { updatedAt: Date.now() });
  persistNow();
  return cloneTestFlightSubscription(subscription);
}

export function recordTestFlightSubscriptionSync(id: string, actor: string, detail: string): void {
  recordAudit(actor, 'testflight-subscription.sync', id, detail);
}

export interface CreateDeviceInput {
  name: string;
  transport?: DeviceTransport;
  host?: string;
  port?: number;
  user?: string;
  udid?: string;
  usbmuxNetwork?: boolean;
  productType?: string;
  iosVersion?: string;
  toolchain?: string;
  notes?: string;
  enabled?: boolean;
  draining?: boolean;
  isPrimary?: boolean;
}

export function createDevice(input: CreateDeviceInput, actor: string): DeviceRecord {
  const now = Date.now();
  const transport = input.transport ?? (input.udid ? input.usbmuxNetwork ? 'wifi' : 'usb' : 'wifi');
  const device: DeviceRecord = {
    id: randomUUID(),
    name: input.name,
    transport,
    host: input.host?.trim() || undefined,
    port: input.port,
    user: input.user?.trim() || undefined,
    udid: input.udid?.trim() || undefined,
    usbmuxNetwork: input.usbmuxNetwork,
    productType: input.productType?.trim() || undefined,
    iosVersion: input.iosVersion?.trim() || undefined,
    toolchain: input.toolchain?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    enabled: input.enabled ?? true,
    isPrimary: input.enabled !== false && input.isPrimary === true,
    createdAt: now,
    updatedAt: now,
  };
  state.devices = deviceRepository.create(device);
  const createdDevice = state.devices.find((candidate) => candidate.id === device.id)!;
  persistNow();
  recordAudit(actor, 'device.add', createdDevice.id, createdDevice.name);
  return createdDevice;
}

export function updateDevice(id: string, patch: Partial<CreateDeviceInput>, actor: string): { ok: boolean; device?: DeviceRecord; error?: string } {
  const previousDevice = deviceRepository.findById(id);
  const devices = deviceRepository.update(id, { ...patch, ...(patch.enabled !== undefined ? { draining: false } : {}), updatedAt: Math.max(Date.now(), (previousDevice?.updatedAt ?? 0) + 1) });
  if (!devices) return { ok: false, error: 'device not found' };
  state.devices = devices;
  const device = state.devices.find((candidate) => candidate.id === id)!;
  persistNow();
  const auditFields = ['name', 'transport', 'usbmuxNetwork', 'productType', 'iosVersion', 'toolchain', 'enabled', 'draining', 'isPrimary'] as const;
  const changes = auditFields.flatMap((field) => {
    const before = previousDevice?.[field] ?? null;
    const after = device[field] ?? null;
    return before === after ? [] : [{ field, before, after }];
  });
  recordAudit(actor, 'device.update', device.id, device.name, changes);
  return { ok: true, device };
}

export function deleteDevice(id: string, actor: string): boolean {
  const result = deviceRepository.delete(id);
  if (!result.changed) return false;
  state.devices = result.devices;
  persistNow();
  recordAudit(actor, 'device.remove', id);
  return true;
}

export function recordWebhookDelivery(entry: Omit<WebhookDeliveryEntry, 'id' | 'ts'>): void {
  state.webhookDeliveryLog.unshift({ id: randomUUID(), ts: Date.now(), ...entry });
  if (state.webhookDeliveryLog.length > MAX_WEBHOOK_LOG) state.webhookDeliveryLog.length = MAX_WEBHOOK_LOG;
  persistNow();
}

export function getWebhookDeliveryLog(limit = 100): WebhookDeliveryEntry[] {
  return state.webhookDeliveryLog.slice(0, limit);
}

export function recordJobHistory(entry: JobHistoryEntry): void {
  const scopedEntry = { ...entry, projectId: entry.projectId ?? DEFAULT_PROJECT_ID };
  state.jobHistory = [scopedEntry, ...state.jobHistory.filter((existing) => existing.id !== scopedEntry.id)];
  if (state.jobHistory.length > MAX_HISTORY) state.jobHistory.length = MAX_HISTORY;
  const retentionDays = getEffectiveSettings().jobHistoryRetentionDays;
  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    state.jobHistory = state.jobHistory.filter((e) => e.finishedAt >= cutoff);
  }
  persistNow();
  emitHistoryAdded(scopedEntry);
}

export function getJobHistoryPage(
  offset: number,
  limit: number,
  filters?: {
    bundleIdSearch?: string;
    source?: 'manual' | 'scheduler';
    status?: 'done' | 'failed';
    queuedBy?: string;
    deviceId?: string;
    errorSearch?: string;
    failureCategory?: string;
    fromTs?: number;
    toTs?: number;
    projectId?: string;
  },
  cursor?: string,
): { entries: JobHistoryEntry[]; total: number; nextCursor?: string } {
  const entries = jobHistoryRepository.list({
    bundleIdSearch: filters?.bundleIdSearch,
    source: filters?.source,
    status: filters?.status,
    queuedBy: filters?.queuedBy,
    deviceId: filters?.deviceId,
    errorSearch: filters?.errorSearch,
    fromTs: filters?.fromTs,
    toTs: filters?.toTs,
    projectId: filters?.projectId,
  });
  const filtered = filters?.failureCategory
    ? entries.filter((entry) => entry.status === 'failed' && categorizeFailure(entry.error) === filters.failureCategory)
    : entries;
  const page = paginateCursor(filtered, {
    cursor,
    offset,
    limit,
    keyOf: (entry) => [entry.finishedAt, entry.id],
    order: 'desc',
  });
  return { entries: page.items, total: filtered.length, nextCursor: page.nextCursor };
}

export function getAllJobHistory(): JobHistoryEntry[] {
  return jobHistoryRepository.list();
}

export function getUserJobHistory(username: string): JobHistoryEntry[] {
  return jobHistoryRepository.listForUser(username);
}

export function simulateJobHistoryRetention(
  entries: readonly JobHistoryEntry[],
  retentionDays: number,
  now = Date.now(),
): {
  retentionDays: number;
  cutoff?: number;
  currentEntries: number;
  retained: number;
  removed: number;
  agePruned: number;
  capacityPruned: number;
  afterNextWrite: number;
  maxEntries: number;
} {
  const normalizedDays = Math.max(0, Math.round(retentionDays));
  const capacityCandidates = entries.slice(0, MAX_HISTORY - 1);
  const capacityPruned = entries.length - capacityCandidates.length;
  const cutoff = normalizedDays > 0 ? now - normalizedDays * 86_400_000 : undefined;
  const retainedEntries = cutoff === undefined
    ? capacityCandidates
    : capacityCandidates.filter((entry) => entry.finishedAt >= cutoff);
  const agePruned = capacityCandidates.length - retainedEntries.length;
  const removed = capacityPruned + agePruned;
  return {
    retentionDays: normalizedDays,
    cutoff,
    currentEntries: entries.length,
    retained: retainedEntries.length,
    removed,
    agePruned,
    capacityPruned,
    afterNextWrite: retainedEntries.length + 1,
    maxEntries: MAX_HISTORY,
  };
}

export function previewJobHistoryRetention(retentionDays: number, now = Date.now()): ReturnType<typeof simulateJobHistoryRetention> {
  return simulateJobHistoryRetention(jobHistoryRepository.list(), retentionDays, now);
}

export interface UserActivityStats {
  manualJobs: number;
  completedJobs: number;
  failedJobs: number;
  lastJobAt?: number;
  apiKeys: number;
  apiRequests30d: number;
}

export function getUserActivityStats(): Map<string, UserActivityStats> {
  const stats = new Map<string, UserActivityStats>();
  const ensure = (username: string): UserActivityStats => {
    const key = username.toLowerCase();
    const current = stats.get(key);
    if (current) return current;
    const next = { manualJobs: 0, completedJobs: 0, failedJobs: 0, apiKeys: 0, apiRequests30d: 0 };
    stats.set(key, next);
    return next;
  };
  for (const job of state.jobHistory) {
    if (!job.queuedBy || job.source !== 'manual') continue;
    const activity = ensure(job.queuedBy);
    activity.manualJobs += 1;
    if (job.status === 'done') activity.completedJobs += 1;
    else activity.failedJobs += 1;
    activity.lastJobAt = Math.max(activity.lastJobAt ?? 0, job.finishedAt) || undefined;
  }
  for (const key of state.apiKeys) {
    const activity = ensure(key.ownerId);
    activity.apiKeys += 1;
    activity.apiRequests30d += getApiKeyUsage(key.id, 30).reduce((total, bucket) => total + bucket.count, 0);
  }
  return stats;
}

export function getJobHistoryEntryById(id: string): JobHistoryEntry | undefined {
  return state.jobHistory.find((e) => e.id === id);
}

export function jobResolutionMessage(entry: JobHistoryEntry): string {
  return `The issue affecting ${entry.bundleId} has been resolved. You can try the job again.`;
}

export function recordJobResolutionNotice(id: string, actor: string, recipientId: string, emailAvailable: boolean): JobHistoryEntry['resolutionNotice'] | undefined {
  const entry = getJobHistoryEntryById(id);
  if (!entry || entry.status !== 'failed' || entry.source !== 'manual' || !entry.queuedBy || entry.resolutionNotice) return undefined;
  const sentAt = Date.now();
  const notice = { sentAt, sentBy: actor, emailStatus: emailAvailable ? 'pending' as const : 'unavailable' as const };
  entry.resolutionNotice = notice;
  state.notifications.unshift({
    id: randomUUID(),
    userId: recipientId.toLowerCase(),
    title: 'Your failed job can be retried',
    message: jobResolutionMessage(entry),
    severity: 'info',
    createdAt: sentAt,
    jobId: id,
    href: `/?tab=home&job=${encodeURIComponent(id)}`,
  });
  if (state.notifications.length > MAX_NOTIFICATIONS) state.notifications.length = MAX_NOTIFICATIONS;
  persistNow();
  recordAudit(actor, 'job.resolution-notice', id, `notified requester of ${entry.bundleId}`);
  return notice;
}

export function setJobResolutionEmailStatus(id: string, status: 'sent' | 'failed'): void {
  const notice = getJobHistoryEntryById(id)?.resolutionNotice;
  if (!notice || notice.emailStatus !== 'pending') return;
  notice.emailStatus = status;
  persistNow();
}

export function getAverageJobDurationMs(bundleId: string, _projectId?: string): number | undefined {
  const durations = state.jobHistory
    .filter((j) => j.bundleId === bundleId && j.status === 'done' && j.startedAt)
    .map((j) => j.finishedAt - (j.startedAt as number));
  if (durations.length === 0) return undefined;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

export interface BundleStats {
  bundleId: string;
  totalRuns: number;
  doneCount: number;
  failedCount: number;
  successRate: number;
  avgDurationMs?: number;
  lastRunAt?: number;
  failureBreakdown: { category: string; count: number }[];
}

export function getBundleStats(bundleId: string, _projectId?: string): BundleStats {
  const runs = state.jobHistory.filter((j) => j.bundleId === bundleId);
  const doneCount = runs.filter((j) => j.status === 'done').length;
  const failedCount = runs.filter((j) => j.status === 'failed').length;
  return {
    bundleId,
    totalRuns: runs.length,
    doneCount,
    failedCount,
    successRate: runs.length > 0 ? doneCount / runs.length : 0,
    avgDurationMs: getAverageJobDurationMs(bundleId),
    lastRunAt: runs.length > 0 ? Math.max(...runs.map((j) => j.finishedAt)) : undefined,
    failureBreakdown: getFailureBreakdown(runs),
  };
}

export function getDailyVolume(days: number, _projectId?: string): { date: string; count: number }[] {
  const buckets = new Map<string, number>();
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const j of state.jobHistory) {
    if (j.status !== 'done') continue;
    const key = new Date(j.finishedAt).toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
}

export interface InsightsAppStats {
  bundleId: string;
  totalRuns: number;
  doneCount: number;
  failedCount: number;
  successRate: number;
  totalSizeBytes: number;
  avgDurationMs?: number;
}

export interface InsightsSummary {
  totalRuns: number;
  doneCount: number;
  failedCount: number;
  successRate: number;
  totalSizeBytes: number;
  manualCount: number;
  systemCount: number;
  topApps: InsightsAppStats[];
  trend: { date: string; count: number }[];
  failureBreakdown: { category: string; count: number }[];
  byDevice: DeviceThroughputStats[];
  anomalies: PerformanceAnomaly[];
}

export interface PerformanceAnomaly {
  jobId: string;
  bundleId: string;
  versionLabel?: string;
  finishedAt: number;
  kind: 'duration' | 'size' | 'duration-and-size';
  durationMs?: number;
  baselineDurationMs?: number;
  durationRatio?: number;
  sizeBytes?: number;
  baselineSizeBytes?: number;
  sizeRatio?: number;
}

function getFailureBreakdown(runs: JobHistoryEntry[]): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const j of runs) {
    if (j.status !== 'failed') continue;
    const category = categorizeFailure(j.error);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function getPerformanceAnomalies(runs: JobHistoryEntry[]): PerformanceAnomaly[] {
  const byBundle = new Map<string, JobHistoryEntry[]>();
  for (const run of runs.filter((entry) => entry.status === 'done')) {
    const bundleRuns = byBundle.get(run.bundleId) ?? [];
    bundleRuns.push(run);
    byBundle.set(run.bundleId, bundleRuns);
  }

  const anomalies: PerformanceAnomaly[] = [];
  for (const bundleRuns of byBundle.values()) {
    const ordered = [...bundleRuns].sort((a, b) => a.finishedAt - b.finishedAt);
    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index];
      const allPrevious = ordered.slice(0, index);
      const sameDevicePrevious = current.deviceId ? allPrevious.filter((entry) => entry.deviceId === current.deviceId) : [];
      const previous = sameDevicePrevious.length >= 3 ? sameDevicePrevious : allPrevious;
      if (previous.length < 3) continue;
      const durationMs = current.startedAt ? current.finishedAt - current.startedAt : undefined;
      const baselineDurationMs = median(previous.filter((entry) => entry.startedAt).map((entry) => entry.finishedAt - (entry.startedAt as number)));
      const baselineSizeBytes = median(previous.map((entry) => entry.sizeBytes).filter((size): size is number => typeof size === 'number' && size > 0));
      const durationRatio = durationMs && baselineDurationMs ? durationMs / baselineDurationMs : undefined;
      const sizeRatio = current.sizeBytes && baselineSizeBytes ? current.sizeBytes / baselineSizeBytes : undefined;
      const durationAnomaly = durationMs !== undefined && baselineDurationMs !== undefined && durationRatio !== undefined && durationRatio >= 1.75 && durationMs - baselineDurationMs >= 60_000;
      const sizeAnomaly = current.sizeBytes !== undefined && baselineSizeBytes !== undefined && sizeRatio !== undefined && sizeRatio >= 1.5 && current.sizeBytes - baselineSizeBytes >= 5 * 1024 * 1024;
      if (!durationAnomaly && !sizeAnomaly) continue;
      anomalies.push({
        jobId: current.id,
        bundleId: current.bundleId,
        versionLabel: current.versionLabel,
        finishedAt: current.finishedAt,
        kind: durationAnomaly && sizeAnomaly ? 'duration-and-size' : durationAnomaly ? 'duration' : 'size',
        durationMs,
        baselineDurationMs,
        durationRatio,
        sizeBytes: current.sizeBytes,
        baselineSizeBytes,
        sizeRatio,
      });
    }
  }
  return anomalies.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 20);
}

export function getInsightsSummary(topAppsLimit = 5, trendDays = 14, projectId?: string): InsightsSummary {
  const runs = state.jobHistory;
  const doneCount = runs.filter((j) => j.status === 'done').length;
  const failedCount = runs.filter((j) => j.status === 'failed').length;
  const totalSizeBytes = runs.reduce((sum, j) => sum + (j.sizeBytes ?? 0), 0);

  const byBundle = new Map<string, InsightsAppStats>();
  const durationsByBundle = new Map<string, number[]>();
  for (const j of runs) {
    const entry = byBundle.get(j.bundleId) ?? {
      bundleId: j.bundleId,
      totalRuns: 0,
      doneCount: 0,
      failedCount: 0,
      successRate: 0,
      totalSizeBytes: 0,
    };
    entry.totalRuns += 1;
    if (j.status === 'done') entry.doneCount += 1;
    else entry.failedCount += 1;
    entry.totalSizeBytes += j.sizeBytes ?? 0;
    byBundle.set(j.bundleId, entry);

    if (j.status === 'done' && j.startedAt) {
      const durations = durationsByBundle.get(j.bundleId) ?? [];
      durations.push(j.finishedAt - j.startedAt);
      durationsByBundle.set(j.bundleId, durations);
    }
  }
  const topApps = [...byBundle.values()]
    .map((a) => {
      const durations = durationsByBundle.get(a.bundleId);
      const avgDurationMs = durations && durations.length > 0 ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length) : undefined;
      return { ...a, successRate: a.totalRuns > 0 ? a.doneCount / a.totalRuns : 0, avgDurationMs };
    })
    .sort((a, b) => b.totalRuns - a.totalRuns)
    .slice(0, topAppsLimit);

  return {
    totalRuns: runs.length,
    doneCount,
    failedCount,
    successRate: runs.length > 0 ? doneCount / runs.length : 0,
    totalSizeBytes,
    manualCount: runs.filter((j) => j.source === 'manual').length,
    systemCount: runs.filter((j) => j.source === 'scheduler').length,
    topApps,
    trend: getDailyVolume(trendDays, projectId),
    failureBreakdown: getFailureBreakdown(runs),
    byDevice: getDeviceThroughput(projectId),
    anomalies: getPerformanceAnomalies(runs),
  };
}

export interface DeviceThroughputStats {
  deviceId: string;
  deviceName: string;
  removed: boolean;
  totalRuns: number;
  doneCount: number;
  failedCount: number;
  successRate: number;
  totalSizeBytes: number;
  avgDurationMs?: number;
}

export function getDeviceThroughput(_projectId?: string): DeviceThroughputStats[] {
  const devicesById = new Map(getEffectiveDevices().map((d) => [d.id, d]));
  const byDevice = new Map<string, JobHistoryEntry[]>();
  for (const j of state.jobHistory) {
    if (!j.deviceId) continue;
    const list = byDevice.get(j.deviceId) ?? [];
    list.push(j);
    byDevice.set(j.deviceId, list);
  }

  return [...byDevice.entries()]
    .map(([deviceId, runs]) => {
      const doneCount = runs.filter((j) => j.status === 'done').length;
      const failedCount = runs.filter((j) => j.status === 'failed').length;
      const durations = runs.filter((j) => j.status === 'done' && j.startedAt).map((j) => j.finishedAt - (j.startedAt as number));
      return {
        deviceId,
        deviceName: devicesById.get(deviceId)?.name ?? deviceId,
        removed: !devicesById.has(deviceId),
        totalRuns: runs.length,
        doneCount,
        failedCount,
        successRate: runs.length > 0 ? doneCount / runs.length : 0,
        totalSizeBytes: runs.reduce((sum, j) => sum + (j.sizeBytes ?? 0), 0),
        avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : undefined,
      };
    })
    .sort((a, b) => b.totalRuns - a.totalRuns);
}

export function recordDeviceActivity(entry: Omit<DeviceActivityEntry, 'id' | 'ts'>): void {
  state.deviceActivity.unshift({ id: randomUUID(), ts: Date.now(), ...entry });
  if (state.deviceActivity.length > MAX_DEVICE_ACTIVITY) state.deviceActivity.length = MAX_DEVICE_ACTIVITY;
  persistNow();
}

export function getDeviceActivity(deviceId: string, limit = 20): DeviceActivityEntry[] {
  return deviceHistoryRepository.listByDevice(deviceId).slice(0, limit);
}

export function getDeviceActivityPage(deviceId: string, offset = 0, limit = 20, cursor?: string): { entries: DeviceActivityEntry[]; total: number; nextCursor?: string } {
  const owned = deviceHistoryRepository.listByDevice(deviceId);
  const page = paginateCursor(owned, {
    cursor,
    offset,
    limit,
    keyOf: (entry) => [entry.ts, entry.id],
    order: 'desc',
  });
  return { entries: page.items, total: owned.length, nextCursor: page.nextCursor };
}

export function recordDeviceHealthCheck(
  deviceId: string,
  reachable: boolean,
  batteryPercent?: number,
  batteryTemperatureC?: number,
  storageUsedPercent?: number,
  subsystemSnapshot?: {
    states: Partial<Record<DeviceSubsystemId, DeviceSubsystemState>>;
    reasons?: Partial<Record<DeviceSubsystemId, string>>;
  },
): void {
  const history = state.deviceHealthHistory[deviceId] ?? [];
  const ts = Date.now();
  const previous = history.at(-1) ?? historyFor(deviceId)[0];
  const subsystemDetails = subsystemSnapshot ? Object.fromEntries(
    Object.entries(subsystemSnapshot.states).map(([key, nextState]) => {
      const subsystem = key as DeviceSubsystemId;
      const previousState = previous?.subsystems?.[subsystem];
      const previousDetail = previous?.subsystemDetails?.[subsystem];
      return [subsystem, {
        state: nextState,
        lastChangedAt: previousState === undefined ? undefined : previousState === nextState ? previousDetail?.lastChangedAt : ts,
        reason: subsystemSnapshot.reasons?.[subsystem],
      } satisfies DeviceSubsystemDetail];
    }),
  ) as Partial<Record<DeviceSubsystemId, DeviceSubsystemDetail>> : undefined;
  history.push({
    ts,
    reachable,
    batteryPercent,
    batteryTemperatureC,
    storageUsedPercent,
    subsystems: subsystemSnapshot?.states,
    subsystemDetails,
  });
  if (history.length > MAX_DEVICE_HEALTH_CHECKS) history.shift();
  state.deviceHealthHistory[deviceId] = history;
  persistNow();
}

export function getDeviceSubsystemDetails(
  deviceId: string,
  currentStates: Partial<Record<DeviceSubsystemId, DeviceSubsystemState>> | undefined,
): Partial<Record<DeviceSubsystemId, DeviceSubsystemDetail>> | undefined {
  if (!currentStates) return undefined;
  const latest = historyFor(deviceId)[0];
  return Object.fromEntries(Object.entries(currentStates).map(([key, state]) => {
    const subsystem = key as DeviceSubsystemId;
    const storedState = latest?.subsystems?.[subsystem];
    const storedDetails = latest?.subsystemDetails?.[subsystem];
    if (storedState === state && storedDetails) return [subsystem, storedDetails];
    return [subsystem, { state, reason: storedState === state ? storedDetails?.reason : undefined }];
  }));
}

function historyFor(deviceId: string): DeviceHealthCheck[] {
  return deviceHealthRepository.listByDevice(deviceId);
}

export interface HourlyHealthBucket {
  hourStart: number;
  reachablePercent: number | null;
  transitions: number;
}

export function getDeviceHealthHourlyBuckets(deviceId: string, hours = 24): HourlyHealthBucket[] {
  const now = Date.now();
  const currentHourStart = Math.floor(now / 3_600_000) * 3_600_000;
  const history = historyFor(deviceId);
  const buckets: HourlyHealthBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = currentHourStart - i * 3_600_000;
    const hourEnd = hourStart + 3_600_000;
    const checks = history.filter((c) => c.ts >= hourStart && c.ts < hourEnd).sort((left, right) => left.ts - right.ts);
    const transitions = checks.slice(1).filter((check, index) => check.reachable !== checks[index]?.reachable).length;
    buckets.push({ hourStart, reachablePercent: checks.length > 0 ? checks.filter((c) => c.reachable).length / checks.length : null, transitions });
  }
  return buckets;
}

export function getDeviceUptimePercent(deviceId: string, hours = 24): number | undefined {
  const cutoff = Date.now() - hours * 3_600_000;
  const recent = historyFor(deviceId).filter((c) => c.ts >= cutoff);
  if (recent.length === 0) return undefined;
  return recent.filter((c) => c.reachable).length / recent.length;
}

export function getConsecutiveDeviceHealthFailures(deviceId: string): number {
  const history = historyFor(deviceId);
  let failures = 0;
  for (const check of history) {
    if (check.reachable) break;
    failures += 1;
  }
  return failures;
}

export function hasSustainedDeviceHealthFailures(deviceId: string): boolean {
  const latestChecks = historyFor(deviceId).slice(0, DEVICE_OFFLINE_CONFIRMATION_CHECKS);
  if (latestChecks.length < DEVICE_OFFLINE_CONFIRMATION_CHECKS || latestChecks.some((check) => check.reachable)) return false;

  const now = Date.now();
  const newestCheck = latestChecks[0];
  const oldestCheck = latestChecks[latestChecks.length - 1];
  const newestCheckAge = now - newestCheck.ts;
  const oldestCheckAge = now - oldestCheck.ts;
  return newestCheckAge >= 0
    && newestCheckAge <= DEVICE_OFFLINE_CONFIRMATION_WINDOW_MS
    && oldestCheckAge <= DEVICE_OFFLINE_CONFIRMATION_WINDOW_MS
    && newestCheck.ts - oldestCheck.ts >= DEVICE_OFFLINE_CONFIRMATION_SPAN_MS;
}

export interface HourlyBatteryBucket {
  hourStart: number;
  batteryPercent: number | null;
}

export function getDeviceBatteryHourlyBuckets(deviceId: string, hours = 24): HourlyBatteryBucket[] {
  const now = Date.now();
  const history = historyFor(deviceId);
  const buckets: HourlyBatteryBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = now - i * 3_600_000;
    const hourEnd = hourStart + 3_600_000;
    const readings = history
      .filter((c) => c.ts >= hourStart && c.ts < hourEnd && c.batteryPercent !== undefined)
      .map((c) => c.batteryPercent as number);
    buckets.push({ hourStart, batteryPercent: readings.length > 0 ? Math.round(readings.reduce((a, b) => a + b, 0) / readings.length) : null });
  }
  return buckets;
}

export interface HourlyTemperatureBucket {
  hourStart: number;
  batteryTemperatureC: number | null;
}

export function getDeviceTemperatureHourlyBuckets(deviceId: string, hours = 24): HourlyTemperatureBucket[] {
  const now = Date.now();
  const history = historyFor(deviceId);
  const buckets: HourlyTemperatureBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = now - i * 3_600_000;
    const hourEnd = hourStart + 3_600_000;
    const readings = history
      .filter((c) => c.ts >= hourStart && c.ts < hourEnd && c.batteryTemperatureC !== undefined)
      .map((c) => c.batteryTemperatureC as number);
    buckets.push({
      hourStart,
      batteryTemperatureC: readings.length > 0 ? Math.round((readings.reduce((a, b) => a + b, 0) / readings.length) * 10) / 10 : null,
    });
  }
  return buckets;
}

export interface HourlyStorageBucket {
  hourStart: number;
  storageUsedPercent: number | null;
}

export function getDeviceStorageHourlyBuckets(deviceId: string, hours = 24): HourlyStorageBucket[] {
  const now = Date.now();
  const history = historyFor(deviceId);
  const buckets: HourlyStorageBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = now - i * 3_600_000;
    const hourEnd = hourStart + 3_600_000;
    const readings = history
      .filter((c) => c.ts >= hourStart && c.ts < hourEnd && c.storageUsedPercent !== undefined)
      .map((c) => c.storageUsedPercent as number);
    buckets.push({ hourStart, storageUsedPercent: readings.length > 0 ? Math.round(readings.reduce((a, b) => a + b, 0) / readings.length) : null });
  }
  return buckets;
}

export function getOrCreateVapidKeys(): VapidKeys {
  if (!state.vapidKeys) {
    state.vapidKeys = generateVAPIDKeys();
    persistNow();
  }
  return state.vapidKeys;
}

export function addPushSubscription(username: string, sub: PushSubscriptionRecord): void {
  const lower = username.toLowerCase();
  const existing = state.pushSubscriptions[lower] ?? [];
  if (existing.some((s) => s.endpoint === sub.endpoint)) return;
  state.pushSubscriptions[lower] = [...existing, sub];
  persistNow();
}

export function removePushSubscription(username: string, endpoint: string): void {
  const lower = username.toLowerCase();
  const existing = state.pushSubscriptions[lower];
  if (!existing) return;
  state.pushSubscriptions[lower] = existing.filter((s) => s.endpoint !== endpoint);
  persistNow();
}

export function getPushSubscriptions(username: string): PushSubscriptionRecord[] {
  return state.pushSubscriptions[username.toLowerCase()] ?? [];
}

export function getUsersWithPushSubscriptions(): string[] {
  return Object.keys(state.pushSubscriptions).filter((username) => state.pushSubscriptions[username].length > 0);
}

export function getUserPrefs(username: string): UserPrefs {
  return state.userPrefs[username.toLowerCase()] ?? {};
}

export function recordDecryptQuotaThresholdNotice(userId: string, used: number, limit: number, threshold: number): void {
  const normalizedUserId = userId.trim().toLowerCase();
  if (!normalizedUserId || !getUserPrefs(normalizedUserId).decryptUsageAlertThresholds?.includes(threshold)) return;
  recordNotification({
    userId: normalizedUserId,
    title: 'Decrypt allowance',
    message: `You have used ${used} of ${limit} new decrypts in the rolling 24-hour window.`,
    severity: threshold >= 90 ? 'warning' : 'info',
    groupKey: `decrypt-quota:${threshold}`,
    href: '/?tab=billing',
  });
}

export function updateUserPrefs(username: string, patch: Partial<UserPrefs>): UserPrefs {
  const lower = username.toLowerCase();
  const updated = { ...(state.userPrefs[lower] ?? {}), ...patch };
  state.userPrefs[lower] = updated;
  persistNow();
  return updated;
}

export function recordNotification(input: Omit<NotificationRecord, 'id' | 'createdAt' | 'readAt'>): NotificationRecord {
  const now = Date.now();
  const userId = input.userId.toLowerCase();
  const existing = input.groupKey
    ? state.notifications.find((notification) => {
      if (notification.userId.toLowerCase() !== userId || notification.groupKey !== input.groupKey) return false;
      const lastOccurredAt = notification.lastOccurredAt ?? notification.createdAt;
      const age = now - lastOccurredAt;
      return age >= 0 && age <= NOTIFICATION_GROUP_WINDOW_MS;
    })
    : undefined;

  if (existing) {
    existing.title = input.title;
    existing.message = input.message;
    existing.severity = input.severity;
    existing.firstOccurredAt ??= existing.createdAt;
    existing.createdAt = now;
    existing.lastOccurredAt = now;
    existing.occurrenceCount = (existing.occurrenceCount ?? 1) + 1;
    existing.readAt = undefined;
    existing.jobId = input.jobId ?? existing.jobId;
    existing.deviceId = input.deviceId ?? existing.deviceId;
    existing.deploymentId = input.deploymentId ?? existing.deploymentId;
    existing.href = input.href ?? existing.href;
    const existingIndex = state.notifications.indexOf(existing);
    if (existingIndex >= 0) state.notifications.splice(existingIndex, 1);
    state.notifications.unshift(existing);
    if (state.notifications.length > MAX_NOTIFICATIONS) state.notifications.length = MAX_NOTIFICATIONS;
    persistNow();
    return { ...existing };
  }

  const notification: NotificationRecord = {
    ...input,
    userId,
    id: randomUUID(),
    createdAt: now,
    ...(input.groupKey ? { firstOccurredAt: now, lastOccurredAt: now, occurrenceCount: 1 } : {}),
  };
  state.notifications.unshift(notification);
  if (state.notifications.length > MAX_NOTIFICATIONS) state.notifications.length = MAX_NOTIFICATIONS;
  persistNow();
  return { ...notification };
}

export function recordDeviceAlertNotification(input: {
  deviceId: string;
  groupKey: string;
  title: string;
  message: string;
  severity: NotificationSeverity;
}): void {
  for (const userId of listDeviceAlertRecipients()) {
    recordNotification({
      userId,
      title: input.title,
      message: input.message,
      severity: input.severity,
      groupKey: input.groupKey,
      deviceId: input.deviceId,
      href: `/?tab=settings&stab=devices#device-${encodeURIComponent(input.deviceId)}`,
    });
  }
}

export function listNotifications(userId: string, limit = 50): { notifications: NotificationRecord[]; unread: number } {
  const page = listNotificationsPage(userId, 0, limit);
  return { notifications: page.notifications, unread: page.unread };
}

export function listNotificationsPage(userId: string, offset = 0, limit = 50, cursor?: string): { notifications: NotificationRecord[]; unread: number; total: number; nextCursor?: string } {
  const lower = userId.toLowerCase();
  const page = notificationRepository.listPageByUser(lower, {
    cursor,
    offset,
    limit,
  });
  return {
    notifications: page.notifications.map(({ groupKey: _groupKey, ...notification }) => ({ ...notification })),
    unread: page.unread,
    total: page.total,
    nextCursor: page.nextCursor,
  };
}

export function markNotificationsRead(userId: string, ids?: string[]): number {
  const lower = userId.toLowerCase();
  const allowed = ids ? new Set(ids) : undefined;
  const now = Date.now();
  let changed = 0;
  for (const notification of state.notifications) {
    if (notification.userId.toLowerCase() !== lower || notification.readAt || (allowed && !allowed.has(notification.id))) continue;
    notification.readAt = now;
    changed += 1;
  }
  if (changed > 0) persistNow();
  return changed;
}

const BACKUP_VERSION = 11;

type BackupDeviceRecord = Omit<DeviceRecord, 'transport' | 'host' | 'udid'>
  & { transport: DeviceTransport }
  & ({ host: string; udid?: string } | { host?: string; udid: string });

export interface ArtifactProjectLink {
  artifactId: string;
  projectIds: string[];
}

export interface BackupPayload {
  backupVersion: typeof BACKUP_VERSION;
  exportedAt: number;
  allowedUsers: AllowedUser[];
  roles: Role[];
  apiKeys: ApiKeyRecord[];
  settings: PersistedSettings;
  watches: Array<Omit<AppWatch, 'projectId'>>;
  devices: BackupDeviceRecord[];
  jobHistory: JobHistoryEntry[];
  lastSchedulerRunAt?: number;
  userPrefs: Record<string, UserPrefs>;
  auditLog: AuditLogEntry[];
  schedulerRunHistory: SchedulerRunEntry[];
  rootSessionVersion: number;
  apiKeyUsage: Record<string, ApiKeyUsageBucket[]>;
  apiKeyBundleUsage: Record<string, Record<string, number>>;
  deviceActivity: DeviceActivityEntry[];
  testFlightSubscriptions: TestFlightSubscription[];
  rootMfa?: UserMfaRecord;
  passkeys: PasskeyCredential[];
  billing: BillingSnapshot;
  identities: IdentitySnapshot;
  decryptQuotaLedger: ReturnType<typeof exportDecryptQuotaLedger>;
}

function normalizeBackupDevice(device: DeviceRecord): BackupDeviceRecord {
  const transport = device.transport ?? (device.udid ? device.usbmuxNetwork ? 'wifi' : 'usb' : 'wifi');
  if (transport !== 'wifi' && transport !== 'usb') throw new Error(`device ${device.id} has no supported transport`);
  if (!device.host && !device.udid) throw new Error(`device ${device.id} has no host or UDID`);
  return { ...device, transport } as BackupDeviceRecord;
}

function artifactProjectLinksReplacement(): StateCollectionReplacement[] {
  const rows = stateDatabase.readCollection('artifacts').flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const artifact = value as Record<string, unknown>;
    if (typeof artifact.id !== 'string') return [];
    return [{
      id: artifact.id,
      payload: { ...artifact, projectIds: [DEFAULT_PROJECT_ID] },
      updatedAt: typeof artifact.lastAccessedAt === 'number' ? artifact.lastAccessedAt : Date.now(),
    }];
  });
  return [{ table: 'artifacts', rows }];
}

export function exportBackup(): BackupPayload {
  const apiKeys = state.apiKeys.map((key) => {
    const { projectIds: _projectIds, ...portable } = key as ApiKeyRecord & { projectIds?: string[] };
    return { ...portable, pendingReveal: undefined };
  });
  return {
    backupVersion: BACKUP_VERSION,
    exportedAt: Date.now(),
    allowedUsers: state.allowedUsers,
    roles: state.roles,
    apiKeys,
    settings: state.settings,
    watches: state.watches.map(({ projectId: _projectId, ...watch }) => watch),
    devices: getEffectiveDevices().map(normalizeBackupDevice),
    jobHistory: state.jobHistory.map(({ projectId: _projectId, ...entry }) => entry),
    lastSchedulerRunAt: state.lastSchedulerRunAt,
    userPrefs: state.userPrefs,
    auditLog: state.auditLog,
    schedulerRunHistory: state.schedulerRunHistory,
    rootSessionVersion: state.rootSessionVersion,
    apiKeyUsage: state.apiKeyUsage,
    apiKeyBundleUsage: state.apiKeyBundleUsage,
    deviceActivity: state.deviceActivity,
    testFlightSubscriptions: getTestFlightSubscriptions(),
    rootMfa: state.rootMfa,
    passkeys: state.passkeys.map((credential) => ({ ...credential, transports: credential.transports ? [...credential.transports] : undefined })),
    billing: exportBillingSnapshot(),
    identities: exportIdentitySnapshot(),
    decryptQuotaLedger: exportDecryptQuotaLedger(),
  };
}

export function getBackupSchedule(): BackupScheduleSettings {
  return { ...state.backupSchedule };
}

export function setBackupSchedule(patch: Partial<BackupScheduleSettings>, actor: string): BackupScheduleSettings {
  state.backupSchedule = { ...state.backupSchedule, ...patch };
  persistNow();
  recordAudit(actor, 'backup.schedule-update', 'backup-schedule', JSON.stringify(patch));
  return { ...state.backupSchedule };
}

export function getBackupHistory(): BackupHistoryEntry[] {
  return [...state.backupHistory].sort((a, b) => b.createdAt - a.createdAt);
}

export function createBackupSnapshot(trigger: 'scheduled' | 'manual', actor = 'system'): BackupHistoryEntry {
  mkdirSync(backupsDir, { recursive: true });
  persistNow();
  const payload = exportBackup();
  const json = JSON.stringify(payload, null, 2);
  const id = randomUUID();
  const snapshotDirectory = `snapshot-${id}`;
  const temporaryDirectory = mkdtempSync(path.join(backupsDir, '.staging-'));
  const publishedDirectory = path.join(backupsDir, snapshotDirectory);
  const filename = `backup-${payload.exportedAt}-${id.slice(0, 8)}.json`;
  const databaseFilename = `${filename}.sqlite`;
  const manifestFilename = `${filename}.manifest`;
  const jsonPath = path.join(temporaryDirectory, filename);
  const databasePath = path.join(temporaryDirectory, databaseFilename);
  const manifestPath = path.join(temporaryDirectory, manifestFilename);
  let published = false;
  try {
    writeFileSync(jsonPath, `${json}\n`, { mode: 0o600 });
    fsyncPath(jsonPath);
    stateDatabase.backupTo(databasePath);
    verifyDatabaseBackup(databasePath);
    fsyncPath(databasePath);
    const manifest = encryptedBackupManifest({
      backupVersion: payload.backupVersion,
      exportedAt: payload.exportedAt,
      stateSchemaVersion: stateDatabase.schemaVersion,
      jsonSha256: createHash('sha256').update(readFileSync(jsonPath)).digest('hex'),
      databaseSha256: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    });
    writeFileSync(manifestPath, `${manifest}\n`, { mode: 0o600 });
    fsyncPath(manifestPath);
    verifyEncryptedBackupManifest(manifestPath, jsonPath, databasePath);
    fsyncPath(temporaryDirectory);
    renameSync(temporaryDirectory, publishedDirectory);
    published = true;
    fsyncPath(backupsDir);
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    if (published) rmSync(publishedDirectory, { recursive: true, force: true });
    throw error;
  }

  const entry: BackupHistoryEntry = {
    id,
    createdAt: payload.exportedAt,
    sizeBytes: Buffer.byteLength(json) + readFileSync(path.join(publishedDirectory, databaseFilename)).byteLength,
    filename: `${snapshotDirectory}/${filename}`,
    databaseFilename: `${snapshotDirectory}/${databaseFilename}`,
    manifestFilename: `${snapshotDirectory}/${manifestFilename}`,
    schemaVersion: stateDatabase.schemaVersion,
    integrity: 'verified',
    encryptedManifest: true,
    restoreDrillStatus: 'not_run',
    trigger,
  };
  const previousHistory = state.backupHistory;
  const retention = Math.max(1, state.backupSchedule.retentionCount);
  const nextHistory = [entry, ...previousHistory].slice(0, retention);
  const removedEntries = previousHistory.slice(Math.max(0, retention - 1));
  state.backupHistory = nextHistory;
  try {
    persistNow();
  } catch (error) {
    state.backupHistory = previousHistory;
    rmSync(publishedDirectory, { recursive: true, force: true });
    throw error;
  }
  for (const removed of removedEntries) removeBackupSnapshotFiles(removed);
  recordAudit(actor, 'backup.create', entry.filename, trigger);
  drillBackupSnapshot(entry.id, actor);
  return state.backupHistory.find((candidate) => candidate.id === entry.id) ?? entry;
}

export function getBackupSnapshotPath(id: string): string | undefined {
  const entry = state.backupHistory.find((e) => e.id === id);
  if (!entry) return undefined;
  const filePath = backupSnapshotFilePath(entry.filename);
  if (!filePath) return undefined;
  return existsSync(filePath) ? filePath : undefined;
}

function backupSnapshotFilePath(filename: string | undefined): string | undefined {
  if (!filename || filename.includes('\\')) return undefined;
  const directory = backupSnapshotDirectory(filename);
  if (directory) return path.join(backupsDir, directory, path.basename(filename));
  if (filename.includes('/') || path.basename(filename) !== filename) return undefined;
  return path.join(backupsDir, filename);
}

function backupSnapshotDirectory(filename: string | undefined): string | undefined {
  if (!filename || filename.includes('\\')) return undefined;
  const [directory, file, ...extra] = filename.split('/');
  if (extra.length > 0 || !directory || !file || path.basename(file) !== file || !/^snapshot-[0-9a-f-]{36}$/.test(directory)) return undefined;
  return directory;
}

function removeBackupSnapshotFiles(entry: BackupHistoryEntry): void {
  for (const filename of [entry.filename, entry.databaseFilename, entry.manifestFilename]) {
    const filePath = backupSnapshotFilePath(filename);
    if (filePath && existsSync(filePath)) rmSync(filePath, { force: true });
  }
  const directory = backupSnapshotDirectory(entry.filename);
  if (directory) rmSync(path.join(backupsDir, directory), { recursive: true, force: true });
}

function cleanupBackupSnapshotDirectories(history: BackupHistoryEntry[]): void {
  if (!existsSync(backupsDir)) return;
  const referencedDirectories = new Set(history.map((entry) => backupSnapshotDirectory(entry.filename)).filter((value): value is string => Boolean(value)));
  for (const entry of readdirSync(backupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.staging-') || (/^snapshot-[0-9a-f-]{36}$/.test(entry.name) && !referencedDirectories.has(entry.name))) {
      rmSync(path.join(backupsDir, entry.name), { recursive: true, force: true });
    }
  }
}

export function verifyLatestDatabaseBackup(): { ok: boolean; detail: string } {
  const entry = getBackupHistory().find((candidate) => candidate.databaseFilename);
  if (!entry?.databaseFilename || !entry.manifestFilename) return { ok: false, detail: 'No verified SQLite backup has been created yet' };
  const databasePath = backupSnapshotFilePath(entry.databaseFilename);
  const jsonPath = backupSnapshotFilePath(entry.filename);
  const manifestPath = backupSnapshotFilePath(entry.manifestFilename);
  if (!databasePath || !jsonPath || !manifestPath) return { ok: false, detail: 'Backup snapshot paths are invalid' };
  try {
    const result = verifyDatabaseBackup(databasePath);
    verifyEncryptedBackupManifest(manifestPath, jsonPath, databasePath);
    return { ok: result.hasStateSnapshot, detail: result.hasStateSnapshot ? `SQLite schema ${result.schemaVersion} restored and verified` : 'SQLite backup has no state snapshot' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface BackupSnapshotRestoreDrill {
  status: 'passed' | 'failed';
  checkedAt: number;
  checks: BackupRestoreDrillCheck[];
}

export function drillBackupSnapshot(id: string, actor: string): BackupSnapshotRestoreDrill | undefined {
  const entry = state.backupHistory.find((candidate) => candidate.id === id);
  if (!entry) return undefined;

  const checks: BackupRestoreDrillCheck[] = [];
  let temporaryStateDir: string | undefined;
  const jsonPath = backupSnapshotFilePath(entry.filename);
  if (!jsonPath || !existsSync(jsonPath)) {
    checks.push({ label: 'Backup JSON', ok: false, detail: 'Backup JSON snapshot is missing' });
  } else {
    try {
      const backupPayload = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
      checks.push({ label: 'Backup JSON', ok: true, detail: 'Backup JSON parsed successfully' });
      const jsonDrill = drillBackupRestore(backupPayload);
      if (!jsonDrill.ok) checks.push({ label: 'JSON restore transformation', ok: false, detail: jsonDrill.error });
      else checks.push(...jsonDrill.drill.checks);
    } catch (error) {
      checks.push({ label: 'Backup JSON', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const databasePath = backupSnapshotFilePath(entry.databaseFilename);
  const manifestPath = backupSnapshotFilePath(entry.manifestFilename);
  if (!databasePath || !manifestPath) {
    checks.push({ label: 'Encrypted manifest and checksums', ok: false, detail: 'This snapshot has no encrypted integrity manifest' });
    checks.push({ label: 'Temporary SQLite restore', ok: false, detail: 'This snapshot has no SQLite database backup' });
  } else if (!existsSync(databasePath) || !existsSync(manifestPath) || !jsonPath) {
    checks.push({ label: 'Encrypted manifest and checksums', ok: false, detail: 'A required integrity file is missing' });
    checks.push({ label: 'Temporary SQLite restore', ok: false, detail: 'A required SQLite backup file is missing' });
  } else {
    try {
      verifyEncryptedBackupManifest(manifestPath, jsonPath, databasePath);
      checks.push({ label: 'Encrypted manifest and checksums', ok: true, detail: 'JSON and SQLite snapshot checksums verified' });
    } catch (error) {
      checks.push({ label: 'Encrypted manifest and checksums', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }

    try {
      temporaryStateDir = mkdtempSync(path.join(config.stateDir, '.restore-drill-'));
      const restoredDatabasePath = path.join(temporaryStateDir, 'restore-drill.sqlite');
      copyFileSync(databasePath, restoredDatabasePath);
      const restoredDatabase = openStateDatabase({
        stateDir: temporaryStateDir,
        filename: path.basename(restoredDatabasePath),
        busyTimeoutMs: config.stateDbBusyTimeoutMs,
      });
      let restoredState: unknown;
      let restoredSchemaVersion = 0;
      try {
        restoredDatabase.integrityStatus();
        restoredSchemaVersion = restoredDatabase.schemaVersion;
        restoredState = restoredDatabase.readState();
      } finally {
        restoredDatabase.close();
      }
      const currentSchemaVersion = stateDatabase.schemaVersion;
      const schemaRestored = restoredSchemaVersion >= currentSchemaVersion;
      checks.push({ label: 'Temporary SQLite restore', ok: schemaRestored, detail: `Restored schema ${restoredSchemaVersion} of ${currentSchemaVersion}` });
      let stateSnapshotReadable = false;
      let stateSnapshotDetail = 'State snapshot is missing or malformed';
      try {
        const migratedState = normalizeLoadedState(migrate(asStateRecord(restoredState)));
        stateSnapshotReadable = migratedState.version === state.version;
        stateSnapshotDetail = stateSnapshotReadable
          ? `State snapshot verified and migrated to version ${migratedState.version}`
          : `State snapshot migrated to unsupported version ${migratedState.version}`;
      } catch (error) {
        stateSnapshotDetail = error instanceof Error ? error.message : String(error);
      }
      checks.push({
        label: 'State snapshot checksum',
        ok: stateSnapshotReadable,
        detail: stateSnapshotDetail,
      });
    } catch (error) {
      checks.push({ label: 'Temporary SQLite restore', ok: false, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      if (temporaryStateDir) rmSync(temporaryStateDir, { recursive: true, force: true });
    }
  }

  const checkedAt = Date.now();
  const status = checks.length > 0 && checks.every((check) => check.ok) ? 'passed' : 'failed';
  const updatedEntry: BackupHistoryEntry = {
    ...entry,
    integrity: !entry.manifestFilename
      ? 'unavailable'
      : checks.some((check) => check.label === 'Encrypted manifest and checksums' && check.ok)
        ? 'verified'
        : 'failed',
    restoreDrillStatus: status,
    restoreDrillAt: checkedAt,
    restoreDrillChecks: checks,
  };
  state.backupHistory = state.backupHistory.map((candidate) => candidate.id === id ? updatedEntry : candidate);
  persistNow();
  recordAudit(actor, 'backup.drill', entry.filename, status);
  return { status, checkedAt, checks };
}

export function deleteBackupSnapshot(id: string, actor: string): boolean {
  const removed = state.backupHistory.find((entry) => entry.id === id);
  if (!removed) return false;
  const previousHistory = state.backupHistory;
  state.backupHistory = previousHistory.filter((entry) => entry.id !== id);
  try {
    persistNow();
  } catch (error) {
    state.backupHistory = previousHistory;
    throw error;
  }
  removeBackupSnapshotFiles(removed);
  recordAudit(actor, 'backup.delete', removed.filename, '');
  return true;
}

function isPasskeyCredentialShape(value: unknown): value is PasskeyCredential {
  if (typeof value !== 'object' || value === null) return false;
  const credential = value as Record<string, unknown>;
  return (
    typeof credential.id === 'string' &&
    typeof credential.userId === 'string' &&
    typeof credential.publicKey === 'string' &&
    typeof credential.counter === 'number' &&
    Number.isInteger(credential.counter) &&
    credential.counter >= 0 &&
    (credential.transports === undefined || (Array.isArray(credential.transports) && credential.transports.every((transport) => typeof transport === 'string'))) &&
    (credential.name === undefined || typeof credential.name === 'string') &&
    typeof credential.createdAt === 'number' &&
    (credential.lastUsedAt === undefined || typeof credential.lastUsedAt === 'number')
  );
}

function isDeviceRecordShape(value: unknown): value is BackupDeviceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  const hasDirectConnection = (d.transport === 'wifi' || d.transport === 'usb') && (typeof d.host === 'string' || typeof d.udid === 'string');
  return typeof d.id === 'string' && typeof d.name === 'string' && typeof d.enabled === 'boolean' && hasDirectConnection;
}

function isJobHistoryEntryShape(value: unknown): value is JobHistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.bundleId === 'string' &&
    (e.status === 'done' || e.status === 'failed') &&
    typeof e.finishedAt === 'number'
  );
}

function isAuditLogEntryShape(value: unknown): value is AuditLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.ts === 'number' &&
    typeof e.actor === 'string' &&
    typeof e.action === 'string' &&
    typeof e.target === 'string' &&
    (e.changes === undefined || (Array.isArray(e.changes) && e.changes.every((change) => {
      if (!change || typeof change !== 'object') return false;
      const item = change as Record<string, unknown>;
      const scalar = (candidate: unknown) => candidate === null || typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean';
      return typeof item.field === 'string' && scalar(item.before) && scalar(item.after);
    })))
  );
}

function isSchedulerRunEntryShape(value: unknown): value is SchedulerRunEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e.ts === 'number' && typeof e.appStore === 'object' && typeof e.testflight === 'object';
}

function isTestFlightSubscriptionDeviceShape(value: unknown): value is TestFlightSubscriptionDevice {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.deviceId === 'string' && ['pending', 'syncing', 'active', 'unavailable', 'unsupported', 'error', 'unsubscribed'].includes(String(d.status));
}

function isTestFlightSubscriptionShape(value: unknown): value is TestFlightSubscription {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    typeof s.url === 'string' &&
    typeof s.inviteCode === 'string' &&
    typeof s.requestedBy === 'string' &&
    ['pending', 'approved', 'denied', 'withdrawn'].includes(String(s.status)) &&
    typeof s.createdAt === 'number' &&
    typeof s.updatedAt === 'number' &&
    Array.isArray(s.devices) &&
    s.devices.every(isTestFlightSubscriptionDeviceShape) &&
    s.devicePolicy === 'all-enabled'
  );
}

function isTestFlightCatalogCacheAppShape(value: unknown): value is TestFlightCatalogCacheApp {
  if (typeof value !== 'object' || value === null) return false;
  const app = value as Record<string, unknown>;
  return (
    typeof app.appId === 'number' &&
    typeof app.bundleId === 'string' &&
    typeof app.displayName === 'string' &&
    typeof app.lastVerifiedAt === 'number' &&
    app.deviceSource === true &&
    Array.isArray(app.devices) &&
    app.devices.every((device) => {
      if (typeof device !== 'object' || device === null) return false;
      const entry = device as Record<string, unknown>;
      return typeof entry.id === 'string' && typeof entry.name === 'string' && (entry.verifiedAt === undefined || typeof entry.verifiedAt === 'number');
    })
  );
}

function isTestFlightCatalogCacheShape(value: unknown): value is TestFlightCatalogCache {
  if (typeof value !== 'object' || value === null) return false;
  const cache = value as Record<string, unknown>;
  return (
    typeof cache.fetchedAt === 'number' &&
    Array.isArray(cache.deviceIds) &&
    cache.deviceIds.every((deviceId) => typeof deviceId === 'string') &&
    Array.isArray(cache.apps) &&
    cache.apps.every(isTestFlightCatalogCacheAppShape) &&
    (cache.complete === undefined || typeof cache.complete === 'boolean')
  );
}

interface ValidatedBackupPayload {
  backupVersion: number;
  exportedAt?: number;
  allowedUsers: AllowedUser[];
  roles: Role[];
  projects: ProjectRecord[];
  artifactProjectLinks: ArtifactProjectLink[];
  apiKeys: ApiKeyRecord[];
  settings: PersistedSettings;
  watches: AppWatch[];
  devices: BackupDeviceRecord[];
  jobHistory: JobHistoryEntry[];
  lastSchedulerRunAt?: number;
  userPrefs: Record<string, UserPrefs>;
  auditLog: AuditLogEntry[];
  schedulerRunHistory: SchedulerRunEntry[];
  rootSessionVersion: number;
  apiKeyUsage: Record<string, ApiKeyUsageBucket[]>;
  apiKeyBundleUsage?: Record<string, Record<string, number>>;
  deviceActivity?: DeviceActivityEntry[];
  testFlightSubscriptions: TestFlightSubscription[];
  rootMfa?: UserMfaRecord;
  passkeys: PasskeyCredential[];
  billing: BillingSnapshot;
  identities: IdentitySnapshot;
  decryptQuotaLedger: ReturnType<typeof exportDecryptQuotaLedger>;
}

function isArtifactProjectLinkShape(value: unknown): value is ArtifactProjectLink {
  if (!value || typeof value !== 'object') return false;
  const link = value as Record<string, unknown>;
  return typeof link.artifactId === 'string'
    && link.artifactId.length > 0
    && Array.isArray(link.projectIds)
    && link.projectIds.every((projectId) => typeof projectId === 'string' && projectId.length > 0);
}

function validateBackupPayload(raw: unknown): { ok: true; payload: ValidatedBackupPayload } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'not a valid backup file' };
  const b = raw as Record<string, unknown>;

  if (b.backupVersion !== 3 && b.backupVersion !== 4 && b.backupVersion !== 5 && b.backupVersion !== 6 && b.backupVersion !== 7 && b.backupVersion !== 8 && b.backupVersion !== 9 && b.backupVersion !== 10 && b.backupVersion !== BACKUP_VERSION) {
    return { ok: false, error: `unsupported backup version (expected 3 through ${BACKUP_VERSION})` };
  }
  if (b.backupVersion === BACKUP_VERSION && (!Array.isArray(b.decryptQuotaLedger) || !b.decryptQuotaLedger.every((entry) => typeof entry === 'object' && entry !== null && typeof entry.jobId === 'string' && typeof entry.ownerId === 'string' && Number.isFinite(entry.admittedAt) && ['reserved', 'consumed'].includes(entry.state)))) {
    return { ok: false, error: 'decrypt quota ledger is missing or malformed' };
  }
  if (!Array.isArray(b.allowedUsers) || !b.allowedUsers.every(isAllowedUserRecord)) {
    return { ok: false, error: 'allowedUsers is missing or malformed' };
  }
  if (new Set((b.allowedUsers as AllowedUser[]).map((user) => user.username.toLowerCase())).size !== b.allowedUsers.length) {
    return { ok: false, error: 'allowedUsers contains duplicate usernames' };
  }
  if (!Array.isArray(b.roles) || !b.roles.every(isRoleRecord)) {
    return { ok: false, error: 'roles is missing or malformed' };
  }
  const backupRoles = b.roles as Role[];
  if (new Set(backupRoles.map((role) => role.id)).size !== backupRoles.length || backupRoles.filter((role) => role.isDefault).length > 1) {
    return { ok: false, error: 'roles must contain unique ids and at most one default role' };
  }
  if (!Array.isArray(b.apiKeys) || !b.apiKeys.every(isApiKeyRecordShape)) {
    return { ok: false, error: 'apiKeys is missing or malformed' };
  }
  if (typeof b.settings !== 'object' || b.settings === null) {
    return { ok: false, error: 'settings is missing or malformed' };
  }
  if (!Array.isArray(b.watches) || !b.watches.every(isAppWatchRecord)) {
    return { ok: false, error: 'watches is missing or malformed' };
  }
  if (!Array.isArray(b.devices) || !b.devices.every(isDeviceRecordShape)) {
    return { ok: false, error: 'devices is missing or malformed' };
  }
  if (!Array.isArray(b.jobHistory) || !b.jobHistory.every(isJobHistoryEntryShape)) {
    return { ok: false, error: 'jobHistory is missing or malformed' };
  }
  if (!Array.isArray(b.auditLog) || !b.auditLog.every(isAuditLogEntryShape)) {
    return { ok: false, error: 'auditLog is missing or malformed' };
  }
  if (!Array.isArray(b.schedulerRunHistory) || !b.schedulerRunHistory.every(isSchedulerRunEntryShape)) {
    return { ok: false, error: 'schedulerRunHistory is missing or malformed' };
  }
  if (typeof b.userPrefs !== 'object' || b.userPrefs === null) {
    return { ok: false, error: 'userPrefs is missing or malformed' };
  }
  if (typeof b.apiKeyUsage !== 'object' || b.apiKeyUsage === null) {
    return { ok: false, error: 'apiKeyUsage is missing or malformed' };
  }
  if (typeof b.rootSessionVersion !== 'number') {
    return { ok: false, error: 'rootSessionVersion is missing or malformed' };
  }
  if (b.rootMfa !== undefined && !isUserMfaRecord(b.rootMfa)) {
    return { ok: false, error: 'rootMfa is malformed' };
  }
  if (b.passkeys !== undefined && (!Array.isArray(b.passkeys) || !b.passkeys.every(isPasskeyCredentialShape))) {
    return { ok: false, error: 'passkeys is malformed' };
  }
  if (b.backupVersion >= 6 && (!Array.isArray(b.testFlightSubscriptions) || !b.testFlightSubscriptions.every(isTestFlightSubscriptionShape))) {
    return { ok: false, error: 'testFlightSubscriptions is missing or malformed' };
  }
  if (b.backupVersion >= 7 && b.backupVersion <= 10 && (!Array.isArray(b.projects) || !b.projects.every(isProjectRecordShape))) {
    return { ok: false, error: 'legacy workspace data is missing or malformed' };
  }
  if (b.backupVersion >= 7 && b.backupVersion <= 10) {
    const projects = b.projects as ProjectRecord[];
    const projectIds = new Set(projects.map((project) => project.id));
    const userIds = new Set((b.allowedUsers as AllowedUser[]).map((user) => user.username.toLowerCase()));
    if (projectIds.size !== projects.length || projects.filter((project) => project.isDefault).length !== 1 || projects.filter((project) => project.isDefault && project.id === DEFAULT_PROJECT_ID).length !== 1 || projects.some((project) => project.memberIds.some((memberId) => !userIds.has(memberId.toLowerCase())))) {
      return { ok: false, error: 'legacy workspace data has invalid membership or no default workspace' };
    }
    if (b.backupVersion >= 8 && (b.jobHistory as JobHistoryEntry[]).some((entry) => typeof entry.projectId !== 'string' || !projectIds.has(entry.projectId))) {
      return { ok: false, error: 'job history references a missing project' };
    }
    if ((b.watches as AppWatch[]).some((watch) => watch.projectId !== undefined && !projectIds.has(watch.projectId))) {
      return { ok: false, error: 'watches reference a missing project' };
    }
    if (b.backupVersion >= 9 && b.backupVersion <= 10 && (!Array.isArray(b.artifactProjectLinks) || !b.artifactProjectLinks.every(isArtifactProjectLinkShape))) {
      return { ok: false, error: 'legacy artifact links are missing or malformed' };
    }
    if (Array.isArray(b.artifactProjectLinks)) {
      const artifactLinks = b.artifactProjectLinks as ArtifactProjectLink[];
      const artifactIds = new Set(artifactLinks.map((link) => link.artifactId));
      if (artifactIds.size !== artifactLinks.length || artifactLinks.some((link) => link.projectIds.some((projectId) => !projectIds.has(projectId)))) {
        return { ok: false, error: 'artifact project links have duplicate artifacts or reference a missing project' };
      }
    }
  }
  if (b.backupVersion >= 4 && !isBillingSnapshot(b.billing)) {
    return { ok: false, error: 'billing is missing or malformed' };
  }
  if (b.backupVersion >= 4 && !isIdentitySnapshot(b.identities)) {
    return { ok: false, error: 'identities is missing or malformed' };
  }

  return {
    ok: true,
    payload: {
      backupVersion: b.backupVersion as number,
      exportedAt: typeof b.exportedAt === 'number' ? b.exportedAt : undefined,
      allowedUsers: b.allowedUsers as AllowedUser[],
      roles: b.roles as Role[],
      projects: [createDefaultProject()],
      artifactProjectLinks: Array.isArray(b.artifactProjectLinks) && b.artifactProjectLinks.every(isArtifactProjectLinkShape) ? b.artifactProjectLinks as ArtifactProjectLink[] : [],
      apiKeys: b.apiKeys as ApiKeyRecord[],
      settings: b.settings as PersistedSettings,
      watches: (b.watches as AppWatch[]).map((watch) => ({ ...watch, projectId: DEFAULT_PROJECT_ID })),
      devices: b.devices as BackupDeviceRecord[],
      jobHistory: (b.jobHistory as JobHistoryEntry[]).map((entry) => ({ ...entry, projectId: DEFAULT_PROJECT_ID })),
      lastSchedulerRunAt: typeof b.lastSchedulerRunAt === 'number' ? b.lastSchedulerRunAt : undefined,
      userPrefs: b.userPrefs as Record<string, UserPrefs>,
      auditLog: b.auditLog as AuditLogEntry[],
      schedulerRunHistory: b.schedulerRunHistory as SchedulerRunEntry[],
      rootSessionVersion: b.rootSessionVersion as number,
      apiKeyUsage: b.apiKeyUsage as Record<string, ApiKeyUsageBucket[]>,
      apiKeyBundleUsage:
        typeof b.apiKeyBundleUsage === 'object' && b.apiKeyBundleUsage !== null
          ? (b.apiKeyBundleUsage as Record<string, Record<string, number>>)
          : undefined,
      deviceActivity: Array.isArray(b.deviceActivity) ? (b.deviceActivity as DeviceActivityEntry[]) : undefined,
      testFlightSubscriptions: Array.isArray(b.testFlightSubscriptions) ? (b.testFlightSubscriptions as TestFlightSubscription[]) : [],
      rootMfa: b.rootMfa as UserMfaRecord | undefined,
      passkeys: Array.isArray(b.passkeys) ? (b.passkeys as PasskeyCredential[]) : [],
      billing: isBillingSnapshot(b.billing)
        ? b.billing
        : { customers: [], subscriptions: [], cryptoCheckouts: [], cryptoCharges: [], processedEvents: [] },
      identities: isIdentitySnapshot(b.identities) ? b.identities : { profiles: [] },
      decryptQuotaLedger: Array.isArray(b.decryptQuotaLedger) ? b.decryptQuotaLedger as ReturnType<typeof exportDecryptQuotaLedger> : [],
    },
  };
}

export interface BackupPreviewSummary {
  exportedAt?: number;
  incoming: {
    users: number;
    roles: number;
    apiKeys: number;
    watches: number;
    devices: number;
    jobHistory: number;
    auditLog: number;
  };
  current: {
    users: number;
    roles: number;
    apiKeys: number;
    watches: number;
    devices: number;
    jobHistory: number;
    auditLog: number;
  };
}

export function previewBackup(raw: unknown): { ok: true; summary: BackupPreviewSummary } | { ok: false; error: string } {
  const validated = validateBackupPayload(raw);
  if (!validated.ok) return validated;
  const { payload } = validated;
  return {
    ok: true,
    summary: {
      exportedAt: payload.exportedAt,
      incoming: {
        users: payload.allowedUsers.length,
        roles: payload.roles.length,
        apiKeys: payload.apiKeys.length,
        watches: payload.watches.length,
        devices: payload.devices.length,
        jobHistory: payload.jobHistory.length,
        auditLog: payload.auditLog.length,
      },
      current: {
        users: state.allowedUsers.length,
        roles: state.roles.length,
        apiKeys: state.apiKeys.length,
        watches: state.watches.length,
        devices: state.devices.length,
        jobHistory: state.jobHistory.length,
        auditLog: state.auditLog.length,
      },
    },
  };
}

export interface BackupRestoreDrill {
  ok: boolean;
  checks: { label: string; ok: boolean; detail: string }[];
}

function prepareBackupRestore(payload: ValidatedBackupPayload): Pick<PersistedState, 'allowedUsers' | 'roles' | 'projects' | 'apiKeys' | 'settings' | 'watches' | 'devices' | 'jobHistory' | 'auditLog' | 'schedulerRunHistory' | 'userPrefs' | 'apiKeyUsage' | 'rootSessionVersion' | 'apiKeyBundleUsage' | 'deviceActivity' | 'testFlightSubscriptions' | 'rootMfa' | 'passkeys'> {
  return {
    allowedUsers: payload.allowedUsers.map((user) => ({ ...user, username: user.username.toLowerCase() })),
    roles: payload.roles.map((role) => ({ ...role, permissions: serializeBits(consolidatePermissionBits(upgradePermissionBits(parseBits(role.permissions)))) })),
    projects: [createDefaultProject()],
    apiKeys: payload.apiKeys.map((key) => {
      const { projectIds: _projectIds, ...portable } = key as ApiKeyRecord & { projectIds?: string[] };
      return { ...portable, pendingReveal: undefined };
    }),
    settings: payload.settings,
    watches: payload.watches.map((watch) => ({ ...watch, projectId: DEFAULT_PROJECT_ID, enabled: false })),
    devices: payload.devices.map(normalizeLoadedDevice),
    jobHistory: payload.jobHistory.slice(0, MAX_HISTORY).map((entry) => ({ ...entry, projectId: DEFAULT_PROJECT_ID })),
    auditLog: payload.auditLog.slice(0, MAX_AUDIT_LOG),
    schedulerRunHistory: payload.schedulerRunHistory.slice(0, MAX_LEGACY_SCHEDULER_RUNS).map((entry) => ({ ...entry, id: entry.id ?? randomUUID() })),
    userPrefs: payload.userPrefs,
    apiKeyUsage: payload.apiKeyUsage,
    rootSessionVersion: payload.rootSessionVersion,
    apiKeyBundleUsage: payload.apiKeyBundleUsage ?? {},
    deviceActivity: payload.deviceActivity?.slice(0, MAX_DEVICE_ACTIVITY) ?? [],
    testFlightSubscriptions: payload.testFlightSubscriptions.map(cloneTestFlightSubscription),
    rootMfa: payload.rootMfa,
    passkeys: payload.passkeys.map((credential) => ({ ...credential, transports: credential.transports ? [...credential.transports] : undefined })),
  };
}

function backupDatabaseCollections(
  payload: ValidatedBackupPayload,
  accounts: AccountCollections = { users: payload.allowedUsers, roles: payload.roles },
): StateCollectionReplacement[] {
  return [
    ...billingSnapshotCollections(payload.billing),
    ...identitySnapshotCollections(payload.identities),
    ...accountRepository.collectionReplacements(accounts),
    projectCollectionReplacement([createDefaultProject()]),
    { table: 'decrypt_quota_ledger', rows: payload.decryptQuotaLedger.map((entry) => ({ id: entry.jobId, payload: entry, updatedAt: entry.admittedAt })) },
  ];
}

type BackupRestoredFields = ReturnType<typeof prepareBackupRestore>;

function sameRecordsByKey<T>(left: T[], right: T[], keyOf: (record: T) => string): boolean {
  const sorted = (records: T[]) => [...records].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function sameCollectionPayloads(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) return false;
  return left.map(stableJson).sort().join('\n') === right.map(stableJson).sort().join('\n');
}

function sameApiKeyRecordsExceptUsage(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map<string, ApiKeyRecord>();
  const leftIds = new Set<string>();
  for (const record of right) {
    if (typeof record !== 'object' || record === null || Array.isArray(record) || typeof (record as ApiKeyRecord).id !== 'string') return false;
    const apiKey = record as ApiKeyRecord;
    if (rightById.has(apiKey.id)) return false;
    rightById.set(apiKey.id, apiKey);
  }
  return left.every((record) => {
    if (typeof record !== 'object' || record === null || Array.isArray(record) || typeof (record as ApiKeyRecord).id !== 'string') return false;
    const snapshotKey = record as ApiKeyRecord;
    if (leftIds.has(snapshotKey.id)) return false;
    leftIds.add(snapshotKey.id);
    const repositoryKey = rightById.get(snapshotKey.id);
    if (!repositoryKey) return false;
    return sameCollectionPayloads([withoutApiKeyUsage(snapshotKey)], [withoutApiKeyUsage(repositoryKey)]);
  });
}

function withoutApiKeyUsage(record: ApiKeyRecord): Omit<ApiKeyRecord, 'lastUsedAt' | 'lastUsedIp'> {
  const core = { ...record };
  delete core.lastUsedAt;
  delete core.lastUsedIp;
  return core;
}

function reconcileApiKeyUsage(snapshot: ApiKeyRecord[], repository: ApiKeyRecord[]): ApiKeyRecord[] | undefined {
  if (!sameApiKeyRecordsExceptUsage(snapshot, repository)) return undefined;
  const repositoryById = new Map(repository.map((record) => [record.id, record]));
  return snapshot.map((record) => {
    const persisted = repositoryById.get(record.id) as ApiKeyRecord;
    return { ...record, lastUsedAt: persisted.lastUsedAt, lastUsedIp: persisted.lastUsedIp };
  });
}

function reconcileSessionLastSeen(snapshot: unknown[], repository: ActiveSessionRecord[]): ActiveSessionRecord[] | undefined {
  if (snapshot.length !== repository.length) return undefined;
  const repositoryById = new Map<string, ActiveSessionRecord>();
  for (const record of repository) {
    if (repositoryById.has(record.id)) return undefined;
    repositoryById.set(record.id, record);
  }
  const snapshotIds = new Set<string>();
  const reconciled: ActiveSessionRecord[] = [];
  for (const value of snapshot) {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as ActiveSessionRecord).id !== 'string') return undefined;
    const record = value as ActiveSessionRecord;
    if (snapshotIds.has(record.id)) return undefined;
    snapshotIds.add(record.id);
    const persisted = repositoryById.get(record.id);
    if (!persisted || !sameCollectionPayloads([withoutSessionLastSeen(record)], [withoutSessionLastSeen(persisted)])) return undefined;
    reconciled.push({ ...record, lastSeenAt: persisted.lastSeenAt });
  }
  return reconciled;
}

function withoutSessionLastSeen(record: ActiveSessionRecord): Omit<ActiveSessionRecord, 'lastSeenAt'> {
  const core: Record<string, unknown> = { ...record };
  delete core.lastSeenAt;
  return core as Omit<ActiveSessionRecord, 'lastSeenAt'>;
}

function sameObjectEntries(left: object, right: object): boolean {
  const sortedEntries = (value: object) => Object.entries(value).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(sortedEntries(left)) === JSON.stringify(sortedEntries(right));
}

function restoredStateForPayload(payload: ValidatedBackupPayload, restored: BackupRestoredFields, baseState: PersistedState): PersistedState {
  const restoredState: PersistedState = { ...structuredClone(baseState), ...restored };
  if (payload.lastSchedulerRunAt) restoredState.lastSchedulerRunAt = payload.lastSchedulerRunAt;
  restoredState.apiKeyBundleUsage = payload.apiKeyBundleUsage ?? {};
  restoredState.apiKeyOutcomeUsage = {};
  restoredState.deviceActivity = payload.deviceActivity?.slice(0, MAX_DEVICE_ACTIVITY) ?? [];
  return restoredState;
}

function temporaryDatabaseRestoreCheck(payload: ValidatedBackupPayload, restored: BackupRestoredFields, additionalCollections: readonly StateCollectionReplacement[] = []): BackupRestoreDrillCheck {
  const temporaryStateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-backup-restore-'));
  const restoredState = restoredStateForPayload(payload, restored, defaultState());
  const options = {
    stateDir: temporaryStateDir,
    filename: 'restore-drill.sqlite',
    busyTimeoutMs: config.stateDbBusyTimeoutMs,
  };
  try {
    let database = openStateDatabase(options);
    try {
      database.writeState(restoredState, undefined, [...backupDatabaseCollections(payload, { users: restored.allowedUsers, roles: restored.roles }), ...additionalCollections]);
      database.integrityStatus();
    } finally {
      database.close();
    }

    database = openStateDatabase(options);
    try {
      database.integrityStatus();
      const persistedState = database.readState();
      if (!persistedState || JSON.stringify(persistedState) !== JSON.stringify(restoredState)) {
        return { label: 'Temporary SQLite restore', ok: false, detail: 'Restored state did not survive a database reopen' };
      }
      const normalized = normalizeLoadedState(migrate(asStateRecord(persistedState)));
      if (normalized.version !== state.version) {
        return { label: 'Temporary SQLite restore', ok: false, detail: `Restored state migrated to unsupported version ${normalized.version}` };
      }

      const accounts = createAccountRepository(database.db);
      if (
        !accounts.hasNormalizedUsernameRowIds() ||
        !sameRecordsByKey(accounts.listUsers(), restored.allowedUsers, (user) => user.username) ||
        !sameRecordsByKey(accounts.listRoles(), restored.roles, (role) => role.id)
      ) {
        return { label: 'Temporary SQLite restore', ok: false, detail: 'Account and role records did not survive a database reopen' };
      }

      const billingRecords = readStateCollection(database.db, 'billing_records');
      const billingSnapshot = billingRecords.find((record) => typeof record === 'object' && record !== null && (record as { kind?: string }).kind === 'snapshot') as { value?: unknown } | undefined;
      const expectedBillingRecord = billingSnapshotCollections(payload.billing).find((replacement) => replacement.table === 'billing_records')?.rows[0]?.payload as { value?: typeof payload.billing } | undefined;
      const expectedBilling = expectedBillingRecord?.value;
      if (!expectedBilling || JSON.stringify(billingSnapshot?.value) !== JSON.stringify(expectedBilling)) {
        return { label: 'Temporary SQLite restore', ok: false, detail: 'Billing records did not survive a database reopen' };
      }
      const billingRepository = createBillingRepository(database.db);
      const quotaRows = database.db.query('SELECT job_id, owner_id, admitted_at, state FROM decrypt_quota_ledger ORDER BY job_id').all() as Array<{ job_id: string; owner_id: string; admitted_at: number; state: string }>;
      const expectedQuotaByJobId = new Map(payload.decryptQuotaLedger.map((entry) => [entry.jobId, entry]));
      if (quotaRows.length !== expectedQuotaByJobId.size || quotaRows.some((row) => {
        const expected = expectedQuotaByJobId.get(row.job_id);
        return !expected || row.owner_id !== expected.ownerId || row.admitted_at !== expected.admittedAt || row.state !== expected.state;
      })) return { label: 'Temporary SQLite restore', ok: false, detail: 'Decrypt quota ledger did not survive a database reopen' };
      const normalizedEntitlementHistory = expectedBilling.entitlementHistory ?? [];
      if (
        !sameRecordsByKey(billingRepository.listCustomers(), expectedBilling.customers, (record) => `${record.provider}:${record.customerId}`) ||
        !sameRecordsByKey(billingRepository.listSubscriptions(), expectedBilling.subscriptions, (record) => `${record.provider}:${record.subscriptionId}`) ||
        !sameRecordsByKey(billingRepository.listCheckouts(), expectedBilling.cryptoCheckouts, (record) => `${record.provider}:${record.checkoutId}`) ||
        !sameRecordsByKey(billingRepository.listCharges(), expectedBilling.cryptoCharges, (record) => `${record.provider}:${record.chargeId}`) ||
        !sameRecordsByKey(billingRepository.listProcessedEvents(), expectedBilling.processedEvents, (record) => `${record.provider}:${record.eventId}`) ||
        !sameRecordsByKey(billingRepository.listEntitlementHistory(), normalizedEntitlementHistory, (record) => record.id)
      ) {
        return { label: 'Temporary SQLite restore', ok: false, detail: 'Normalized billing records did not survive a database reopen' };
      }

      const identities = new Map<string, unknown>();
      for (const record of readStateCollection(database.db, 'auth_profiles')) {
        if (typeof record !== 'object' || record === null) continue;
        const profile = (record as { value?: { userId?: unknown } }).value;
        if (typeof profile?.userId === 'string') identities.set(profile.userId, profile);
      }
      if (identities.size !== payload.identities.profiles.length || payload.identities.profiles.some((profile) => JSON.stringify(identities.get(profile.userId)) !== JSON.stringify(profile))) {
        return { label: 'Temporary SQLite restore', ok: false, detail: 'Identity records did not survive a database reopen' };
      }

      return { label: 'Temporary SQLite restore', ok: true, detail: `SQLite schema ${database.schemaVersion} reopened with state, accounts, roles, billing, and identity records intact` };
    } finally {
      database.close();
    }
  } catch (error) {
    return { label: 'Temporary SQLite restore', ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(temporaryStateDir, { recursive: true, force: true });
  }
}

function backupRestoreChecks(payload: ValidatedBackupPayload, restored: BackupRestoredFields, additionalCollections: readonly StateCollectionReplacement[] = []): BackupRestoreDrillCheck[] {
  const roleIds = new Set(payload.roles.map((role) => role.id));
  const userIds = new Set(payload.allowedUsers.map((user) => user.username.toLowerCase()));
  const watchIds = new Set(payload.watches.map((watch) => watch.id));
  const deviceIds = new Set(payload.devices.map((device) => device.id));
  const checks = [
    { label: 'Unique role IDs', ok: roleIds.size === payload.roles.length, detail: `${roleIds.size} roles` },
    { label: 'Default role', ok: payload.roles.filter((role) => role.isDefault).length <= 1, detail: `${payload.roles.filter((role) => role.isDefault).length} default roles` },
    { label: 'User role assignments', ok: payload.allowedUsers.every((user) => user.roleIds.every((id) => roleIds.has(id))), detail: `${payload.allowedUsers.length} users checked` },
    { label: 'API key owners', ok: payload.apiKeys.every((key) => key.ownerId === 'root' || userIds.has(key.ownerId.toLowerCase())), detail: `${payload.apiKeys.length} keys checked` },
    { label: 'Unique watch IDs', ok: watchIds.size === payload.watches.length, detail: `${watchIds.size} watches` },
    { label: 'Unique device IDs', ok: deviceIds.size === payload.devices.length, detail: `${deviceIds.size} devices` },
    { label: 'Shared data scope', ok: restored.projects.length === 1 && restored.projects[0]?.id === DEFAULT_PROJECT_ID, detail: 'one shared account scope' },
    { label: 'Restore transformation', ok: restored.roles.length === payload.roles.length && restored.apiKeys.every((key) => key.pendingReveal === undefined), detail: `${restored.apiKeys.length} keys normalized` },
    { label: 'Serializable restored state', ok: (() => { try { JSON.stringify(restored); return true; } catch { return false; } })(), detail: 'normalized state checked' },
    temporaryDatabaseRestoreCheck(payload, restored, additionalCollections),
  ];
  return checks;
}

export function drillBackupRestore(raw: unknown): { ok: true; drill: BackupRestoreDrill } | { ok: false; error: string } {
  const validated = validateBackupPayload(raw);
  if (!validated.ok) return validated;
  const { payload } = validated;
  const restored = prepareBackupRestore(payload);
  const checks = backupRestoreChecks(payload, restored);
  return { ok: true, drill: { ok: checks.every((check) => check.ok), checks } };
}

export interface ImportBackupResult {
  ok: boolean;
  error?: string;
}

export function importBackup(raw: unknown, actor: string): ImportBackupResult {
  const validated = validateBackupPayload(raw);
  if (!validated.ok) return { ok: false, error: validated.error };
  const b = validated.payload;
  const restored = prepareBackupRestore(b);
  const artifactCollections = artifactProjectLinksReplacement();
  const restoreCollections = [...backupDatabaseCollections(b, { users: restored.allowedUsers, roles: restored.roles }), ...artifactCollections];
  const checks = backupRestoreChecks(b, restored, artifactCollections);
  if (checks.some((check) => !check.ok)) {
    return { ok: false, error: `backup restore test failed: ${checks.filter((check) => !check.ok).map((check) => check.label).join(', ')}` };
  }

  const restoredState = restoredStateForPayload(b, restored, state);
  const importedAt = Date.now();
  restoredState.auditLog = [{
    id: randomUUID(),
    ts: importedAt,
    actor,
    action: 'state.import' as const,
    target: 'server state',
    detail: `restored from backup exported ${b.exportedAt ? new Date(b.exportedAt).toISOString() : 'unknown time'}`,
  }, ...restoredState.auditLog].slice(0, MAX_AUDIT_LOG);
  const previousBilling = exportBillingSnapshot();
  const previousIdentities = exportIdentitySnapshot();
  try {
    replaceBillingSnapshot(b.billing, { persist: false });
    replaceIdentitySnapshot(b.identities, { persist: false });
    stateDatabase.writeState(restoredState, undefined, restoreCollections);
  } catch (error) {
    replaceBillingSnapshot(previousBilling, { persist: false });
    replaceIdentitySnapshot(previousIdentities, { persist: false });
    return { ok: false, error: `backup restore could not be committed: ${error instanceof Error ? error.message : String(error)}` };
  }

  Object.assign(state, restoredState);
  syncLegacyStateMirror('state', () => writeStateMirror(statePath, state));
  syncLegacyStateMirror('billing', writeBillingSnapshotMirror);
  syncLegacyStateMirror('identity', writeIdentitySnapshotMirror);
  return { ok: true };
}
