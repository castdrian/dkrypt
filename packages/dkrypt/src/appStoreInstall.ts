import { randomUUID } from 'node:crypto';
import { iso31661Alpha3ToAlpha2 } from 'iso-3166';
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
import { compareVersions, normalizeVersion } from '#util/version.js';
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

function appStoreCountryCode(response: Record<string, unknown>): string {
  const storefrontCode = typeof response.countryCode === 'string' ? response.countryCode.toUpperCase() : '';
  if (/^[A-Z]{2}$/.test(storefrontCode)) return storefrontCode;
  const countryCode = iso31661Alpha3ToAlpha2[storefrontCode];
  if (!countryCode) throw new Error('StoreKit returned an unsupported App Store storefront country');
  return countryCode;
}

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
  await execCommand(conn, 'killall AppStore PassbookUIService 2>/dev/null || true', 10_000, signal);
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
  if (versionId !== undefined && !expectedVersion?.trim()) {
    throw new Error('refusing to install a pinned App Store release without its expected version');
  }

  const report = (message: string) => {
    log.info(message, { bundleId, externalVersionId });
    onProgress?.(message);
  };
  let activeSignal = options.signal;
  const ensureNotCancelled = () => {
    if (options.isCancelled?.()) throw new Error('App Store install cancelled');
    throwIfAborted(activeSignal);
  };

  ensureNotCancelled();
  report('resolving App Store id for bundle');
  return withSSH(options.device ?? primaryDevice(), async (conn, operationSignal) => {
    activeSignal = operationSignal;
    ensureNotCancelled();
    await ensureAppStoreBridgeReady(conn, operationSignal);
    ensureNotCancelled();
    let country: string;
    try {
      const storefront = await sendAppStoreBridgeRequest(conn, { action: 'storefront' }, 15_000, operationSignal);
      ensureNotCancelled();
      country = appStoreCountryCode(storefront);
    } catch (error) {
      ensureNotCancelled();
      throw new Error(`could not verify the signed-in App Store storefront before installing ${bundleId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { trackId, version: latestVersion } = await lookupCurrentVersion(bundleId, operationSignal, country);
    ensureNotCancelled();
    if (options.currentVersion && options.currentVersion.trackId !== trackId) {
      throw new Error(`the App Store track ID for ${bundleId} changed between metadata resolution and device verification`);
    }
    const targetVersion = expectedVersion
      ? normalizeVersion(expectedVersion)
      : versionId === undefined
        ? normalizeVersion(latestVersion)
        : undefined;
    if (!targetVersion) throw new Error(`could not resolve the expected App Store version for ${bundleId}`);
    let listing: Awaited<ReturnType<typeof lookupAppMetadataByTrackId>>;
    try {
      listing = await lookupAppMetadataByTrackId(trackId, country, operationSignal);
      ensureNotCancelled();
    } catch (error) {
      ensureNotCancelled();
      throw new Error(`could not verify the free ${country} App Store listing for ${bundleId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (listing.bundleId !== bundleId || listing.trackId !== trackId || listing.price !== 0) {
      throw new Error(`App Store automation requires a verified free ${country} listing for ${bundleId}`);
    }
    const appNames = [listing.trackName];
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
    await restartAppStore(conn, operationSignal);

    report('bringing the App Store to the foreground');
    await ensureAppStoreForeground(conn, operationSignal);
    ensureNotCancelled();
    await ensureAppStoreBridgeReady(conn, operationSignal);

    try {
      ensureNotCancelled();
      report('arming headless auto-confirm and sending install request');
      await armAppStoreAutoConfirm(conn, 'Install');
      ensureNotCancelled();

      let operationId = options.operationId ?? randomUUID();
      const request: Record<string, unknown> = { action: 'install', adamId: trackId, appName: listing.trackName, appNames, verifiedPrice: listing.price, contextMode: 'fallback', operationId };
      if (versionId !== undefined) request.versionId = versionId;
      const installResponse = await sendAppStoreBridgeRequest(conn, request, 20_000, operationSignal);
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
              status = (await sendAppStoreBridgeRequest(conn, { action: 'status' }, APP_STORE_BRIDGE_STATUS_TIMEOUT_MS, operationSignal)).install;
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
          await restartAppStore(conn, operationSignal);
          await ensureAppStoreForeground(conn, operationSignal);
          await ensureAppStoreBridgeReady(conn, operationSignal);
          ensureNotCancelled();
          await armAppStoreAutoConfirm(conn, 'Install');
          operationId = `${operationId}-download-retry-1`;
          const retryResponse = await sendAppStoreBridgeRequest(conn, { ...request, operationId }, 20_000, operationSignal);
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
        await delayWithSignal(5_000, operationSignal);
      }
      ensureNotCancelled();
      const finalBundlePath = await findInstalledAppStoreBundle(conn, bundleId);
      ensureNotCancelled();
      if (finalBundlePath) {
        const finalVersion = await readInstalledBundleVersions(conn, finalBundlePath);
        ensureNotCancelled();
          const matchesTarget = normalizeVersion(finalVersion.shortVersion ?? '') === targetVersion || (finalVersion.shortVersion ? compareVersions(finalVersion.shortVersion, targetVersion) === 0 : false);
        if (matchesTarget) {
          report(`install verified during final device check: ${finalVersion.shortVersion ?? 'unknown version'} build ${finalVersion.buildVersion ?? 'unknown'}`);
          return { ...finalVersion, bundleId, appPath: finalBundlePath, fairPlayProtected: true, elapsedMs: Date.now() - start };
        }
        lastUnexpectedVersion = finalVersion.shortVersion ?? 'unknown';
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
    }, options.signal, 'foreground');
}
