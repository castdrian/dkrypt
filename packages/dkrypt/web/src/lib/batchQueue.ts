export type BatchQueueSource = 'appstore' | 'testflight';

export interface BatchQueueEntry {
  bundleId: string;
  selector?: string;
}

export interface BatchQueueParseResult {
  entries: BatchQueueEntry[];
  duplicateBundleIds: string[];
  invalidSelectors: string[];
}

export const BATCH_QUEUE_TEMPLATES: Array<{
  source: BatchQueueSource;
  label: string;
  description: string;
  placeholder: string;
}> = [
  {
    source: 'appstore',
    label: 'App Store',
    description: 'Queue the latest release, or add an App Store version ID after @.',
    placeholder: 'com.example.app\ncom.example.app2@version_123',
  },
  {
    source: 'testflight',
    label: 'TestFlight',
    description: 'Add the build as version_build after @ for each available app.',
    placeholder: 'com.example.app@2.4.1_123\ncom.example.app2@3.0_456',
  },
];

export const MAX_BATCH_QUEUE_ENTRIES = 50;
export const TESTFLIGHT_ACCESS_MAX_AGE_MS = 30 * 60_000;
const TESTFLIGHT_ACCESS_CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;
const APP_STORE_VERSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TESTFLIGHT_BUILD_SELECTOR_RE = /^\d+(?:\.\d+)*_\d+$/;

export function batchQueueEntryKey(entry: BatchQueueEntry): string {
  return `${entry.bundleId}@${entry.selector ?? ''}`;
}

export function isValidBatchQueueSelector(selector: string, source: BatchQueueSource): boolean {
  return source === 'appstore'
    ? APP_STORE_VERSION_ID_RE.test(selector)
    : TESTFLIGHT_BUILD_SELECTOR_RE.test(selector);
}

export function getRecentlyVerifiedTestFlightDevices(
  app: { devices: Array<{ id: string; name: string; verifiedAt?: number }> },
  now = Date.now(),
): Array<{ id: string; name: string }> {
  const verifiedDevices = app.devices.filter((device) => {
    if (typeof device.verifiedAt !== 'number' || !Number.isFinite(device.verifiedAt)) return false;
    const verificationAge = now - device.verifiedAt;
    return verificationAge >= -TESTFLIGHT_ACCESS_CLOCK_SKEW_TOLERANCE_MS
      && verificationAge <= TESTFLIGHT_ACCESS_MAX_AGE_MS;
  });
  return verifiedDevices.filter((device, index, devices) =>
    devices.findIndex((candidate) => candidate.id === device.id) === index,
  ).map(({ id, name }) => ({ id, name }));
}

export function isTestFlightAppAvailable(
  app: { devices: Array<{ id: string; name: string; verifiedAt?: number }>; available?: boolean },
  now = Date.now(),
): boolean {
  return app.available === true || getRecentlyVerifiedTestFlightDevices(app, now).length > 0;
}

export function parseBatchQueueEntries(raw: string, source: BatchQueueSource): BatchQueueParseResult {
  const seen = new Set<string>();
  const seenBundleIds = new Set<string>();
  const duplicateBundleIds = new Set<string>();
  const entries: BatchQueueEntry[] = [];

  for (const line of raw.split(/[\n,]/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('@');
    const bundleId = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
    const selector = separator === -1 ? undefined : trimmed.slice(separator + 1).trim();
    const entry = { bundleId, selector: selector || undefined };
    const key = batchQueueEntryKey(entry);

    if (seenBundleIds.has(bundleId)) duplicateBundleIds.add(bundleId);
    seenBundleIds.add(bundleId);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= MAX_BATCH_QUEUE_ENTRIES) break;
  }

  return {
    entries,
    duplicateBundleIds: [...duplicateBundleIds],
    invalidSelectors: entries
      .filter((entry) => entry.selector && !isValidBatchQueueSelector(entry.selector, source))
      .map(batchQueueEntryKey),
  };
}
