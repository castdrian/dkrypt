import { randomUUID } from 'node:crypto';
import {
  armAppStoreAutoConfirm,
  clearAppStoreAutoConfirm,
  execCommand,
  findInstalledAppStoreBundle,
  isAppStoreRunning,
  readAppStoreInstallStatus,
  readInstalledBundleVersions,
  sendAppStoreBridgeRequest,
  sendSpringBoardBridgeRequest,
  uninstallInstalledBundle,
  uninstallInstalledApp,
  withSSH,
  type DeviceClient,
  type InstallVerification,
} from '#idevice.js';
import { scopedLogger } from '#logger.js';
import { lookupAppMetadataByTrackId, lookupCurrentVersion, type ItunesLookupResult } from '#appStoreMetadata.js';
import { getPrimaryDevice, type DeviceRecord } from '#store/state.js';
import { BRIDGE_CAPABILITIES, hasBridgeCapabilities } from '#bridgeProtocol.js';
import { normalizeVersion } from '#util/version.js';
import { delayWithSignal, throwIfAborted } from '#util/abort.js';

const log = scopedLogger('appstore');

const SAFE_BUNDLE_ID_RE = /^[A-Za-z0-9.-]{1,200}$/;
const APP_EXT_VERSION_ID_RE = /^\d{1,20}$/;
const APP_STORE_BRIDGE_READY_TIMEOUT_MS = 20_000;
const APP_STORE_BRIDGE_STATUS_TIMEOUT_MS = 3_000;
const APP_STORE_BRIDGE_POLL_INTERVAL_MS = 500;
const APP_STORE_INSTALL_STATUS_POLL_INTERVAL_MS = 5_000;
const APP_STORE_COMPLETED_DOWNLOAD_RETRY_DELAY_MS = 90_000;
const APP_STORE_DOWNLOAD_RETRY_MIN_REMAINING_MS = 45_000;
const APP_STORE_LOCALE_RE = /^[a-z]{2,3}[_-]([A-Za-z]{2})(?:@.*)?$/;

class AppStoreInstallTimeoutError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'AppStoreInstallTimeoutError';
  }
}

function currentInstallStatus(status: unknown, operationId: string): Record<string, unknown> | undefined {
  if (!status || typeof status !== 'object') return undefined;
  const install = (status as Record<string, unknown>).install;
  if (!install || typeof install !== 'object') return undefined;
  const installRecord = install as Record<string, unknown>;
  if (installRecord.operationId !== operationId) return undefined;
  return installRecord;
}

export function buildAppStoreOperationId(jobId: string, retryCount = 0): string {
  return retryCount > 0 ? `${jobId}-retry-${retryCount}` : jobId;
}

function primaryDevice() {
  const device = getPrimaryDevice();
  if (!device) throw new Error('No enabled device is configured');
  return device;
}

async function ensureAppStoreForeground(conn: DeviceClient, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const wasRunning = await isAppStoreRunning(conn);
  throwIfAborted(signal);
  const response = await sendSpringBoardBridgeRequest(conn, { action: 'launch_app', bundleId: 'com.apple.AppStore' }, 20_000, signal);
  throwIfAborted(signal);
  if (!wasRunning && response?.launchResult !== 0) {
    throw new Error(`autoinstall SpringBoard launch_app (AppStore) failed: ${JSON.stringify(response)}`);
  }

  await delayWithSignal(wasRunning ? 4_000 : 8_000, signal);
}

async function ensureAppStoreBridgeReady(conn: DeviceClient, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + APP_STORE_BRIDGE_READY_TIMEOUT_MS;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    let response: Record<string, unknown> | undefined;
    try {
      response = await sendAppStoreBridgeRequest(conn, { action: 'status' }, APP_STORE_BRIDGE_STATUS_TIMEOUT_MS, signal);
      throwIfAborted(signal);
    } catch (err) {
      throwIfAborted(signal);
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (response) {
      if (!hasBridgeCapabilities('appstore', response.capabilities)) {
        const reported = Array.isArray(response.capabilities) ? response.capabilities.filter((value: unknown): value is string => typeof value === 'string') : [];
        const missing = BRIDGE_CAPABILITIES.appstore.filter((capability) => !reported.includes(capability));
        throw new Error(`autoinstall App Store bridge is incompatible; missing ${missing.join(', ')}`);
      }
      return;
    }

    try {
      const launch = await sendSpringBoardBridgeRequest(conn, { action: 'launch_app', bundleId: 'com.apple.AppStore' }, APP_STORE_BRIDGE_STATUS_TIMEOUT_MS, signal);
      throwIfAborted(signal);
      if (launch?.launchResult !== 0) {
        lastError = new Error(`autoinstall SpringBoard launch_app (AppStore) failed: ${JSON.stringify(launch)}`);
      }
    } catch (err) {
      throwIfAborted(signal);
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    await delayWithSignal(APP_STORE_BRIDGE_POLL_INTERVAL_MS, signal);
  }

  throw new Error(`autoinstall App Store bridge did not become ready within ${APP_STORE_BRIDGE_READY_TIMEOUT_MS / 1000}s${lastError ? `: ${lastError.message}` : ''}`);
}

async function restartAppStore(conn: DeviceClient, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await execCommand(conn, 'killall AppStore PassbookUIService 2>/dev/null || true');
  throwIfAborted(signal);
  await delayWithSignal(1_000, signal);
}

export async function uninstallFromDevice(bundleId: string, device = primaryDevice()): Promise<boolean> {
  if (!SAFE_BUNDLE_ID_RE.test(bundleId)) return false;
  try {
    return await withSSH(device, (conn) => uninstallInstalledApp(conn, bundleId));
  } catch (err) {
    log.warn('device uninstall failed', { bundleId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export interface AppStoreInstallOptions {
  externalVersionId?: string;
  expectedVersion?: string;
  currentVersion?: ItunesLookupResult;
  device?: DeviceRecord;
  operationId?: string;
  onProgress?: (message: string) => void;
  waitTimeoutMs?: number;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
}

export async function installFromAppStore(bundleId: string, options: AppStoreInstallOptions = {}): Promise<InstallVerification> {
  const { externalVersionId, expectedVersion, onProgress, waitTimeoutMs = 5 * 60_000 } = options;

  if (!SAFE_BUNDLE_ID_RE.test(bundleId)) {
    throw new Error(`refusing to install App Store app with unsafe bundleId: ${JSON.stringify(bundleId)}`);
  }
  const versionId = externalVersionId && APP_EXT_VERSION_ID_RE.test(externalVersionId) ? Number(externalVersionId) : undefined;
  if (externalVersionId && versionId === undefined) {
    throw new Error(`refusing to install with non-numeric externalVersionId: ${JSON.stringify(externalVersionId)}`);
  }

  const report = (message: string) => {
    log.info(message, { bundleId, externalVersionId });
    onProgress?.(message);
  };
  const ensureNotCancelled = () => {
    if (options.isCancelled?.()) throw new Error('App Store install cancelled');
    throwIfAborted(options.signal);
  };

  ensureNotCancelled();
  report('resolving App Store id for bundle');
  const { trackId, version: latestVersion } = options.currentVersion ?? (await lookupCurrentVersion(bundleId, options.signal));
  ensureNotCancelled();
  const targetVersion = expectedVersion
    ? normalizeVersion(expectedVersion)
    : versionId === undefined
      ? normalizeVersion(latestVersion)
      : undefined;
  const listing = await lookupAppMetadataByTrackId(trackId);
  ensureNotCancelled();
  if (listing.bundleId !== bundleId || listing.price !== 0) {
    throw new Error(`App Store automation requires a verified free listing for ${bundleId}`);
  }

  return withSSH(options.device ?? primaryDevice(), async (conn) => {
    ensureNotCancelled();
    const appNames = [listing.trackName];
    let country: string | undefined;
    try {
      const locale = await execCommand(conn, 'defaults read /var/mobile/Library/Preferences/.GlobalPreferences AppleLocale 2>/dev/null', 5_000, options.signal);
      ensureNotCancelled();
      country = APP_STORE_LOCALE_RE.exec(locale.stdout.trim())?.[1]?.toUpperCase();
    } catch (error) {
      ensureNotCancelled();
      log.warn('device App Store locale could not be read; using the verified US title', { bundleId, error: error instanceof Error ? error.message : String(error) });
    }
    if (country && country !== 'US') {
      let localizedListing: Awaited<ReturnType<typeof lookupAppMetadataByTrackId>> | undefined;
      try {
        localizedListing = await lookupAppMetadataByTrackId(trackId, country);
        ensureNotCancelled();
      } catch (error) {
        ensureNotCancelled();
        log.warn('localized App Store title lookup unavailable; using the verified US title', { bundleId, country, error: error instanceof Error ? error.message : String(error) });
      }
      if (localizedListing) {
        if (localizedListing.trackId !== trackId || localizedListing.bundleId !== bundleId || localizedListing.price !== 0) {
          throw new Error(`App Store automation requires a verified free ${country} listing for ${bundleId}`);
        }
        if (!appNames.includes(localizedListing.trackName)) appNames.push(localizedListing.trackName);
      }
    }
    const existing = await findInstalledAppStoreBundle(conn, bundleId);
    ensureNotCancelled();
    if (existing) {
      report('removing the installed app before the App Store install');
      const removed = (await uninstallInstalledApp(conn, bundleId)) || (await uninstallInstalledBundle(conn, bundleId, existing));
      ensureNotCancelled();
      if (!removed) {
        throw new Error(`failed to remove the existing ${bundleId} before installing from the App Store`);
      }
    }

    report('restarting the App Store to clear pending purchases');
    await restartAppStore(conn, options.signal);

    report('bringing the App Store to the foreground');
    await ensureAppStoreForeground(conn, options.signal);
    ensureNotCancelled();
    await ensureAppStoreBridgeReady(conn, options.signal);

    try {
      ensureNotCancelled();
      report('arming headless auto-confirm and sending install request');
      await armAppStoreAutoConfirm(conn, 'Install');
      ensureNotCancelled();

      let operationId = options.operationId ?? randomUUID();
      const request: Record<string, unknown> = { action: 'install', adamId: trackId, appName: listing.trackName, appNames, verifiedPrice: listing.price, contextMode: 'fallback', operationId };
      if (versionId !== undefined) request.versionId = versionId;
      const installResponse = await sendAppStoreBridgeRequest(conn, request, 20_000, options.signal);
      ensureNotCancelled();
      if (installResponse?.requested === false && installResponse?.completed !== true) {
        throw new Error('App Store did not start the requested installation');
      }
      report(
        versionId !== undefined
          ? `App Store accepted the install request (version ${versionId}), waiting for it to land`
          : 'App Store accepted the install request, waiting for it to land',
      );

      const start = Date.now();
      const deadline = start + waitTimeoutMs;
      let lastInstallStatusAt = Number.NEGATIVE_INFINITY;
      let lastReportedAt = 0;
      let lastUnexpectedVersion: string | undefined;
      let lastInstallState: string | undefined;
      let lastInstallStatusVerified = false;
      let authorizationReported = false;
      let purchaseCompletedAt: number | undefined;
      let retriedCompletedPurchase = false;
      while (Date.now() < deadline) {
        ensureNotCancelled();
        if (lastInstallState !== 'completed' && Date.now() - lastInstallStatusAt >= APP_STORE_INSTALL_STATUS_POLL_INTERVAL_MS) {
          lastInstallStatusAt = Date.now();
          let status: unknown;
          try {
            status = await readAppStoreInstallStatus(conn);
          } catch (error) {
            ensureNotCancelled();
            log.warn('App Store install status file could not be read', { bundleId, externalVersionId, error: String(error) });
          }
          if (!currentInstallStatus({ install: status }, operationId)) {
            try {
              status = (await sendAppStoreBridgeRequest(conn, { action: 'status' }, APP_STORE_BRIDGE_STATUS_TIMEOUT_MS, options.signal)).install;
            } catch (error) {
              ensureNotCancelled();
              log.warn('App Store bridge status check failed while installation continues', { bundleId, externalVersionId, error: String(error) });
            }
          }
          ensureNotCancelled();
          const install = currentInstallStatus({ install: status }, operationId);
          lastInstallStatusVerified = Boolean(install);
          lastInstallState = typeof install?.state === 'string' ? install.state : lastInstallState;
          if (install?.state === 'completed') purchaseCompletedAt ??= Date.now();
          if (install?.state === 'failed') {
            const detail = typeof install.error === 'string' ? install.error : 'the App Store reported an installation failure';
            throw new Error(`App Store install operation failed: ${detail}`);
          }
          if ((install?.state === 'authorizing' || install?.state === 'requires_user_action') && !authorizationReported) {
            authorizationReported = true;
            report('Autoinstall is confirming the free App Store install');
          }
        }
        const bundlePath = await findInstalledAppStoreBundle(conn, bundleId);
        ensureNotCancelled();
        if (bundlePath) {
          const installedVersion = await readInstalledBundleVersions(conn, bundlePath);
          ensureNotCancelled();
          const { shortVersion } = installedVersion;
          const isVersionMatch = !targetVersion || normalizeVersion(shortVersion ?? '') === targetVersion || (shortVersion ? compareVersions(shortVersion, targetVersion) === 0 : false);
          if (!isVersionMatch) {
            const unexpectedVersion = shortVersion ?? 'unknown';
            if (lastUnexpectedVersion !== unexpectedVersion) {
              report(`waiting for App Store version ${targetVersion}; version ${unexpectedVersion} is currently installed`);
              lastUnexpectedVersion = unexpectedVersion;
            }
          } else {
            report(`install verified: ${shortVersion ?? 'unknown version'} build ${installedVersion.buildVersion ?? 'unknown'} in ${Math.round((Date.now() - start) / 1000)}s`);
            return { ...installedVersion, bundleId, appPath: bundlePath, fairPlayProtected: true, elapsedMs: Date.now() - start };
          }
        }
        if (!retriedCompletedPurchase && purchaseCompletedAt !== undefined && Date.now() - purchaseCompletedAt >= APP_STORE_COMPLETED_DOWNLOAD_RETRY_DELAY_MS && Date.now() + APP_STORE_DOWNLOAD_RETRY_MIN_REMAINING_MS < deadline) {
          ensureNotCancelled();
          report('App Store confirmed the purchase but did not install the app; retrying the download once');
          await restartAppStore(conn, options.signal);
          await ensureAppStoreForeground(conn, options.signal);
          await ensureAppStoreBridgeReady(conn, options.signal);
          ensureNotCancelled();
          await armAppStoreAutoConfirm(conn, 'Install');
          operationId = `${operationId}-download-retry-1`;
          const retryResponse = await sendAppStoreBridgeRequest(conn, { ...request, operationId }, 20_000, options.signal);
          ensureNotCancelled();
          if (retryResponse?.requested === false && retryResponse?.completed !== true) throw new Error('App Store did not start the download retry');
          retriedCompletedPurchase = true;
          purchaseCompletedAt = undefined;
          lastInstallStatusAt = Number.NEGATIVE_INFINITY;
          lastInstallStatusVerified = false;
          lastInstallState = undefined;
          authorizationReported = false;
        }
        const elapsedSec = Math.round((Date.now() - start) / 1000);
        if (elapsedSec - lastReportedAt >= 10) {
          lastReportedAt = elapsedSec;
          report(`still waiting for the App Store to finish installing (${elapsedSec}s elapsed)`);
        }
        await delayWithSignal(5_000, options.signal);
      }
      if (lastUnexpectedVersion && targetVersion) {
        throw new Error(`timed out waiting for ${bundleId} version ${targetVersion}; version ${lastUnexpectedVersion} remained installed after ${Math.round(waitTimeoutMs / 1000)}s`);
      }
      if (!lastInstallStatusVerified) {
        throw new AppStoreInstallTimeoutError(`App Store install status could not be verified for ${bundleId} within ${Math.round(waitTimeoutMs / 1000)}s; the app was not installed`);
      }
      if (lastInstallState === 'authorizing' || lastInstallState === 'requires_user_action') {
        throw new AppStoreInstallTimeoutError(`Autoinstall could not complete the free App Store confirmation for ${bundleId} within ${Math.round(waitTimeoutMs / 1000)}s`);
      }
      if (lastInstallState === 'completed') {
        throw new AppStoreInstallTimeoutError(`App Store purchase request completed but ${bundleId} was not installed within ${Math.round(waitTimeoutMs / 1000)}s`);
      }
      throw new AppStoreInstallTimeoutError(`timed out waiting for ${bundleId} to install from the App Store after ${Math.round(waitTimeoutMs / 1000)}s`);
    } finally {
      await clearAppStoreAutoConfirm(conn).catch(() => {});
    }
  }, options.signal);
}
