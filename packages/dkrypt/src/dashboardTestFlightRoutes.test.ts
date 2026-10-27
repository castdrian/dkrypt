import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { buildTestServer } from '#testServer.js';
import type { Response } from '#http.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { createDashboardTestFlightRoutes } from '#routes/dashboardTestFlightRoutes.js';
import { setSessionCookie } from '#session.js';
import { createTestFlightSubscription, withdrawTestFlightSubscription } from '#store/state.js';

function sessionCookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0];
}

function createSubscription(inviteCode: string, requestedBy = 'root', status: 'pending' | 'approved' = 'pending') {
  return createTestFlightSubscription({
    url: `https://testflight.apple.com/join/${inviteCode}`,
    inviteCode,
    requestedBy,
    status,
    appId: 12345,
    bundleId: `com.example.${inviteCode.toLowerCase()}`,
    displayName: `Test ${inviteCode}`,
  }, 'root');
}

test('TestFlight management endpoints are not registered through the legacy router', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/testflight/subscriptions');
  expect(routes).not.toContain('POST /v1/dashboard/testflight/subscriptions');
  expect(routes).not.toContain('POST /v1/dashboard/testflight/subscriptions/:id/approve');
  expect(routes).not.toContain('POST /v1/dashboard/testflight/subscriptions/:id/deny');
  expect(routes).not.toContain('POST /v1/dashboard/testflight/subscriptions/:id/sync');
  expect(routes).not.toContain('POST /v1/dashboard/testflight/subscriptions/:id/unsubscribe');
  expect(routes).not.toContain('GET /v1/dashboard/testflight/catalog');
  expect(routes).not.toContain('POST /v1/dashboard/testflight/catalog/:bundleId/unsubscribe');
});

test('TestFlight browse and decrypt endpoints are not registered through the legacy router', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/testflight/:appId/trains');
  expect(routes).not.toContain('GET /v1/dashboard/testflight/diagnostics');
  expect(routes).not.toContain('GET /v1/dashboard/testflight/:appId/builds');
  expect(routes).not.toContain('POST /v1/dashboard/testflight/decrypt');
});

test('TestFlight subscription listing keeps personal requests private', async () => {
  const own = createSubscription(crypto.randomUUID().replaceAll('-', '').slice(0, 12));
  const other = createSubscription(crypto.randomUUID().replaceAll('-', '').slice(0, 12), 'other@example.com');
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/testflight/subscriptions',
      headers: { cookie: sessionCookie(PermissionFlag.requestTestFlightSubscriptions) },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { subscriptions: Array<{ id: string }> }).subscriptions.map((entry) => entry.id)).toContain(own.id);
    expect((response.json() as { subscriptions: Array<{ id: string }> }).subscriptions.map((entry) => entry.id)).not.toContain(other.id);
  } finally {
    withdrawTestFlightSubscription(own.id, 'root');
    withdrawTestFlightSubscription(other.id, 'root');
    await server.close();
  }
});

test('TestFlight invite submission rejects noncanonical links without resolving them', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/testflight/subscriptions',
      headers: { cookie: sessionCookie(PermissionFlag.requestTestFlightSubscriptions) },
      payload: { url: 'https://example.com/join/ABC123' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'request_error' });
  } finally {
    await server.close();
  }
});

test('TestFlight approval requires manager permission', async () => {
  const subscription = createSubscription(crypto.randomUUID().replaceAll('-', '').slice(0, 12));
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    const response = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/testflight/subscriptions/${subscription.id}/approve`,
      headers: { cookie: sessionCookie(PermissionFlag.requestTestFlightSubscriptions) },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden' });
  } finally {
    withdrawTestFlightSubscription(subscription.id, 'root');
    await server.close();
  }
});

test('TestFlight duplicate approved links are rejected with the existing subscription', async () => {
  const inviteCode = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const subscription = createSubscription(inviteCode, 'root', 'approved');
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/testflight/subscriptions',
      headers: { cookie: sessionCookie(PermissionFlag.requestTestFlightSubscriptions) },
      payload: { url: subscription.url },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ alreadySubscribed: true, subscription: { id: subscription.id } });
  } finally {
    withdrawTestFlightSubscription(subscription.id, 'root');
    await server.close();
  }
});

test('TestFlight duplicate links do not reveal another requester’s approved subscription', async () => {
  const inviteCode = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const subscription = createSubscription(inviteCode, 'other@example.com', 'approved');
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/testflight/subscriptions',
      headers: { cookie: sessionCookie(PermissionFlag.requestTestFlightSubscriptions) },
      payload: { url: subscription.url },
    });
    const body = response.json() as Record<string, unknown>;
    expect(response.statusCode).toBe(409);
    expect(body).toMatchObject({ code: 'conflict', error: 'a subscription already exists for this invite link' });
    expect(body).not.toHaveProperty('subscription');
    expect(body).not.toHaveProperty('alreadySubscribed');
  } finally {
    withdrawTestFlightSubscription(subscription.id, 'root');
    await server.close();
  }
});

test('TestFlight managers can deny pending requests', async () => {
  const subscription = createSubscription(crypto.randomUUID().replaceAll('-', '').slice(0, 12));
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightRoutes());
  try {
    const response = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/testflight/subscriptions/${subscription.id}/deny`,
      headers: { cookie: sessionCookie(PermissionFlag.manageTestFlightSubscriptions) },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ subscription: { id: subscription.id, status: 'denied' } });
  } finally {
    withdrawTestFlightSubscription(subscription.id, 'root');
    await server.close();
  }
});

test('TestFlight managers create approved subscriptions and start synchronization immediately', async () => {
  let syncCalled = false;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightRoutes({
    resolveInvite: async () => ({ appId: 12345, bundleId: 'com.example.managed', displayName: 'Managed app' }),
    getVerifiedCatalog: async () => [],
    syncSubscription: async () => {
      syncCalled = true;
      return undefined;
    },
  }));
  let subscriptionId = '';
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/testflight/subscriptions',
      headers: { cookie: sessionCookie(PermissionFlag.manageTestFlightSubscriptions) },
      payload: { url: `https://testflight.apple.com/join/${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}` },
    });
    const body = response.json() as { subscription: { id: string; status: string } };
    subscriptionId = body.subscription.id;
    expect(response.statusCode).toBe(202);
    expect(body.subscription.status).toBe('approved');
    expect(syncCalled).toBe(true);
  } finally {
    if (subscriptionId) withdrawTestFlightSubscription(subscriptionId, 'root');
    await server.close();
  }
});

test('TestFlight requests are rejected when an enabled device already has the app', async () => {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightRoutes({
    resolveInvite: async () => ({ appId: 12345, bundleId: 'com.example.device-app', displayName: 'Device app' }),
    getVerifiedCatalog: async () => [{
      appId: 12345,
      bundleId: 'com.example.device-app',
      displayName: 'Device app',
      devices: [{ id: 'ipad', name: 'iPad' }],
      lastVerifiedAt: Date.now(),
      deviceSource: true,
    }],
  }));
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/testflight/subscriptions',
      headers: { cookie: sessionCookie(PermissionFlag.requestTestFlightSubscriptions) },
      payload: { url: `https://testflight.apple.com/join/${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ alreadySubscribed: true });
  } finally {
    await server.close();
  }
});

test('TestFlight requesters cannot unsubscribe another user’s subscription', async () => {
  const subscription = createSubscription(crypto.randomUUID().replaceAll('-', '').slice(0, 12), 'other@example.com', 'approved');
  let unsubscribeCalled = false;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightRoutes({
    unsubscribeSubscription: async () => {
      unsubscribeCalled = true;
      return undefined;
    },
  }));
  try {
    const response = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/testflight/subscriptions/${subscription.id}/unsubscribe`,
      headers: { cookie: sessionCookie(PermissionFlag.requestTestFlightSubscriptions) },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden' });
    expect(unsubscribeCalled).toBe(false);
  } finally {
    withdrawTestFlightSubscription(subscription.id, 'root');
    await server.close();
  }
});

test('TestFlight catalog shortcuts return cached device results and request refreshes', async () => {
  const refreshes: boolean[] = [];
  const app = {
    appId: 12345,
    bundleId: 'com.example.cached',
    displayName: 'Cached app',
    devices: [{ id: 'ipad', name: 'iPad' }],
    lastVerifiedAt: 1,
    deviceSource: true as const,
  };
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightRoutes({
    getCatalogCacheState: () => ({ apps: [app], fetchedAt: 1, stale: false, refreshing: false }),
    refreshCatalogInBackground: (force) => refreshes.push(force),
  }));
  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/testflight/catalog?refresh=true',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ apps: [app], refreshing: true });
    expect(refreshes).toEqual([true]);
  } finally {
    await server.close();
  }
});

test('TestFlight managers cannot remove the immutable Discord app from a device', async () => {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardTestFlightRoutes());
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/testflight/catalog/com.hammerandchisel.discord/unsubscribe',
      headers: { cookie: sessionCookie(PermissionFlag.manageTestFlightSubscriptions) },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'conflict', message: expect.stringContaining('protected') });
  } finally {
    await server.close();
  }
});
