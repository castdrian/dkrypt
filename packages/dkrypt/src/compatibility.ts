import { getDeploymentMetadata } from '#deployment.js';
import { getCachedDeviceHealth } from '#deviceHealthCache.js';
import { getRustDeviceBridgeStatus } from '#idevice.js';
import { getDeviceHealth } from '#deviceHealth.js';
import { getEffectiveDevices, getStateDatabaseStatus } from '#store/state.js';
import { LATEST_SQLITE_SCHEMA_VERSION } from '#store/sqlite.js';

export const supportedCompatibility = {
  sqliteSchema: LATEST_SQLITE_SCHEMA_VERSION,
  rustBridge: '0.1.0',
  autoinstallMinimum: '1.4.0',
  autoinstallMajor: 1,
} as const;

export type CompatibilityState = 'supported' | 'unsupported' | 'unknown';

export interface CompatibilityRow {
  component: string;
  observed: string;
  supported: string;
  state: CompatibilityState;
  detail?: string;
}

export function evaluateAutoinstallVersion(version: string | undefined): CompatibilityState {
  if (!version) return 'unknown';
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+)|\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return 'unknown';
  if (match[4]) return 'unsupported';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === supportedCompatibility.autoinstallMajor && minor >= 4 ? 'supported' : 'unsupported';
}

export async function getAutoinstallCompatibilityRows(
  devices: Array<{ id: string; name: string }>,
  healthProvider: typeof getDeviceHealth = getDeviceHealth,
): Promise<CompatibilityRow[]> {
  const health = await Promise.all(devices.map(async (device) => {
    let latest: Awaited<ReturnType<typeof healthProvider>> | undefined;
    try {
      latest = await healthProvider(device.id, false, AbortSignal.timeout(10000));
    } catch {}
    if (latest?.bridgeHeartbeats?.springboard?.bridgeVersion) return latest;
    return getCachedDeviceHealth(device.id)?.value ?? latest;
  }));
  return devices.map((device, index) => {
    const version = health[index]?.bridgeHeartbeats?.springboard?.bridgeVersion;
    return {
      component: `${device.name} Autoinstall`,
      observed: version ?? 'not reported',
      supported: `>=${supportedCompatibility.autoinstallMinimum} <2.0.0`,
      state: evaluateAutoinstallVersion(version),
      detail: device.id,
    };
  });
}

export async function getCompatibilityMatrix(): Promise<{ policy: typeof supportedCompatibility; rows: CompatibilityRow[] }> {
  const deployment = getDeploymentMetadata();
  const database = getStateDatabaseStatus();
  const rows: CompatibilityRow[] = [
    { component: 'dkrypt deployment', observed: deployment.ref, supported: 'running build', state: deployment.ref === 'development' ? 'unknown' : 'supported', detail: deployment.id },
    { component: 'SQLite schema', observed: String(database.schemaVersion), supported: String(supportedCompatibility.sqliteSchema), state: database.schemaVersion === supportedCompatibility.sqliteSchema ? 'supported' : 'unsupported' },
  ];
  try {
    const bridge = await getRustDeviceBridgeStatus();
    rows.push({ component: 'Rust device bridge', observed: bridge.version ?? 'not reported', supported: supportedCompatibility.rustBridge, state: bridge.version ? bridge.version === supportedCompatibility.rustBridge ? 'supported' : 'unsupported' : 'unknown', detail: bridge.state });
  } catch {
    rows.push({ component: 'Rust device bridge', observed: 'unavailable', supported: supportedCompatibility.rustBridge, state: 'unknown' });
  }
  const devices = getEffectiveDevices();
  rows.push(...await getAutoinstallCompatibilityRows(devices));
  return { policy: supportedCompatibility, rows };
}
