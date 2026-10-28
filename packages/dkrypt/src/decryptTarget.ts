import { lookupAppMetadata, lookupCurrentPlatformVersion } from '#appStoreMetadata.js';
import { listAppVersions, type AppVersionEntry } from '#versions.js';
import { compareVersions } from '#util/version.js';
import { listBuilds, listTrains, type TFBuild } from '#testflight.js';
import { artifactKeyForAppStoreVersion, artifactKeyForTestFlight } from '#artifacts.js';
import type { AppStorePlatform } from '#platform.js';

export const VERSION_SELECTOR_RE = /^v?\d+(?:\.\d+)*(?:_\d+)?$/i;

export interface ResolvedDecryptTarget {
  bundleId: string;
  platform: AppStorePlatform;
  selector?: string;
  channel: 'appstore' | 'testflight';
  externalVersionId?: string;
  testflight?: { appId: number; build: TFBuild };
  versionLabel: string;
  artifactKey: string;
  minimumOsVersion?: string;
}

export interface LatestTestFlightTargetServices {
  lookupAppMetadata: typeof lookupAppMetadata;
  listTrains: typeof listTrains;
  listBuilds: typeof listBuilds;
}

export interface DecryptTargetServices extends LatestTestFlightTargetServices {
  listAppVersions: typeof listAppVersions;
  lookupCurrentPlatformVersion: typeof lookupCurrentPlatformVersion;
}

const decryptTargetServices: DecryptTargetServices = { lookupAppMetadata, listTrains, listBuilds, listAppVersions, lookupCurrentPlatformVersion };

const latestTestFlightTargetServices: LatestTestFlightTargetServices = { lookupAppMetadata, listTrains, listBuilds };

export function normalizeVersionSelector(selector: string | undefined): string | undefined {
  const trimmed = selector?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/^v/i, '');
  if (!VERSION_SELECTOR_RE.test(trimmed)) {
    throw new Error('version must match a release tag such as 240, 234.2, or 240_109440');
  }
  return normalized;
}

function selectVersion(entries: AppVersionEntry[], requested: string | undefined): AppVersionEntry | undefined {
  if (!requested) return entries.find((entry) => entry.isLatest) ?? entries[0];
  return entries
    .filter((entry) => entry.displayVersion && compareVersions(entry.displayVersion, requested) === 0)
    .sort((a, b) => Number(b.externalVersionId) - Number(a.externalVersionId))[0];
}

export async function resolveDecryptTarget(bundleId: string, selector?: string, platform: AppStorePlatform = 'ios', services: DecryptTargetServices = decryptTargetServices): Promise<ResolvedDecryptTarget> {
  const normalized = normalizeVersionSelector(selector);
  const testFlightMatch = normalized?.match(/^(\d+(?:\.\d+)*)_(\d+)$/);

  if (testFlightMatch) {
    if (platform !== 'ios') throw new Error('TestFlight builds are available only for iOS');
    const shortVersion = testFlightMatch[1];
    const buildNumber = testFlightMatch[2];
    const { trackId } = await lookupAppMetadata(bundleId);
    const trains = await listTrains(trackId);
    const train = trains.find((candidate) => compareVersions(candidate.trainVersion, shortVersion) === 0);
    if (!train) throw new Error(`TestFlight train ${shortVersion} was not found for ${bundleId}`);
    const builds = await listBuilds(trackId, train.trainVersion);
    const build = builds.find((candidate) => candidate.cfBundleVersion === buildNumber && candidate.bundleId === bundleId);
    if (!build) throw new Error(`TestFlight build ${shortVersion}_${buildNumber} was not found for ${bundleId}`);
    return {
      bundleId,
      platform,
      selector: normalized,
      channel: 'testflight',
      testflight: { appId: trackId, build },
      versionLabel: `${build.cfBundleShortVersion}_${build.cfBundleVersion}`,
      artifactKey: artifactKeyForTestFlight(bundleId, build.id),
    };
  }

  if (platform !== 'ios') {
    const current = await services.lookupCurrentPlatformVersion(bundleId, platform);
    if (normalized && compareVersions(current.version, normalized) !== 0) {
      throw new Error(`Only the latest ${platform === 'tvos' ? 'tvOS' : 'visionOS'} release is supported`);
    }
    return {
      bundleId,
      platform,
      selector: normalized,
      channel: 'appstore',
      externalVersionId: current.externalVersionId,
      versionLabel: current.version,
      artifactKey: artifactKeyForAppStoreVersion(bundleId, current.version, current.externalVersionId, platform),
      minimumOsVersion: current.minimumOsVersion,
    };
  }

  const entries = await services.listAppVersions(bundleId);
  const selected = selectVersion(entries, normalized);
  if (!selected) {
    throw new Error(normalized ? `App Store version ${normalized} was not found for ${bundleId}` : `no latest App Store version was found for ${bundleId}`);
  }
  const versionLabel = selected.displayVersion ?? normalized ?? 'latest';

  return {
    bundleId,
    platform,
    selector: normalized,
    channel: 'appstore',
    externalVersionId: selected.externalVersionId,
    versionLabel,
    artifactKey: artifactKeyForAppStoreVersion(bundleId, versionLabel, selected.externalVersionId, platform),
    minimumOsVersion: selected.minimumOsVersion,
  };
}

export async function resolveLatestTestFlightTarget(
  bundleId: string,
  services: LatestTestFlightTargetServices = latestTestFlightTargetServices,
): Promise<ResolvedDecryptTarget> {
  const { trackId } = await services.lookupAppMetadata(bundleId);
  const trains = await services.listTrains(trackId);
  const latestFirstTrains = [...trains].sort((left, right) => compareVersions(right.trainVersion, left.trainVersion));

  for (const train of latestFirstTrains) {
    const builds = await services.listBuilds(trackId, train.trainVersion);
    const build = builds
      .filter((candidate) => {
        if (candidate.bundleId !== bundleId) return false;
        if (compareVersions(candidate.cfBundleShortVersion, train.trainVersion) !== 0) return false;
        if (!candidate.expiration) return true;
        const expiresAt = Date.parse(candidate.expiration);
        return !Number.isFinite(expiresAt) || expiresAt > Date.now();
      })
      .sort((left, right) => compareVersions(right.cfBundleVersion, left.cfBundleVersion)
        || (Date.parse(right.releaseDate ?? '') || 0) - (Date.parse(left.releaseDate ?? '') || 0))[0];

    if (!build) continue;
    const selector = `${build.cfBundleShortVersion}_${build.cfBundleVersion}`;
    return {
      bundleId,
      platform: 'ios',
      selector,
      channel: 'testflight',
      testflight: { appId: trackId, build },
      versionLabel: selector,
      artifactKey: artifactKeyForTestFlight(bundleId, build.id),
    };
  }

  throw new Error(`no available TestFlight build was found for ${bundleId}`);
}
