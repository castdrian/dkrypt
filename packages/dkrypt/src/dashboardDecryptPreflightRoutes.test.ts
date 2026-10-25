import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Response } from '#http.js';
import type { Job } from '#jobs/types.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { createDashboardDecryptPreflightRoutes, type DashboardDecryptPreflightServices } from '#routes/dashboardDecryptPreflightRoutes.js';
import { setSessionCookie } from '#session.js';
import type { DeviceHealth } from '#deviceHealth.js';
import type { DeviceRecord } from '#store/state.js';
import { TestFlightCatalogUnavailableError, type TestFlightCatalogApp } from '#testflightSubscriptions.js';

function sessionCookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

function createDevice(id: string, overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id,
    name: id,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createJob(id: string, projectId: string): Job {
  return {
    id,
    projectId,
    bundleId: 'com.example.app',
    source: 'manual',
    priority: 0,
    status: 'queued',
    progress: 'queued',
    createdAt: 1,
    waiters: [],
  };
}

function createHealth(overrides: Partial<DeviceHealth> = {}): DeviceHealth {
  return {
    reachable: true,
    jailbreakAvailable: true,
    checkedAt: 1,
    ...overrides,
  };
}

function createTestFlightApp(devices: TestFlightCatalogApp['devices']): TestFlightCatalogApp {
  const verifiedAt = Date.now();
  return {
    appId: 123,
    bundleId: 'com.example.app',
    displayName: 'Example App',
    devices: devices.map((device) => ({ ...device, verifiedAt: device.verifiedAt ?? verifiedAt })),
    lastVerifiedAt: verifiedAt,
    deviceSource: true,
  };
}

function build(overrides: Partial<DashboardDecryptPreflightServices> = {}) {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  void server.register(createDashboardDecryptPreflightRoutes({
    getEffectiveDevices: () => [],
    ...overrides,
  }));
  return server;
}

test('dashboard decrypt preflight is not registered through the legacy router', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('POST /v1/dashboard/decrypt/preflight');
});

test('decrypt preflight limits checks to enabled devices and returns shared queue readiness', async () => {
  const devices = [createDevice('enabled-device', { name: 'Enabled iPad', isPrimary: true }), createDevice('disabled-device', { enabled: false }), createDevice('draining-device', { draining: true })];
  const checkedDevices: string[] = [];
  const server = build({
    getEffectiveDevices: () => devices,
    getAverageJobDurationMs: () => 4_200,
    getActiveJobs: () => [createJob('shared-job', 'default'), createJob('legacy-job', 'legacy-project')],
    getDeviceHealth: async (deviceId) => {
      checkedDevices.push(deviceId);
      return createHealth({
        internetAccess: false,
        storageFreeBytes: 128,
        batteryPercent: 71,
        readiness: { score: 50, state: 'blocked', reasons: ['no internet access'] },
      });
    },
    getDeviceInstallBlocker: () => 'device storage is below the install threshold',
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { bundleId: 'com.example.app', versionLabel: ' v2 ', installSizeBytes: 64 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      bundleId: 'com.example.app',
      versionLabel: 'v2',
      testflight: false,
      installSizeBytes: 64,
      estimatedDurationMs: 4_200,
      queueLength: 1,
      canQueue: false,
      devices: [{
        id: 'enabled-device',
        name: 'Enabled iPad',
        isPrimary: true,
        ready: false,
        blockers: ['device cannot reach Apple services', 'device storage is below the install threshold', 'no internet access'],
        readiness: { score: 50, state: 'blocked', reasons: ['no internet access'] },
        reachable: true,
        storageFreeBytes: 128,
        batteryPercent: 71,
      }],
    });
    expect(checkedDevices).toEqual(['enabled-device']);
  } finally {
    await server.close();
  }
});

test('App Store preflight reports the shared SpringBoard bridge outage', async () => {
  const device = createDevice('appstore-device');
  const server = build({
    getEffectiveDevices: () => [device],
    getDeviceHealth: async () => createHealth({
      testFlightBridgeReachable: false,
      readiness: { score: 0, state: 'blocked', reasons: ['autoinstall bridge is unresponsive'] },
    }),
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { bundleId: 'com.example.app' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      canQueue: false,
      devices: [{ id: device.id, ready: false, blockers: ['autoinstall SpringBoard bridge is unresponsive'], readiness: { state: 'blocked' } }],
    });
  } finally {
    await server.close();
  }
});

test('preflight does not wait indefinitely for an occupied device-health probe', async () => {
  const device = createDevice('busy-device');
  let releaseProbe: ((value: DeviceHealth) => void) | undefined;
  const probe = new Promise<DeviceHealth>((resolve) => { releaseProbe = resolve; });
  const server = build({
    getEffectiveDevices: () => [device],
    getDeviceHealth: () => probe,
  });

  try {
    const request = server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { bundleId: 'com.myfitnesspal.mfp' },
    });
    const response = await Promise.race([
      request,
      Bun.sleep(1_500).then(() => undefined),
    ]);
    expect(response?.statusCode).toBe(200);
    expect(response?.json()).toMatchObject({ canQueue: false, devices: [{ ready: false, checking: true }] });
  } finally {
    releaseProbe?.(createHealth());
    await server.close();
  }
});

test('TestFlight preflight exposes only verified devices and rejects an ineligible selection', async () => {
  const first = createDevice('device-one');
  const second = createDevice('device-two');
  const checkedDevices: string[] = [];
  const catalogOptions: Array<{ requireAllDevices?: boolean } | undefined> = [];
  const server = build({
    getEffectiveDevices: () => [first, second],
    getDevice: (id) => [first, second].find((device) => device.id === id),
    getVerifiedTestFlightCatalog: async (options) => {
      catalogOptions.push(options);
      return [createTestFlightApp([{ id: first.id, name: first.name }])];
    },
    getDeviceHealth: async (deviceId) => {
      checkedDevices.push(deviceId);
      return createHealth({ internetAccess: true });
    },
    getDeviceInstallBlocker: () => undefined,
    getDeviceReadiness: () => ({ score: 100, state: 'ready', reasons: [] }),
  });

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.requestDecrypt) };
    const selectedIneligible = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers,
      payload: { bundleId: 'com.example.app', testflight: true, deviceId: second.id },
    });
    const available = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers,
      payload: { bundleId: 'com.example.app', testflight: true },
    });

    expect(selectedIneligible.statusCode).toBe(409);
    expect(selectedIneligible.json()).toMatchObject({ error: 'TestFlight access is not recently verified on the selected device', retryable: false });
    expect(available.statusCode).toBe(200);
    expect(available.json()).toMatchObject({ canQueue: true, devices: [{ id: first.id, ready: true }] });
    expect(checkedDevices).toEqual([first.id]);
    expect(catalogOptions).toEqual([{ requireAllDevices: false }, { requireAllDevices: false }]);
  } finally {
    await server.close();
  }
});

test('TestFlight preflight rejects stale app access while allowing partial device availability', async () => {
  const available = createDevice('recent-device');
  const stale = createDevice('stale-device');
  const server = build({
    getEffectiveDevices: () => [available, stale],
    getVerifiedTestFlightCatalog: async () => [createTestFlightApp([
      { id: available.id, name: available.name },
      { id: stale.id, name: stale.name, verifiedAt: Date.now() - 31 * 60_000 },
    ])],
    getDeviceHealth: async () => createHealth({ internetAccess: true }),
    getDeviceInstallBlocker: () => undefined,
    getDeviceReadiness: () => ({ score: 100, state: 'ready', reasons: [] }),
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { bundleId: 'com.example.app', testflight: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ canQueue: true, devices: [{ id: available.id, ready: true }] });
  } finally {
    await server.close();
  }
});

test('a failed device health lookup does not hide other ready devices', async () => {
  const primary = createDevice('primary-device', { isPrimary: true });
  const recovering = createDevice('recovering-device');
  const server = build({
    getEffectiveDevices: () => [primary, recovering],
    getDeviceHealth: async (deviceId) => {
      if (deviceId === recovering.id) throw new Error('bridge reconnecting');
      return createHealth({ internetAccess: true });
    },
    getDeviceInstallBlocker: () => undefined,
    getDeviceReadiness: () => ({ score: 100, state: 'ready', reasons: [] }),
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { bundleId: 'com.example.app' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      canQueue: true,
      devices: [
        { id: primary.id, isPrimary: true, ready: true },
        { id: recovering.id, isPrimary: false, ready: false, reachable: false, blockers: ['bridge reconnecting'] },
      ],
    });
  } finally {
    await server.close();
  }
});

test('decrypt preflight reports unavailable TestFlight verification', async () => {
  const device = createDevice('enabled-device');
  const unavailableServer = build({
    getEffectiveDevices: () => [device],
    getVerifiedTestFlightCatalog: async () => { throw new TestFlightCatalogUnavailableError(); },
  });

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.requestDecrypt) };
    const unavailable = await unavailableServer.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers,
      payload: { bundleId: 'com.example.app', testflight: true },
    });

    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ code: 'testflight_catalog_unavailable', retryable: true });
  } finally {
    await unavailableServer.close();
  }
});

test('decrypt preflight enforces permission and enabled-device selection without project scopes', async () => {
  const permissionServer = build();
  const disabledDeviceServer = build({
    getDevice: (id) => id === 'disabled-device' ? createDevice(id, { enabled: false }) : undefined,
  });
  const drainingDeviceServer = build({
    getDevice: (id) => id === 'draining-device' ? createDevice(id, { draining: true }) : undefined,
  });

  try {
    const denied = await permissionServer.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers: { cookie: sessionCookie(0n) },
      payload: { bundleId: 'com.example.app' },
    });
    const unscoped = await permissionServer.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { bundleId: 'com.example.app', projectId: 'hidden' },
    });
    const disabledDevice = await disabledDeviceServer.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { bundleId: 'com.example.app', deviceId: 'disabled-device' },
    });
    const drainingDevice = await drainingDeviceServer.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt/preflight',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { bundleId: 'com.example.app', deviceId: 'draining-device' },
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'forbidden', requestId: expect.any(String), retryable: false });
    expect(unscoped.statusCode).toBe(200);
    expect(unscoped.json()).not.toHaveProperty('projectId');
    expect(disabledDevice.statusCode).toBe(400);
    expect(disabledDevice.json()).toMatchObject({ error: 'deviceId must refer to an enabled device accepting jobs', retryable: false });
    expect(drainingDevice.statusCode).toBe(400);
    expect(drainingDevice.json()).toMatchObject({ error: 'deviceId must refer to an enabled device accepting jobs', retryable: false });
  } finally {
    await permissionServer.close();
    await disabledDeviceServer.close();
    await drainingDeviceServer.close();
  }
});
