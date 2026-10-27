import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { deviceTransportSchema, identifierSchema } from '#apiCommonContracts.js';
import { bridgeHeartbeatsSchema, dashboardDeviceResponseSchema, deviceTransportStateSchema } from '#dashboardModelsContracts.js';

const subsystemStateSchema = Type.Union([
  Type.Literal('ready'),
  Type.Literal('idle'),
  Type.Literal('degraded'),
  Type.Literal('offline'),
  Type.Literal('unsupported'),
  Type.Literal('unknown'),
]);

const subsystemDetailSchema = Type.Object({
  state: subsystemStateSchema,
  lastChangedAt: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
});

export const deviceHealthResponseSchema = Type.Object({
  reachable: Type.Boolean(),
  refreshing: Type.Optional(Type.Boolean()),
  transport: Type.Optional(deviceTransportSchema),
  transportState: Type.Optional(deviceTransportStateSchema),
  capabilities: Type.Optional(Type.Array(Type.String())),
  lastSeenAt: Type.Optional(Type.Number()),
  recoveryState: Type.Optional(Type.Union([Type.Literal('stable'), Type.Literal('recovering'), Type.Literal('degraded'), Type.Literal('offline')])),
  agentHeartbeatAt: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
  jailbreakAvailable: Type.Optional(Type.Boolean()),
  testFlightRunning: Type.Optional(Type.Boolean()),
  testFlightBridgeReachable: Type.Optional(Type.Boolean()),
  darkEnabled: Type.Optional(Type.Boolean()),
  displayMode: Type.Optional(Type.Union([Type.Literal('dark_awake'), Type.Literal('dark_sleep'), Type.Literal('restore_idle'), Type.Literal('unchanged')])),
  autoinstallPaused: Type.Optional(Type.Boolean()),
  autoinstallPauseReason: Type.Optional(Type.String()),
  batteryPauseEnabled: Type.Optional(Type.Boolean()),
  batteryPauseThreshold: Type.Optional(Type.Number({ minimum: 5, maximum: 50 })),
  activeOperation: Type.Optional(Type.String()),
  screenIsOn: Type.Optional(Type.Boolean()),
  backlightState: Type.Optional(Type.Number()),
  batteryPercent: Type.Optional(Type.Number()),
  batteryCharging: Type.Optional(Type.Boolean()),
  batteryTemperatureC: Type.Optional(Type.Number()),
  batteryCycleCount: Type.Optional(Type.Number()),
  batteryHealthPercent: Type.Optional(Type.Number()),
  batteryDesignCapacityMah: Type.Optional(Type.Number()),
  batteryMaxCapacityMah: Type.Optional(Type.Number()),
  storageTotalBytes: Type.Optional(Type.Number()),
  storageUsedBytes: Type.Optional(Type.Number()),
  storageFreeBytes: Type.Optional(Type.Number()),
  storageUsedPercent: Type.Optional(Type.Number()),
  networkConnected: Type.Optional(Type.Boolean()),
  internetAccess: Type.Optional(Type.Boolean()),
  networkIpAddress: Type.Optional(Type.String()),
  networkInterface: Type.Optional(Type.String()),
  bridgeHeartbeats: Type.Optional(bridgeHeartbeatsSchema),
  subsystems: Type.Optional(Type.Object({
    usb: subsystemStateSchema,
    mux: subsystemStateSchema,
    agent: subsystemStateSchema,
    jailbreak: Type.Optional(subsystemStateSchema),
    appStore: subsystemStateSchema,
    testFlight: subsystemStateSchema,
    sshTunnel: subsystemStateSchema,
    storage: subsystemStateSchema,
    battery: subsystemStateSchema,
    thermal: subsystemStateSchema,
  })),
  subsystemDetails: Type.Optional(Type.Record(Type.String(), subsystemDetailSchema)),
  readiness: Type.Optional(Type.Object({
    score: Type.Number(),
    state: Type.Union([Type.Literal('ready'), Type.Literal('caution'), Type.Literal('blocked')]),
    reasons: Type.Array(Type.String()),
  })),
  checkedAt: Type.Number(),
}, { additionalProperties: true });

const deviceBridgeDiagnosticsSchema = Type.Object({
  bridge: Type.Object({
    bridgeVersion: Type.Optional(Type.String()),
    capabilities: Type.Optional(Type.Array(Type.String())),
    hasInstaller: Type.Optional(Type.Boolean()),
    hasCatalogManager: Type.Optional(Type.Boolean()),
    backgroundTaskActive: Type.Optional(Type.Boolean()),
    backgroundTimeRemaining: Type.Optional(Type.Number()),
  }, { additionalProperties: true }),
  install: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  recentLog: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: true });

const devicePreflightCheckSchema = Type.Object({
  label: Type.String(),
  ok: Type.Boolean(),
  detail: Type.Optional(Type.String()),
});

export const devicePreflightResponseSchema = Type.Object({
  device: dashboardDeviceResponseSchema,
  health: deviceHealthResponseSchema,
  bridge: Type.Optional(deviceBridgeDiagnosticsSchema),
  checks: Type.Array(devicePreflightCheckSchema),
  ready: Type.Boolean(),
}, { additionalProperties: true });

export const deviceInventoryResponseSchema = Type.Object({
  deviceId: identifierSchema,
  bundles: Type.Array(Type.String()),
}, { additionalProperties: true });

export const deviceBridgeActionBodySchema = Type.Object({
  action: Type.Union([Type.Literal('open-testflight'), Type.Literal('open-appstore'), Type.Literal('screen-status')]),
});

export const deviceBridgeActionResponseSchema = Type.Object({
  result: Type.Object({}, { additionalProperties: true }),
}, { additionalProperties: true });

export const deviceRecoveryOperationSchema = Type.Object({
  id: identifierSchema,
  deviceId: identifierSchema,
  action: Type.Literal('springboard-reload'),
  status: Type.Union([Type.Literal('queued'), Type.Literal('running'), Type.Literal('verifying'), Type.Literal('complete'), Type.Literal('failed'), Type.Literal('interrupted')]),
  stage: Type.String(),
  stages: Type.Array(Type.Object({ label: Type.String(), at: Type.Number(), status: Type.Union([Type.Literal('running'), Type.Literal('complete'), Type.Literal('failed')]) })),
  commandExitCode: Type.Optional(Type.Number()),
  reachable: Type.Optional(Type.Boolean()),
  agentReady: Type.Optional(Type.Boolean()),
  springboardReady: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  completedAt: Type.Optional(Type.Number()),
}, { additionalProperties: false });

export const deviceRecoveryResponseSchema = Type.Object({ ok: Type.Literal(true), operation: deviceRecoveryOperationSchema });
export const deviceRecoveryListResponseSchema = Type.Object({ operations: Type.Array(deviceRecoveryOperationSchema) });

export const deviceForceQuerySchema = Type.Object({
  force: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
}, { additionalProperties: true });

export type DeviceHealthResponse = Static<typeof deviceHealthResponseSchema>;
export type DevicePreflightResponse = Static<typeof devicePreflightResponseSchema>;
export type DeviceInventoryResponse = Static<typeof deviceInventoryResponseSchema>;
export type DeviceBridgeActionBody = Static<typeof deviceBridgeActionBodySchema>;

type DeviceParams = { id: string };
type DeviceHealthRouteErrors = { 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 502: ApiErrorEnvelope; 503: ApiErrorEnvelope };

export type DashboardDeviceHealthRoute = {
  Params: DeviceParams;
  Querystring: Static<typeof deviceForceQuerySchema>;
  Reply: { 200: DeviceHealthResponse } & DeviceHealthRouteErrors;
};

export type DashboardDevicePreflightRoute = {
  Params: DeviceParams;
  Reply: { 200: DevicePreflightResponse } & DeviceHealthRouteErrors;
};

export type DashboardDeviceInventoryRoute = {
  Params: DeviceParams;
  Reply: { 200: DeviceInventoryResponse } & DeviceHealthRouteErrors;
};

export type DashboardDeviceDarkModeRoute = {
  Params: DeviceParams;
  Body: { enabled: boolean };
  Reply: { 200: DeviceHealthResponse } & DeviceHealthRouteErrors;
};

export type DashboardDeviceBridgeActionRoute = {
  Params: DeviceParams;
  Body: DeviceBridgeActionBody;
  Reply: { 200: Static<typeof deviceBridgeActionResponseSchema> } & DeviceHealthRouteErrors;
};

export type DashboardDeviceRecoverRoute = {
  Params: DeviceParams;
  Reply: { 200: Static<typeof deviceRecoveryResponseSchema> } & DeviceHealthRouteErrors;
};

export type DashboardDeviceRecoveryListRoute = {
  Params: DeviceParams;
  Reply: { 200: Static<typeof deviceRecoveryListResponseSchema> } & DeviceHealthRouteErrors;
};

export type DashboardDeviceRecoveryStatusRoute = {
  Params: DeviceParams & { operationId: string };
  Reply: { 200: Static<typeof deviceRecoveryResponseSchema> } & DeviceHealthRouteErrors;
};
