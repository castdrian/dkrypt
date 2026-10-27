import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Job } from '#jobs/types.js';
import { PermissionFlag } from '#permissions.js';
import { createDashboardTestFlightBrowseRoutes } from '#routes/dashboardTestFlightBrowseRoutes.js';
import { setSessionCookie } from '#session.js';
import { createDevice, deleteDevice } from '#store/state.js';
import { TestFlightCatalogUnavailableError } from '#testflightSubscriptions.js';
import type { Response } from '#http.js';

function sessionCookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0];
}

function createEnabledDevice(name: string) {
  return createDevice({ name, transport: 'usb', udid: crypto.randomUUID() }, 'test');
}

const build = {
  id: 987,
  cfBundleShortVersion: '2.4',
  cfBundleVersion: '204',
  bundleId: 'com.example.testflight',
};

test('TestFlight browse routes pass through an explicitly selected enabled device', async () => {
  const device = createEnabledDevice(`TestFlight browse ${crypto.randomUUID()}`);
  const seenDeviceIds: Array<string | undefined> = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightBrowseRoutes({
    getVerifiedCatalog: async () => [{
      appId: 12345,
      bundleId: build.bundleId,
      displayName: 'TestFlight app',
      devices: [{ id: device.id, name: device.name, verifiedAt: Date.now() }],
      lastVerifiedAt: Date.now(),
      deviceSource: true,
    }],
    listTrains: async (appId, selectedDevice) => {
      expect(appId).toBe(12345);
      seenDeviceIds.push(selectedDevice?.id);
      return [{ trainVersion: '2.4', buildCount: 3 }];
    },
    listBuilds: async (appId, trainVersion, selectedDevice) => {
      expect(appId).toBe(12345);
      expect(trainVersion).toBe('2.4');
      seenDeviceIds.push(selectedDevice?.id);
      return [build];
    },
  }));

  try {
    const cookie = sessionCookie(PermissionFlag.viewDevices);
    const trains = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/testflight/12345/trains?deviceId=${device.id}`,
      headers: { cookie },
    });
    const builds = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/testflight/12345/builds?trainVersion=2.4&deviceId=${device.id}`,
      headers: { cookie },
    });
    const invalidAppId = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/testflight/0/trains',
      headers: { cookie },
    });

    expect(trains.statusCode).toBe(200);
    expect(JSON.parse(trains.body)).toEqual({ trains: [{ trainVersion: '2.4', buildCount: 3 }] });
    expect(builds.statusCode).toBe(200);
    expect(JSON.parse(builds.body)).toEqual({ builds: [build] });
    expect(invalidAppId.statusCode).toBe(400);
    expect(seenDeviceIds).toEqual([device.id, device.id]);
  } finally {
    await server.close();
    deleteDevice(device.id, 'test cleanup');
  }
});

test('TestFlight diagnostics remain restricted to automation managers', async () => {
  let diagnosticsCalls = 0;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightBrowseRoutes({
    getDiagnostics: async () => {
      diagnosticsCalls += 1;
      return { bridge: { bridgeVersion: '1.2.0', capabilities: ['testflight.trains'] } };
    },
  }));

  try {
    const denied = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/testflight/diagnostics',
      headers: { cookie: sessionCookie(0n) },
    });
    const allowed = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/testflight/diagnostics',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ bridge: { bridgeVersion: '1.2.0' } });
    expect(diagnosticsCalls).toBe(1);
  } finally {
    await server.close();
  }
});

test('TestFlight decrypt queues only for a device with verified access', async () => {
  const eligible = createEnabledDevice(`TestFlight eligible ${crypto.randomUUID()}`);
  const ineligible = createEnabledDevice(`TestFlight ineligible ${crypto.randomUUID()}`);
  let queuedDeviceId: string | undefined;
  let enqueueCalls = 0;
  const queuedJob: Job = {
    id: 'testflight-job',
    projectId: 'default',
    bundleId: build.bundleId,
    testflight: { appId: 12345, build },
    source: 'manual',
    queuedBy: 'root',
    priority: 0,
    status: 'queued',
    progress: 'queued',
    createdAt: Date.now(),
    waiters: [],
  };
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightBrowseRoutes({
    getVerifiedCatalog: async (options) => {
      expect(options).toEqual({ requireAllDevices: false });
      return [{
        appId: 12345,
        bundleId: build.bundleId,
        displayName: 'TestFlight app',
        devices: [{ id: eligible.id, name: eligible.name, verifiedAt: Date.now() }],
        lastVerifiedAt: Date.now(),
        deviceSource: true,
      }];
    },
    enqueueDecryptJob: (bundleId, _source, options) => {
      enqueueCalls += 1;
      queuedDeviceId = options?.preferredDeviceId;
      expect(bundleId).toBe(build.bundleId);
      expect(options?.testflight?.appId).toBe(12345);
      return queuedJob;
    },
  }));

  try {
    const cookie = sessionCookie(PermissionFlag.requestDecrypt);
    const accepted = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/testflight/decrypt',
      headers: { cookie },
      payload: { bundleId: build.bundleId, appId: 12345, build, deviceId: eligible.id },
    });
    const rejected = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/testflight/decrypt',
      headers: { cookie },
      payload: { bundleId: build.bundleId, appId: 12345, build, deviceId: ineligible.id },
    });

    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ id: 'testflight-job', channel: 'testflight' });
    expect(queuedDeviceId).toBe(eligible.id);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ code: 'conflict', message: 'TestFlight access is not recently verified on the selected device' });
    expect(enqueueCalls).toBe(1);
  } finally {
    await server.close();
    deleteDevice(eligible.id, 'test cleanup');
    deleteDevice(ineligible.id, 'test cleanup');
  }
});

test('TestFlight decrypt rejects stale per-device access without requiring every device to respond', async () => {
  const device = createEnabledDevice(`TestFlight stale ${crypto.randomUUID()}`);
  const queuedJob: Job = {
    id: 'testflight-stale-job',
    projectId: 'default',
    bundleId: build.bundleId,
    testflight: { appId: 12345, build },
    source: 'manual',
    queuedBy: 'root',
    priority: 0,
    status: 'queued',
    progress: 'queued',
    createdAt: Date.now(),
    waiters: [],
  };
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightBrowseRoutes({
    getVerifiedCatalog: async (options) => {
      expect(options).toEqual({ requireAllDevices: false });
      return [{
        appId: 12345,
        bundleId: build.bundleId,
        displayName: 'TestFlight app',
        devices: [{ id: device.id, name: device.name, verifiedAt: Date.now() - 31 * 60_000 }],
        lastVerifiedAt: Date.now() - 31 * 60_000,
        deviceSource: true,
      }];
    },
    enqueueDecryptJob: (() => queuedJob) as typeof import('#jobs/store.js').enqueueDecryptJob,
  }));

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/testflight/decrypt',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices) },
      payload: { bundleId: build.bundleId, appId: 12345, build, deviceId: device.id },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'conflict', message: 'TestFlight access is not recently verified on the selected device' });
  } finally {
    await server.close();
    deleteDevice(device.id, 'test cleanup');
  }
});

test('TestFlight decrypt rejects build mismatches and returns retryable unavailable status safely', async () => {
  let catalogCalls = 0;
  let enqueueCalls = 0;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightBrowseRoutes({
    getVerifiedCatalog: async () => {
      catalogCalls += 1;
      throw new TestFlightCatalogUnavailableError();
    },
    enqueueDecryptJob: (() => {
      enqueueCalls += 1;
      throw new Error('must not enqueue');
    }) as typeof import('#jobs/store.js').enqueueDecryptJob,
  }));

  try {
    const cookie = sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices);
    const mismatch = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/testflight/decrypt',
      headers: { cookie },
      payload: { bundleId: build.bundleId, appId: 12345, build: { ...build, bundleId: 'com.example.other' } },
    });
    const unavailable = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/testflight/decrypt',
      headers: { cookie },
      payload: { bundleId: build.bundleId, appId: 12345, build },
    });

    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ code: 'request_error' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      code: 'testflight_catalog_unavailable',
      retryable: true,
      message: 'TestFlight availability could not be verified on every enabled device',
    });
    expect(catalogCalls).toBe(1);
    expect(enqueueCalls).toBe(0);
  } finally {
    await server.close();
  }
});

test('TestFlight upstream failures return a safe retryable error envelope', async () => {
  const device = createEnabledDevice(`TestFlight upstream ${crypto.randomUUID()}`);
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightBrowseRoutes({
    getVerifiedCatalog: async () => [{
      appId: 12345,
      bundleId: build.bundleId,
      displayName: 'TestFlight app',
      devices: [{ id: device.id, name: device.name, verifiedAt: Date.now() }],
      lastVerifiedAt: Date.now(),
      deviceSource: true,
    }],
    listTrains: async () => {
      throw new Error('private upstream token details');
    },
  }));

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/testflight/12345/trains',
      headers: { cookie: sessionCookie(PermissionFlag.viewDevices) },
    });
    const body = response.json() as Record<string, unknown>;
    expect(response.statusCode).toBe(502);
    expect(body).toMatchObject({
      code: 'testflight_lookup_failed',
      retryable: true,
      message: 'TestFlight service is temporarily unavailable',
    });
    expect(JSON.stringify(body)).not.toContain('private upstream token details');
  } finally {
    await server.close();
    deleteDevice(device.id, 'test cleanup');
  }
});
