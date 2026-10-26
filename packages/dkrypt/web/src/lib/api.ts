import { markLoggedOut, type Role } from '#lib/session.svelte';
import { ApiError, apiErrorMessage } from '#lib/apiErrors.js';
import { rateLimitState } from '#lib/rateLimit.svelte';
import { showToast } from '#lib/ui.svelte';
import { serverStateCache, type ServerQueryListener } from '#lib/serverStateCache.svelte';
import { isUnauthenticatedResponse } from '#lib/apiAuthResponse.js';
import { parseApiResponse } from '#lib/apiResponse.js';
import { saveOfflineAppStoreAccountRequest } from '#lib/offlineAppStoreAccountSave.js';
import { authenticateOfflineAppStoreAccountRequest } from '#lib/offlineAppStoreAuthentication.js';
import { retrieveOfflineAppStoreCredentialRequest } from '#lib/offlineAppStoreCredentialRetrieval.js';

export type { Role };
export { rateLimitState, type RateLimitInfo } from '#lib/rateLimit.svelte';

function captureRateLimitHeaders(bucket: string | undefined, res: Response): void {
  if (!bucket) return;
  const limit = res.headers.get('X-RateLimit-Limit');
  const remaining = res.headers.get('X-RateLimit-Remaining');
  const reset = res.headers.get('X-RateLimit-Reset');
  if (limit === null || remaining === null || reset === null) return;
  rateLimitState[bucket] = { limit: Number(limit), remaining: Number(remaining), resetAt: Number(reset) * 1000 };
}

async function request(path: string, opts: RequestInit = {}, bucket?: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    });
  } catch {
    if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('request aborted');
    showToast("Couldn't reach the server - check your connection", 'error', { id: 'network-error', track: false });
    throw new Error('network error');
  }
  captureRateLimitHeaders(bucket, res);
  if (await isUnauthenticatedResponse(res)) {
    markLoggedOut();
    throw new Error('unauthorized');
  }
  return res;
}

export async function apiJson<T>(path: string, opts?: RequestInit, bucket?: string): Promise<T> {
  const res = await request(path, opts, bucket);
  const data = await parseApiResponse(res);
  if (!res.ok) {
    const payloadCode = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as { code?: unknown }).code : undefined;
    const code = typeof payloadCode === 'string' ? payloadCode : undefined;
    throw new ApiError(apiErrorMessage(data, res.status), res.status, code);
  }
  return data as T;
}

function invalidateQueriesForMutation(path: string): void {
  const endpoint = path.split('?', 1)[0];
  if (endpoint === '/v1/dashboard/backup/import') {
    serverStateCache.clear();
    serverStateCache.invalidateAll();
    return;
  }
  if (endpoint === '/v1/auth/privacy/delete') {
    serverStateCache.clear();
    return;
  }

  const prefixes = new Set<string>();
  if (endpoint.startsWith('/v1/dashboard/jobs') || endpoint === '/v1/dashboard/decrypt' || endpoint === '/v1/dashboard/testflight/decrypt') {
    prefixes.add('/v1/dashboard/jobs');
    prefixes.add('/v1/dashboard/artifacts');
    prefixes.add('/v1/dashboard/overview');
  }
  if (endpoint.startsWith('/v1/dashboard/devices')) {
    prefixes.add('/v1/dashboard/devices');
    prefixes.add('/v1/dashboard/overview');
  }
  if (endpoint.startsWith('/v1/dashboard/artifacts')) {
    prefixes.add('/v1/dashboard/artifacts');
    prefixes.add('/v1/dashboard/overview');
  }
  if (endpoint.startsWith('/v1/dashboard/testflight')) {
    prefixes.add('/v1/dashboard/testflight');
    prefixes.add('/v1/dashboard/jobs');
    prefixes.add('/v1/dashboard/artifacts');
    prefixes.add('/v1/dashboard/overview');
  }
  if (endpoint.startsWith('/v1/billing/')) prefixes.add('/v1/billing');
  for (const prefix of prefixes) serverStateCache.invalidatePrefix(prefix);
}

export async function apiAction<T = Record<string, unknown>>(
  path: string,
  opts: RequestInit,
  successMsg?: string,
  suppressErrorToast = false,
): Promise<{ ok: boolean; data: T }> {
  const method = String(opts.method ?? 'GET').toUpperCase();

  const res = await request(path, opts);
  let data = {} as T;
  try {
    data = (await res.json()) as T;
  } catch {}
  if (!res.ok) {
    if (!suppressErrorToast) showToast((data as { error?: string }).error ?? `Request failed (${res.status})`, 'error');
    return { ok: false, data };
  }
  if (method !== 'GET') invalidateQueriesForMutation(path);
  if (successMsg) showToast(successMsg, 'success');
  return { ok: true, data };
}

export interface JobTestFlightSummary {
  appId: number;
  buildId: number;
  version: string;
  buildNumber: string;
}

export interface JobQueueSummary {
  position: number;
  total: number;
  predictedStartMs?: number;
  predictedCompletionMs?: number;
}

export interface JobSummary {
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: JobTestFlightSummary;
  versionLabel?: string;
  minimumOsVersion?: string;
  source: 'manual' | 'scheduler';
  channel?: 'appstore' | 'testflight';
  queuedBy?: string;
  queuedByDisplayName?: string;
  priority?: number;
  deviceId?: string;
  preferredDeviceId?: string;
  transport?: 'usb' | 'wifi';
  attempt?: number;
  retryCount?: number;
  executionPath?: 'appstore_offline' | 'device' | 'device_fallback';
  offlineAttemptedAt?: number;
  offlineFailureReason?: string;
  deadlineAt?: string;
  deadlineExceeded?: boolean;
  failureClass?: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: string;
  warnings?: string[];
  error?: string;
  artifactId?: string;
  artifactUrl?: string;
  cacheHit?: boolean;
  sizeBytes?: number;
  sha256?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  queue?: JobQueueSummary;
  queueReason?: string;
  statusUrl: string;
}

export interface ActiveJob {
  id: string;
  bundleId: string;
  source: 'manual' | 'scheduler';
  status: 'queued' | 'running';
  pausedAt?: number;
  progress: string;
  versionLabel?: string;
  testflight?: JobTestFlightSummary;
  queuedBy?: string;
  queuedByDisplayName?: string;
  priority?: number;
  createdAt: number;
  queue?: JobQueueSummary;
  deviceId?: string;
  preferredDeviceId?: string;
  transport?: 'usb' | 'wifi';
  warnings?: string[];
  attempt?: number;
  retryCount?: number;
  deadlineAt?: number;
  deadlineExceeded?: boolean;
  executionPath?: 'appstore_offline' | 'device' | 'device_fallback';
  offlineAttemptedAt?: number;
  offlineFailureReason?: string;
  failureClass?: string;
  queueReason?: string;
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

export interface MaintenanceStatus {
  active: boolean;
  manual: boolean;
  auto: boolean;
  reason?: string;
}

interface DeviceTransportStatus {
  transportState?: 'discovered' | 'pairing' | 'connecting' | 'ready' | 'degraded' | 'recovering' | 'offline' | 'unsupported';
  lastSeenAt?: number;
  agentHeartbeatAt?: number;
  recoveryState?: 'stable' | 'recovering' | 'degraded' | 'offline';
}

export interface DeviceRecord extends DeviceTransportStatus {
  id: string;
  name: string;
  transport: 'wifi' | 'usb';
  host?: string;
  port: number;
  user: string;
  udid?: string;
  usbmuxNetwork?: boolean;
  productType?: string;
  setupRequired?: boolean;
  iosVersion?: string;
  toolchain?: string;
  notes?: string;
  transportCapabilities?: string[];
  enabled: boolean;
  draining?: boolean;
  isPrimary?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DevicePreflight {
  device: DeviceRecord;
  health: DeviceHealth;
  bridge?: TestFlightBridgeDiagnostics;
  ready: boolean;
  checks: Array<{ label: string; ok: boolean; detail?: string }>;
}

export interface DeviceDiscoveryCandidate {
  discoveryId: string;
  name: string;
  transport: 'wifi' | 'usb';
  host?: string;
  port: number;
  user: string;
  udid?: string;
  usbmuxNetwork?: boolean;
  productType?: string;
  productVersion?: string;
  source: 'usb' | 'wifi';
}

export interface DeviceDiscoveryResult {
  devices: DeviceDiscoveryCandidate[];
  scannedNetworks: string[];
  warnings: string[];
}

export interface DeviceSetupStep {
  id: string;
  label: string;
  status: 'ready' | 'attention' | 'unavailable';
  detail?: string;
}

export interface DeviceSetupResult {
  info: {
    name: string;
    model?: string;
    productType?: string;
    productVersion?: string;
    architecture?: string;
    serialNumber?: string;
  };
  steps: DeviceSetupStep[];
  ready: boolean;
}

export interface DeviceSetupOperation {
  id: string;
  status: 'queued' | 'running' | 'interrupted' | 'complete' | 'failed';
  stage: string;
  stages: Array<{ id: string; label: string; at: number; status: 'running' | 'complete' | 'failed' }>;
  deviceId?: string;
  ready?: boolean;
  setup?: DeviceSetupResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface OverviewPayload {
  settings: DashboardSettings;
  devices: DeviceRecord[];
  statusDevices?: Array<{ id: string; name: string; enabled: boolean; draining?: boolean; isPrimary?: boolean; reachable?: boolean }>;
  deviceStatus?: { configured: number; enabled: number; online: number; ready: number; attention: number; checking: number; unavailable: number; freshUntil?: number };
  disk?: DiskUsage;
  isPaidPlan?: boolean;
  maintenance?: MaintenanceStatus;
  activeJobs: ActiveJob[];
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
  bundleId: string;
  externalVersionId?: string;
  testflight?: { appId: number; build: TFBuild };
  versionLabel?: string;
  minimumOsVersion?: string;
  queuedBy?: string;
  requester?: { username?: string; displayName: string; avatarUrl?: string };
  status: 'done' | 'failed';
  warnings?: string[];
  error?: string;
  queueReason?: string;
  artifactId?: string;
  sha256?: string;
  sizeBytes?: number;
  source: 'manual' | 'scheduler';
  createdAt: number;
  startedAt?: number;
  finishedAt: number;
  deviceId?: string;
  transport?: 'usb' | 'wifi';
  ipaMetadata?: IpaMetadata;
  ipaInfoPlist?: Record<string, unknown>;
  downloadUrl?: string;
  fileAvailable: boolean;
  attempt?: number;
  retryCount?: number;
  cacheHit?: boolean;
  deadlineAt?: number;
  deadlineExceeded?: boolean;
  failureClass?: string;
}

export interface CursorPage {
  nextCursor?: string;
}

export interface ArtifactRecord {
  id: string;
  bundleId: string;
  key: string;
  channel: 'appstore' | 'testflight';
  externalVersionId?: string;
  testflightBuildId?: number;
  versionLabel?: string;
  buildNumber?: string;
  fileSizeBytes: number;
  sha256: string;
  createdAt: string;
  lastAccessedAt: string;
  pinnedAt?: string;
  archivedAt?: string;
  pinnedStateChangedAt?: number;
  archivedStateChangedAt?: number;
  accessCount: number;
  fileUrl: string;
  sourceJobId?: string;
  warnings?: string[];
}

export interface DashboardQuickSearchResult {
  kind: 'app' | 'job' | 'artifact' | 'device' | 'user' | 'settings';
  id: string;
  title: string;
  subtitle?: string;
}

export function fetchDashboardQuickSearch(query: string): Promise<{ results: DashboardQuickSearchResult[] }> {
  const params = new URLSearchParams({ q: query });
  return apiJson(`/v1/dashboard/quick-search?${params}`);
}

export interface DashboardApiChanges {
  lifecycle: {
    currentVersion: string;
    policy: { compatibility: string; noticePeriodDays: number; noticeHeaders: string[] };
    versions: Array<{ id: string; status: string; documentation: string }>;
    deprecations: Array<{ method: string; path: string; deprecatedAt: number; sunsetAt: string; migrationUrl: string }>;
  };
  operations: Record<string, string[]>;
}

export function fetchDashboardApiChanges(): Promise<DashboardApiChanges> {
  return apiJson('/v1/dashboard/api-changes');
}

export interface DashboardIncidentEvent {
  id: string;
  at: number;
  kind: 'device' | 'job' | 'watch' | 'deployment';
  title: string;
  detail?: string;
  jobId?: string;
  watchId?: string;
  deviceId?: string;
  deploymentId?: string;
  correlationId?: string;
}

export function fetchDashboardIncidents(): Promise<{ events: DashboardIncidentEvent[]; truncated: boolean }> {
  return apiJson('/v1/dashboard/incidents');
}

export interface IncidentStateAtTime {
  at: number;
  coverage: 'recorded' | 'incomplete';
  coverageStartAt?: number;
  incidents: Array<{ id: string; kind: 'job' | 'watch' | 'device' | 'deployment'; title: string; sourceId: string; status: 'open' | 'in_progress' | 'snoozed' | 'resolved'; recovered: boolean }>;
}

export function fetchIncidentStateAtTime(at: number): Promise<IncidentStateAtTime> {
  return apiJson(`/v1/dashboard/incidents/state-at?at=${Math.floor(at)}`);
}

export function fetchDashboardArtifact(id: string): Promise<ArtifactRecord> {
  return apiJson(`/v1/dashboard/artifacts/${encodeURIComponent(id)}`);
}

export interface ArtifactPackageEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
}

export interface ArtifactPackageContentsPage {
  entries: ArtifactPackageEntry[];
  total: number;
  nextOffset?: number;
}

export function fetchDashboardArtifactContents(id: string, options: { q?: string; offset?: number; limit?: number } = {}): Promise<ArtifactPackageContentsPage> {
  const params = new URLSearchParams();
  if (options.q) params.set('q', options.q);
  if (options.offset) params.set('offset', String(options.offset));
  if (options.limit) params.set('limit', String(options.limit));
  return apiJson(`/v1/dashboard/artifacts/${encodeURIComponent(id)}/contents?${params}`);
}

export interface ArtifactStructureComparison {
  before: { id: string; bundleId: string; versionLabel?: string; fileSizeBytes: number };
  after: { id: string; bundleId: string; versionLabel?: string; fileSizeBytes: number };
  counts: { added: number; removed: number; changed: number; unchanged: number };
  added: string[];
  removed: string[];
  changed: Array<{ path: string; beforeBytes: number; afterBytes: number }>;
  truncated: boolean;
}

export function compareDashboardArtifacts(ids: [string, string]): Promise<ArtifactStructureComparison> {
  return apiJson('/v1/dashboard/artifacts/compare', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export interface JobTimelineEvent {
  at: number;
  label: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  durationMs?: number;
}

export interface JobTimeline {
  id: string;
  correlationId: string;
  bundleId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  executionStage?: 'preparing' | 'installing' | 'decrypting' | 'offline_download' | 'offline_decrypting' | 'finalizing';
  executionPath?: 'appstore_offline' | 'device' | 'device_fallback';
  offlineAttemptedAt?: number;
  offlineAttemptDurationMs?: number;
  offlineDeviceFallbackStartedAt?: number;
  deviceFallbackDurationMs?: number;
  offlineFailureReason?: string;
  quotaReceipt?: { state: 'reserved' | 'consumed'; admittedAt: number };
  testflight?: { appId: number; build: { id: number; cfBundleShortVersion: string; cfBundleVersion: string; bundleId: string } };
  dependencies?: Array<{ id: string; label: string; state: 'ready' | 'active' | 'waiting' | 'failed' | 'blocked' | 'not_applicable' | 'unknown'; detail: string }>;
  events: JobTimelineEvent[];
  warnings?: string[];
  queueReason?: string;
  guidance?: { category: string; title: string; action: string; retryRecommended: boolean };
  versionLabel?: string;
  deviceId?: string;
  transport?: 'usb' | 'wifi';
  sizeBytes?: number;
  ipaMetadata?: IpaMetadata;
  ipaInfoPlist?: Record<string, unknown>;
}

export interface JobResolutionNoticePreview {
  requester: string;
  emailAvailable: boolean;
  message: string;
  notice?: { sentAt: number; sentBy: string; emailStatus: 'pending' | 'sent' | 'unavailable' | 'failed' };
}

export interface DecryptPreflightDevice {
  id: string;
  name: string;
  isPrimary: boolean;
  ready: boolean;
  checking?: boolean;
  blockers: string[];
  warnings?: string[];
  readiness?: DeviceReadiness;
  reachable?: boolean;
  storageFreeBytes?: number;
  batteryPercent?: number;
}

export interface DecryptPreflight {
  bundleId: string;
  versionLabel?: string;
  testflight: boolean;
  installSizeBytes?: number;
  estimatedDurationMs?: number;
  queueLength: number;
  canQueue: boolean;
  quota?: { limit: number | null; used: number; remaining: number | null; nextAvailableAt?: number; legacy?: boolean; apiRatePerMinute?: number };
  devices: DecryptPreflightDevice[];
}

export interface BulkJobPreviewItem {
  id: string;
  bundleId: string;
  versionLabel?: string;
  status: 'done' | 'failed';
  action: 'queue' | 'join-existing';
  reason?: string;
  estimatedDurationMs?: number;
}

export interface BulkJobPreview {
  requested: number;
  eligible: number;
  projectedQueueAdds: number;
  estimatedDurationMs: number;
  previousSizeBytes: number;
  items: BulkJobPreviewItem[];
}

export interface DashboardNotification {
  id: string;
  title: string;
  message: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  createdAt: number;
  firstOccurredAt?: number;
  lastOccurredAt?: number;
  occurrenceCount?: number;
  readAt?: number;
  jobId?: string;
  deviceId?: string;
  deploymentId?: string;
  href?: string;
}

export interface NotificationResponse {
  notifications: DashboardNotification[];
  unread: number;
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

export interface ApiKeyRecord {
  id: string;
  name: string;
  ownerId: string;
  ownerDisplayName?: string;
  ownerUsername?: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
  approvedAt?: number;
  lastUsedAt?: number;
  lastUsedIp?: string;
  expiresAt?: number;
  hasUnrevealedSecret: boolean;
  allowedBundleIds?: string[];
  dailyLimit?: number;
  maxConcurrent?: number;
  allowTestFlight?: boolean;
  priority?: number;
  previousKeyValidUntil?: number;
}

export interface AllowedUser {
  username: string;
  accountUsername?: string;
  displayName?: string;
  avatarUrl?: string;
  roleIds: string[];
  billingEntitlements?: {
    planId: BillingPlanId;
    decrypt: boolean;
    api: boolean;
    priority: number;
  };
  addedAt: number;
  lastActiveAt?: number;
  priority?: number;
  activity?: {
    manualJobs: number;
    completedJobs: number;
    failedJobs: number;
    lastJobAt?: number;
    apiKeys: number;
    apiRequests30d: number;
  };
}

export type BillingPlanId = 'regular' | 'priority' | 'api' | 'priority_api' | 'access' | 'standard' | 'plus' | 'developer' | 'unlimited' | 'unlimited_priority';

export interface AuditLogEntry {
  id: string;
  ts: number;
  actor: string;
  actorDisplayName?: string;
  action:
    | 'user.add'
    | 'user.update'
    | 'user.remove'
    | 'state.import'
    | 'settings.update'
    | 'watch.add'
    | 'watch.update'
    | 'watch.remove'
    | 'device.add'
    | 'device.update'
    | 'device.remove'
    | 'role.add'
    | 'role.update'
    | 'role.remove'
    | 'auth.session.new_context'
    | 'artifact.pin'
    | 'artifact.unpin'
    | 'artifact.archive'
    | 'artifact.restore';
  target: string;
  detail?: string;
  changes?: Array<{ field: string; before: string | number | boolean | null; after: string | number | boolean | null }>;
}

export interface LogEntry {
  id: string;
  ts: number;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface AppStoreSearchResult {
  bundleId: string;
  trackId: number;
  trackName: string;
  version: string;
  sellerName: string;
  artworkUrl: string;
  price: number;
  category?: string;
  minimumOsVersion?: string;
  testflight?: {
    appId: number;
    devices: Array<{ id: string; name: string; verifiedAt?: number }>;
    lastVerifiedAt: number;
  };
}

export type TestFlightSubscriptionStatus = 'pending' | 'approved' | 'denied' | 'withdrawn';
export type TestFlightSubscriptionDeviceStatus = 'pending' | 'syncing' | 'active' | 'unavailable' | 'unsupported' | 'error' | 'unsubscribed';

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
  requestedByDisplayName?: string;
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

export interface TestFlightCatalogApp {
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

export interface AppCatalogEntry {
  bundleId: string;
  displayName: string;
  displayNameLanguage?: 'en';
  iconUrl?: string;
  trackId?: number;
  sellerName?: string;
  category?: string;
  description?: string;
  screenshots?: string[];
  releaseNotes?: string;
  price?: number;
  metadataFetchedAt?: number;
  updatedAt: number;
}

export function fetchOverview(): Promise<OverviewPayload> {
  return apiJson('/v1/dashboard/overview');
}

export interface DeviceHealth extends DeviceTransportStatus {
  reachable: boolean;
  refreshing?: boolean;
  transport?: 'usb' | 'wifi';
  capabilities?: string[];
  error?: string;
  jailbreakAvailable?: boolean;
  testFlightRunning?: boolean;
  testFlightBridgeReachable?: boolean;
  darkEnabled?: boolean;
  screenIsOn?: boolean;
  backlightState?: number;
  batteryPercent?: number;
  batteryCharging?: boolean;
  batteryTemperatureC?: number;
  batteryCycleCount?: number;
  batteryHealthPercent?: number;
  batteryDesignCapacityMah?: number;
  batteryMaxCapacityMah?: number;
  storageTotalBytes?: number;
  storageUsedBytes?: number;
  storageFreeBytes?: number;
  storageUsedPercent?: number;
  networkConnected?: boolean;
  internetAccess?: boolean;
  networkIpAddress?: string;
  networkInterface?: string;
  bridgeHeartbeats?: Partial<Record<'springboard' | 'testflight' | 'appstore', { bridgeVersion?: string; channel?: string; process?: string; at?: number }>>;
  subsystems?: Partial<Record<'usb' | 'mux' | 'agent' | 'jailbreak' | 'appStore' | 'testFlight' | 'sshTunnel' | 'storage' | 'battery' | 'thermal', 'ready' | 'idle' | 'degraded' | 'offline' | 'unsupported' | 'unknown'>>;
  subsystemDetails?: Partial<Record<'usb' | 'mux' | 'agent' | 'jailbreak' | 'appStore' | 'testFlight' | 'sshTunnel' | 'storage' | 'battery' | 'thermal', {
    state: 'ready' | 'idle' | 'degraded' | 'offline' | 'unsupported' | 'unknown';
    lastChangedAt?: number;
    reason?: string;
  }>>;
  readiness?: DeviceReadiness;
  checkedAt: number;
}

export interface DeviceReadiness {
  score: number;
  state: 'ready' | 'caution' | 'blocked';
  reasons: string[];
}

export interface DeviceActivityEntry {
  id: string;
  ts: number;
  deviceId: string;
  kind: 'health' | 'bridge' | 'job';
  message: string;
  bundleId?: string;
}

export function fetchDeviceHealth(deviceId: string, force = false): Promise<DeviceHealth> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/health${force ? '?force=true' : ''}`);
}

export function fetchDevicePreflight(deviceId: string): Promise<DevicePreflight> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/preflight`, undefined, 'external');
}

export function fetchDeviceInventory(deviceId: string): Promise<{ deviceId: string; bundles: string[] }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/inventory`, undefined, 'external');
}

export interface HourlyHealthBucket {
  hourStart: number;
  reachablePercent: number | null;
  transitions: number;
}

export function fetchDeviceHealthHistory(deviceId: string, hours = 24): Promise<{ buckets: HourlyHealthBucket[]; uptimePercent: number | null }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/health-history?hours=${hours}`);
}

export function fetchDeviceActivity(deviceId: string, cursorOrLimit: string | number | undefined = undefined, limit = 12): Promise<{ activity: DeviceActivityEntry[]; total: number } & CursorPage> {
  const resolvedLimit = typeof cursorOrLimit === 'number' ? cursorOrLimit : limit;
  const cursorQuery = typeof cursorOrLimit === 'string' && cursorOrLimit ? `&cursor=${encodeURIComponent(cursorOrLimit)}` : '';
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/activity?limit=${resolvedLimit}${cursorQuery}`);
}

export interface HourlyBatteryBucket {
  hourStart: number;
  batteryPercent: number | null;
}

export function fetchDeviceBatteryHistory(deviceId: string, hours = 24): Promise<{ buckets: HourlyBatteryBucket[] }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/battery-history?hours=${hours}`);
}

export interface HourlyTemperatureBucket {
  hourStart: number;
  batteryTemperatureC: number | null;
}

export function fetchDeviceTemperatureHistory(deviceId: string, hours = 24): Promise<{ buckets: HourlyTemperatureBucket[] }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/temperature-history?hours=${hours}`);
}

export interface HourlyStorageBucket {
  hourStart: number;
  storageUsedPercent: number | null;
}

export function fetchDeviceStorageHistory(deviceId: string, hours = 24): Promise<{ buckets: HourlyStorageBucket[] }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/storage-history?hours=${hours}`);
}

export function fetchDevices(options?: RequestInit): Promise<{ devices: DeviceRecord[] }> {
  return apiJson('/v1/dashboard/devices', options);
}

export function discoverDevices(): Promise<DeviceDiscoveryResult> {
  return apiJson('/v1/dashboard/devices/discover');
}

export function setupDevice(
  connection: Pick<DeviceDiscoveryCandidate, 'transport' | 'host' | 'port' | 'user' | 'udid' | 'usbmuxNetwork' | 'productType'>,
  profile?: { name?: string; existingId?: string; iosVersion?: string; toolchain?: string; notes?: string },
): Promise<{ ok: boolean; data: { device: DeviceRecord; setup: DeviceSetupResult } }> {
  return apiAction('/v1/dashboard/devices/setup', { method: 'POST', body: JSON.stringify({ ...connection, ...profile }) });
}

export function startDeviceSetupOperation(
  connection: Pick<DeviceDiscoveryCandidate, 'transport' | 'host' | 'port' | 'user' | 'udid' | 'usbmuxNetwork' | 'productType'>,
  profile?: { name?: string; existingId?: string; iosVersion?: string; toolchain?: string; notes?: string },
): Promise<{ ok: boolean; data: { operation: DeviceSetupOperation; error?: string } }> {
  return apiAction('/v1/dashboard/devices/setup-operations', { method: 'POST', body: JSON.stringify({ ...connection, ...profile }) });
}

export function fetchDeviceSetupOperations(): Promise<{ operations: DeviceSetupOperation[] }> {
  return apiJson('/v1/dashboard/devices/setup-operations');
}

export function fetchDeviceSetupOperation(id: string): Promise<{ operation: DeviceSetupOperation }> {
  return apiJson(`/v1/dashboard/devices/setup-operations/${encodeURIComponent(id)}`);
}

export function resumeDeviceSetupOperation(id: string): Promise<{ ok: boolean; data: { operation: DeviceSetupOperation; error?: string } }> {
  return apiAction(`/v1/dashboard/devices/setup-operations/${encodeURIComponent(id)}/resume`, { method: 'POST' });
}

export function createDevice(connection: Pick<DeviceRecord, 'name' | 'transport' | 'host' | 'port' | 'user' | 'udid' | 'usbmuxNetwork' | 'productType'>): Promise<{ ok: boolean; data: DeviceRecord }> {
  return apiAction('/v1/dashboard/devices', { method: 'POST', body: JSON.stringify(connection) }, 'Device added');
}

export function updateDevice(id: string, patch: Partial<Pick<DeviceRecord, 'name' | 'transport' | 'host' | 'port' | 'user' | 'udid' | 'usbmuxNetwork' | 'productType' | 'iosVersion' | 'toolchain' | 'notes' | 'enabled' | 'isPrimary'>> & { expectedUpdatedAt?: number }): Promise<{ ok: boolean; data: DeviceRecord }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Device updated');
}

export async function fetchDeviceDisableImpact(id: string): Promise<{ queuedJobCount: number; runningJobCount: number }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(id)}/disable-impact`);
}

export function drainDevice(id: string): Promise<{ ok: boolean; data: DeviceRecord }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}/drain`, { method: 'POST' }, 'Device draining');
}

export function deleteDevice(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Device removed');
}

export function setDeviceDarkMode(id: string, enabled: boolean): Promise<{ ok: boolean; data: DeviceHealth }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}/dark-mode`, { method: 'PUT', body: JSON.stringify({ enabled }) }, enabled ? 'Display dark mode enabled' : 'Display dark mode disabled');
}

export function runBridgeAction(id: string, action: 'open-testflight' | 'open-appstore' | 'screen-status'): Promise<{ ok: boolean; data: { result: Record<string, unknown> } }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}/bridge-action`, { method: 'POST', body: JSON.stringify({ action }) }, 'Bridge action completed');
}

export function recoverDevice(id: string): Promise<{ ok: boolean; data?: DeviceHealth }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}/recover`, { method: 'POST' });
}

export interface WebhookDeliveryEntry {
  id: string;
  ts: number;
  kind: 'automation' | 'scheduler' | 'job';
  event: string;
  targetHost: string;
  ok: boolean;
  status?: number;
  error?: string;
  durationMs: number;
}

export function fetchWebhookDeliveries(limit = 100): Promise<{ deliveries: WebhookDeliveryEntry[] }> {
  return apiJson(`/v1/dashboard/webhooks?limit=${limit}`);
}

export interface JobDiffSide {
  id: string;
  versionLabel?: string;
  buildNumber?: string;
  releaseNotes?: string;
  channel?: 'appstore' | 'testflight';
  cacheHit?: boolean;
  sizeBytes?: number;
  finishedAt: number;
  metadata?: IpaMetadata;
}

export interface JobDiffResult {
  a: JobDiffSide;
  b: JobDiffSide;
  sizeDeltaBytes: number;
  plistDiff: { key: string; before: unknown; after: unknown }[];
}

export function fetchJobDiff(bundleId: string, a: string, b: string): Promise<JobDiffResult> {
  return apiJson(
    `/v1/dashboard/jobs/diff?bundleId=${encodeURIComponent(bundleId)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
    undefined,
    'jobDiff',
  );
}

export interface JobAttemptComparison {
  a: { id: string; status: 'done' | 'failed'; attempt?: number; retryCount?: number; startedAt?: number; finishedAt: number; durationMs?: number; deviceId?: string; transport?: 'usb' | 'wifi'; cacheHit?: boolean; deadlineExceeded?: boolean; error?: string; warnings?: string[]; artifactId?: string };
  b: { id: string; status: 'done' | 'failed'; attempt?: number; retryCount?: number; startedAt?: number; finishedAt: number; durationMs?: number; deviceId?: string; transport?: 'usb' | 'wifi'; cacheHit?: boolean; deadlineExceeded?: boolean; error?: string; warnings?: string[]; artifactId?: string };
  durationDeltaMs: number;
  changedFields: string[];
}

export function fetchJobAttemptComparison(a: string, b: string): Promise<JobAttemptComparison> {
  const params = new URLSearchParams({ a, b });
  return apiJson(`/v1/dashboard/jobs/attempt-diff?${params}`, undefined, 'jobDiff');
}

export type JobHistoryPage = { history: JobHistoryEntry[]; total: number } & CursorPage;

export interface JobHistoryQuery {
  cursorOrOffset: string | number | undefined;
  limit: number;
  q?: string;
  source?: 'manual' | 'scheduler';
  status?: 'done' | 'failed';
  opts?: JobHistoryFilters;
}

export interface JobHistoryFilters {
  queuedBy?: string;
  deviceId?: string;
  errorQ?: string;
  failureCategory?: string;
  fromTs?: number;
  toTs?: number;
}

function paginationQuery(cursorOrOffset: string | number | undefined): string {
  if (typeof cursorOrOffset === 'number') return `&offset=${Math.max(0, cursorOrOffset)}`;
  return cursorOrOffset ? `&cursor=${encodeURIComponent(cursorOrOffset)}` : '';
}

function jobHistoryPath({ cursorOrOffset, limit, q, source, status, opts }: JobHistoryQuery): string {
  const pageQuery = paginationQuery(cursorOrOffset);
  const query = q ? `&q=${encodeURIComponent(q)}` : '';
  const sourceQuery = source ? `&source=${source}` : '';
  const statusQuery = status ? `&status=${status}` : '';
  const queuedByQuery = opts?.queuedBy ? `&queuedBy=${encodeURIComponent(opts.queuedBy)}` : '';
  const deviceIdQuery = opts?.deviceId ? `&deviceId=${encodeURIComponent(opts.deviceId)}` : '';
  const errorQuery = opts?.errorQ ? `&errorQ=${encodeURIComponent(opts.errorQ)}` : '';
  const failureCategoryQuery = opts?.failureCategory ? `&failureCategory=${encodeURIComponent(opts.failureCategory)}` : '';
  const fromTsQuery = Number.isFinite(opts?.fromTs) ? `&fromTs=${opts?.fromTs}` : '';
  const toTsQuery = Number.isFinite(opts?.toTs) ? `&toTs=${opts?.toTs}` : '';
  return `/v1/dashboard/jobs?limit=${limit}${pageQuery}${query}${sourceQuery}${statusQuery}${queuedByQuery}${deviceIdQuery}${errorQuery}${failureCategoryQuery}${fromTsQuery}${toTsQuery}`;
}

const SERVER_QUERY_STALE_TIME_MS = 15_000;

export function fetchJobHistory(
  query: JobHistoryQuery,
): Promise<JobHistoryPage> {
  const path = jobHistoryPath(query);
  return serverStateCache.query(path, () => apiJson<JobHistoryPage>(path), SERVER_QUERY_STALE_TIME_MS);
}

export function observeJobHistory(
  query: JobHistoryQuery,
  listener: ServerQueryListener<JobHistoryPage>,
): () => void {
  const path = jobHistoryPath(query);
  return serverStateCache.observe(path, () => apiJson<JobHistoryPage>(path), listener, SERVER_QUERY_STALE_TIME_MS);
}

export type ArtifactPage = { artifacts: ArtifactRecord[]; total: number; totalBytes: number; maxBytes: number } & CursorPage;

export interface ArtifactQuery {
  cursorOrOffset?: string | number;
  limit: number;
  q?: string;
  channel?: ArtifactRecord['channel'];
  archived?: boolean;
}

function artifactsPath({ cursorOrOffset, limit, q, channel, archived }: ArtifactQuery): string {
  const pageQuery = paginationQuery(cursorOrOffset);
  const query = q ? `&q=${encodeURIComponent(q)}` : '';
  const channelQuery = channel ? `&channel=${channel}` : '';
  const archivedQuery = archived === undefined ? '' : `&archived=${archived}`;
  return `/v1/dashboard/artifacts?limit=${limit}${pageQuery}${query}${channelQuery}${archivedQuery}`;
}

export function fetchArtifacts(
  query: ArtifactQuery,
  refresh = false,
): Promise<ArtifactPage> {
  const path = artifactsPath(query);
  if (refresh) serverStateCache.invalidatePrefix(path);
  return serverStateCache.query(path, () => apiJson<ArtifactPage>(path), SERVER_QUERY_STALE_TIME_MS);
}

export function observeArtifacts(
  query: ArtifactQuery,
  listener: ServerQueryListener<ArtifactPage>,
): () => void {
  const path = artifactsPath(query);
  return serverStateCache.observe(path, () => apiJson<ArtifactPage>(path), listener, SERVER_QUERY_STALE_TIME_MS);
}

export interface ArtifactPinResult {
  ok: boolean;
  changed: boolean;
  artifactId: string;
  pinned: boolean;
  pinnedAt?: string;
  pinnedStateChangedAt?: number;
  previousPinnedAt?: number;
}

export function setDashboardArtifactPinned(id: string, pinned: boolean): Promise<{ ok: boolean; data: ArtifactPinResult }> {
  return apiAction(`/v1/dashboard/artifacts/${encodeURIComponent(id)}/pin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
}

export interface ArtifactBulkPinResult {
  ok: boolean;
  pinned: boolean;
  changedIds: string[];
  artifacts: Array<{ artifactId: string; pinned: boolean; pinnedAt?: string; pinnedStateChangedAt?: number; previousPinnedAt?: number }>;
}

export function setDashboardArtifactsPinned(ids: string[], pinned: boolean): Promise<{ ok: boolean; data: ArtifactBulkPinResult }> {
  return apiAction('/v1/dashboard/artifacts/bulk-pin', {
    method: 'POST',
    body: JSON.stringify({ ids, pinned }),
  });
}

export function setDashboardArtifactsPinnedByQuery(filter: { q?: string; channel?: 'appstore' | 'testflight'; archived: boolean }, pinned: boolean): Promise<{ ok: boolean; data: ArtifactBulkPinResult }> {
  return apiAction('/v1/dashboard/artifacts/bulk-pin-query', {
    method: 'POST',
    body: JSON.stringify({ filter, pinned }),
  });
}

export interface ArtifactArchiveResult {
  ok: boolean;
  changed: boolean;
  artifactId: string;
  archived: boolean;
  archivedAt?: string;
  archivedStateChangedAt?: number;
  previousArchivedAt?: number;
}

export function setDashboardArtifactArchived(id: string, archived: boolean): Promise<{ ok: boolean; data: ArtifactArchiveResult }> {
  return apiAction(`/v1/dashboard/artifacts/${encodeURIComponent(id)}/archive`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
}

export interface ArtifactBulkArchiveResult {
  ok: boolean;
  archived: boolean;
  changedIds: string[];
  artifacts: Array<{ artifactId: string; archived: boolean; archivedAt?: string; archivedStateChangedAt?: number; previousArchivedAt?: number }>;
}

export function setDashboardArtifactsArchived(ids: string[], archived: boolean): Promise<{ ok: boolean; data: ArtifactBulkArchiveResult }> {
  return apiAction('/v1/dashboard/artifacts/bulk-archive', {
    method: 'POST',
    body: JSON.stringify({ ids, archived }),
  });
}

export function setDashboardArtifactsArchivedByQuery(filter: { q?: string; channel?: 'appstore' | 'testflight'; archived: boolean }, archived: boolean): Promise<{ ok: boolean; data: ArtifactBulkArchiveResult }> {
  return apiAction('/v1/dashboard/artifacts/bulk-archive-query', {
    method: 'POST',
    body: JSON.stringify({ filter, archived }),
  });
}

export async function downloadDashboardArtifactsZip(ids: string[]): Promise<void> {
  const response = await fetch('/v1/dashboard/artifacts/export.zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(apiErrorMessage(errorBody, response.status));
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'dkrypt-artifacts.zip';
  link.click();
  URL.revokeObjectURL(url);
}

export interface ArtifactUndoChange {
  id: string;
  kind: 'pin' | 'archive';
  expectedStateChangedAt: number;
  expectedCurrentState: boolean;
  restoreAt?: number;
}

export interface ArtifactUndoResult {
  undoneIds: string[];
  conflictIds: string[];
}

export function undoDashboardArtifactChanges(changes: ArtifactUndoChange[]): Promise<{ ok: boolean; data: ArtifactUndoResult }> {
  return apiAction('/v1/dashboard/artifacts/undo', { method: 'POST', body: JSON.stringify({ changes }) });
}

export function dashboardArtifactDownloadUrl(id: string): string {
  return `/v1/dashboard/artifacts/${encodeURIComponent(id)}/file`;
}

export function artifactDownloadUrl(id: string): string {
  return `/v1/artifacts/${encodeURIComponent(id)}/file`;
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

export function fetchBundleStats(bundleId: string): Promise<BundleStats> {
  return apiJson(`/v1/dashboard/jobs/stats/${encodeURIComponent(bundleId)}`);
}

export function cancelJob(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/jobs/${id}/cancel`, { method: 'POST' }, 'Cancelled').then((r) => ({ ok: r.ok }));
}

export function pauseJob(id: string): Promise<{ ok: boolean }> {
	return apiAction(`/v1/dashboard/jobs/${id}/pause`, { method: 'POST' }, 'Paused job').then((r) => ({ ok: r.ok }));
}

export function resumeJob(id: string): Promise<{ ok: boolean }> {
	return apiAction(`/v1/dashboard/jobs/${id}/resume`, { method: 'POST' }, 'Resumed job').then((r) => ({ ok: r.ok }));
}

export function prioritizeJob(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/jobs/${id}/prioritize`, { method: 'POST' }, 'Moved to front of queue').then((r) => ({ ok: r.ok }));
}

export function reorderQueue(ids: string[]): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/jobs/reorder', { method: 'POST', body: JSON.stringify({ ids }) }).then((r) => ({ ok: r.ok }));
}

export interface ApiKeyUsageBucket {
  date: string;
  count: number;
}

export function fetchKeyUsage(id: string, days = 14): Promise<{ usage: ApiKeyUsageBucket[] }> {
  return apiJson(`/v1/dashboard/keys/${id}/usage?days=${days}`);
}

export interface ApiKeyBundleUsage {
  bundleId: string;
  count: number;
}

export function fetchKeyBundleUsage(id: string, limit = 10): Promise<{ bundles: ApiKeyBundleUsage[] }> {
  return apiJson(`/v1/dashboard/keys/${id}/bundle-usage?limit=${limit}`);
}

export interface ApiKeyOutcomeUsage {
  route: string;
  success: number;
  clientError: number;
  serverError: number;
  lastAt: number;
  latencyCount?: number;
  averageLatencyMs?: number;
  maxLatencyMs?: number;
}

export function fetchKeyOutcomeUsage(id: string, limit = 10): Promise<{ outcomes: ApiKeyOutcomeUsage[] }> {
  return apiJson(`/v1/dashboard/keys/${id}/outcomes?limit=${limit}`);
}

export interface ApiKeyRequestHistoryEntry {
  at: number;
  method: string;
  route: string;
  status: number;
  durationMs?: number;
}

export function fetchKeyRequestHistory(id: string, limit = 100): Promise<{ requests: ApiKeyRequestHistoryEntry[] }> {
  return apiJson(`/v1/dashboard/keys/${encodeURIComponent(id)}/requests?limit=${Math.min(100, Math.max(1, Math.floor(limit)))}`);
}

export interface LogQuery {
  scope?: string;
  level?: string;
  q?: string;
  regex?: boolean;
  cursor?: string;
  offset?: number;
  limit?: number;
}

export function fetchLogs(query: LogQuery = {}): Promise<{ logs: LogEntry[]; total: number } & CursorPage> {
  const params = new URLSearchParams();
  if (query.scope && query.scope !== 'all') params.set('scope', query.scope);
  if (query.level && query.level !== 'all') params.set('level', query.level);
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.regex) params.set('regex', '1');
  if (query.cursor) params.set('cursor', query.cursor);
  else if (query.offset) params.set('offset', String(query.offset));
  if (query.limit) params.set('limit', String(query.limit));
  return apiJson(`/v1/dashboard/logs${params.size ? `?${params}` : ''}`);
}

export function jobHistoryExportUrl(format: 'csv' | 'json'): string {
  return `/v1/dashboard/jobs/export?format=${format}`;
}

export function fetchJobEta(bundleId: string): Promise<{ avgMs: number | null; p50Ms: number | null; p95Ms: number | null; sampleCount: number; confidence: 'none' | 'low' | 'medium' | 'high' }> {
  return apiJson(`/v1/dashboard/jobs/eta/${encodeURIComponent(bundleId)}`);
}

export function fetchJobVolume(days = 14): Promise<{ days: { date: string; count: number }[] }> {
  const path = jobVolumePath(days);
  return serverStateCache.query(path, () => apiJson<{ days: { date: string; count: number }[] }>(path), SERVER_QUERY_STALE_TIME_MS);
}

export function observeJobVolume(
  listener: ServerQueryListener<{ days: { date: string; count: number }[] }>,
  days = 14,
): () => void {
  const path = jobVolumePath(days);
  return serverStateCache.observe(path, () => apiJson<{ days: { date: string; count: number }[] }>(path), listener, SERVER_QUERY_STALE_TIME_MS);
}

export function refreshJobVolume(days = 14): void {
  const path = jobVolumePath(days);
  if (serverStateCache.getSnapshot(path).isFetching) return;
  serverStateCache.invalidatePrefix(path);
}

function jobVolumePath(days: number): string {
  return `/v1/dashboard/jobs/volume?days=${days}`;
}

export interface JobSloAssessment {
  id: string;
  bundleId: string;
  status: 'queued' | 'running';
  waitedMs: number;
  predictedStartMs: number | null;
  predictedCompletionMs: number | null;
  parallelism: number;
  objective: 'within' | 'breached';
}

export interface JobSloSummary {
  targetMs: number;
  historicalP95Ms: number | null;
  jobs: JobSloAssessment[];
}

export function fetchJobSlo(): Promise<JobSloSummary> {
  return apiJson('/v1/dashboard/jobs/slo');
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
  executionPath: { serverAttempts: number; serverCompleted: number; deviceFallbacks: number; fallbackCompleted: number; fallbackFailed: number; averageServerAttemptMs?: number; averageDeviceFallbackMs?: number };
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

export interface ReleaseCoverageItem {
  bundleId: string;
  name: string;
  iconUrl?: string;
  recentJob?: { id: string; status: string; at: number };
  appStore: { latestVersion?: string; checkedAt?: number; artifactId?: string };
  testFlight?: { latestVersion?: string; buildId?: number; checkedAt?: number; verifiedAt?: number; artifactId?: string; stale: boolean };
}

export function fetchReleaseCoverage(): Promise<{ items: ReleaseCoverageItem[] }> {
  return apiJson('/v1/dashboard/release-coverage');
}

export interface OperationalIncident {
  id: string;
  sourceKey: string;
  kind: 'job' | 'watch' | 'device' | 'deployment';
  title: string;
  detail: string;
  sourceId: string;
  status: 'open' | 'in_progress' | 'snoozed' | 'resolved';
  recoveredAt?: number;
  assignedTo?: string;
  assignedToDisplayName?: string;
  snoozedUntil?: number;
  resolutionNote?: string;
  createdAt: number;
  updatedAt: number;
  history: Array<{ at: number; actor: string; action: string; note?: string }>;
}

export function fetchActionCenter(): Promise<{ incidents: OperationalIncident[] }> {
  return apiJson('/v1/dashboard/action-center');
}

export function simulateApiKeyScope(input: { keyId?: string; bundleId: string; source: 'appstore' | 'testflight'; allowedBundleIds?: string[]; allowTestFlight?: boolean; dailyLimit?: number | null; maxConcurrent?: number | null }): Promise<{ allowed: boolean; reasons: string[]; warnings: string[]; routes: string[]; operations: Array<{ route: string; allowed: boolean; reasons: string[] }>; bundleId: string; source: string; limits: { daily: number | null; dailyUsed: number; dailyRemaining: number | null; concurrent: number | null; concurrentRunning: number; queueWait: boolean } }> {
  return apiJson('/v1/dashboard/keys/simulate', { method: 'POST', body: JSON.stringify(input) });
}

export interface SignedTriggerIntegration {
  id: string;
  kind: 'signed_decrypt';
  bundleIds: string[];
  sources: Array<'appstore' | 'testflight'>;
  enabled: boolean;
  createdBy: string;
  billingOwnerId?: string;
  billingOwnerDisplayName?: string;
  billingOwnerTransfer?: { userId: string; requestedBy: string; requestedAt: number };
  billingOwnerTransferDisplayName?: string;
  billingOwnerTransferRequestorDisplayName?: string;
  createdAt: number;
  updatedAt: number;
  previousSecretExpiresAt?: number;
}

export function fetchSignedTriggerIntegrations(): Promise<{ integrations: SignedTriggerIntegration[] }> {
  return apiJson('/v1/dashboard/integrations/signed-triggers');
}

export function createSignedTriggerIntegration(input: { bundleIds: string[]; sources: Array<'appstore' | 'testflight'> }): Promise<{ integration: SignedTriggerIntegration; secret: string }> {
  return apiJson('/v1/dashboard/integrations/signed-triggers', { method: 'POST', body: JSON.stringify(input) });
}

export function rotateSignedTriggerIntegration(id: string): Promise<{ integration: SignedTriggerIntegration; secret: string }> {
  return apiJson(`/v1/dashboard/integrations/signed-triggers/${encodeURIComponent(id)}/rotate`, { method: 'POST' });
}

export function revokeSignedTriggerIntegration(id: string): Promise<{ integration: SignedTriggerIntegration }> {
  return apiJson(`/v1/dashboard/integrations/signed-triggers/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
}

export interface GithubOidcTrustPolicy {
  id: string;
  repositoryId: string;
  workflowRef: string;
  ref?: string;
  environment?: string;
  audience: string;
  bundleIds: string[];
  allowTestFlight: boolean;
  enabled: boolean;
  createdBy: string;
  billingOwnerId?: string;
  billingOwnerDisplayName?: string;
  billingOwnerTransfer?: { userId: string; requestedBy: string; requestedAt: number };
  billingOwnerTransferDisplayName?: string;
}

export interface IntegrationOwnershipRequest {
  id: string;
  kind: 'signed_decrypt' | 'github_oidc';
  bundleIds: string[];
  billingOwnerId?: string;
  billingOwnerDisplayName: string;
  billingOwnerTransfer: { userId: string; requestedBy: string; requestedAt: number };
  billingOwnerTransferDisplayName?: string;
  billingOwnerTransferRequestorDisplayName?: string;
  label: string;
}

export function fetchEligibleIntegrationOwners(id: string): Promise<{ users: Array<{ id: string; name: string }> }> {
  return apiJson(`/v1/dashboard/integrations/${encodeURIComponent(id)}/ownership/eligible`);
}

export function requestIntegrationOwnership(id: string, userId: string): Promise<{ policy: SignedTriggerIntegration | GithubOidcTrustPolicy }> {
  return apiJson(`/v1/dashboard/integrations/${encodeURIComponent(id)}/ownership/request`, { method: 'POST', body: JSON.stringify({ userId }) });
}

export function fetchPendingIntegrationOwnership(): Promise<{ requests: IntegrationOwnershipRequest[] }> {
  return apiJson('/v1/dashboard/integrations/ownership/pending');
}

export function acceptIntegrationOwnership(id: string): Promise<{ policy: SignedTriggerIntegration | GithubOidcTrustPolicy }> {
  return apiJson(`/v1/dashboard/integrations/${encodeURIComponent(id)}/ownership/accept`, { method: 'POST' });
}

export function fetchGithubOidcPolicies(): Promise<{ policies: GithubOidcTrustPolicy[] }> {
  return apiJson('/v1/dashboard/integrations/github-oidc');
}

export function createGithubOidcTrust(input: Omit<GithubOidcTrustPolicy, 'id' | 'enabled' | 'createdBy' | 'billingOwnerId' | 'billingOwnerDisplayName' | 'billingOwnerTransfer' | 'billingOwnerTransferDisplayName'>): Promise<{ policy: GithubOidcTrustPolicy }> {
  return apiJson('/v1/dashboard/integrations/github-oidc', { method: 'POST', body: JSON.stringify(input) });
}

export function revokeGithubOidcTrust(id: string): Promise<{ ok: true }> {
  return apiJson(`/v1/dashboard/integrations/github-oidc/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
}

export function updateActionCenterIncident(id: string, input: { status?: OperationalIncident['status']; assignedTo?: string | null; snoozedUntil?: number; resolutionNote?: string }): Promise<{ incident: OperationalIncident }> {
  return apiJson(`/v1/dashboard/action-center/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function refreshReleaseCoverage(bundleId: string): Promise<{ item: ReleaseCoverageItem; failures: string[] }> {
  return apiJson(`/v1/dashboard/release-coverage/${encodeURIComponent(bundleId)}/refresh`, { method: 'POST' });
}

export function fetchInsights(trendDays = 14, topApps = 5): Promise<InsightsSummary> {
  return apiJson(`/v1/dashboard/insights?trendDays=${trendDays}&topApps=${topApps}`);
}

export interface FailurePattern {
  message: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  bundleIds: string[];
}

export function fetchFailurePatterns(): Promise<{ patterns: FailurePattern[] }> {
  return apiJson('/v1/dashboard/failure-patterns');
}

export interface StorageForecast {
  freeBytes: number;
  bytesPerDay: number;
  daysRemaining: number | null;
  sampleCount: number;
}

export function fetchStorageForecast(): Promise<StorageForecast> {
  return apiJson('/v1/dashboard/storage-forecast');
}

export function supportBundleUrl(): string {
  return '/v1/dashboard/support-bundle';
}

export function searchApps(term: string): Promise<{ results: AppStoreSearchResult[] } | { error: string }> {
  return apiJson(`/v1/dashboard/search?q=${encodeURIComponent(term)}`);
}

export function lookupAppStoreTrack(trackId: number): Promise<{ bundleId: string; trackName: string; trackId: number }> {
  return apiJson(`/v1/dashboard/apps/lookup-track?trackId=${encodeURIComponent(trackId)}`);
}

export function fetchAppCatalog(bundleIds: string[]): Promise<{ entries: AppCatalogEntry[] }> {
  const unique = [...new Set(bundleIds.map((bundleId) => bundleId.trim()).filter(Boolean))];
  if (unique.length === 0) return Promise.resolve({ entries: [] });
  return apiJson(`/v1/dashboard/apps/metadata?bundleIds=${encodeURIComponent(unique.join(','))}`);
}

export function refreshAppCatalog(bundleIds: string[]): Promise<{ ok: boolean; data: { entries: AppCatalogEntry[] } }> {
  return apiAction('/v1/dashboard/apps/metadata/refresh', {
    method: 'POST',
    body: JSON.stringify({ bundleIds }),
  });
}

export interface AppCatalogStats {
  entries: number;
  icons: number;
  oldestUpdatedAt?: number;
  newestUpdatedAt?: number;
}

export interface AppStorefrontListing {
  countryCode: string;
  countryName: string;
  status: 'available' | 'unavailable' | 'unknown';
  price?: number;
  formattedPrice?: string;
  currency?: string;
}

export function fetchAppStorefronts(trackId: number, countries: string[]): Promise<{ trackId: number; checkedAt: number; storefronts: AppStorefrontListing[] }> {
  const unique = [...new Set(countries.map((country) => country.trim().toUpperCase()).filter(Boolean))];
  return apiJson(`/v1/dashboard/apps/storefronts?trackId=${encodeURIComponent(trackId)}&countries=${encodeURIComponent(unique.join(','))}`);
}

export function fetchAppCatalogStats(): Promise<AppCatalogStats> {
  return apiJson('/v1/dashboard/apps/cache');
}

export function queueDecrypt(
  bundleId: string,
  externalVersionId?: string,
  versionLabel?: string,
  preferPrimary = false,
  minimumOsVersion?: string,
  suppressErrorToast = false,
): Promise<{ ok: boolean; data: JobSummary }> {
  return apiAction('/v1/dashboard/decrypt', {
    method: 'POST',
    body: JSON.stringify({ bundleId, externalVersionId, versionLabel, preferPrimary, minimumOsVersion }),
  }, undefined, suppressErrorToast);
}

export function fetchDecryptPreflight(input: { bundleId: string; versionLabel?: string; testflight?: boolean; installSizeBytes?: number; deviceId?: string }): Promise<DecryptPreflight> {
  return apiJson('/v1/dashboard/decrypt/preflight', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface AppVersionEntry {
  externalVersionId: string;
  isLatest: boolean;
  displayVersion?: string;
  bundleVersion?: string;
  releaseDate?: string;
  minimumOsVersion?: string;
  artifactId?: string;
}

export function fetchAppVersions(bundleId: string, force = false): Promise<{ versions: AppVersionEntry[] } | { error: string }> {
  return apiJson(`/v1/dashboard/versions/${encodeURIComponent(bundleId)}${force ? '?force=true' : ''}`);
}

export function fetchJobStatus(id: string): Promise<JobSummary> {
  return apiJson(`/v1/dashboard/jobs/${id}/status`);
}

export interface TFTrain {
  trainVersion: string;
  buildCount: number;
}

export interface TFBuild {
  id: number;
  bundleId: string;
  cfBundleShortVersion: string;
  cfBundleVersion: string;
  whatsNew?: string;
  releaseDate?: string;
  expiration?: string;
  fileSize?: number;
}

export interface TestFlightBridgeDiagnostics {
  bridge: {
    bridgeVersion?: string;
    capabilities?: string[];
    hasInstaller?: boolean;
    hasCatalogManager?: boolean;
    backgroundTaskActive?: boolean;
    backgroundTimeRemaining?: number;
  };
  install?: Record<string, unknown>;
  recentLog?: string[];
}

export interface DashboardDoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export interface DashboardDoctorReport {
  ok: boolean;
  checkedAt: string;
  deployment: { id: string; ref: string };
  checks: DashboardDoctorCheck[];
  runtimeConfiguration: {
    appStoreOfflineDecryptEnabled: boolean;
    appStoreOfflineMaxWorkers: number;
    appStoreOfflineWorkerMemoryMb: number;
    appStoreOfflineVaultConfigured: boolean;
    backupManifestSecretConfigured: boolean;
    otelBaseEndpointConfigured: boolean;
    otelTracesEndpointConfigured: boolean;
    otelMetricsEndpointConfigured: boolean;
    otelBaseEndpointFingerprint?: string;
    otelTracesEndpointFingerprint?: string;
    otelMetricsEndpointFingerprint?: string;
  };
}

export interface DashboardSyntheticProbe {
  id: 'database' | 'artifacts' | 'device-bridge' | 'device-agent' | 'testflight' | 'webhooks';
  status: 'ok' | 'warn' | 'error' | 'skipped';
  durationMs: number;
  detail: string;
}

export interface DashboardSyntheticReport {
  ok: boolean;
  checkedAt: string;
  probes: DashboardSyntheticProbe[];
}

export function fetchDashboardDoctor(): Promise<DashboardDoctorReport> {
  return apiJson('/v1/dashboard/doctor');
}

export interface WorkerInstanceStatus {
  workerId: string;
  startedAt: number;
  heartbeatAt: number;
  state: 'active' | 'draining' | 'drained' | 'offline';
  configuration: {
    runtimeVersion: string;
    offlineConcurrency: number;
    maxJobWaitSeconds: number;
    maxRetries: number;
    databaseBusyTimeoutMs: number;
  };
  activeLeases: number;
  resources: string[];
}

export interface WorkerFleetStatus {
  currentWorkerId: string;
  workers: WorkerInstanceStatus[];
  configurationConsistent: boolean;
  capacity: {
    enabledDeviceSlots: number;
    offlineSlots: number;
    maxParallelJobs: number;
    activeLeases: number;
    availableSlots: number;
    queuedJobs: number;
    runningJobs: number;
  };
  checkedAt: number;
}

export function fetchWorkerFleetStatus(): Promise<WorkerFleetStatus> {
  return apiJson('/v1/dashboard/workers');
}

export function setWorkerDraining(workerId: string, draining: boolean): Promise<{ ok: boolean; workers: WorkerInstanceStatus[] }> {
  return apiJson(`/v1/dashboard/workers/${encodeURIComponent(workerId)}/drain`, { method: 'POST', body: JSON.stringify({ draining }) });
}

export interface DashboardBrowserCheck {
  cookieSessionValid: boolean;
  expectedOrigin: string | null;
  observedOrigin: string;
  forwardedHeadersPresent: boolean;
  oauthCallbacks: { github: string; discord: string };
}

export function fetchDashboardBrowserCheck(): Promise<DashboardBrowserCheck> {
  return apiJson('/v1/dashboard/browser-check');
}

export interface CompatibilityMatrix {
  policy: { sqliteSchema: number; rustBridge: string; autoinstallMinimum: string; autoinstallMajor: number };
  rows: Array<{ component: string; observed: string; supported: string; state: 'supported' | 'unsupported' | 'unknown'; detail?: string }>;
}

export function fetchCompatibilityMatrix(): Promise<CompatibilityMatrix> {
  return apiJson('/v1/dashboard/compatibility');
}

export interface OfflineAppStoreStatus {
  enabled: boolean;
  ready: boolean;
  downloaderAvailable: boolean;
  decryptorAvailable: boolean;
  fairPlayAuthorized: boolean;
  vault: { encryptionReady: boolean; accountConfigured: boolean; credentialConfigured: boolean; fairPlayCredentialCount?: number; authenticatedAt?: number; accountHint?: string; authenticationError?: string };
  blockers: string[];
  authentication?: { state: 'idle' | 'running' | 'verification_required' | 'succeeded' | 'failed' | 'interrupted'; operationId?: string; startedAt?: number; completedAt?: number; error?: string };
  credentialRetrieval: { state: 'idle' | 'running' | 'succeeded' | 'failed' | 'interrupted'; operationId?: string; deviceId?: string; startedAt?: number; completedAt?: number; error?: string; source?: 'settings' | 'job'; bundleId?: string };
}

export function fetchOfflineAppStoreStatus(options?: RequestInit): Promise<OfflineAppStoreStatus> {
  return apiJson('/v1/dashboard/appstore-offline/status', options);
}

export interface OfflineAppStoreReadinessCheck {
  id: string;
  ready: boolean;
  detail: string;
}

export interface AppStoreDownloaderNetworkCheck {
  reachable: boolean;
  latencyMs: number;
  endpoint: string;
  redirected: boolean;
  rangeSupported?: boolean;
  rateLimited: boolean;
  retryAfterSeconds?: number;
  checkedAt: string;
  diagnostic?: string;
}

export function checkAppStoreDownloaderNetwork(): Promise<AppStoreDownloaderNetworkCheck> {
  return apiJson('/v1/dashboard/appstore-offline/network-check', { method: 'POST' });
}

export function verifyOfflineAppStoreReadiness(): Promise<{ ok: boolean; checkedAt: string; purchaseMade: false; downloadStarted: false; checks: OfflineAppStoreReadinessCheck[] }> {
  return apiJson('/v1/dashboard/appstore-offline/verify', { method: 'POST' });
}

export function saveOfflineAppStoreAccount(appleId: string, password: string): Promise<OfflineAppStoreStatus> {
  return saveOfflineAppStoreAccountRequest(apiJson, appleId, password);
}

export function authenticateOfflineAppStoreAccount(verificationCode?: string, retrySavedCredentials = false): Promise<OfflineAppStoreStatus> {
  return authenticateOfflineAppStoreAccountRequest(apiJson, verificationCode, undefined, retrySavedCredentials);
}

export function saveOfflineAppStoreCredential(credential: string): Promise<OfflineAppStoreStatus> {
  return apiJson('/v1/dashboard/appstore-offline/credential', { method: 'PUT', body: JSON.stringify({ credential }) });
}

export function retrieveOfflineAppStoreCredential(deviceId: string): Promise<OfflineAppStoreStatus> {
  return retrieveOfflineAppStoreCredentialRequest(apiJson, deviceId);
}

export function clearOfflineAppStoreAccount(): Promise<OfflineAppStoreStatus> {
  return apiJson('/v1/dashboard/appstore-offline/account', { method: 'DELETE' });
}

export function runDashboardSyntheticProbes(): Promise<DashboardSyntheticReport> {
  return apiJson('/v1/dashboard/synthetic');
}

export function fetchTestFlightBridgeDiagnostics(): Promise<TestFlightBridgeDiagnostics> {
  return apiJson('/v1/dashboard/testflight/diagnostics', undefined, 'external');
}

export function fetchTestFlightTrains(appId: number, deviceId?: string): Promise<{ trains: TFTrain[] } | { error: string }> {
  const suffix = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : '';
  return apiJson(`/v1/dashboard/testflight/${appId}/trains${suffix}`, undefined, 'external');
}

export function fetchTestFlightBuilds(appId: number, trainVersion: string, deviceId?: string): Promise<{ builds: TFBuild[] } | { error: string }> {
  const params = new URLSearchParams({ trainVersion });
  if (deviceId) params.set('deviceId', deviceId);
  return apiJson(`/v1/dashboard/testflight/${appId}/builds?${params.toString()}`, undefined, 'external');
}

export function queueTestFlightDecrypt(
  bundleId: string,
  appId: number,
  build: TFBuild,
  preferPrimary = false,
  deviceId?: string,
  suppressErrorToast = false,
): Promise<{ ok: boolean; data: JobSummary }> {
  return apiAction('/v1/dashboard/testflight/decrypt', { method: 'POST', body: JSON.stringify({ bundleId, appId, build, preferPrimary, deviceId }) }, undefined, suppressErrorToast);
}

export function fetchTestFlightSubscriptions(cursor?: string, limit = 50): Promise<{ subscriptions: TestFlightSubscription[]; total: number } & CursorPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return apiJson(`/v1/dashboard/testflight/subscriptions?${params.toString()}`);
}

export function submitTestFlightSubscription(url: string): Promise<{ ok: boolean; data: { subscription: TestFlightSubscription } }> {
  return apiAction('/v1/dashboard/testflight/subscriptions', { method: 'POST', body: JSON.stringify({ url }) });
}

export function approveTestFlightSubscription(id: string): Promise<{ ok: boolean; data: { subscription: TestFlightSubscription } }> {
  return apiAction(`/v1/dashboard/testflight/subscriptions/${encodeURIComponent(id)}/approve`, { method: 'POST' });
}

export function denyTestFlightSubscription(id: string): Promise<{ ok: boolean; data: { subscription: TestFlightSubscription } }> {
  return apiAction(`/v1/dashboard/testflight/subscriptions/${encodeURIComponent(id)}/deny`, { method: 'POST' });
}

export function syncTestFlightSubscription(id: string): Promise<{ ok: boolean; data: { subscription: TestFlightSubscription } }> {
  return apiAction(`/v1/dashboard/testflight/subscriptions/${encodeURIComponent(id)}/sync`, { method: 'POST' });
}

export function unsubscribeTestFlightSubscription(id: string): Promise<{ ok: boolean; data: { subscription: TestFlightSubscription } }> {
  return apiAction(`/v1/dashboard/testflight/subscriptions/${encodeURIComponent(id)}/unsubscribe`, { method: 'POST' });
}

export function fetchTestFlightCatalog(refresh = false): Promise<{ apps: TestFlightCatalogApp[]; fetchedAt?: number; refreshing?: boolean }> {
  return apiJson(`/v1/dashboard/testflight/catalog${refresh ? '?refresh=true' : ''}`);
}

export function unsubscribeTestFlightCatalogApp(bundleId: string): Promise<{ ok: boolean; data: { bundleId: string; removedDeviceIds: string[]; failures: string[] } }> {
  return apiAction(`/v1/dashboard/testflight/catalog/${encodeURIComponent(bundleId)}/unsubscribe`, { method: 'POST' });
}

export function retryJob(id: string, preferPrimary = false): Promise<{ ok: boolean; data: JobSummary }> {
  return apiAction(`/v1/dashboard/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ preferPrimary }) });
}

export function fetchJobTimeline(id: string): Promise<JobTimeline> {
  return apiJson(`/v1/dashboard/jobs/${encodeURIComponent(id)}/timeline`);
}

export function fetchJobResolutionNotice(id: string): Promise<JobResolutionNoticePreview> {
  return apiJson(`/v1/dashboard/jobs/${encodeURIComponent(id)}/resolution-notice`);
}

export function sendJobResolutionNotice(id: string): Promise<JobResolutionNoticePreview> {
  return apiJson(`/v1/dashboard/jobs/${encodeURIComponent(id)}/resolution-notice`, { method: 'POST' });
}

export function previewBulkJobReplay(ids: string[]): Promise<BulkJobPreview> {
  return apiJson('/v1/dashboard/jobs/bulk-preview', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export function fetchNotifications(limit = 50, cursor?: string): Promise<NotificationResponse & { total: number } & CursorPage> {
  const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
  return apiJson(`/v1/dashboard/notifications?limit=${limit}${cursorQuery}`);
}

export function markNotificationsRead(ids?: string[]): Promise<{ ok: boolean; data: { marked: number } }> {
  return apiAction('/v1/dashboard/notifications/read', {
    method: 'POST',
    body: JSON.stringify(ids ? { ids } : {}),
  });
}

export function jobDiagnosticUrl(id: string): string {
  return `/v1/dashboard/jobs/${encodeURIComponent(id)}/diagnostic`;
}

export function fetchMyKeys(): Promise<{ keys: ApiKeyRecord[] }> {
  return apiJson('/v1/dashboard/keys/mine');
}

export function fetchPendingKeys(): Promise<{ keys: ApiKeyRecord[] }> {
  return apiJson('/v1/dashboard/keys/pending');
}

export function fetchAllKeys(cursorOrOffset: string | number | undefined = undefined, limit = 25, search?: string): Promise<{ keys: ApiKeyRecord[]; total: number } & CursorPage> {
  const pageQuery = typeof cursorOrOffset === 'number'
    ? `&offset=${Math.max(0, cursorOrOffset)}`
    : cursorOrOffset
      ? `&cursor=${encodeURIComponent(cursorOrOffset)}`
      : '';
  const q = search?.trim() ? `&search=${encodeURIComponent(search.trim())}` : '';
  return apiJson(`/v1/dashboard/keys/all?limit=${limit}${pageQuery}${q}`);
}

export function requestKey(
  name: string,
  expiresInDays?: number,
  allowedBundleIds?: string[],
  dailyLimit?: number,
): Promise<{ ok: boolean; data: { key?: string; expiresAt?: number } }> {
  return apiAction('/v1/dashboard/keys/request', {
    method: 'POST',
    body: JSON.stringify({ name, expiresInDays, allowedBundleIds, dailyLimit }),
  });
}

export function createKey(
  name: string,
  expiresInDays?: number,
  allowedBundleIds?: string[],
  dailyLimit?: number,
): Promise<{ ok: boolean; data: { key?: string; expiresAt?: number } }> {
  return apiAction('/v1/dashboard/keys/create', {
    method: 'POST',
    body: JSON.stringify({ name, expiresInDays, allowedBundleIds, dailyLimit }),
  });
}

export function revealKey(id: string): Promise<{ ok: boolean; data: { key: string } }> {
  return apiAction(`/v1/dashboard/keys/${id}/reveal`, { method: 'POST' });
}

export function regenerateKey(id: string, graceMinutes = 0): Promise<{ ok: boolean; data: { key?: ApiKeyRecord } }> {
  return apiAction(
    `/v1/dashboard/keys/${id}/regenerate`,
    { method: 'POST', body: JSON.stringify({ graceMinutes }) },
    graceMinutes > 0 ? `Key regenerated - old secret still works for ${graceMinutes}m` : 'Key regenerated - reveal it to get the new value',
  );
}

export function revokeKey(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/keys/${id}`, { method: 'DELETE' }, 'Key revoked');
}

export function bulkRevokeKeys(ids: string[]): Promise<{ ok: boolean; data: { revoked: string[] } }> {
  return apiAction('/v1/dashboard/keys/bulk-revoke', { method: 'POST', body: JSON.stringify({ ids }) }, 'Keys revoked');
}

export function bulkExtendKeyExpiry(ids: string[], days: number): Promise<{ ok: boolean; data: { extended: string[] } }> {
  return apiAction('/v1/dashboard/keys/bulk-extend-expiry', { method: 'POST', body: JSON.stringify({ ids, days }) }, 'Expiry extended');
}

export function bulkSetKeyDailyLimit(ids: string[], dailyLimit: number | null): Promise<{ ok: boolean; data: { updated: string[] } }> {
  return apiAction('/v1/dashboard/keys/bulk-set-daily-limit', { method: 'POST', body: JSON.stringify({ ids, dailyLimit }) }, 'Daily limit updated');
}

export function bulkSetKeyScope(ids: string[], allowedBundleIds: string[] | null): Promise<{ ok: boolean; data: { updated: string[] } }> {
  return apiAction('/v1/dashboard/keys/bulk-set-scope', { method: 'POST', body: JSON.stringify({ ids, allowedBundleIds }) }, 'Scope updated');
}

export function approveKey(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/keys/${id}/approve`, { method: 'POST' }, 'Key approved');
}

export function bulkApproveKeys(ids: string[]): Promise<{ ok: boolean; data: { approved: string[] } }> {
  return apiAction('/v1/dashboard/keys/bulk-approve', { method: 'POST', body: JSON.stringify({ ids }) }, 'Keys approved');
}

export function denyKey(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/keys/${id}/deny`, { method: 'POST' }, 'Key denied');
}

export function updateKeyPriority(id: string, priority: number): Promise<{ ok: boolean; data: { priority?: number } }> {
  return apiAction(`/v1/dashboard/keys/${id}/priority`, { method: 'PATCH', body: JSON.stringify({ priority }) }, 'Priority updated');
}

export function updateKeyMaxConcurrent(id: string, maxConcurrent: number | null): Promise<{ ok: boolean; data: { maxConcurrent?: number } }> {
  return apiAction(`/v1/dashboard/keys/${id}/max-concurrent`, { method: 'PATCH', body: JSON.stringify({ maxConcurrent }) }, 'Concurrency cap updated');
}

export function updateKeyAllowTestFlight(id: string, allowTestFlight: boolean): Promise<{ ok: boolean; data: { allowTestFlight?: boolean } }> {
  return apiAction(
    `/v1/dashboard/keys/${id}/allow-testflight`,
    { method: 'PATCH', body: JSON.stringify({ allowTestFlight }) },
    allowTestFlight ? 'TestFlight access enabled for this key' : 'TestFlight access disabled for this key',
  );
}

export function fetchSettings(): Promise<DashboardSettings> {
  return apiJson('/v1/dashboard/settings');
}

export function saveSettings(patch: Partial<DashboardSettings>): Promise<{ ok: boolean; data: DashboardSettings }> {
  return apiAction('/v1/dashboard/settings', { method: 'PUT', body: JSON.stringify(patch) }, 'Settings saved');
}

export interface JobHistoryRetentionPreview {
  retentionDays: number;
  cutoff?: number;
  currentEntries: number;
  retained: number;
  removed: number;
  agePruned: number;
  capacityPruned: number;
  afterNextWrite: number;
  maxEntries: number;
  artifacts: {
    retained: number;
    retainedBytes: number;
    maxBytes: number;
    reclaimable: number;
    reclaimableBytes: number;
  };
}

export function previewJobHistoryRetention(retentionDays: number): Promise<JobHistoryRetentionPreview> {
  return apiJson(`/v1/dashboard/settings/job-history-retention/preview?retentionDays=${encodeURIComponent(retentionDays)}`);
}

export interface ArtifactQuotaRetentionPreview {
  targetMaxBytes: number;
  currentMaxBytes: number;
  currentCount: number;
  currentBytes: number;
  retainedCount: number;
  retainedBytes: number;
  evictedCount: number;
  reclaimedBytes: number;
  pinnedCount: number;
  pinnedBytes: number;
  remainingOverQuotaBytes: number;
  evictionExamples: Array<{
    id: string;
    bundleId: string;
    channel: 'appstore' | 'testflight';
    versionLabel?: string;
    fileSizeBytes: number;
    lastAccessedAt: number;
  }>;
  additionalEvictions: number;
}

export interface ArtifactStorageStats {
  count: number;
  usedBytes: number;
  maxBytes: number;
}

export function fetchArtifactStorageStats(): Promise<ArtifactStorageStats> {
  return apiJson('/v1/dashboard/settings/artifact-storage');
}

export function previewArtifactQuotaRetention(maxBytes: number): Promise<ArtifactQuotaRetentionPreview> {
  return apiJson(`/v1/dashboard/artifacts/retention-preview?maxBytes=${encodeURIComponent(maxBytes)}`);
}

export function validateCron(expr: string): Promise<{ valid: boolean }> {
  return apiJson(`/v1/dashboard/settings/validate-cron?expr=${encodeURIComponent(expr)}`);
}

export function testWebhook(url?: string): Promise<{ ok: boolean; data: { ok: boolean; error?: string } }> {
  return apiAction('/v1/dashboard/settings/test-webhook', { method: 'POST', body: JSON.stringify({ url }) });
}

export interface TestFlightUpdateCheck {
  ok: boolean;
  appId?: number;
  latestTag?: string;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
}

export interface UpdateCheck {
  ok: boolean;
  itunesVersion?: string;
  normalizedVersion?: string;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
  testflight?: TestFlightUpdateCheck;
}

export function fetchUsers(): Promise<{ users: AllowedUser[] }> {
  return apiJson('/v1/dashboard/users');
}

export function fetchAuditLog(limit = 100, cursor?: string): Promise<{ entries: AuditLogEntry[]; total: number } & CursorPage> {
  const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
  return apiJson(`/v1/dashboard/audit-log?limit=${limit}${cursorQuery}`);
}

export function fetchAuditLogByTarget(target: string): Promise<{ entries: AuditLogEntry[] }> {
  return apiJson(`/v1/dashboard/audit-log/target/${encodeURIComponent(target)}`);
}

export function auditLogExportUrl(format: 'csv' | 'json'): string {
  return `/v1/dashboard/audit-log/export?format=${format}`;
}

export function fetchRoles(): Promise<{ roles: Role[] }> {
  return apiJson('/v1/dashboard/roles');
}

export interface RoleImpactPreview {
  affectedCount: number;
  members: Array<{ username: string; displayName?: string; beforePermissions: string; afterPermissions: string }>;
  truncated: boolean;
  memberDetailsHidden?: boolean;
}

export function previewRoleImpact(id: string, permissions: string): Promise<RoleImpactPreview> {
  return apiJson(`/v1/dashboard/roles/${encodeURIComponent(id)}/impact-preview`, { method: 'POST', body: JSON.stringify({ permissions }) });
}

export function addUser(username: string, roleIds: string[]): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/users', { method: 'POST', body: JSON.stringify({ username, roleIds }) }, `${username} added`);
}

export function removeUser(username: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/users/${encodeURIComponent(username)}`, { method: 'DELETE' }, `${username} removed`);
}

export function updateUserRoles(username: string, roleIds: string[], priority?: number): Promise<{ ok: boolean }> {
  return apiAction(
    `/v1/dashboard/users/${encodeURIComponent(username)}`,
    { method: 'PATCH', body: JSON.stringify({ roleIds, priority }) },
    `${username}'s roles updated`,
  );
}

export function createRole(name: string, color: string, permissions: string): Promise<{ ok: boolean; data: Role }> {
  return apiAction<Role>('/v1/dashboard/roles', { method: 'POST', body: JSON.stringify({ name, color, permissions }) }, `Role "${name}" created`);
}

export function updateRole(id: string, patch: { name?: string; color?: string; permissions?: string }): Promise<{ ok: boolean; data: Role }> {
  return apiAction<Role>(`/v1/dashboard/roles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Role updated');
}

export function deleteRole(id: string, name: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }, `Role "${name}" deleted`);
}

export function reorderRoles(roleIds: string[]): Promise<{ ok: boolean; data: { roles: Role[] } }> {
  return apiAction<{ roles: Role[] }>('/v1/dashboard/roles/reorder', { method: 'POST', body: JSON.stringify({ roleIds }) }, 'Role order updated');
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
  icon: string | null;
}

export interface DiscordGuildRole {
  id: string;
  name: string;
  color: number;
  position: number;
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

export function fetchDiscordStatus(): Promise<{ botEnabled: boolean; guilds: DiscordGuildSummary[] }> {
  return apiJson('/v1/dashboard/discord/status');
}

export function fetchDiscordGuilds(): Promise<{ guilds: DiscordGuildSummary[] }> {
  return apiJson('/v1/dashboard/discord/guilds');
}

export function setDiscordGuilds(guilds: DiscordGuildSummary[]): Promise<{ ok: boolean; data: { guilds: DiscordGuildSummary[] } }> {
  return apiAction('/v1/dashboard/discord/guilds', { method: 'POST', body: JSON.stringify({ guilds }) }, 'Discord guilds updated');
}

export function fetchDiscordGuildRoles(guildId: string): Promise<{ roles: DiscordGuildRole[] }> {
  return apiJson(`/v1/dashboard/discord/roles?guildId=${encodeURIComponent(guildId)}`);
}

export function fetchDiscordRolePerks(): Promise<{ perks: DiscordRolePerk[] }> {
  return apiJson('/v1/dashboard/discord/perks');
}

export function createDiscordRolePerk(
  guild: DiscordGuildSummary,
  discordRole: DiscordGuildRole,
  appRoleId: string,
): Promise<{ ok: boolean; data: DiscordRolePerk }> {
  return apiAction(
    '/v1/dashboard/discord/perks',
    {
      method: 'POST',
      body: JSON.stringify({
        guildId: guild.id,
        guildName: guild.name,
        guildIcon: guild.icon,
        discordRoleId: discordRole.id,
        discordRoleName: discordRole.name,
        discordRoleColor: discordRole.color,
        appRoleId,
      }),
    },
    'Discord role perk added',
  );
}

export function deleteDiscordRolePerk(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/discord/perks/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Discord role perk removed');
}

export function backupExportUrl(): string {
  return '/v1/dashboard/backup/export';
}

export function importBackup(payload: unknown): Promise<{ ok: boolean; data: { error?: string } }> {
  return apiAction('/v1/dashboard/backup/import', { method: 'POST', body: JSON.stringify(payload) }, 'Backup restored');
}

export interface BackupPreviewSummary {
  exportedAt?: number;
  incoming: { users: number; roles: number; apiKeys: number; watches: number; devices: number; jobHistory: number; auditLog: number };
  current: { users: number; roles: number; apiKeys: number; watches: number; devices: number; jobHistory: number; auditLog: number };
}

export function previewBackup(payload: unknown): Promise<{ ok: boolean; data: BackupPreviewSummary | { error?: string } }> {
  return apiAction('/v1/dashboard/backup/preview', { method: 'POST', body: JSON.stringify(payload) });
}

export interface BackupRestoreDrill {
  ok: boolean;
  restoreDrillStatus: 'passed' | 'failed';
  checkedAt: number;
  checks: BackupRestoreDrillCheck[];
  database?: { ok: boolean; detail: string };
}

export interface BackupRestoreDrillCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export function drillBackupRestore(payload: unknown): Promise<{ ok: boolean; data: BackupRestoreDrill | { error?: string } }> {
  return apiAction('/v1/dashboard/backup/drill', { method: 'POST', body: JSON.stringify(payload) });
}

export interface BackupSnapshotDrill {
  status: 'passed' | 'failed';
  checkedAt: number;
  checks: BackupRestoreDrillCheck[];
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

export function fetchBackupSchedule(): Promise<BackupScheduleSettings> {
  return apiJson('/v1/dashboard/backup/schedule');
}

export function updateBackupSchedule(patch: Partial<BackupScheduleSettings>): Promise<{ ok: boolean; data: BackupScheduleSettings }> {
  return apiAction('/v1/dashboard/backup/schedule', { method: 'POST', body: JSON.stringify(patch) }, 'Backup schedule updated');
}

export function fetchBackupHistory(): Promise<BackupHistoryEntry[]> {
  return apiJson('/v1/dashboard/backup/history');
}

export function createBackupSnapshot(): Promise<{ ok: boolean; data: BackupHistoryEntry }> {
  return apiAction('/v1/dashboard/backup/history', { method: 'POST' }, 'Backup snapshot created');
}

export function drillBackupSnapshot(id: string): Promise<{ ok: boolean; data: BackupSnapshotDrill | { error?: string } }> {
  return apiAction(`/v1/dashboard/backup/history/${encodeURIComponent(id)}/drill`, { method: 'POST' });
}

export function deleteBackupSnapshot(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/backup/history/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Backup snapshot deleted');
}

export function backupSnapshotDownloadUrl(id: string): string {
  return `/v1/dashboard/backup/history/${encodeURIComponent(id)}/download`;
}

export function accountExportUrl(): string {
  return '/v1/auth/privacy/export';
}

export function deleteAccount(confirmation: string): Promise<{ ok: boolean; error?: string }> {
  return apiAction('/v1/auth/privacy/delete', { method: 'POST', body: JSON.stringify({ confirmation }) }, 'Account deleted');
}

export async function reauthenticate(input: { password?: string; mfaToken?: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/v1/auth/reauthenticate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true } : { ok: false, error: data.error ?? 'Reauthentication failed.' };
  } catch {
    return { ok: false, error: 'Reauthentication failed.' };
  }
}

export async function reauthenticateWithPasskey(response: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/v1/auth/passkeys/reauth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(response),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    return res.ok ? { ok: true } : { ok: false, error: data.message ?? data.error ?? 'Reauthentication failed.' };
  } catch {
    return { ok: false, error: 'Reauthentication failed.' };
  }
}

export interface ActiveSessionInfo {
  id: string;
  sub: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
  ip?: string;
  risk?: 'new_context';
  current: boolean;
}

export function fetchSessions(): Promise<ActiveSessionInfo[]> {
  return apiJson('/v1/auth/sessions');
}

export function revokeSession(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Session signed out');
}

export function revokeOtherSessions(): Promise<{ ok: boolean; data: { revoked: number } }> {
  return apiAction('/v1/auth/sessions/revoke-others', { method: 'POST' }, 'Other sessions signed out');
}

export function fetchPushPublicKey(): Promise<{ publicKey: string }> {
  return apiJson('/v1/dashboard/push/public-key');
}

export function subscribePush(subscription: PushSubscriptionJSON): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) }).then((r) => ({ ok: r.ok }));
}

export function unsubscribePush(endpoint: string): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }).then((r) => ({ ok: r.ok }));
}

export function testPush(): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/push/test', { method: 'POST' }, 'Test push sent').then((r) => ({ ok: r.ok }));
}

export function testEmail(): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/email/test', { method: 'POST' }, 'Test email sent').then((r) => ({ ok: r.ok }));
}

export interface BillingManagerSubscription {
  user?: { id: string; displayName: string; username?: string; email?: string };
  provider: 'stripe' | 'nowpayments' | 'legacy';
  subscriptionId: string;
  checkoutId?: string;
  customerId: string;
  priceId: string;
  productId: string;
  interval?: string;
  plan: { id: string; name?: string; amount?: number; currency?: string };
  status: string;
  nextBilledAt?: string;
  occurredAt: string;
  updatedAt: string;
  crypto?: { walletAddress?: string; chain?: string; asset?: string };
  tax?: { status: string; country?: string; postalCode?: string; transactionId?: string };
  lastCharge: {
    id?: string;
    status?: string;
    at?: string;
    txHash?: string;
    failureReason?: string;
    graceUntil?: string;
    attempts: Array<{ status: string; amount: number; currency: string; occurredAt: string; txHash?: string; failureReason?: string }>;
  };
  entitlementHistory?: Array<{ id: string; kind: string; status: string; at: string; detail?: string }>;
}

export function fetchBillingSubscriptions(filters: { q?: string; provider?: string; status?: string; planId?: string; from?: string; to?: string; wallet?: string; invoice?: string; cursor?: string; limit?: number } = {}): Promise<{ subscriptions: BillingManagerSubscription[]; total: number } & CursorPage> {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.provider) params.set('provider', filters.provider);
  if (filters.status) params.set('status', filters.status);
  if (filters.planId) params.set('planId', filters.planId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.wallet) params.set('wallet', filters.wallet);
  if (filters.invoice) params.set('invoice', filters.invoice);
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.limit) params.set('limit', String(filters.limit));
  const query = params.toString();
  return apiJson(`/v1/billing/subscriptions${query ? `?${query}` : ''}`);
}

export interface BillingAccessCode {
  id: string;
  prefix: string;
  planId: string;
  durationDays: number;
  redeemBy: string;
  createdBy?: string;
  createdAt: string;
  redeemedBy?: string;
  redeemedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  status: 'available' | 'redeemed' | 'expired' | 'revoked';
}

export function fetchBillingAccessCodes(): Promise<{ accessCodes: BillingAccessCode[] }> {
  return apiJson('/v1/billing/access-codes');
}

export function createBillingAccessCode(input: { planId: string; durationDays: number; redeemWithinDays: number }): Promise<{ code: string; accessCode: BillingAccessCode }> {
  return apiJson('/v1/billing/access-codes', { method: 'POST', body: JSON.stringify(input) });
}

export function redeemBillingAccessCode(code: string): Promise<{ planId: string; expiresAt: string }> {
  return apiJson('/v1/billing/access-codes/redeem', { method: 'POST', body: JSON.stringify({ code }) });
}

export function revokeBillingAccessCode(id: string): Promise<BillingAccessCode> {
  return apiJson(`/v1/billing/access-codes/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
}

export interface BillingWebhookInboxRecord {
  id: string;
  provider: 'stripe' | 'nowpayments';
  eventId: string;
  status: 'received' | 'processed' | 'failed' | 'quarantined';
  rawBodySha256: string;
  rawBodyBytes: number;
  receivedAt: number;
  processedAt?: number;
  attempts: number;
  lastError?: string;
  replayableProcessed: boolean;
}

export function fetchBillingWebhookInbox(filters: { provider?: string; status?: string; cursor?: string; limit?: number } = {}): Promise<{ inbox: BillingWebhookInboxRecord[]; total: number } & CursorPage> {
  const params = new URLSearchParams();
  if (filters.provider) params.set('provider', filters.provider);
  if (filters.status) params.set('status', filters.status);
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.limit) params.set('limit', String(filters.limit));
  const query = params.toString();
  return apiJson(`/v1/billing/webhooks/inbox${query ? `?${query}` : ''}`);
}

export function replayBillingWebhook(id: string): Promise<{ ok: boolean; data: { replayed?: boolean; duplicate?: boolean; status?: string } }> {
  return apiAction(`/v1/billing/webhooks/inbox/${encodeURIComponent(id)}/replay`, { method: 'POST' }, 'Webhook replayed');
}

export function quarantineBillingWebhook(id: string, reason?: string): Promise<{ ok: boolean; data: { record?: BillingWebhookInboxRecord } }> {
  return apiAction(`/v1/billing/webhooks/inbox/${encodeURIComponent(id)}/quarantine`, { method: 'POST', body: JSON.stringify({ reason }) }, 'Webhook quarantined');
}

export interface BillingProviderStatus {
  checkoutsPaused: boolean;
  stripe: {
    enabled: boolean;
    environment: 'test' | 'live';
    missingConfiguration: string[];
    webhook: {
      state: 'ready' | 'missing_endpoint' | 'missing_events' | 'unavailable' | 'not_configured';
      endpointUrl: string;
      requiredEvents: string[];
      missingEvents: string[];
      checkedAt?: string;
    };
  };
  crypto: { enabled: boolean; configured: boolean; ready: boolean; environment: 'test' | 'live'; settlementType?: string; settlementCurrency: string; supportedChains: string[]; supportedAssets: string[]; missingConfiguration: string[]; issues: string[]; checkedAt?: string };
}

export interface BillingRevenueCurrencyTotal {
  currency: string;
  gross: number;
  refunded: number;
  net: number;
}

export interface BillingRevenueProviderSummary {
  state: 'ready' | 'unavailable' | 'not_configured';
  totals: BillingRevenueCurrencyTotal[];
  paymentCount: number;
}

export interface BillingRevenueTrendMonth {
  month: string;
  currency: string;
  gross: number;
  refunded: number;
  net: number;
  paymentCount: number;
  providers: { stripe: number; nowpayments: number };
}

export interface BillingRevenueSummary {
  updatedAt: string;
  complete: boolean;
  totals: BillingRevenueCurrencyTotal[];
  trend: BillingRevenueTrendMonth[];
  retention: {
    activeAccounts: number;
    paymentIssues: number;
    cancellationsUpdatedLast30Days: number;
    recentCancellationRatePercent: number;
  };
  providers: {
    stripe: BillingRevenueProviderSummary;
    nowpayments: BillingRevenueProviderSummary;
  };
  warnings: string[];
}

export type BillingReconciliationDiscrepancy = 'provider_unavailable' | 'unrecognized_price' | 'plan_mismatch' | 'status_mismatch' | 'entitlement_mismatch' | 'refund_protected';

export interface BillingReconciliationEntry {
  subscriptionId: string;
  userId?: string;
  displayName?: string;
  local: { planId: string; status: string; updatedAt: string };
  stripe: { state: 'ready' | 'unavailable'; planId?: string; status?: string; priceId?: string };
  entitlement?: { planId: string; provider: string; status: string };
  discrepancies: BillingReconciliationDiscrepancy[];
  syncAllowed: boolean;
}

export function fetchBillingReconciliation(cursor?: string): Promise<{ checkedAt: string; entries: BillingReconciliationEntry[]; total: number; nextCursor?: string }> {
  const params = new URLSearchParams({ limit: '25' });
  if (cursor) params.set('cursor', cursor);
  return apiJson(`/v1/billing/reconciliation?${params}`);
}

export function syncBillingReconciliation(entry: BillingReconciliationEntry): Promise<{ subscriptionId: string; status: string; planId: string; updatedAt: string; entitlement: { planId: string; provider: string; status: string } }> {
  if (!entry.stripe.status || !entry.stripe.priceId) throw new Error('Check Stripe again before syncing this subscription');
  return apiJson(`/v1/billing/reconciliation/${encodeURIComponent(entry.subscriptionId)}/sync`, {
    method: 'POST',
    body: JSON.stringify({ expectedUpdatedAt: entry.local.updatedAt, expectedStripeStatus: entry.stripe.status, expectedStripePriceId: entry.stripe.priceId }),
  });
}

export function fetchBillingRevenue(refresh = false): Promise<BillingRevenueSummary> {
  return apiJson(`/v1/billing/revenue${refresh ? '?refresh=true' : ''}`);
}

export interface BillingInvoice {
  id: string;
  provider: 'stripe' | 'nowpayments';
  planId: string;
  status: string;
  createdAt: string;
  amountMinor: number;
  currency: string;
  invoiceUrl?: string;
  paymentId?: string;
}

export function fetchBillingInvoices(): Promise<{ invoices: BillingInvoice[]; warnings: string[] }> {
  return apiJson('/v1/billing/invoices');
}

export interface BillingQuotaHistoryEntry {
  jobId: string;
  at: number;
  state: 'reserved' | 'consumed';
  bundleId?: string;
  versionLabel?: string;
  source?: string;
  status: string;
}

export function fetchBillingQuotaHistory(limit = 50): Promise<{ entries: BillingQuotaHistoryEntry[] }> {
  return apiJson(`/v1/billing/quota-history?limit=${Math.min(100, Math.max(1, Math.floor(limit)))}`);
}

export function fetchBillingProviderStatus(refresh = false): Promise<BillingProviderStatus> {
  return apiJson(`/v1/billing/provider-status${refresh ? '?refresh=true' : ''}`);
}

export function setBillingCheckoutPaused(paused: boolean): Promise<{ paused: boolean }> {
  return apiJson('/v1/billing/checkouts', { method: 'PUT', body: JSON.stringify({ paused }) });
}

export function syncStripeBillingWebhookEvents(): Promise<{ ok: boolean; data: { webhook?: BillingProviderStatus['stripe']['webhook'] } }> {
  return apiAction('/v1/billing/stripe-webhook/sync', { method: 'POST' }, 'Stripe webhook events synchronized');
}

export type DiagnosticReportCategory = 'bug' | 'device' | 'job' | 'other';

export interface DiagnosticReportDraft {
  category: DiagnosticReportCategory;
  summary: string;
  details: string;
}

export interface DiagnosticReport {
  id: string;
  userId?: string;
  userDisplayName?: string;
  category: DiagnosticReportCategory;
  summary: string;
  details: string;
  createdAt: number;
  expiresAt: number;
  status: 'received';
  messages?: Array<{ id: string; authorDisplayName: string; authorRole: 'reporter' | 'support'; body: string; createdAt: number }>;
}

export interface DiagnosticReportPreview extends DiagnosticReportDraft {
  previewToken: string;
  expiresAt: number;
}

export function previewDiagnosticReport(draft: DiagnosticReportDraft): Promise<DiagnosticReportPreview> {
  return apiJson('/v1/dashboard/diagnostic-reports/preview', { method: 'POST', body: JSON.stringify(draft) });
}

export function submitDiagnosticReport(preview: DiagnosticReportPreview): Promise<DiagnosticReport> {
  return apiJson('/v1/dashboard/diagnostic-reports', { method: 'POST', body: JSON.stringify({
    category: preview.category,
    summary: preview.summary,
    details: preview.details,
    previewToken: preview.previewToken,
    consent: true,
  }) });
}

export function fetchDiagnosticReports(): Promise<{ reports: DiagnosticReport[] }> {
  return apiJson('/v1/dashboard/diagnostic-reports');
}

export function fetchDiagnosticReportInbox(): Promise<{ reports: DiagnosticReport[] }> {
  return apiJson('/v1/dashboard/diagnostic-reports/inbox');
}

export function replyToDiagnosticReport(id: string, message: string): Promise<DiagnosticReport> {
  return apiJson(`/v1/dashboard/diagnostic-reports/${encodeURIComponent(id)}/replies`, { method: 'POST', body: JSON.stringify({ message }) });
}
