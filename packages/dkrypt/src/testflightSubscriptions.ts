import { BridgeError } from '#idevice.js';
import { scopedLogger } from '#logger.js';
import { trackBackgroundWork } from '#backgroundWork.js';
import { uninstallFromDevice } from '#appStoreInstall.js';
import { lookupAppMetadata, searchApps, type ItunesSearchResult } from '#appStoreMetadata.js';
import {
  ensureTestFlightSubscriptionDevices,
  getTestFlightSubscriptions,
  getEffectiveDevices,
  getAppCatalogEntry,
  getTestFlightCatalogCache,
  getTestFlightSubscription,
  IMMUTABLE_TESTFLIGHT_BUNDLE_ID,
  recordDeviceActivity,
  recordAudit,
  recordNotification,
  recordTestFlightSubscriptionSync,
  setTestFlightCatalogCache,
  upsertAppCatalogEntries,
  type TestFlightCatalogCache,
  updateTestFlightSubscriptionDevice,
  withdrawTestFlightSubscription,
  type DeviceRecord,
  type TestFlightSubscription,
  type TestFlightSubscriptionDevice,
} from '#store/state.js';
import { listTestFlightApps, statusTestFlightInvite, subscribeToTestFlightInvite, unsubscribeFromTestFlightInvite, type TFDeviceApp } from '#testflight.js';
import { TESTFLIGHT_VERIFICATION_TTL_MS } from '#testflightPolicy.js';
import { notifyDeviceDispatchStateChanged } from '#jobs/store.js';

const log = scopedLogger('testflight');

export { TESTFLIGHT_VERIFICATION_TTL_MS } from '#testflightPolicy.js';
const TESTFLIGHT_INVITE_PATH = /^\/join\/([A-Za-z0-9]{4,32})\/?$/;
const TESTFLIGHT_HTML_LIMIT = 2_000_000;
const TESTFLIGHT_SYNC_CONCURRENCY = 3;
const TESTFLIGHT_VERIFICATION_ATTEMPTS = 12;
const TESTFLIGHT_VERIFICATION_DELAY_MS = 1_000;
const TESTFLIGHT_DEVICE_CATALOG_TTL_MS = 2 * 60_000;
const TESTFLIGHT_CATALOG_CACHE_TTL_MS = 5 * 60_000;
const TESTFLIGHT_CATALOG_REFRESH_FAILURE_BACKOFF_MS = 5 * 60_000;
const TESTFLIGHT_METADATA_TTL_MS = 60 * 60_000;
export { IMMUTABLE_TESTFLIGHT_BUNDLE_ID } from '#store/state.js';

export interface NormalizedTestFlightInvite {
  url: string;
  inviteCode: string;
}

export interface ResolvedTestFlightInvite {
  appId: number;
  bundleId: string;
  displayName: string;
  iconUrl?: string;
  sellerName?: string;
  category?: string;
}

export interface TestFlightCatalogApp {
  appId: number;
  bundleId: string;
  displayName: string;
  iconUrl?: string;
  sellerName?: string;
  category?: string;
  devices: Array<{ id: string; name: string; verifiedAt?: number }>;
  available?: boolean;
  lastVerifiedAt: number;
  deviceSource: true;
}

export class TestFlightCatalogUnavailableError extends Error {
  constructor() {
    super('TestFlight availability could not be verified on every enabled device');
    this.name = 'TestFlightCatalogUnavailableError';
  }
}

export function normalizeTestFlightInvite(raw: unknown): NormalizedTestFlightInvite {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('a TestFlight public link is required');
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('use a canonical TestFlight link such as https://testflight.apple.com/join/ABC123');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'testflight.apple.com' || parsed.username || parsed.password || parsed.port) {
    throw new Error('only https://testflight.apple.com/join/<code> links are supported');
  }
  const match = parsed.pathname.match(TESTFLIGHT_INVITE_PATH);
  if (!match) throw new Error('only public TestFlight join links are supported');
  return { url: `https://testflight.apple.com/join/${match[1]}`, inviteCode: match[1] };
}

function htmlMetaValue(html: string, attribute: string, value: string): string | undefined {
  const pattern = new RegExp(`<meta[^>]+${attribute}=["']${value}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const reversePattern = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attribute}=["']${value}["'][^>]*>`, 'i');
  return pattern.exec(html)?.[1] ?? reversePattern.exec(html)?.[1];
}

export function parseTestFlightInviteHtml(html: string): { displayName?: string; iconUrl?: string } {
  const title = /<title[^>]*>\s*([^<]+?)\s*<\/title>/i.exec(html)?.[1]?.trim();
  const ogTitle = htmlMetaValue(html, 'property', 'og:title') ?? htmlMetaValue(html, 'name', 'twitter:title');
  const source = ogTitle ?? title;
  const displayName = source
    ?.replace(/^Join the\s+/i, '')
    .replace(/\s+beta\s+-\s+TestFlight(?:\s+-\s+Apple)?\s*$/i, '')
    .replace(/\s+-\s+TestFlight(?:\s+-\s+Apple)?\s*$/i, '')
    .trim();
  const iconUrl = htmlMetaValue(html, 'property', 'og:image') ?? htmlMetaValue(html, 'name', 'twitter:image');
  return { displayName: displayName || undefined, iconUrl };
}

function chooseItunesResult(results: ItunesSearchResult[], displayName: string): ItunesSearchResult | undefined {
  const normalized = displayName.toLowerCase();
  return results.find((result) => result.trackName.toLowerCase() === normalized)
    ?? results.find((result) => result.trackName.toLowerCase().startsWith(normalized))
    ?? results[0];
}

export async function resolveTestFlightInvite(url: string): Promise<ResolvedTestFlightInvite> {
  const normalized = normalizeTestFlightInvite(url);
  const response = await fetch(normalized.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`TestFlight invite could not be resolved (${response.status})`);
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'testflight.apple.com') throw new Error('TestFlight invite redirected to an unsupported host');
  }
  const html = await response.text();
  if (html.length > TESTFLIGHT_HTML_LIMIT) throw new Error('TestFlight invite response was unexpectedly large');
  const parsed = parseTestFlightInviteHtml(html);
  const queryCandidates = [...new Set([
    parsed.displayName,
    parsed.displayName?.split(' - ')[0],
  ].filter((value): value is string => Boolean(value?.trim())))];
  if (queryCandidates.length === 0) throw new Error('TestFlight invite did not include app metadata');
  let result: ItunesSearchResult | undefined;
  for (const candidate of queryCandidates) {
    result = chooseItunesResult(await searchApps(candidate), candidate);
    if (result) break;
  }
  if (!result) throw new Error(`could not resolve ${parsed.displayName ?? 'the TestFlight app'} in the App Store`);
  return {
    appId: result.trackId,
    bundleId: result.bundleId,
    displayName: result.trackName,
    iconUrl: result.artworkUrl || parsed.iconUrl,
    sellerName: result.sellerName,
    category: result.category,
  };
}

function cloneDeviceState(device: TestFlightSubscriptionDevice): TestFlightSubscriptionDevice {
  return { ...device };
}

function enabledDeviceMap(): Map<string, DeviceRecord> {
  return new Map(getEffectiveDevices().filter((device) => device.enabled).map((device) => [device.id, device]));
}

interface DeviceCatalogCacheEntry {
  fetchedAt: number;
  apps: TFDeviceApp[];
}

interface AppMetadataCacheEntry {
  fetchedAt: number;
  metadata?: Awaited<ReturnType<typeof lookupAppMetadata>>;
}

export interface TestFlightCatalogCacheState {
  apps: TestFlightCatalogApp[];
  fetchedAt?: number;
  stale: boolean;
  refreshing: boolean;
}

const deviceCatalogCache = new Map<string, DeviceCatalogCacheEntry>();
const appMetadataCache = new Map<string, AppMetadataCacheEntry>();
let catalogRefreshPromise: Promise<TestFlightCatalogApp[]> | undefined;
let catalogRefreshRequiresAllDevices = false;
let catalogRefreshFailureAt: number | undefined;

export function clearTestFlightDeviceCatalogCache(): void {
  deviceCatalogCache.clear();
}

async function getDeviceApps(device: DeviceRecord, forceRefresh = false, refreshRemoteCatalog = false): Promise<{ device: DeviceRecord; fetchedAt: number; apps: TFDeviceApp[] }> {
  const cached = deviceCatalogCache.get(device.id);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < TESTFLIGHT_DEVICE_CATALOG_TTL_MS) return { device, ...cached };
  const apps = await listTestFlightApps(device, refreshRemoteCatalog);
  const fetchedAt = Date.now();
  deviceCatalogCache.set(device.id, { fetchedAt, apps });
  return { device, fetchedAt, apps };
}

async function getAppMetadata(bundleId: string): Promise<Awaited<ReturnType<typeof lookupAppMetadata>> | undefined> {
  const cached = appMetadataCache.get(bundleId);
  if (cached && Date.now() - cached.fetchedAt < TESTFLIGHT_METADATA_TTL_MS) return cached.metadata;
  const stored = getAppCatalogEntry(bundleId);
  if (stored?.trackId) {
    const metadata = {
      bundleId: stored.bundleId,
      trackId: stored.trackId,
      trackName: stored.displayName,
      sellerName: stored.sellerName ?? '',
      artworkUrl: stored.iconUrl ?? '',
      version: '',
      category: stored.category,
      description: stored.description,
      screenshots: stored.screenshots,
      releaseNotes: stored.releaseNotes,
      price: stored.price,
    };
    appMetadataCache.set(bundleId, { fetchedAt: Date.now(), metadata });
    return metadata;
  }
  const metadata = await lookupAppMetadata(bundleId).catch(() => undefined);
  appMetadataCache.set(bundleId, { fetchedAt: Date.now(), metadata });
  return metadata;
}

function appKey(app: Pick<TFDeviceApp, 'appId' | 'bundleId'>): string {
  return `${app.appId}:${app.bundleId}`;
}

export function isImmutableTestFlightBundle(bundleId: string | undefined): boolean {
  return bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID;
}

export function readTestFlightCatalogCache(cache: TestFlightCatalogCache | undefined, devices: DeviceRecord[], now = Date.now()): { apps: TestFlightCatalogApp[]; fetchedAt: number; stale: boolean } | undefined {
  const enabledDevices = devices.filter((device) => device.enabled);
  if (!cache) return enabledDevices.length === 0 ? { apps: [], fetchedAt: now, stale: false } : undefined;
  const enabledDeviceIds = enabledDevices.map((device) => device.id).sort();
  const cachedDeviceIds = [...cache.deviceIds].sort();
  const sameDevices = enabledDeviceIds.length === cachedDeviceIds.length && enabledDeviceIds.every((id, index) => id === cachedDeviceIds[index]);
  const enabledDeviceSet = new Set(enabledDeviceIds);
  const apps = cache.apps
    .map(({ devices, ...app }) => ({ ...app, devices: devices.filter((device) => enabledDeviceSet.has(device.id)).map(({ id, name, verifiedAt }) => ({ id, name, verifiedAt })) }))
    .filter((app) => app.devices.length > 0);
  return {
    apps,
    fetchedAt: cache.fetchedAt,
    stale: cache.complete === false || !sameDevices || now - cache.fetchedAt >= TESTFLIGHT_CATALOG_CACHE_TTL_MS,
  };
}

export function mergeDeviceTestFlightApps(entries: Array<{ device: DeviceRecord; fetchedAt: number; apps: TFDeviceApp[] }>, metadata: Map<string, Awaited<ReturnType<typeof lookupAppMetadata>> | undefined> = new Map()): TestFlightCatalogApp[] {
  const byApp = new Map<string, TestFlightCatalogApp>();
  for (const entry of entries) {
    for (const app of entry.apps) {
      const key = appKey(app);
      const storeMetadata = metadata.get(app.bundleId);
      const current = byApp.get(key);
      const device = { id: entry.device.id, name: entry.device.name, verifiedAt: entry.fetchedAt };
      if (current) {
        if (!current.devices.some((candidate) => candidate.id === device.id)) current.devices.push(device);
        current.lastVerifiedAt = Math.max(current.lastVerifiedAt, entry.fetchedAt);
        continue;
      }
      byApp.set(key, {
        appId: app.appId,
        bundleId: app.bundleId,
        displayName: app.name?.trim() || storeMetadata?.trackName || app.bundleId,
        iconUrl: storeMetadata?.artworkUrl,
        sellerName: app.providerName || storeMetadata?.sellerName,
        category: storeMetadata?.category,
        devices: [device],
        lastVerifiedAt: entry.fetchedAt,
        deviceSource: true,
      });
    }
  }
  return [...byApp.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function cachedCatalogForEnabledDevices(): { apps: TestFlightCatalogApp[]; fetchedAt: number; stale: boolean } | undefined {
  return readTestFlightCatalogCache(getTestFlightCatalogCache(), getEffectiveDevices());
}

export function getTestFlightCatalogCacheState(): TestFlightCatalogCacheState {
  const cached = cachedCatalogForEnabledDevices();
  return {
    apps: cached?.apps ?? [],
    fetchedAt: cached?.fetchedAt,
    stale: cached?.stale ?? true,
    refreshing: Boolean(catalogRefreshPromise),
  };
}

async function refreshTestFlightCatalog(requireAllDevices = false, refreshRemoteCatalog = false): Promise<TestFlightCatalogApp[]> {
  if (catalogRefreshPromise && (!requireAllDevices || catalogRefreshRequiresAllDevices)) return catalogRefreshPromise;
  if (catalogRefreshPromise) await catalogRefreshPromise.catch(() => undefined);

  const operation = (async () => {
    const devices = getEffectiveDevices().filter((device) => device.enabled);
    if (devices.length === 0) {
      const apps: TestFlightCatalogApp[] = [];
      setTestFlightCatalogCache({ fetchedAt: Date.now(), deviceIds: [], apps, complete: true });
      return apps;
    }
    const settled = await Promise.allSettled(devices.map((device) => getDeviceApps(device, true, refreshRemoteCatalog)));
    if (requireAllDevices && settled.some((result) => result.status === 'rejected')) throw new TestFlightCatalogUnavailableError();
    const complete = settled.every((result) => result.status === 'fulfilled');
    const entries = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const bundleIds = [...new Set(entries.flatMap((entry) => entry.apps.map((app) => app.bundleId)))];
    const metadataEntries = await Promise.all(bundleIds.map(async (bundleId) => [bundleId, await getAppMetadata(bundleId)] as const));
    const apps = mergeDeviceTestFlightApps(entries, new Map(metadataEntries));
    const metadata = metadataEntries.flatMap(([, entry]) => entry ? [{
      bundleId: entry.bundleId,
      displayName: entry.trackName,
      iconUrl: entry.artworkUrl,
      trackId: entry.trackId,
      sellerName: entry.sellerName,
      category: entry.category,
      description: entry.description,
      screenshots: entry.screenshots,
      releaseNotes: entry.releaseNotes,
      price: entry.price,
    }] : []);
    if (metadata.length > 0) upsertAppCatalogEntries(metadata);
    setTestFlightCatalogCache({ fetchedAt: Date.now(), deviceIds: devices.map((device) => device.id), apps, complete });
    return apps;
  })();

  catalogRefreshPromise = operation;
  catalogRefreshRequiresAllDevices = requireAllDevices;
  try {
    return await operation;
  } finally {
    if (catalogRefreshPromise === operation) {
      catalogRefreshPromise = undefined;
      catalogRefreshRequiresAllDevices = false;
    }
  }
}

export function refreshTestFlightCatalogInBackground(force = false): void {
  if (!force && catalogRefreshFailureAt && Date.now() - catalogRefreshFailureAt < TESTFLIGHT_CATALOG_REFRESH_FAILURE_BACKOFF_MS) return;
  void trackBackgroundWork('testflight-catalog-refresh', () => refreshTestFlightCatalog(false, force))
    .then(() => {
      catalogRefreshFailureAt = undefined;
      notifyDeviceDispatchStateChanged();
    })
    .catch(() => {
      catalogRefreshFailureAt = Date.now();
    });
}

export async function getVerifiedTestFlightCatalog(options: { requireAllDevices?: boolean } = {}): Promise<TestFlightCatalogApp[]> {
  if (!options.requireAllDevices) {
    const cached = cachedCatalogForEnabledDevices();
    if (cached) {
      if (cached.stale) refreshTestFlightCatalogInBackground();
      return cached.apps;
    }
    refreshTestFlightCatalogInBackground();
    return [];
  }
  return refreshTestFlightCatalog(true, true);
}

export async function decorateSearchResults<T extends { bundleId: string; trackId: number }>(results: T[]): Promise<Array<T & { testflight?: Pick<TestFlightCatalogApp, 'appId' | 'devices' | 'available' | 'lastVerifiedAt'> }>> {
  const catalog = await getVerifiedTestFlightCatalog();
  const byBundle = new Map(catalog.map((entry) => [entry.bundleId, entry]));
  const byApp = new Map(catalog.map((entry) => [entry.appId, entry]));
  return results.map((result) => {
    const catalog = byBundle.get(result.bundleId) ?? byApp.get(result.trackId);
    if (!catalog) return result;
    return { ...result, testflight: { appId: catalog.appId, devices: catalog.devices, available: true, lastVerifiedAt: catalog.lastVerifiedAt } };
  });
}

function listApprovedSubscriptions(): TestFlightSubscription[] {
  return getSubscriptions().filter((subscription) => subscription.status === 'approved');
}

function getSubscriptions(): TestFlightSubscription[] {
  return getTestFlightSubscriptions();
}

function classifySyncError(error: unknown): TestFlightSubscriptionDevice['status'] {
  if (error instanceof BridgeError && error.details.code && ['unsupported', 'capability_missing', 'incompatible'].includes(error.details.code)) return 'unsupported';
  const message = error instanceof Error ? error.message : String(error);
  if (/unsupported|capabilit|incompatible/i.test(message)) return 'unsupported';
  if (/unreachable|unable to connect|ssh|timed out|timeout|device unavailable|not configured/i.test(message)) return 'unavailable';
  return 'error';
}

async function verifySubscriptionOnDevice(subscription: TestFlightSubscription, device: DeviceRecord): Promise<void> {
  if (!subscription.appId) throw new Error('TestFlight app metadata is missing');
  await subscribeToTestFlightInvite(subscription.url, `${subscription.id}-${device.id}`, device, subscription.appId);
  let lastError: unknown;
  for (let attempt = 0; attempt < TESTFLIGHT_VERIFICATION_ATTEMPTS; attempt += 1) {
    try {
      const status = await statusTestFlightInvite(subscription.url, subscription.appId, `${subscription.id}-${device.id}-status-${attempt}`, device);
      if (status.verified === true) return;
      lastError = new Error('TestFlight invite has not appeared for this device yet');
    } catch (error) {
      lastError = error;
    }
    if (attempt < TESTFLIGHT_VERIFICATION_ATTEMPTS - 1) await new Promise((resolve) => setTimeout(resolve, TESTFLIGHT_VERIFICATION_DELAY_MS));
  }
  throw lastError instanceof Error ? lastError : new Error('TestFlight invite could not be verified on this device');
}

async function syncDevice(subscription: TestFlightSubscription, device: DeviceRecord): Promise<TestFlightSubscriptionDevice> {
  updateTestFlightSubscriptionDevice(subscription.id, device.id, { status: 'syncing', lastError: undefined });
  try {
    await verifySubscriptionOnDevice(subscription, device);
    const verifiedAt = Date.now();
    updateTestFlightSubscriptionDevice(subscription.id, device.id, {
      status: 'active',
      appleMembership: 'accepted',
      lastVerifiedAt: verifiedAt,
      lastSyncedAt: verifiedAt,
      lastError: undefined,
    });
    recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: `verified TestFlight access for ${subscription.displayName ?? subscription.url}` });
  } catch (error) {
    const status = classifySyncError(error);
    updateTestFlightSubscriptionDevice(subscription.id, device.id, {
      status,
      appleMembership: 'unknown',
      lastSyncedAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
    });
    recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: `TestFlight access sync failed for ${subscription.displayName ?? subscription.url}: ${error instanceof Error ? error.message : String(error)}` });
  }
  const updated = getTestFlightSubscription(subscription.id);
  const current = updated?.devices.find((entry) => entry.deviceId === device.id);
  return current ? cloneDeviceState(current) : { deviceId: device.id, status: 'error', lastError: 'subscription state disappeared' };
}

export async function syncTestFlightSubscription(id: string, actor = 'system'): Promise<TestFlightSubscription | undefined> {
  const initial = getTestFlightSubscription(id);
  if (!initial || initial.status !== 'approved') return initial;
  if (isImmutableTestFlightBundle(initial.bundleId)) return initial;
  ensureTestFlightSubscriptionDevices(id);
  const subscription = getTestFlightSubscription(id);
  if (!subscription) return undefined;
  const devices = [...enabledDeviceMap().values()];
  const completed: TestFlightSubscriptionDevice[] = [];
  for (let index = 0; index < devices.length; index += TESTFLIGHT_SYNC_CONCURRENCY) {
    const batch = devices.slice(index, index + TESTFLIGHT_SYNC_CONCURRENCY);
    completed.push(...await Promise.all(batch.map((device) => syncDevice(subscription, device))));
  }
  const active = completed.filter((device) => device.status === 'active').length;
  const failed = completed.length - active;
  recordTestFlightSubscriptionSync(id, actor, `${active} device(s) verified, ${failed} device(s) unavailable or unsupported`);
  const updated = getTestFlightSubscription(id);
  clearTestFlightDeviceCatalogCache();
  if (updated) {
    recordNotification({
      userId: updated.requestedBy,
      title: failed === 0 ? 'TestFlight access verified' : 'TestFlight access partially available',
      message: `${updated.displayName ?? updated.url}: ${active}/${completed.length} enabled device(s) verified.`,
      severity: failed === 0 ? 'success' : active > 0 ? 'warning' : 'error',
      groupKey: `testflight-sync:${updated.id}:${failed === 0 ? 'verified' : active > 0 ? 'partial' : 'unavailable'}`,
      href: '/?tab=settings&stab=testflight',
    });
  }
  return updated;
}

export async function unsubscribeTestFlightSubscription(id: string, actor: string): Promise<TestFlightSubscription | undefined> {
  const subscription = getTestFlightSubscription(id);
  if (!subscription) return undefined;
  if (isImmutableTestFlightBundle(subscription.bundleId)) return subscription;
  if (subscription.status !== 'approved') return withdrawTestFlightSubscription(id, actor);
  const devices = enabledDeviceMap();
  const failures: string[] = [];
  for (const device of subscription.devices) {
    const record = devices.get(device.deviceId);
    if (!record) {
      const message = 'device is disabled or unavailable';
      updateTestFlightSubscriptionDevice(id, device.deviceId, { status: 'unavailable', appleMembership: 'unknown', lastSyncedAt: Date.now(), lastError: message });
      failures.push(`${device.deviceId}: ${message}`);
      continue;
    }
    const errors: string[] = [];
    if (!subscription.bundleId) {
      errors.push('TestFlight app metadata is missing');
    } else {
      try {
        await unsubscribeFromTestFlightInvite(subscription.bundleId, record, `${subscription.id}-${record.id}-unsubscribe`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      try {
        const removed = await uninstallFromDevice(subscription.bundleId, record);
        if (!removed) errors.push('installed app could not be removed from the device');
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const lastSyncedAt = Date.now();
    if (errors.length > 0) {
      const message = errors.join('; ');
      updateTestFlightSubscriptionDevice(id, record.id, { status: 'error', appleMembership: 'unknown', lastSyncedAt, lastError: message });
      recordDeviceActivity({ deviceId: record.id, kind: 'bridge', message: `TestFlight unsubscribe cleanup failed for ${subscription.displayName ?? subscription.url}: ${message}` });
      failures.push(`${record.name}: ${message}`);
    } else {
      updateTestFlightSubscriptionDevice(id, record.id, { status: 'unsubscribed', appleMembership: 'unknown', lastSyncedAt, lastError: undefined });
    }
  }
  const detail = failures.length > 0 ? `unsubscribed with ${failures.length} device cleanup failure(s): ${failures.join(' | ')}` : subscription.url;
  const result = withdrawTestFlightSubscription(id, actor, detail);
  if (result) {
    recordNotification({
      userId: result.requestedBy,
      title: failures.length > 0 ? 'TestFlight subscription removed with warnings' : 'TestFlight subscription removed',
      message: failures.length > 0 ? `${result.displayName ?? result.url}: ${failures.join(' | ')}` : `${result.displayName ?? result.url} was removed from dkrypt automation.`,
      severity: failures.length > 0 ? 'warning' : 'success',
      groupKey: `testflight-unsubscribe:${result.id}:${failures.length > 0 ? 'warning' : 'success'}`,
      href: '/?tab=settings&stab=testflight',
    });
  }
  return result;
}

export async function unsubscribeDeviceTestFlightApp(bundleId: string, actor: string): Promise<{ bundleId: string; removedDeviceIds: string[]; failures: string[] }> {
  if (isImmutableTestFlightBundle(bundleId)) throw new Error('Discord TestFlight access is protected and cannot be removed');
  const managed = getTestFlightSubscriptions().find((entry) => entry.bundleId === bundleId && entry.status !== 'withdrawn');
  if (managed?.status === 'approved') {
    const result = await unsubscribeTestFlightSubscription(managed.id, actor);
    const devices = result?.devices ?? [];
    return {
      bundleId,
      removedDeviceIds: devices.filter((device) => device.status === 'unsubscribed').map((device) => device.deviceId),
      failures: devices.filter((device) => device.status === 'error' || device.status === 'unavailable').map((device) => `${device.deviceId}: ${device.lastError ?? 'device cleanup failed'}`),
    };
  }
  if (managed) withdrawTestFlightSubscription(managed.id, actor, `device catalog removal for ${bundleId}`);
  const catalog = await getVerifiedTestFlightCatalog({ requireAllDevices: true });
  const app = catalog.find((entry) => entry.bundleId === bundleId);
  if (!app) throw new Error('TestFlight app was not found on an enabled device');
  const devices = enabledDeviceMap();
  const removedDeviceIds: string[] = [];
  const failures: string[] = [];
  for (const device of app.devices) {
    const record = devices.get(device.id);
    if (!record) {
      failures.push(`${device.name}: device is disabled or unavailable`);
      continue;
    }
    const errors: string[] = [];
    try {
      await unsubscribeFromTestFlightInvite(bundleId, record, `device-${bundleId}-${record.id}-unsubscribe`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      const removed = await uninstallFromDevice(bundleId, record);
      if (!removed) errors.push('installed app could not be removed from the device');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (errors.length > 0) {
      const detail = errors.join('; ');
      failures.push(`${record.name}: ${detail}`);
      recordDeviceActivity({ deviceId: record.id, kind: 'bridge', message: `TestFlight device cleanup failed for ${app.displayName}: ${detail}` });
    } else {
      removedDeviceIds.push(record.id);
      recordDeviceActivity({ deviceId: record.id, kind: 'bridge', message: `removed ${app.displayName} from TestFlight device access` });
    }
  }
  clearTestFlightDeviceCatalogCache();
  const detail = failures.length > 0 ? `device catalog cleanup failed: ${failures.join(' | ')}` : `removed from ${removedDeviceIds.length} device(s)`;
  recordAudit(actor, 'testflight-subscription.remove', `device:${bundleId}`, detail);
  recordNotification({
    userId: actor.toLowerCase(),
    title: failures.length > 0 ? 'TestFlight device access removed with warnings' : 'TestFlight device access removed',
    message: `${app.displayName}: ${detail}`,
    severity: failures.length > 0 ? 'warning' : 'success',
    groupKey: `testflight-device-cleanup:${bundleId}:${failures.length > 0 ? 'warning' : 'success'}`,
    href: '/?tab=settings&stab=testflight',
  });
  return { bundleId, removedDeviceIds, failures };
}

export async function syncApprovedTestFlightSubscriptions(): Promise<void> {
  for (const subscription of listApprovedSubscriptions()) {
    const current = ensureTestFlightSubscriptionDevices(subscription.id) ?? subscription;
    const hasStaleDevice = current.devices.some((device) => device.status !== 'active' || !device.lastVerifiedAt || Date.now() - device.lastVerifiedAt > TESTFLIGHT_VERIFICATION_TTL_MS);
    if (hasStaleDevice) await syncTestFlightSubscription(subscription.id);
  }
}

let syncTimer: NodeJS.Timeout | undefined;

export function startTestFlightSubscriptionPoller(): void {
  refreshTestFlightCatalogInBackground();
  if (!syncTimer) syncTimer = setInterval(() => {
    void trackBackgroundWork('testflight-subscription-sync', syncApprovedTestFlightSubscriptions)
      .catch((error: unknown) => log.warn('TestFlight subscription poll failed', { error: String(error) }));
  }, TESTFLIGHT_VERIFICATION_TTL_MS).unref();
}

export function stopTestFlightSubscriptionPoller(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = undefined;
}

export function subscriptionsForUser(userId: string, manager: boolean): TestFlightSubscription[] {
  const lower = userId.toLowerCase();
  const source = manager ? getSubscriptions() : getSubscriptions().filter((subscription) => subscription.requestedBy === lower);
  return source;
}
