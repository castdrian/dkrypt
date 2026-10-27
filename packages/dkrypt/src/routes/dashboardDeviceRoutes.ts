import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type {
  DashboardDeviceActivityRoute,
  DashboardDeviceBatteryHistoryRoute,
  DashboardDeviceHealthHistoryRoute,
  DashboardDeviceListRoute,
  DashboardDeviceStorageHistoryRoute,
  DashboardDeviceTemperatureHistoryRoute,
} from '#dashboardDeviceContracts.js';
import type {
  DashboardDeviceCreateRoute,
  DashboardDeviceDeleteRoute,
  DashboardDeviceDiscoveryRoute,
  DashboardDeviceSetupRoute,
  DashboardDeviceUpdateRoute,
  DeviceConnectionInput,
  DevicePatchInput,
  DeviceRecordInput,
} from '#dashboardDeviceManagementContracts.js';
import type {
  DashboardDeviceBridgeActionRoute,
  DashboardDeviceDarkModeRoute,
  DashboardDeviceHealthRoute,
  DashboardDeviceInventoryRoute,
  DashboardDevicePreflightRoute,
  DashboardDeviceRecoverRoute,
  DashboardDeviceRecoveryListRoute,
  DashboardDeviceRecoveryStatusRoute,
} from '#dashboardDeviceOperationContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { serializeDashboardDevice } from '#dashboardDevicePresentation.js';
import { getRouteContract } from '#contracts.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { emitJobsChanged } from '#events.js';
import { getActiveJobs, notifyDeviceDispatchStateChanged } from '#jobs/store.js';
import { getDeviceHealth, isBridgeHeartbeatFresh, type DeviceHealth } from '#deviceHealth.js';
import { getCachedDeviceHealth } from '#deviceHealthCache.js';
import { discoverDevices, execCommand, isDirectUsbDeviceAgentConnection, listInstalledAppStoreBundles, sendSpringBoardBridgeRequest, setupDeviceConnection, withAutoinstallDeviceAgent, withSSH, type DeviceConnection } from '#idevice.js';
import { getTestFlightBridgeDiagnostics } from '#testflight.js';
import {
  createDevice,
  deleteDevice,
  getDevice,
  getDeviceActivityPage,
  getDeviceBatteryHourlyBuckets,
  getDeviceSubsystemDetails,
  getDeviceHealthHourlyBuckets,
  getDeviceStorageHourlyBuckets,
  getDeviceTemperatureHourlyBuckets,
  getDeviceUptimePercent,
  getEffectiveDevices,
  getPrimaryDevice,
  recordDeviceActivity,
  type DeviceRecord,
  updateDevice,
} from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { resolveWithin } from '#util/resolveWithin.js';
import type { DeviceTransport } from '#apiCommonContracts.js';
import { config } from '#config.js';
import { isSupportedDeviceHost } from '#deviceHost.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { createDeviceSetupOperationRepository, type DeviceSetupOperation } from '#store/deviceSetupOperationRepository.js';
import { createDeviceRecoveryRepository, type DeviceRecoveryOperation } from '#store/deviceRecoveryRepository.js';

const canViewDevices = fastifyRequirePermission(PermissionFlag.viewDevices, PermissionFlag.manageDevices);
const canManageDevices = fastifyRequirePermission(PermissionFlag.manageDevices);

type DeviceInput = DeviceRecordInput;

function normalizeConnectionFields(input: Record<string, unknown>) {
  return {
    transport: input.transport === 'usb' || input.transport === 'wifi' ? input.transport as DeviceTransport : undefined,
    host: typeof input.host === 'string' ? input.host.trim() : '',
    port: typeof input.port === 'number' && Number.isInteger(input.port) && input.port >= 1 && input.port <= 65_535 ? input.port : undefined,
    user: typeof input.user === 'string' ? input.user.trim() : '',
    udid: typeof input.udid === 'string' ? input.udid.trim() : '',
    usbmuxNetwork: input.usbmuxNetwork === true,
  };
}

function isValidDeviceConnectionFields(connection: ReturnType<typeof normalizeConnectionFields>): boolean {
  return (!connection.host || isSupportedDeviceHost(connection.host)) && (connection.transport !== 'usb' || Boolean(connection.udid));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDeviceMetadata(input: Record<string, unknown>): Partial<Pick<DeviceInput, 'productType' | 'iosVersion' | 'toolchain' | 'notes'>> {
  return {
    ...(typeof input.productType === 'string' ? { productType: input.productType.trim() || undefined } : {}),
    ...(typeof input.iosVersion === 'string' ? { iosVersion: input.iosVersion.trim() || undefined } : {}),
    ...(typeof input.toolchain === 'string' ? { toolchain: input.toolchain.trim() || undefined } : {}),
    ...(typeof input.notes === 'string' ? { notes: input.notes.trim().slice(0, 1000) || undefined } : {}),
  };
}

function hasObsoleteDeviceRootDirectory(input: Record<string, unknown>): boolean {
  return typeof input.rootDir === 'string' && input.rootDir.trim().length > 0;
}

function parseDeviceInput(body: unknown): DeviceInput | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const input = body as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const connection = normalizeConnectionFields(input);
  if (!name || (!connection.host && !connection.udid)) return undefined;
  if (!isValidDeviceConnectionFields(connection)) return undefined;
  return {
    name,
    transport: connection.transport,
    host: connection.host || undefined,
    port: connection.port,
    user: connection.user || undefined,
    udid: connection.udid || undefined,
    usbmuxNetwork: connection.usbmuxNetwork,
    ...normalizeDeviceMetadata(input),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : undefined,
    isPrimary: typeof input.isPrimary === 'boolean' ? input.isPrimary : undefined,
  };
}

export function parseDeviceConnection(body: unknown): { connection: DeviceConnection; name?: string; existingId?: string; productType?: string; iosVersion?: string; toolchain?: string; notes?: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const input = body as DeviceConnectionInput & Record<string, unknown>;
  const connectionFields = normalizeConnectionFields(input);
  const { host, udid, transport, usbmuxNetwork } = connectionFields;
  if (!host && !udid) return undefined;
  if (!isValidDeviceConnectionFields(connectionFields)) return undefined;
  if (udid && !/^[A-Za-z0-9-]{8,80}$/.test(udid)) return undefined;
  const resolvedTransport = host ? 'wifi' : udid ? usbmuxNetwork ? 'wifi' : 'usb' : undefined;
  if (!resolvedTransport || (transport && transport !== resolvedTransport)) return undefined;
  return {
    connection: { transport: resolvedTransport, host: host || undefined, port: connectionFields.port, user: connectionFields.user || undefined, udid: udid || undefined, usbmuxNetwork },
    name: typeof input.name === 'string' ? input.name.trim() || undefined : undefined,
    existingId: typeof input.existingId === 'string' ? input.existingId.trim() || undefined : undefined,
    ...normalizeDeviceMetadata(input),
  };
}

function resolveDevice(id: string) {
  return getDevice(id) ?? (id === 'primary' ? getPrimaryDevice() : undefined);
}

function canReadDeviceStatus(permissions: bigint, id: string, force = false): boolean {
  if (hasPermission(permissions, PermissionFlag.manageDevices)) return true;
  if (force) return false;
  return hasPermission(permissions, PermissionFlag.viewDevices) || id === 'primary';
}

function resolveReadableStatusDevice(permissions: bigint, id: string): { device: DeviceRecord } | { status: 403 | 404; message: string } {
  if (!canReadDeviceStatus(permissions, id)) return { status: 403, message: 'device history is unavailable' };
  const device = resolveDevice(id);
  return device ? { device } : { status: 404, message: 'device not found' };
}

function serializeMemberDeviceHealth(health: DeviceHealth, refreshing: boolean): DeviceHealth & { refreshing: boolean } {
  return {
    reachable: health.reachable,
    refreshing,
    checkedAt: health.checkedAt,
    error: health.error,
    testFlightRunning: health.testFlightRunning,
    testFlightBridgeReachable: health.testFlightBridgeReachable,
    darkEnabled: health.darkEnabled,
    displayMode: health.displayMode,
    autoinstallPaused: health.autoinstallPaused,
    autoinstallPauseReason: health.autoinstallPauseReason,
    batteryPauseEnabled: health.batteryPauseEnabled,
    batteryPauseThreshold: health.batteryPauseThreshold,
    activeOperation: health.activeOperation,
    batteryPercent: health.batteryPercent,
    batteryCharging: health.batteryCharging,
    batteryTemperatureC: health.batteryTemperatureC,
    batteryCycleCount: health.batteryCycleCount,
    batteryHealthPercent: health.batteryHealthPercent,
    batteryDesignCapacityMah: health.batteryDesignCapacityMah,
    batteryMaxCapacityMah: health.batteryMaxCapacityMah,
    storageTotalBytes: health.storageTotalBytes,
    storageUsedBytes: health.storageUsedBytes,
    storageFreeBytes: health.storageFreeBytes,
    storageUsedPercent: health.storageUsedPercent,
    networkConnected: health.networkConnected,
    internetAccess: health.internetAccess,
    networkInterface: health.networkInterface,
    networkIpAddress: health.networkIpAddress,
    subsystems: health.subsystems,
  };
}

const springBoardActions = {
  'open-testflight': { action: 'launch_app', bundleId: 'com.apple.TestFlight' },
  'open-appstore': { action: 'launch_app', bundleId: 'com.apple.AppStore' },
  'screen-status': { action: 'screen_status' },
} as const;

export const dashboardDeviceRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);
  const setupOperations = createDeviceSetupOperationRepository(openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['device_setup_operations']));
  const recoveryOperations = createDeviceRecoveryRepository(openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['device_recovery_operations']));
  setupOperations.interruptRunning();
  recoveryOperations.interruptRunning();
  let closing = false;
  server.addHook('onClose', async () => {
    closing = true;
    setupOperations.interruptRunning();
    setupOperations.close();
    recoveryOperations.interruptRunning();
    recoveryOperations.close();
  });

  const publicSetupOperation = (operation: DeviceSetupOperation) => {
    const { input: _input, ownerId: _ownerId, ...visible } = operation;
    return visible;
  };

  const publicRecoveryOperation = (operation: DeviceRecoveryOperation) => {
    const { ownerId: _ownerId, ...visible } = operation;
    return visible;
  };

  const runRecoveryOperation = async (operation: DeviceRecoveryOperation) => {
    if (closing) return;
    const device = resolveDevice(operation.deviceId);
    if (!device) {
      recoveryOperations.fail(operation.id, 'Device was removed before recovery started.');
      return;
    }
    recoveryOperations.advance(operation.id, 'running', 'Sending SpringBoard reload request');
    try {
      const runRecoveryCommand = (connection: Parameters<typeof execCommand>[0]) => execCommand(connection, 'sudo -n /var/jb/usr/bin/sbreload', 30_000);
      const command = isDirectUsbDeviceAgentConnection(device)
        ? await withAutoinstallDeviceAgent(device, runRecoveryCommand)
        : await withSSH(device, runRecoveryCommand);
      if (closing) return;
      if (command.code !== 0) {
        const message = `could not reload SpringBoard: ${command.stderr.trim() || command.stdout.trim() || `exit code ${command.code ?? 'unknown'}`}`;
        recoveryOperations.fail(operation.id, message, { commandExitCode: command.code ?? undefined });
        recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: `SpringBoard recovery failed: ${message}` });
        return;
      }
      recoveryOperations.advance(operation.id, 'verifying', 'Waiting for device and Autoinstall to reconnect');
      recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: 'SpringBoard reload requested; waiting to verify device and Autoinstall recovery' });
      let lastHealth: DeviceHealth | undefined;
      for (let attempt = 0; attempt < 24 && !closing; attempt += 1) {
        lastHealth = await getDeviceHealth(device.id, true).catch(() => undefined);
        if (closing) return;
        const agentReady = lastHealth?.subsystems?.agent === 'ready' || (lastHealth?.agentHeartbeatAt !== undefined && Date.now() - lastHealth.agentHeartbeatAt < 90_000);
        const springboardReady = lastHealth?.testFlightBridgeReachable === true || isBridgeHeartbeatFresh(lastHealth?.bridgeHeartbeats?.springboard);
        if (lastHealth?.reachable && agentReady && springboardReady) {
          recoveryOperations.complete(operation.id, {
            commandExitCode: command.code ?? 0,
            reachable: true,
            agentReady,
            springboardReady,
          });
          recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: 'SpringBoard recovery verified; device and Autoinstall bridge are reachable' });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      const agentReady = lastHealth?.subsystems?.agent === 'ready' || (lastHealth?.agentHeartbeatAt !== undefined && Date.now() - lastHealth.agentHeartbeatAt < 90_000);
      const springboardReady = lastHealth?.testFlightBridgeReachable === true || isBridgeHeartbeatFresh(lastHealth?.bridgeHeartbeats?.springboard);
      const message = closing ? 'Recovery was interrupted by a dkrypt restart.' : 'SpringBoard accepted the reload request, but dkrypt did not verify the device and Autoinstall bridge within two minutes.';
      recoveryOperations.fail(operation.id, message, {
        commandExitCode: command.code ?? 0,
        reachable: lastHealth?.reachable ?? false,
        agentReady,
        springboardReady,
      });
      recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message });
    } catch (error) {
      if (closing) return;
      const message = `device recovery failed: ${getErrorMessage(error)}`;
      recoveryOperations.fail(operation.id, message);
      recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message });
    }
  };

  const performDeviceSetup = async (input: NonNullable<ReturnType<typeof parseDeviceConnection>>, userId: string, onStage?: (id: string, label: string) => void) => {
    const existingId = input.existingId ?? getEffectiveDevices().find((candidate) => {
      if (input.connection.udid && candidate.udid === input.connection.udid) return true;
      return Boolean(input.connection.host && candidate.host === input.connection.host && (candidate.port ?? config.deviceSshPort) === (input.connection.port ?? config.deviceSshPort));
    })?.id;
    const setupConnection = existingId ? { ...input.connection, id: existingId } : input.connection;
    const setup = await setupDeviceConnection(setupConnection, onStage);
    if (closing) throw new Error('device setup interrupted by service shutdown');
    const connectionFields: Pick<DeviceInput, 'transport' | 'host' | 'port' | 'user' | 'udid' | 'usbmuxNetwork' | 'productType' | 'iosVersion'> = {
      transport: input.connection.transport as DeviceTransport,
      host: input.connection.host,
      port: input.connection.port,
      user: input.connection.user,
      udid: input.connection.udid,
      usbmuxNetwork: input.connection.usbmuxNetwork,
      productType: input.productType ?? setup.info.productType,
      iosVersion: input.iosVersion ?? setup.info.productVersion,
    };
    let device: DeviceRecord;
    if (existingId) {
      const existing = getDevice(existingId);
      if (!existing) throw new Error('device not found');
      const patch: Partial<DeviceInput> = {
        ...connectionFields,
        productType: connectionFields.productType ?? existing.productType,
        name: input.name ?? existing.name,
        iosVersion: connectionFields.iosVersion ?? existing.iosVersion,
        enabled: true,
      };
      if (input.toolchain !== undefined) patch.toolchain = input.toolchain;
      if (input.notes !== undefined) patch.notes = input.notes;
      const result = updateDevice(existing.id, patch, userId);
      if (!result.ok || !result.device) throw new Error(result.error ?? 'device not found');
      device = result.device;
    } else {
      device = createDevice({ ...connectionFields, name: input.name ?? setup.info.name, toolchain: input.toolchain, notes: input.notes }, userId);
    }
    emitJobsChanged();
    return { device, setup };
  };

  const runSetupOperation = async (operation: DeviceSetupOperation) => {
    if (closing) return;
    setupOperations.advance(operation.id, 'starting', 'Starting device setup');
    try {
      const result = await performDeviceSetup(operation.input, operation.ownerId, (id, label) => {
        if (!closing) setupOperations.advance(operation.id, id, label);
      });
      setupOperations.advance(operation.id, 'verifying', 'Verifying decrypt readiness');
      const health = await getDeviceHealth(result.device.id, true).catch(() => undefined);
      if (closing) return;
      const ready = result.setup.ready && health?.reachable === true;
      const setup = ready ? result.setup : {
        ...result.setup,
        ready: false,
        steps: [...result.setup.steps, { id: 'fresh-health', label: 'Fresh device health', status: 'attention' as const, detail: health?.error ?? 'The device did not pass a fresh connection check.' }],
      };
      setupOperations.complete(operation.id, { deviceId: result.device.id, ready, setup });
    } catch (error) {
      if (!closing) setupOperations.fail(operation.id, `Device setup failed: ${getErrorMessage(error)}`);
    }
  };

  server.get<DashboardDeviceDiscoveryRoute>('/v1/dashboard/devices/discover', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/discover'),
    preHandler: canManageDevices,
  }, async (request, reply) => {
    try {
      return await discoverDevices();
    } catch (error) {
      return reply.code(502).send(createHttpErrorEnvelope(request.id, 502, `device discovery failed: ${getErrorMessage(error)}`));
    }
  });

  server.post<DashboardDeviceSetupRoute>('/v1/dashboard/devices/setup', {
    schema: getRouteContract('POST', '/v1/dashboard/devices/setup'),
    preHandler: canManageDevices,
    attachValidation: true,
  }, async (request, reply) => {
    const input = parseDeviceConnection(request.body);
    if (!input) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'a discovered device connection is required'));
    if (request.validationError) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'device connection contains invalid fields'));
    const userId = getFastifySession(request)!.sub;
    try {
      const { device, setup } = await performDeviceSetup(input, userId);
      return reply.code(201).send({ device: serializeDashboardDevice(device), setup });
    } catch (error) {
      if (getErrorMessage(error) === 'device not found') return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
      return reply.code(502).send(createHttpErrorEnvelope(request.id, 502, `could not connect to the device: ${getErrorMessage(error)}`));
    }
  });

  server.post('/v1/dashboard/devices/setup-operations', {
    schema: getRouteContract('POST', '/v1/dashboard/devices/setup-operations'),
    preHandler: canManageDevices,
    attachValidation: true,
  }, async (request, reply) => {
    const input = parseDeviceConnection(request.body);
    if (!input || request.validationError) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'a valid discovered device connection is required'));
    const operation = setupOperations.create(getFastifySession(request)!.sub, input);
    void runSetupOperation(operation);
    return reply.code(202).send({ operation: publicSetupOperation(operation) });
  });

  server.get('/v1/dashboard/devices/setup-operations', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/setup-operations'),
    preHandler: canManageDevices,
  }, (request) => ({ operations: setupOperations.list(getFastifySession(request)!.sub).map(publicSetupOperation) }));

  server.get<{ Params: { id: string } }>('/v1/dashboard/devices/setup-operations/:id', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/setup-operations/:id'),
    preHandler: canManageDevices,
  }, (request, reply) => {
    const operation = setupOperations.get(request.params.id);
    if (!operation || operation.ownerId !== getFastifySession(request)!.sub) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'setup operation not found'));
    return { operation: publicSetupOperation(operation) };
  });

  server.post<{ Params: { id: string } }>('/v1/dashboard/devices/setup-operations/:id/resume', {
    schema: getRouteContract('POST', '/v1/dashboard/devices/setup-operations/:id/resume'),
    preHandler: canManageDevices,
  }, async (request, reply) => {
    const previous = setupOperations.get(request.params.id);
    if (!previous || previous.ownerId !== getFastifySession(request)!.sub) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'setup operation not found'));
    if (previous.status !== 'interrupted' && previous.status !== 'failed') return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, 'only interrupted or failed setup can resume'));
    const discovered = await discoverDevices().catch(() => undefined);
    const available = discovered?.devices.some((candidate) => candidate.udid && candidate.udid === previous.input.connection.udid && candidate.transport === previous.input.connection.transport);
    if (!available) return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, 'reconnect the device before resuming setup'));
    const operation = setupOperations.resume(previous.id)!;
    void runSetupOperation(operation);
    return reply.code(202).send({ operation: publicSetupOperation(operation) });
  });

  server.post<DashboardDeviceCreateRoute>('/v1/dashboard/devices', {
    schema: getRouteContract('POST', '/v1/dashboard/devices'),
    preHandler: canManageDevices,
    attachValidation: true,
  }, (request, reply) => {
    const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as DeviceRecordInput & Record<string, unknown>;
    if (hasObsoleteDeviceRootDirectory(body)) {
      reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'device setup requires a discovered USB or Wi-Fi connection'));
      return;
    }
    const input = parseDeviceInput(body);
    if (!input) {
      reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'name and a device connection are required'));
      return;
    }
    if (request.validationError) {
      reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'device record contains invalid fields'));
      return;
    }
    const device = createDevice(input, getFastifySession(request)!.sub);
    emitJobsChanged();
    reply.code(201).send(serializeDashboardDevice(device));
  });

  server.patch<DashboardDeviceUpdateRoute>('/v1/dashboard/devices/:id', {
    schema: getRouteContract('PATCH', '/v1/dashboard/devices/:id'),
    preHandler: canManageDevices,
    attachValidation: true,
  }, (request, reply) => {
    const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as DevicePatchInput & Record<string, unknown>;
    if (hasObsoleteDeviceRootDirectory(body)) {
      reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'device setup requires a discovered USB or Wi-Fi connection'));
      return;
    }
    if (request.validationError) {
      reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'device update contains invalid fields'));
      return;
    }
    const current = getDevice(request.params.id);
    if (!current) {
      reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
      return;
    }
    if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== current.updatedAt) {
      reply.code(409).send({ ...createHttpErrorEnvelope(request.id, 409, 'device changed in another session'), code: 'revision_conflict', remediation: { current: serializeDashboardDevice(current) } });
      return;
    }
    const patch: Partial<DeviceInput> = {};
    const connection = normalizeConnectionFields(body);
    if (connection.host && !isSupportedDeviceHost(connection.host)) {
      reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'device host is invalid'));
      return;
    }
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (connection.transport) patch.transport = connection.transport;
    if (typeof body.host === 'string') patch.host = connection.host || undefined;
    if (typeof body.port === 'number') patch.port = connection.port;
    if (typeof body.user === 'string') patch.user = connection.user || undefined;
    if (typeof body.udid === 'string') patch.udid = connection.udid || undefined;
    if (typeof body.usbmuxNetwork === 'boolean') patch.usbmuxNetwork = connection.usbmuxNetwork;
    Object.assign(patch, normalizeDeviceMetadata(body));
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.isPrimary === 'boolean') patch.isPrimary = body.isPrimary;
    const result = updateDevice(request.params.id, patch, getFastifySession(request)!.sub);
    if (!result.ok) {
      reply.code(404).send(createHttpErrorEnvelope(request.id, 404, result.error ?? 'device not found'));
      return;
    }
    notifyDeviceDispatchStateChanged();
    emitJobsChanged();
    return serializeDashboardDevice(result.device as DeviceRecord);
  });

  server.get<{ Params: { id: string } }>('/v1/dashboard/devices/:id/disable-impact', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/disable-impact'),
    preHandler: canManageDevices,
  }, (request, reply) => {
    const device = getDevice(request.params.id);
    if (!device) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
    const alternatives = getEffectiveDevices().filter((candidate) => candidate.id !== device.id && candidate.enabled && !candidate.draining);
    const jobs = getActiveJobs().filter((job) => job.status === 'queued' && (job.preferredDeviceId === device.id || (!job.preferredDeviceId && alternatives.length === 0)));
    return { deviceId: device.id, queuedJobCount: jobs.length, runningJobCount: getActiveJobs().filter((job) => job.status === 'running' && job.deviceId === device.id).length };
  });

  server.post<{ Params: { id: string } }>('/v1/dashboard/devices/:id/drain', {
    schema: getRouteContract('POST', '/v1/dashboard/devices/:id/drain'),
    preHandler: canManageDevices,
  }, (request, reply) => {
    const device = getDevice(request.params.id);
    if (!device) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
    if (!device.enabled) return serializeDashboardDevice(device);
    const result = updateDevice(device.id, { draining: true }, getFastifySession(request)!.sub);
    notifyDeviceDispatchStateChanged();
    emitJobsChanged();
    return serializeDashboardDevice(getDevice(device.id) ?? result.device!);
  });

  server.delete<DashboardDeviceDeleteRoute>('/v1/dashboard/devices/:id', {
    schema: getRouteContract('DELETE', '/v1/dashboard/devices/:id'),
    preHandler: canManageDevices,
  }, (request, reply) => {
    if (!deleteDevice(request.params.id, getFastifySession(request)!.sub)) {
      reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
      return;
    }
    emitJobsChanged();
    return { ok: true };
  });

  server.get<DashboardDeviceHealthRoute>('/v1/dashboard/devices/:id/health', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/health'),
    attachValidation: true,
  }, async (request, reply) => {
    if (request.validationError) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'device health query is invalid'));
    const permissions = getFastifySession(request)!.permissions;
    const canViewDeviceData = hasPermission(permissions, PermissionFlag.viewDevices) || hasPermission(permissions, PermissionFlag.manageDevices);
    const force = request.query.force === 'true';
    if (!canReadDeviceStatus(permissions, request.params.id, force)) return reply.code(403).send(createHttpErrorEnvelope(request.id, 403, 'device status is unavailable'));
    const device = resolveDevice(request.params.id);
    if (!device) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
    try {
      const cached = getCachedDeviceHealth(device.id);
      if (!force && cached) {
        const staleAfterMs = cached.value.reachable && cached.value.testFlightBridgeReachable !== false ? 45_000 : 120_000;
        const refreshing = Date.now() - cached.at >= staleAfterMs;
        if (refreshing) void getDeviceHealth(device.id).catch(() => undefined);
        return canViewDeviceData
          ? { ...cached.value, refreshing, subsystemDetails: getDeviceSubsystemDetails(device.id, cached.value.subsystems) }
          : serializeMemberDeviceHealth(cached.value, refreshing);
      }
      const snapshot = await resolveWithin(getDeviceHealth(device.id, force), force ? 8_000 : 1_000);
      if (!snapshot.completed) {
        return reply.code(503).send({
          error: 'Device health check is still running. Try again shortly.',
          code: 'device_health_refreshing',
          message: 'Device health check is still running. Try again shortly.',
          requestId: request.id,
          retryable: true,
        });
      }
      return canViewDeviceData
        ? { ...snapshot.value, refreshing: false, subsystemDetails: getDeviceSubsystemDetails(device.id, snapshot.value.subsystems) }
        : serializeMemberDeviceHealth(snapshot.value, false);
    } catch (error) {
      return reply.code(502).send(createHttpErrorEnvelope(request.id, 502, canViewDeviceData ? `device health check failed: ${getErrorMessage(error)}` : 'device health check failed'));
    }
  });

  server.get<DashboardDevicePreflightRoute>('/v1/dashboard/devices/:id/preflight', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/preflight'),
    preHandler: canViewDevices,
  }, async (request, reply) => {
    const device = resolveDevice(request.params.id);
    if (!device) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
    try {
      const health = await getDeviceHealth(device.id, true);
      health.subsystemDetails = getDeviceSubsystemDetails(device.id, health.subsystems);
      const bridge = health.reachable ? await getTestFlightBridgeDiagnostics(device).catch(() => undefined) : undefined;
      const checks = [
        { label: 'Device connection', ok: health.reachable, detail: health.error },
        { label: 'Internet access', ok: health.internetAccess !== false, detail: health.internetAccess === false ? 'Device cannot reach Apple services' : undefined },
        { label: 'autoinstall bridge', ok: health.testFlightBridgeReachable === true, detail: health.testFlightBridgeReachable === true ? undefined : 'Bridge did not respond' },
        { label: 'Device readiness', ok: health.readiness?.state !== 'blocked', detail: health.readiness?.reasons.join(' · ') || undefined },
        { label: 'Bridge compatibility', ok: Boolean(bridge?.bridge.bridgeVersion), detail: bridge?.bridge.bridgeVersion ? `autoinstall ${bridge.bridge.bridgeVersion}` : 'No autoinstall version reported' },
        { label: 'SpringBoard heartbeat', ok: isBridgeHeartbeatFresh(health.bridgeHeartbeats?.springboard), detail: health.bridgeHeartbeats?.springboard?.at ? `reported ${new Date(health.bridgeHeartbeats.springboard.at * 1000).toISOString()}` : 'No authenticated autoinstall heartbeat reported' },
      ];
      return { device: serializeDashboardDevice(device, health), health, bridge, checks, ready: checks.every((check) => check.ok) };
    } catch (error) {
      return reply.code(502).send(createHttpErrorEnvelope(request.id, 502, `device preflight failed: ${getErrorMessage(error)}`));
    }
  });

  server.get<DashboardDeviceInventoryRoute>('/v1/dashboard/devices/:id/inventory', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/inventory'),
    preHandler: canViewDevices,
  }, async (request, reply) => {
    const device = resolveDevice(request.params.id);
    if (!device) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
    try {
      const bundles = await withSSH(device, listInstalledAppStoreBundles);
      return { deviceId: device.id, bundles };
    } catch (error) {
      return reply.code(502).send(createHttpErrorEnvelope(request.id, 502, `could not inspect installed App Store apps: ${getErrorMessage(error)}`));
    }
  });

  server.put<DashboardDeviceDarkModeRoute>('/v1/dashboard/devices/:id/dark-mode', {
    schema: getRouteContract('PUT', '/v1/dashboard/devices/:id/dark-mode'),
    preHandler: canManageDevices,
    attachValidation: true,
  }, async (request, reply) => {
    if (request.validationError) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'enabled must be a boolean'));
    const device = resolveDevice(request.params.id);
    if (!device) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
    try {
      await withSSH(device, (connection) => sendSpringBoardBridgeRequest(connection, { action: request.body.enabled ? 'dark_on' : 'dark_off' }));
      recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: request.body.enabled ? 'Display blacked out through autoinstall' : 'Display blackout disabled through autoinstall' });
      return await getDeviceHealth(device.id, true);
    } catch (error) {
      return reply.code(502).send(createHttpErrorEnvelope(request.id, 502, `autoinstall could not change the display state: ${getErrorMessage(error)}`));
    }
  });

  server.post<DashboardDeviceBridgeActionRoute>('/v1/dashboard/devices/:id/bridge-action', {
    schema: getRouteContract('POST', '/v1/dashboard/devices/:id/bridge-action'),
    preHandler: canManageDevices,
    attachValidation: true,
  }, async (request, reply) => {
    if (request.validationError) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'unsupported bridge action'));
    const device = resolveDevice(request.params.id);
    if (!device) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
    try {
      const result = await withSSH(device, (connection) => sendSpringBoardBridgeRequest(connection, springBoardActions[request.body.action]));
      recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: `Bridge action: ${request.body.action}` });
      return { result };
    } catch (error) {
      return reply.code(502).send(createHttpErrorEnvelope(request.id, 502, `autoinstall bridge action failed: ${getErrorMessage(error)}`));
    }
  });

  server.post<DashboardDeviceRecoverRoute>('/v1/dashboard/devices/:id/recover', {
    schema: getRouteContract('POST', '/v1/dashboard/devices/:id/recover'),
    preHandler: canManageDevices,
  }, async (request, reply) => {
    const device = resolveDevice(request.params.id);
    if (!device) {
      reply.code(404);
      return createHttpErrorEnvelope(request.id, 404, 'device not found');
    }
    const running = recoveryOperations.list(device.id).find((operation) => ['queued', 'running', 'verifying'].includes(operation.status));
    if (running) return { ok: true as const, operation: publicRecoveryOperation(running) };
    const operation = recoveryOperations.create(device.id, getFastifySession(request)!.sub);
    void runRecoveryOperation(operation);
    return { ok: true as const, operation: publicRecoveryOperation(operation) };
  });

  server.get<DashboardDeviceRecoveryListRoute>('/v1/dashboard/devices/:id/recoveries', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/recoveries'),
    preHandler: canViewDevices,
  }, (request, reply) => {
    const device = resolveDevice(request.params.id);
    if (!device) {
      reply.code(404);
      return createHttpErrorEnvelope(request.id, 404, 'device not found');
    }
    return { operations: recoveryOperations.list(device.id).map(publicRecoveryOperation) };
  });

  server.get<DashboardDeviceRecoveryStatusRoute>('/v1/dashboard/devices/:id/recoveries/:operationId', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/recoveries/:operationId'),
    preHandler: canViewDevices,
  }, (request, reply) => {
    const operation = recoveryOperations.get(request.params.operationId);
    if (!operation || operation.deviceId !== request.params.id) {
      reply.code(404);
      return createHttpErrorEnvelope(request.id, 404, 'recovery receipt not found');
    }
    return { ok: true as const, operation: publicRecoveryOperation(operation) };
  });

  server.get<DashboardDeviceListRoute>('/v1/dashboard/devices', {
    schema: getRouteContract('GET', '/v1/dashboard/devices'),
    preHandler: canViewDevices,
  }, () => ({ devices: getEffectiveDevices().map((device) => serializeDashboardDevice(device)) }));

  server.get<DashboardDeviceActivityRoute>('/v1/dashboard/devices/:id/activity', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/activity'),
    preHandler: canViewDevices,
  }, (request, reply) => {
    const device = resolveDevice(request.params.id);
    if (!device) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
    const { cursor, limit, offset } = request.query;
    const page = getDeviceActivityPage(device.id, cursor ? 0 : offset ?? 0, Math.min(limit ?? 12, 50), cursor);
    return { activity: page.entries, total: page.total, nextCursor: page.nextCursor };
  });

  server.get<DashboardDeviceHealthHistoryRoute>('/v1/dashboard/devices/:id/health-history', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/health-history'),
  }, (request, reply) => {
    const access = resolveReadableStatusDevice(getFastifySession(request)!.permissions, request.params.id);
    if ('status' in access) return reply.code(access.status).send(createHttpErrorEnvelope(request.id, access.status, access.message));
    const hours = request.query.hours ?? 24;
    return { buckets: getDeviceHealthHourlyBuckets(access.device.id, hours), uptimePercent: getDeviceUptimePercent(access.device.id, hours) ?? null };
  });

  server.get<DashboardDeviceBatteryHistoryRoute>('/v1/dashboard/devices/:id/battery-history', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/battery-history'),
  }, (request, reply) => {
    const access = resolveReadableStatusDevice(getFastifySession(request)!.permissions, request.params.id);
    if ('status' in access) return reply.code(access.status).send(createHttpErrorEnvelope(request.id, access.status, access.message));
    return { buckets: getDeviceBatteryHourlyBuckets(access.device.id, request.query.hours ?? 24) };
  });

  server.get<DashboardDeviceTemperatureHistoryRoute>('/v1/dashboard/devices/:id/temperature-history', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/temperature-history'),
  }, (request, reply) => {
    const access = resolveReadableStatusDevice(getFastifySession(request)!.permissions, request.params.id);
    if ('status' in access) return reply.code(access.status).send(createHttpErrorEnvelope(request.id, access.status, access.message));
    return { buckets: getDeviceTemperatureHourlyBuckets(access.device.id, request.query.hours ?? 24) };
  });

  server.get<DashboardDeviceStorageHistoryRoute>('/v1/dashboard/devices/:id/storage-history', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/storage-history'),
    preHandler: canViewDevices,
  }, (request) => ({ buckets: getDeviceStorageHourlyBuckets(request.params.id, request.query.hours ?? 24) }));
};
