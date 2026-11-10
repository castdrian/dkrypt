import { getDeviceInstallBlocker } from '#deviceInstallEligibility.js';
import type { DeviceHealth } from '#deviceHealth.js';
import type { Job } from '#jobs/types.js';
import { isTestFlightVerificationFresh } from '#testflightPolicy.js';
import type { DeviceRecord, TestFlightCatalogCache } from '#store/state.js';
import { compareVersions } from '#util/version.js';
import type { TFBuild } from '#testflight.js';

export interface DeviceDispatchState {
  health?: DeviceHealth;
  testFlightCatalog?: TestFlightCatalogCache;
}

export function minimumOsVersionForBuild(build: TFBuild | undefined): string | undefined {
  const candidate = build?.minimumOsVersion ?? build?.minimumOSVersion ?? build?.minOsVersion;
  if (typeof candidate !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(candidate.trim())) return undefined;
  return candidate.trim();
}

export function testFlightAccessBlocker(
  job: Pick<Job, 'testflight'>,
  deviceId: string,
  catalog: TestFlightCatalogCache | undefined,
  now: number,
): string | undefined {
  if (!job.testflight) return undefined;
  const app = catalog?.apps.find((entry) => entry.appId === job.testflight?.appId && entry.bundleId === job.testflight?.build.bundleId);
  if (!app) return 'TestFlight access is not verified on this device';
  const deviceAccess = app.devices.find((entry) => entry.id === deviceId);
  if (!deviceAccess) return 'TestFlight access is not verified on this device';
  const verifiedAt = deviceAccess.verifiedAt;
  if (typeof verifiedAt !== 'number' || !Number.isFinite(verifiedAt)) return 'TestFlight access has not been individually verified on this device';
  if (!isTestFlightVerificationFresh(verifiedAt, now)) return 'TestFlight access verification is stale on this device';
  return undefined;
}

export function getJobDeviceBlocker(
  job: Pick<Job, 'preferredDeviceId' | 'testflight' | 'minimumOsVersion'>,
  device: Pick<DeviceRecord, 'id' | 'iosVersion'>,
  state: DeviceDispatchState,
  now = Date.now(),
): string | undefined {
  if (job.preferredDeviceId && job.preferredDeviceId !== device.id) return 'job is assigned to another device';

  const minimumOsVersion = job.minimumOsVersion ?? minimumOsVersionForBuild(job.testflight?.build);
  const deviceOsVersion = device.iosVersion?.trim();
  if (minimumOsVersion && !deviceOsVersion) return `device iOS version is unknown; cannot verify minimum iOS ${minimumOsVersion}`;
  if (minimumOsVersion && deviceOsVersion && compareVersions(deviceOsVersion, minimumOsVersion) < 0) {
    return `device is running iOS ${deviceOsVersion}; this build requires iOS ${minimumOsVersion}`;
  }

  const healthBlocker = state.health
    ? getDeviceInstallBlocker(state.health, job.testflight?.build.fileSize, job.testflight ? 'testflight' : 'appstore')
    : undefined;
  if (healthBlocker) return healthBlocker;

  return testFlightAccessBlocker(job, device.id, state.testFlightCatalog, now);
}
