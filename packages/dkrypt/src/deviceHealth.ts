import { config } from '#config.js';
import { trackBackgroundWork } from '#backgroundWork.js';
import { execCommand, getRustDeviceBridgeHealth, isDirectUsbDeviceAgentConnection, isRustDeviceConnection, isTestFlightRunning, probeDeviceSshTunnel, readBridgeHeartbeats, sendSpringBoardBridgeRequest, tryIoregCandidates, withSSH, type BridgeHeartbeat, type DeviceClient, type DeviceConnection, type DeviceTransport } from '#idevice.js';
import { scopedLogger } from '#logger.js';
import { EMBED_COLOR, notify } from '#notify.js';
import { notifyDeviceDispatchStateChanged, releasePinnedJobsForDevice } from '#jobs/store.js';
import { getEffectiveDevices, getEffectiveSettings, hasSustainedDeviceHealthFailures, recordDeviceActivity, recordDeviceAlertNotification, recordDeviceHealthCheck, type DeviceRecord, type DeviceSubsystemDetail, type DeviceSubsystemId } from '#store/state.js';
import { getDiskUsage } from '#util/diskUsage.js';
import { getCachedDeviceHealth, setCachedDeviceHealth } from '#deviceHealthCache.js';
import { incrementMetric, observeMetric, setGaugeMetric } from '#metrics.js';
import { throwIfAborted } from '#util/abort.js';
import { getDeviceSourceBlocker, getRootlessJailbreakBlocker, isBridgeHeartbeatFresh } from '#deviceInstallEligibility.js';
import type { DeviceInstallSource } from '#deviceInstallEligibility.js';
export { getDeviceInstallBlocker, isBridgeHeartbeatFresh } from '#deviceInstallEligibility.js';

const log = scopedLogger('idevice');

export interface DeviceHealth {
  reachable: boolean;
  transport?: DeviceTransport;
  transportState?: 'discovered' | 'pairing' | 'connecting' | 'ready' | 'degraded' | 'recovering' | 'offline' | 'unsupported';
  capabilities?: string[];
  lastSeenAt?: number;
  recoveryState?: 'stable' | 'recovering' | 'degraded' | 'offline';
  agentHeartbeatAt?: number;
  error?: string;
  jailbreakAvailable?: boolean;
  testFlightRunning?: boolean;
  testFlightBridgeReachable?: boolean;
  darkEnabled?: boolean;
  displayMode?: 'dark_awake' | 'dark_sleep' | 'restore_idle' | 'unchanged';
  autoinstallPaused?: boolean;
  autoinstallPauseReason?: string;
  batteryPauseEnabled?: boolean;
  batteryPauseThreshold?: number;
  activeOperation?: string;
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
  bridgeHeartbeats?: Partial<Record<'springboard' | 'testflight' | 'appstore', BridgeHeartbeat>>;
  subsystems?: DeviceSubsystemHealth;
  subsystemDetails?: Partial<Record<DeviceSubsystemId, DeviceSubsystemDetail>>;
  readiness?: DeviceReadiness;
  checkedAt: number;
}

export type DeviceSubsystemState = 'ready' | 'idle' | 'degraded' | 'offline' | 'unsupported' | 'unknown';

export interface DeviceSubsystemHealth {
  usb: DeviceSubsystemState;
  mux: DeviceSubsystemState;
  agent: DeviceSubsystemState;
  jailbreak?: DeviceSubsystemState;
  appStore: DeviceSubsystemState;
  testFlight: DeviceSubsystemState;
  sshTunnel: DeviceSubsystemState;
  storage: DeviceSubsystemState;
  battery: DeviceSubsystemState;
  thermal: DeviceSubsystemState;
}

export function getDeviceHealthSubsystemsWithoutAgent(
  connection: Pick<DeviceConnection, 'udid' | 'host'>,
  transport: DeviceTransport,
  sshSftpReady: boolean,
): DeviceSubsystemHealth {
  return {
    usb: transport === 'usb' ? 'ready' : 'unsupported',
    mux: 'ready',
    agent: getDeviceAgentSubsystemState(connection, false),
    jailbreak: 'unknown',
    appStore: getAppStoreSubsystemState(undefined, false),
    testFlight: 'unknown',
    sshTunnel: getDeviceSshTunnelSubsystemState(connection, sshSftpReady),
    storage: 'unknown',
    battery: 'unknown',
    thermal: 'unknown',
  };
}

export function getDeviceAgentSubsystemState(connection: Pick<DeviceConnection, 'udid' | 'host'>, agentRequestSucceeded: boolean): DeviceSubsystemState {
  if (!isRustDeviceConnection(connection)) return 'unsupported';
  return agentRequestSucceeded ? 'ready' : 'offline';
}

export function getDeviceSshTunnelSubsystemState(connection: Pick<DeviceConnection, 'udid' | 'host'>, sshSftpReady: boolean): DeviceSubsystemState {
  if (isRustDeviceConnection(connection)) return sshSftpReady ? 'ready' : 'degraded';
  return sshSftpReady ? 'ready' : 'offline';
}

function subsystemReasons(health: DeviceHealth): Partial<Record<DeviceSubsystemId, string>> {
  const readinessReasons = health.readiness?.reasons ?? [];
  const reasonFor = (term: string) => readinessReasons.find((reason) => reason.toLowerCase().includes(term));
  const reasons: Partial<Record<DeviceSubsystemId, string>> = {};
  const states = health.subsystems;
  if (!states) return reasons;
  if (states.usb === 'offline' || states.mux === 'offline') reasons.usb = health.error;
  if (states.mux === 'offline') reasons.mux = health.error;
  if (states.agent === 'offline' || states.agent === 'degraded') reasons.agent = reasonFor('device agent') ?? health.error;
  if (states.jailbreak === 'degraded' || states.jailbreak === 'offline') reasons.jailbreak = reasonFor('jailbreak') ?? reasonFor('palera1n') ?? reasonFor('dopamine');
  if (states.appStore === 'idle') reasons.appStore = 'The App Store app is not open; dkrypt can launch it when needed.';
  if (states.appStore === 'offline' || states.appStore === 'degraded') reasons.appStore = reasonFor('app store') ?? reasonFor('appstore') ?? health.error;
  if (states.testFlight === 'offline' || states.testFlight === 'degraded') reasons.testFlight = reasonFor('springboard') ?? health.error;
  if (states.sshTunnel === 'offline' || states.sshTunnel === 'degraded') reasons.sshTunnel = health.error;
  if (states.storage === 'degraded' || states.storage === 'offline') reasons.storage = reasonFor('storage');
  if (states.battery === 'degraded' || states.battery === 'offline') reasons.battery = reasonFor('battery');
  if (states.thermal === 'degraded' || states.thermal === 'offline') reasons.thermal = reasonFor('°c');
  return Object.fromEntries(Object.entries(reasons).filter(([, reason]) => Boolean(reason))) as Partial<Record<DeviceSubsystemId, string>>;
}

export function getAppStoreSubsystemState(heartbeat: BridgeHeartbeat | undefined, deviceReachable: boolean, now = Date.now()): DeviceSubsystemState {
  if (isBridgeHeartbeatFresh(heartbeat, now)) return 'ready';
  return deviceReachable ? 'idle' : 'unknown';
}

export function applyDeviceSshTunnelHealth(
  health: DeviceHealth,
  connection: Pick<DeviceConnection, 'udid' | 'host'>,
  sshSftpReady: boolean,
): DeviceHealth {
  if (!health.subsystems) return health;
  const updated: DeviceHealth = {
    ...health,
    subsystems: {
      ...health.subsystems,
      sshTunnel: getDeviceSshTunnelSubsystemState(connection, sshSftpReady),
    },
  };
  return { ...updated, readiness: getDeviceReadiness(updated) };
}

export interface DeviceReadiness {
  score: number;
  state: 'ready' | 'caution' | 'blocked';
  reasons: string[];
}

export function formatTestFlightBridgeDownDescription(deviceName: string, alertMinutes: number): string {
  return `The autoinstall SpringBoard bridge on ${deviceName} has stopped responding for at least ${alertMinutes} minutes - TestFlight installs can't run until it recovers.`;
}

export function testFlightBridgeReachability(health: Pick<DeviceHealth, 'reachable' | 'testFlightBridgeReachable'>): boolean | undefined {
  if (!health.reachable) return undefined;
  return health.testFlightBridgeReachable;
}

export function getDeviceReadiness(health: DeviceHealth, source?: DeviceInstallSource): DeviceReadiness {
  const reasons: string[] = [];
  let score = 100;
  if (!health.reachable) {
    return { score: 0, state: 'blocked', reasons: ['device is unreachable'] };
  }
  const jailbreakBlocker = getRootlessJailbreakBlocker(health);
  if (jailbreakBlocker) {
    score = 0;
    reasons.push(jailbreakBlocker);
  }
  if (health.internetAccess === false) {
    score -= 50;
    reasons.push('no internet access');
  }
  const sourceBlocker = source ? getDeviceSourceBlocker(health, source) : undefined;
  if (sourceBlocker) {
    score -= 50;
    reasons.push(sourceBlocker);
  } else if (!source && health.testFlightBridgeReachable === false) {
    score -= 50;
    reasons.push('autoinstall SpringBoard bridge is unresponsive');
  }
  if (health.subsystems?.agent === 'degraded' || health.subsystems?.agent === 'offline') {
    score -= 30;
    reasons.push('device agent is unavailable');
  }
  if (health.bridgeHeartbeats?.springboard && !isBridgeHeartbeatFresh(health.bridgeHeartbeats.springboard)) {
    score -= 50;
    reasons.push('autoinstall SpringBoard heartbeat is stale');
  }
  if (health.batteryPercent !== undefined && !health.batteryCharging && health.batteryPercent < 15) {
    score -= 20;
    reasons.push(`battery is ${health.batteryPercent}% and not charging`);
  }
  if (health.batteryTemperatureC !== undefined && health.batteryTemperatureC >= 45) {
    score -= 25;
    reasons.push(`battery is ${health.batteryTemperatureC.toFixed(1)}°C`);
  }
  if (health.storageUsedPercent !== undefined && health.storageUsedPercent >= 0.95) {
    score -= 25;
    reasons.push(`storage is ${Math.round(health.storageUsedPercent * 100)}% full`);
  }
  score = Math.max(0, score);
  return { score, state: jailbreakBlocker ? 'blocked' : score >= 80 ? 'ready' : score >= 55 ? 'caution' : 'blocked', reasons };
}

function parseIoregValue(output: string, key: string): string | undefined {
  return new RegExp(`"${key}" = ([^\\n]+)`).exec(output)?.[1]?.trim();
}

interface BatteryStatus {
  batteryPercent?: number;
  batteryCharging?: boolean;
  batteryTemperatureC?: number;
  batteryCycleCount?: number;
  batteryHealthPercent?: number;
  batteryDesignCapacityMah?: number;
  batteryMaxCapacityMah?: number;
}

const IOREG_CANDIDATES = ['ioreg', '/usr/sbin/ioreg', '/cores/binpack/usr/sbin/ioreg', '/cores/binpack/usr/bin/ioreg'];
const IOREG_BATTERY_CLASS = 'AppleARMPMUCharger';

async function runIoreg(conn: DeviceClient): Promise<string | undefined> {
  return tryIoregCandidates(conn, IOREG_BATTERY_CLASS, IOREG_CANDIDATES);
}

async function queryBatteryStatus(conn: DeviceClient): Promise<BatteryStatus | undefined> {
  const stdout = await runIoreg(conn);
  if (!stdout) {
    log.warn('ioreg is not available on the device via any known path - battery telemetry disabled');
    return undefined;
  }

  const currentCapacity = Number(parseIoregValue(stdout, 'CurrentCapacity'));
  const maxCapacity = Number(parseIoregValue(stdout, 'MaxCapacity'));
  const isCharging = parseIoregValue(stdout, 'IsCharging');
  const temperature = Number(parseIoregValue(stdout, 'Temperature'));
  const cycleCount = Number(parseIoregValue(stdout, 'CycleCount'));
  const designCapacity = Number(parseIoregValue(stdout, 'DesignCapacity'));
  const rawMaxCapacity = Number(parseIoregValue(stdout, 'AppleRawMaxCapacity'));

  if (!Number.isFinite(currentCapacity) || !maxCapacity) {
    log.warn('ioreg output did not contain the expected AppleARMPMUCharger fields', { sample: stdout.slice(0, 500) });
  }

  return {
    batteryPercent: Number.isFinite(currentCapacity) && maxCapacity ? Math.round((currentCapacity / maxCapacity) * 100) : undefined,
    batteryCharging: isCharging === undefined ? undefined : isCharging === 'Yes',
    batteryTemperatureC: Number.isFinite(temperature) ? temperature / 100 : undefined,
    batteryCycleCount: Number.isFinite(cycleCount) ? cycleCount : undefined,
    batteryHealthPercent:
      Number.isFinite(designCapacity) && designCapacity > 0 && Number.isFinite(rawMaxCapacity)
        ? Math.round((rawMaxCapacity / designCapacity) * 100)
        : undefined,
    batteryDesignCapacityMah: Number.isFinite(designCapacity) ? designCapacity : undefined,
    batteryMaxCapacityMah: Number.isFinite(rawMaxCapacity) ? rawMaxCapacity : undefined,
  };
}

interface DeviceStorage {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
}

export function parseDeviceStorageDf(stdout: string): DeviceStorage | undefined {
  const lines = stdout.trim().split('\n').filter(Boolean);
  let parsed: { totalKb: number; freeKb: number } | undefined;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    const match = line.match(/(?:^|\s)(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%(?:\s|$)/);
    if (!match) continue;
    parsed = {
      totalKb: Number(match[1]),
      freeKb: Number(match[3]),
    };
    break;
  }

  if (!parsed) return undefined;

  const totalBytes = parsed.totalKb * 1024;
  const freeBytes = parsed.freeKb * 1024;
  const usedBytes = totalBytes - freeBytes;
  if (
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(usedBytes) ||
    !Number.isFinite(freeBytes) ||
    totalBytes <= 0 ||
    freeBytes < 0 ||
    freeBytes > totalBytes
  ) {
    return undefined;
  }

  return { totalBytes, usedBytes, freeBytes, usedPercent: usedBytes / totalBytes };
}

async function queryDeviceStorage(conn: DeviceClient): Promise<DeviceStorage | undefined> {
  const { stdout, code } = await execCommand(conn, 'df -k /private/var 2>&1');
  if (code !== 0) {
    log.warn('device storage df query failed', { code, output: stdout.slice(0, 200) });
    return undefined;
  }

  const storage = parseDeviceStorageDf(stdout);
  if (!storage) {
    log.warn('device storage df output did not contain parseable numbers', { sample: stdout.slice(-200) });
  }
  return storage;
}

interface NetworkStatus {
  networkConnected: boolean;
  internetAccess?: boolean;
  ipAddress?: string;
  networkInterface?: string;
}

const IFCONFIG_CANDIDATES = ['ifconfig', '/sbin/ifconfig', '/var/jb/sbin/ifconfig', '/cores/binpack/sbin/ifconfig'];

const CAPTIVE_CHECK_URL = 'http://captive.apple.com/hotspot-detect.html';

interface SpringBoardStatusResult {
  ok: boolean;
  value?: {
    darkEnabled?: boolean;
    displayMode?: DeviceHealth['displayMode'];
    autoinstallPaused?: boolean;
    pauseReason?: string | null;
    batteryPauseEnabled?: boolean;
    batteryPauseThreshold?: number;
    batteryPercent?: number | null;
    batteryCharging?: boolean;
    activeOperation?: string | null;
    screenIsOn?: boolean;
    backlightState?: number;
  };
}

export interface DeviceHealthQueries {
  testFlightRunning: () => Promise<boolean>;
  springBoardStatus: () => Promise<SpringBoardStatusResult>;
  jailbreakAvailable: () => Promise<boolean | undefined>;
  battery: () => Promise<BatteryStatus | undefined>;
  storage: () => Promise<DeviceStorage | undefined>;
  network: () => Promise<NetworkStatus | undefined>;
  bridgeHeartbeats: () => Promise<Partial<Record<'springboard' | 'testflight' | 'appstore', BridgeHeartbeat>>>;
}

export interface DeviceTelemetry {
  testFlightRunning: boolean;
  testFlightBridgeReachable?: boolean;
  jailbreakAvailable?: boolean;
  darkEnabled?: boolean;
  displayMode?: DeviceHealth['displayMode'];
  autoinstallPaused?: boolean;
  autoinstallPauseReason?: string;
  batteryPauseEnabled?: boolean;
  batteryPauseThreshold?: number;
  activeOperation?: string;
  screenIsOn?: boolean;
  backlightState?: number;
  battery?: BatteryStatus;
  storage?: DeviceStorage;
  network?: NetworkStatus;
  bridgeHeartbeats: Partial<Record<'springboard' | 'testflight' | 'appstore', BridgeHeartbeat>>;
}

async function runHealthQuery<T>(name: string, query: () => Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  try {
    const result = await query();
    throwIfAborted(signal);
    return result;
  } catch (err) {
    throwIfAborted(signal);
    log.warn('device telemetry query failed', { name, error: String(err) });
    return fallback;
  }
}

export async function collectDeviceTelemetry(queries: DeviceHealthQueries, signal?: AbortSignal): Promise<DeviceTelemetry> {
  const testFlightRunning = await runHealthQuery('TestFlight process status', queries.testFlightRunning, false, signal);
  const springBoardStatus = await runHealthQuery('SpringBoard bridge status', queries.springBoardStatus, { ok: false }, signal);
  const jailbreakAvailable = await runHealthQuery('rootless jailbreak status', queries.jailbreakAvailable, undefined, signal);
  const battery = await runHealthQuery('battery status', queries.battery, undefined, signal);
  const storage = await runHealthQuery('storage status', queries.storage, undefined, signal);
  const network = await runHealthQuery('network status', queries.network, undefined, signal);
  const bridgeHeartbeats = await runHealthQuery('autoinstall heartbeats', queries.bridgeHeartbeats, {}, signal);
  const springBoardBatteryPercent = typeof springBoardStatus.value?.batteryPercent === 'number' ? springBoardStatus.value.batteryPercent : undefined;
  const springBoardBatteryCharging = typeof springBoardStatus.value?.batteryCharging === 'boolean' ? springBoardStatus.value.batteryCharging : undefined;

  return {
    testFlightRunning,
    testFlightBridgeReachable: springBoardStatus.ok,
    jailbreakAvailable,
    darkEnabled: springBoardStatus.value?.darkEnabled,
    displayMode: springBoardStatus.value?.displayMode,
    autoinstallPaused: springBoardStatus.value?.autoinstallPaused,
    autoinstallPauseReason: typeof springBoardStatus.value?.pauseReason === 'string' ? springBoardStatus.value.pauseReason : undefined,
    batteryPauseEnabled: springBoardStatus.value?.batteryPauseEnabled,
    batteryPauseThreshold: springBoardStatus.value?.batteryPauseThreshold,
    activeOperation: typeof springBoardStatus.value?.activeOperation === 'string' ? springBoardStatus.value.activeOperation : undefined,
    screenIsOn: springBoardStatus.value?.screenIsOn,
    backlightState: springBoardStatus.value?.backlightState,
    battery: battery ? {
      ...battery,
      batteryPercent: springBoardBatteryPercent ?? battery.batteryPercent,
      batteryCharging: springBoardBatteryCharging ?? battery.batteryCharging,
    } : springBoardBatteryPercent === undefined && springBoardBatteryCharging === undefined ? undefined : {
      batteryPercent: springBoardBatteryPercent,
      batteryCharging: springBoardBatteryCharging,
    },
    storage,
    network,
    bridgeHeartbeats,
  };
}

async function runIfconfig(conn: DeviceClient): Promise<string | undefined> {
  for (const bin of IFCONFIG_CANDIDATES) {
    const { stdout, code } = await execCommand(conn, `${bin} 2>/dev/null`);
    if (code === 0 && stdout.includes('inet ')) return stdout;
  }
  return undefined;
}

function parsePrimaryIPv4(ifconfigOutput: string): { ipAddress: string; iface: string } | undefined {
  let currentIface = '';
  for (const line of ifconfigOutput.split('\n')) {
    const ifaceMatch = line.match(/^([a-z0-9]+):\s/i);
    if (ifaceMatch) {
      currentIface = ifaceMatch[1];
      continue;
    }
    const inetMatch = line.match(/^\s+inet (\d+\.\d+\.\d+\.\d+)/);
    if (!inetMatch) continue;
    const ip = inetMatch[1];
    if (currentIface === 'lo0' || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
    return { ipAddress: ip, iface: currentIface };
  }
  return undefined;
}

async function queryNetworkStatus(conn: DeviceClient): Promise<NetworkStatus | undefined> {
  const ifconfigOutput = await runIfconfig(conn);
  if (!ifconfigOutput) {
    log.warn('ifconfig is not available on the device via any known path - network telemetry disabled');
    return undefined;
  }

  const primary = parsePrimaryIPv4(ifconfigOutput);
  if (!primary) return { networkConnected: false };

  const { stdout, code } = await execCommand(conn, `curl -s --max-time 6 ${CAPTIVE_CHECK_URL} 2>/dev/null`);
  const internetAccess = code === 0 && /Success/i.test(stdout);
  return { networkConnected: true, internetAccess, ipAddress: primary.ipAddress, networkInterface: primary.iface };
}

const HEALTH_CACHE_TTL_MS = 45_000;
const HEALTH_FAILURE_CACHE_TTL_MS = 2 * 60_000;
const HEALTH_FAILURE_CONFIRMATIONS = 3;

export function coalesceDeviceHealthRequest<T>(
  pending: Map<string, Promise<T>>,
  deviceId: string,
  request: () => Promise<T>,
): Promise<T> {
  const existing = pending.get(deviceId);
  if (existing) return existing;

  let next: Promise<T>;
  try {
    next = request();
  } catch (error) {
    next = Promise.reject(error);
  }
  const tracked = next.finally(() => {
    if (pending.get(deviceId) === tracked) pending.delete(deviceId);
  });
  pending.set(deviceId, tracked);
  return tracked;
}

export class DeviceHealthRefreshQueue {
  private readonly active = new Map<string, { promise: Promise<void>; running: boolean; rerun: boolean }>();

  request(deviceId: string, refresh: () => Promise<void>, waitFor?: Promise<unknown>): Promise<void> {
    const current = this.active.get(deviceId);
    if (current) {
      if (current.running) current.rerun = true;
      return current.promise;
    }

    const state = { promise: Promise.resolve(), running: false, rerun: false };
    const run = async () => {
      if (waitFor) await waitFor.catch(() => undefined);
      let failed = false;
      let failure: unknown;
      do {
        state.rerun = false;
        state.running = true;
        try {
          await refresh();
          failed = false;
          failure = undefined;
        } catch (error) {
          failed = true;
          failure = error;
        }
      } while (state.rerun);
      if (failed) throw failure;
    };
    state.promise = run().finally(() => {
      if (this.active.get(deviceId) === state) this.active.delete(deviceId);
    });
    this.active.set(deviceId, state);
    return state.promise;
  }
}

export function stabilizeDeviceHealth(previous: DeviceHealth | undefined, next: DeviceHealth, consecutiveFailures: number): DeviceHealth {
  if (next.reachable && getRootlessJailbreakBlocker(next)) return next;
  const nextReadiness = next.readiness ?? getDeviceReadiness(next);
  const previousReadiness = previous?.readiness ?? (previous ? getDeviceReadiness(previous) : undefined);
  const nextIsHealthy = next.reachable && nextReadiness.state !== 'blocked';
  const previousIsHealthy = previous?.reachable === true && previousReadiness?.state !== 'blocked';
  if (nextIsHealthy || !previousIsHealthy || consecutiveFailures >= HEALTH_FAILURE_CONFIRMATIONS) return next;
  return { ...previous, checkedAt: next.checkedAt };
}

const pendingDeviceHealth = new Map<string, Promise<DeviceHealth>>();
const deviceHealthFailures = new Map<string, number>();
const lastKnownGoodDeviceHealth = new Map<string, DeviceHealth>();
const deviceAvailabilityTransports = new Set<string>();

function updateDeviceAvailabilityMetrics(): void {
  const devices = getEffectiveDevices().filter((device) => device.enabled);
  const groups = new Map<string, { enabled: number; available: number; storageDevices: number; storageUsedPercent?: number; storageFreeBytes: number }>();
  for (const device of devices) {
    const health = getCachedDeviceHealth(device.id)?.value;
    const transport = health?.transport ?? device.transport ?? (device.udid ? 'usb' : 'wifi');
    const group = groups.get(transport) ?? { enabled: 0, available: 0, storageDevices: 0, storageFreeBytes: 0 };
    group.enabled += 1;
    if (health?.reachable) group.available += 1;
    const hasStorage = typeof health?.storageUsedPercent === 'number' || typeof health?.storageFreeBytes === 'number';
    if (hasStorage) group.storageDevices += 1;
    if (typeof health?.storageUsedPercent === 'number') group.storageUsedPercent = Math.max(group.storageUsedPercent ?? 0, health.storageUsedPercent * 100);
    if (typeof health?.storageFreeBytes === 'number') group.storageFreeBytes += health.storageFreeBytes;
    groups.set(transport, group);
  }
  for (const transport of deviceAvailabilityTransports) {
    if (groups.has(transport)) continue;
    setGaugeMetric('devices_available', 0, { transport });
    setGaugeMetric('devices_enabled', 0, { transport });
    setGaugeMetric('device_storage_available', 0, { transport });
    setGaugeMetric('device_storage_used_percent', 0, { transport });
    setGaugeMetric('device_storage_free_bytes', 0, { transport });
  }
  deviceAvailabilityTransports.clear();
  for (const [transport, group] of groups) {
    deviceAvailabilityTransports.add(transport);
    setGaugeMetric('devices_available', group.available, { transport });
    setGaugeMetric('devices_enabled', group.enabled, { transport });
    setGaugeMetric('device_storage_available', group.storageDevices, { transport });
    setGaugeMetric('device_storage_used_percent', group.storageUsedPercent ?? 0, { transport });
    setGaugeMetric('device_storage_free_bytes', group.storageFreeBytes, { transport });
  }
}

function cacheDeviceHealth(deviceId: string, value: DeviceHealth): void {
  const previous = getCachedDeviceHealth(deviceId)?.value;
  const readiness = value.readiness ?? getDeviceReadiness(value);
  incrementMetric('device_health_probes_total', { transport: value.transport ?? 'unknown', outcome: value.reachable ? readiness.state : 'offline' });
  if (previous?.reachable === false && value.reachable) incrementMetric('device_reconnects_total', { transport: value.transport ?? 'unknown' });
  for (const [service, heartbeat] of Object.entries(value.bridgeHeartbeats ?? {})) {
    if (typeof heartbeat?.at === 'number') observeMetric('device_agent_heartbeat_age_ms', Math.max(0, Date.now() - heartbeat.at * 1000), { service, transport: value.transport ?? 'unknown' });
  }
  if (value.reachable && readiness.state !== 'blocked') {
    deviceHealthFailures.delete(deviceId);
    lastKnownGoodDeviceHealth.set(deviceId, value);
    setCachedDeviceHealth(deviceId, value);
    updateDeviceAvailabilityMetrics();
    return;
  }

  const failures = (deviceHealthFailures.get(deviceId) ?? 0) + 1;
  deviceHealthFailures.set(deviceId, failures);
  setCachedDeviceHealth(deviceId, stabilizeDeviceHealth(lastKnownGoodDeviceHealth.get(deviceId), value, failures));
  updateDeviceAvailabilityMetrics();
}

async function computeDeviceHealth(device: DeviceRecord, signal?: AbortSignal): Promise<DeviceHealth> {
  const bridgeHealthPromise = isRustDeviceConnection(device)
    ? getRustDeviceBridgeHealth(device).catch((error) => {
      if (!signal?.aborted) log.warn('Rust device bridge health lookup failed', { deviceId: device.id, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    })
    : Promise.resolve(undefined);
  let agentHeartbeatAt: number | undefined;
  try {
    const telemetry = await withSSH(device, async (conn, operationSignal) => {
      const trackAgentHeartbeat = <T>(query: () => Promise<T>) => async (): Promise<T> => {
        const value = await query();
        if ('transport' in conn && conn.transport === 'autoinstall') agentHeartbeatAt = Date.now();
        return value;
      };
      return collectDeviceTelemetry({
        testFlightRunning: trackAgentHeartbeat(() => isTestFlightRunning(conn)),
        springBoardStatus: trackAgentHeartbeat(() => sendSpringBoardBridgeRequest(conn, { action: 'screen_status' }, 8_000).then((value) => ({ ok: true, value }))),
        jailbreakAvailable: trackAgentHeartbeat(async () => {
          const { code } = await execCommand(conn, 'test -d /var/jb');
          return code === 0 ? true : code === 1 ? false : undefined;
        }),
        battery: trackAgentHeartbeat(() => queryBatteryStatus(conn)),
        storage: trackAgentHeartbeat(() => queryDeviceStorage(conn)),
        network: trackAgentHeartbeat(() => queryNetworkStatus(conn)),
        bridgeHeartbeats: trackAgentHeartbeat(() => readBridgeHeartbeats(conn)),
      }, operationSignal);
    }, signal, 'background');
    const bridge = await bridgeHealthPromise;
    const sshSftpReady = await probeDeviceSshTunnel(device, signal);
    const health: DeviceHealth = {
      reachable: true,
      transport: device.transport ?? (device.udid ? 'usb' : 'wifi'),
      transportState: 'ready',
      capabilities: bridge?.capabilities,
      lastSeenAt: Date.now(),
      recoveryState: 'stable',
      agentHeartbeatAt,
      testFlightRunning: telemetry.testFlightRunning,
      testFlightBridgeReachable: telemetry.testFlightBridgeReachable,
      jailbreakAvailable: telemetry.jailbreakAvailable,
      darkEnabled: telemetry.darkEnabled,
      displayMode: telemetry.displayMode,
      autoinstallPaused: telemetry.autoinstallPaused,
      autoinstallPauseReason: telemetry.autoinstallPauseReason,
      batteryPauseEnabled: telemetry.batteryPauseEnabled,
      batteryPauseThreshold: telemetry.batteryPauseThreshold,
      activeOperation: telemetry.activeOperation,
      screenIsOn: telemetry.screenIsOn,
      backlightState: telemetry.backlightState,
      batteryPercent: telemetry.battery?.batteryPercent,
      batteryCharging: telemetry.battery?.batteryCharging,
      batteryTemperatureC: telemetry.battery?.batteryTemperatureC,
      batteryCycleCount: telemetry.battery?.batteryCycleCount,
      batteryHealthPercent: telemetry.battery?.batteryHealthPercent,
      batteryDesignCapacityMah: telemetry.battery?.batteryDesignCapacityMah,
      batteryMaxCapacityMah: telemetry.battery?.batteryMaxCapacityMah,
      storageTotalBytes: telemetry.storage?.totalBytes,
      storageUsedBytes: telemetry.storage?.usedBytes,
      storageFreeBytes: telemetry.storage?.freeBytes,
      storageUsedPercent: telemetry.storage?.usedPercent,
      networkConnected: telemetry.network?.networkConnected,
      internetAccess: telemetry.network?.internetAccess,
      networkIpAddress: telemetry.network?.ipAddress,
      networkInterface: telemetry.network?.networkInterface,
      bridgeHeartbeats: telemetry.bridgeHeartbeats,
      subsystems: {
        usb: device.transport === 'usb' ? 'ready' : 'unsupported',
        mux: 'ready',
        agent: getDeviceAgentSubsystemState(device, true),
        jailbreak: telemetry.jailbreakAvailable === undefined ? 'unknown' : telemetry.jailbreakAvailable ? 'ready' : 'unsupported',
        appStore: getAppStoreSubsystemState(telemetry.bridgeHeartbeats.appstore, true),
        testFlight: isBridgeHeartbeatFresh(telemetry.bridgeHeartbeats.testflight) ? 'ready' : 'unknown',
        sshTunnel: getDeviceSshTunnelSubsystemState(device, sshSftpReady),
        storage: telemetry.storage ? 'ready' : 'unknown',
        battery: telemetry.battery ? 'ready' : 'unknown',
        thermal: telemetry.battery?.batteryTemperatureC === undefined ? 'unknown' : 'ready',
      },
      checkedAt: Date.now(),
    };
    return applyDeviceSshTunnelHealth(health, device, sshSftpReady);
  } catch (err) {
    throwIfAborted(signal);
    const error = err instanceof Error ? err.message : String(err);
    log.warn('device health check failed', { deviceId: device.id, error });
    if (isRustDeviceConnection(device)) {
      try {
        const bridge = await bridgeHealthPromise;
        throwIfAborted(signal);
        if (bridge?.state === 'ready') {
          const sshSftpReady = await probeDeviceSshTunnel(device, signal);
          const health: DeviceHealth = {
            reachable: true,
            transport: bridge.transport,
            transportState: 'degraded',
            capabilities: bridge.capabilities,
            lastSeenAt: Date.now(),
            recoveryState: 'degraded',
            agentHeartbeatAt,
            error: `device agent unavailable: ${error}`,
            testFlightBridgeReachable: undefined,
            subsystems: getDeviceHealthSubsystemsWithoutAgent(device, bridge.transport, sshSftpReady),
            checkedAt: Date.now(),
          };
          return applyDeviceSshTunnelHealth(health, device, sshSftpReady);
        }
      } catch (bridgeError) {
        throwIfAborted(signal);
        log.warn('Rust device bridge health query failed', { deviceId: device.id, error: String(bridgeError) });
      }
    }
    const health: DeviceHealth = {
      reachable: false,
      transport: device.transport ?? (device.udid ? 'usb' : 'wifi'),
      transportState: 'offline',
      recoveryState: 'offline',
      error,
      subsystems: {
        usb: device.transport === 'usb' ? 'offline' : 'unsupported',
        mux: device.transport === 'usb' ? 'offline' : 'unsupported',
        agent: getDeviceAgentSubsystemState(device, false),
        jailbreak: 'unknown',
        appStore: 'offline',
        testFlight: 'offline',
        sshTunnel: device.transport === 'usb' ? 'offline' : 'degraded',
        storage: 'unknown',
        battery: 'unknown',
        thermal: 'unknown',
      },
      checkedAt: Date.now(),
    };
    return { ...health, readiness: getDeviceReadiness(health) };
  }
}

export function peekPrimaryDeviceHealth(): DeviceHealth | undefined {
  const devices = getEffectiveDevices().filter((d) => d.enabled);
  const primary = devices.find((d) => d.isPrimary) ?? devices[0];
  if (!primary) return undefined;
  return getCachedDeviceHealth(primary.id)?.value;
}

export async function getDeviceHealth(deviceId: string, force = false, signal?: AbortSignal): Promise<DeviceHealth> {
  throwIfAborted(signal);
  const cached = getCachedDeviceHealth(deviceId);
  const cacheTtl = cached?.value.reachable === true && cached.value.testFlightBridgeReachable !== false
    ? HEALTH_CACHE_TTL_MS
    : HEALTH_FAILURE_CACHE_TTL_MS;
  if (!force && cached && Date.now() - cached.at < cacheTtl) return cached.value;
  const request = async () => {
    const device = getEffectiveDevices().find((d) => d.id === deviceId);
    if (!device) {
      const missing: DeviceHealth = { reachable: false, error: 'device not found', checkedAt: Date.now(), readiness: { score: 0, state: 'blocked', reasons: ['device is unreachable'] } };
      return missing;
    }
    const result = await computeDeviceHealth(device, signal);
    throwIfAborted(signal);
    cacheDeviceHealth(deviceId, result);
    return result;
  };
  const value = signal
    ? await request()
    : await coalesceDeviceHealthRequest(pendingDeviceHealth, deviceId, request);
  throwIfAborted(signal);
  return getCachedDeviceHealth(deviceId)?.value ?? value;
}

const HEALTH_POLL_INTERVAL_MS = 5 * 60_000;

interface DeviceAlertState {
  unreachableSince?: number;
  offlineAlertSentAt?: number;
  batteryHotAlertSentAt?: number;
  batteryLowAlertSentAt?: number;
  deviceStorageAlertSentAt?: number;
  bridgeEverReachable: boolean;
  bridgeUnreachableSince?: number;
  bridgeDownAlertSentAt?: number;
}

const alertStates = new Map<string, DeviceAlertState>();
const lastActivityState = new Map<string, { reachable: boolean; bridgeReachable?: boolean }>();

function alertStateFor(deviceId: string): DeviceAlertState {
  let s = alertStates.get(deviceId);
  if (!s) {
    s = { bridgeEverReachable: false };
    alertStates.set(deviceId, s);
  }
  return s;
}

async function checkOfflineAlert(device: DeviceRecord, reachable: boolean): Promise<void> {
  const s = alertStateFor(device.id);
  if (reachable) {
    const recovered = s.offlineAlertSentAt !== undefined;
    s.unreachableSince = undefined;
    s.offlineAlertSentAt = undefined;
    if (recovered) {
      recordDeviceAlertNotification({
        deviceId: device.id,
        groupKey: `device-recovered:${device.id}`,
        title: 'Device recovered',
        message: `${device.name} is reachable again.`,
        severity: 'success',
      });
    }
    return;
  }

  if (!hasSustainedDeviceHealthFailures(device.id)) return;

  if (s.unreachableSince === undefined) {
    s.unreachableSince = Date.now();
    releasePinnedJobsForDevice(device.id);
  }
  if (s.offlineAlertSentAt !== undefined) return;

  const settings = getEffectiveSettings();
  const thresholdMs = settings.deviceOfflineAlertMinutes * 60_000;
  if (Date.now() - s.unreachableSince < thresholdMs) return;

  s.offlineAlertSentAt = Date.now();
  const message = `${device.name} has been unreachable for at least ${settings.deviceOfflineAlertMinutes} minutes. Decrypts assigned to it cannot run until it recovers.`;
  recordDeviceAlertNotification({
    deviceId: device.id,
    groupKey: `device-unreachable:${device.id}`,
    title: 'Device unreachable',
    message,
    severity: 'error',
  });
  await notify('deviceOffline', {
    title: 'Device unreachable',
    description: message,
    color: EMBED_COLOR.err,
  });
}

async function checkBatteryHotAlert(device: DeviceRecord, tempC: number | undefined): Promise<void> {
  if (tempC === undefined) return;
  const s = alertStateFor(device.id);
  const settings = getEffectiveSettings();

  if (tempC < settings.batteryHotAlertC - 3) {
    s.batteryHotAlertSentAt = undefined;
    return;
  }
  if (tempC < settings.batteryHotAlertC || s.batteryHotAlertSentAt !== undefined) return;

  s.batteryHotAlertSentAt = Date.now();
  recordDeviceAlertNotification({
    deviceId: device.id,
    groupKey: `device-battery-hot:${device.id}`,
    title: 'Device running hot',
    message: `${device.name}'s battery temperature reached ${tempC.toFixed(1)}°C (alert threshold ${settings.batteryHotAlertC}°C).`,
    severity: 'warning',
  });
  await notify('deviceBatteryHot', {
    title: 'iDevice running hot',
    description: `${device.name}'s battery temperature reached ${tempC.toFixed(1)}°C (alert threshold ${settings.batteryHotAlertC}°C).`,
    color: EMBED_COLOR.warn,
  });
}

async function checkBatteryLowAlert(device: DeviceRecord, percent: number | undefined, charging: boolean | undefined): Promise<void> {
  if (percent === undefined) return;
  const s = alertStateFor(device.id);
  const settings = getEffectiveSettings();

  if (charging || percent > settings.batteryLowAlertPercent + 5) {
    s.batteryLowAlertSentAt = undefined;
    return;
  }
  if (percent > settings.batteryLowAlertPercent || s.batteryLowAlertSentAt !== undefined) return;

  s.batteryLowAlertSentAt = Date.now();
  recordDeviceAlertNotification({
    deviceId: device.id,
    groupKey: `device-battery-low:${device.id}`,
    title: 'Device battery low',
    message: `${device.name}'s battery is at ${percent}% and not charging (alert threshold ${settings.batteryLowAlertPercent}%).`,
    severity: 'warning',
  });
  await notify('deviceBatteryLow', {
    title: 'iDevice battery low',
    description: `${device.name}'s battery is at ${percent}% and not charging (alert threshold ${settings.batteryLowAlertPercent}%).`,
    color: EMBED_COLOR.warn,
  });
}

async function checkDeviceStorageAlert(device: DeviceRecord, usedPercent: number | undefined): Promise<void> {
  if (usedPercent === undefined) return;
  const s = alertStateFor(device.id);
  const settings = getEffectiveSettings();
  const percent = usedPercent * 100;

  if (percent < settings.deviceStorageAlertPercent - 5) {
    s.deviceStorageAlertSentAt = undefined;
    return;
  }
  if (percent < settings.deviceStorageAlertPercent || s.deviceStorageAlertSentAt !== undefined) return;

  s.deviceStorageAlertSentAt = Date.now();
  recordDeviceAlertNotification({
    deviceId: device.id,
    groupKey: `device-storage-low:${device.id}`,
    title: 'Device storage running low',
    message: `${device.name}'s storage is ${Math.round(percent)}% full (alert threshold ${settings.deviceStorageAlertPercent}%). Decrypts and TestFlight installs need available storage.`,
    severity: 'warning',
  });
  await notify('deviceStorageLow', {
    title: 'iDevice storage running low',
    description: `${device.name}'s storage is ${Math.round(percent)}% full (alert threshold ${settings.deviceStorageAlertPercent}%) - decrypts and TestFlight installs need room to work in.`,
    color: EMBED_COLOR.warn,
  });
}

let diskFullAlertSentAt: number | undefined;

async function checkDiskFullAlert(): Promise<void> {
  const usage = getDiskUsage(config.artifactDir);
  if (!usage) return;
  const settings = getEffectiveSettings();
  const percent = usage.usedPercent * 100;

  if (percent < settings.diskFullAlertPercent - 5) {
    diskFullAlertSentAt = undefined;
    return;
  }
  if (percent < settings.diskFullAlertPercent || diskFullAlertSentAt !== undefined) return;

  diskFullAlertSentAt = Date.now();
  await notify('diskFull', {
    title: 'Staging disk running low',
    description: `${config.artifactDir} is ${Math.round(percent)}% full (alert threshold ${settings.diskFullAlertPercent}%) - decrypts will start failing once it fills up.`,
    color: EMBED_COLOR.warn,
  });
}

async function checkTestFlightBridgeAlert(device: DeviceRecord, reachable: boolean): Promise<void> {
  const s = alertStateFor(device.id);
  if (reachable) {
    const recovered = s.bridgeDownAlertSentAt !== undefined;
    s.bridgeEverReachable = true;
    s.bridgeUnreachableSince = undefined;
    s.bridgeDownAlertSentAt = undefined;
    if (recovered) {
      recordDeviceAlertNotification({
        deviceId: device.id,
        groupKey: `device-testflight-bridge-recovered:${device.id}`,
        title: 'TestFlight bridge recovered',
        message: `${device.name}'s TestFlight bridge is responding again.`,
        severity: 'success',
      });
    }
    return;
  }
  if (!s.bridgeEverReachable) return;

  if (s.bridgeUnreachableSince === undefined) s.bridgeUnreachableSince = Date.now();
  if (s.bridgeDownAlertSentAt !== undefined) return;

  const settings = getEffectiveSettings();
  const thresholdMs = settings.testFlightBridgeAlertMinutes * 60_000;
  if (Date.now() - s.bridgeUnreachableSince < thresholdMs) return;

  s.bridgeDownAlertSentAt = Date.now();
  const message = formatTestFlightBridgeDownDescription(device.name, settings.testFlightBridgeAlertMinutes);
  recordDeviceAlertNotification({
    deviceId: device.id,
    groupKey: `device-testflight-bridge-unresponsive:${device.id}`,
    title: 'TestFlight bridge unresponsive',
    message,
    severity: 'warning',
  });
  await notify('testFlightBridgeDown', {
    title: 'TestFlight bridge unresponsive',
    description: message,
    color: EMBED_COLOR.warn,
  });
}

function warnOnMissingTelemetry(device: DeviceRecord, health: DeviceHealth): void {
  if (!health.reachable) return;
  const missing = (
    [
      ['testFlightRunning', health.testFlightRunning],
      ['batteryPercent', health.batteryPercent],
      ['batteryTemperatureC', health.batteryTemperatureC],
    ] as const
  )
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) log.warn('device is reachable but missing expected telemetry fields', { deviceId: device.id, missing });
}

async function pollOneDevice(device: DeviceRecord): Promise<void> {
  const health = await getDeviceHealth(device.id, true);
  notifyDeviceDispatchStateChanged();
  warnOnMissingTelemetry(device, health);
  recordDeviceHealthCheck(
    device.id,
    health.reachable,
    health.batteryPercent,
    health.batteryTemperatureC,
    health.storageUsedPercent !== undefined ? Math.round(health.storageUsedPercent * 100) : undefined,
    health.subsystems ? { states: health.subsystems, reasons: subsystemReasons(health) } : undefined,
  );
  const previous = lastActivityState.get(device.id);
  if (!previous || previous.reachable !== health.reachable) {
    recordDeviceActivity({ deviceId: device.id, kind: 'health', message: health.reachable ? 'Device became reachable' : 'Device became unreachable' });
  }
  if (health.testFlightBridgeReachable !== undefined && previous?.bridgeReachable !== health.testFlightBridgeReachable) {
    recordDeviceActivity({
      deviceId: device.id,
      kind: 'bridge',
      message: health.testFlightBridgeReachable ? 'autoinstall bridge became available' : 'autoinstall bridge became unavailable',
    });
  }
  lastActivityState.set(device.id, { reachable: health.reachable, bridgeReachable: health.testFlightBridgeReachable });
  const bridgeReachable = testFlightBridgeReachability(health);
  await Promise.all([
    checkOfflineAlert(device, health.reachable),
    checkBatteryHotAlert(device, health.batteryTemperatureC),
    checkBatteryLowAlert(device, health.batteryPercent, health.batteryCharging),
    checkDeviceStorageAlert(device, health.storageUsedPercent),
    ...(bridgeReachable === undefined ? [] : [checkTestFlightBridgeAlert(device, bridgeReachable)]),
  ]);
}

const pendingDeviceHealthPolls = new Map<string, Promise<void>>();
const usbDeviceHealthRefreshQueue = new DeviceHealthRefreshQueue();

function pollOneDeviceOnce(device: DeviceRecord): Promise<void> {
  return coalesceDeviceHealthRequest(pendingDeviceHealthPolls, device.id, () => pollOneDevice(device));
}

export function refreshUsbDeviceHealth(udid: string): Promise<void> {
  const device = getEffectiveDevices().find((entry) => entry.enabled && entry.udid === udid && isDirectUsbDeviceAgentConnection(entry));
  if (!device) return Promise.resolve();
  return usbDeviceHealthRefreshQueue.request(device.id, () => pollOneDeviceOnce(device), pendingDeviceHealthPolls.get(device.id));
}

export function startDeviceHealthPoller(): void {
  if (deviceHealthTimer) return;
  const poll = async () => {
    const devices = getEffectiveDevices().filter((d) => d.enabled);
    await Promise.all(devices.map((d) => pollOneDeviceOnce(d).catch((err) => log.warn('device health poll failed', { deviceId: d.id, error: String(err) }))));
    await checkDiskFullAlert().catch((err) => log.warn('disk full check failed', { error: String(err) }));
  };

  const runPoll = () => {
    void trackBackgroundWork('device-health-poll', poll).catch((error: unknown) => log.warn('device health poll failed', { error: String(error) }));
  };
  runPoll();
  deviceHealthTimer = setInterval(runPoll, HEALTH_POLL_INTERVAL_MS).unref();
}

let deviceHealthTimer: NodeJS.Timeout | undefined;

export function stopDeviceHealthPoller(): void {
  if (deviceHealthTimer) clearInterval(deviceHealthTimer);
  deviceHealthTimer = undefined;
}
