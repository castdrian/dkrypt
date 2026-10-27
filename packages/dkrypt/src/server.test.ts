import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { buildArtifactFileUrl, promoteArtifact, touchArtifact } from '#artifacts.js';
import { exportBillingSnapshot, replaceBillingSnapshot, upsertBillingSubscription } from '#billing.js';
import { currentCorrelation } from '#correlation.js';
import { deleteAuthProfile, upsertAuthProfile } from '#identity.js';
import { scopedLogger } from '#logger.js';
import { closeDashboardConnections, dashboardEvents, emitBillingChanged, emitJobsChanged } from '#events.js';
import { cancelJob, cancelQueuedJob, enqueueDecryptJob } from '#jobs/store.js';
import { replacePersistedJobs } from '#jobs/repository.js';
import { config } from '#config.js';
import { setCachedDeviceHealth } from '#deviceHealthCache.js';
import { PermissionFlag, serializeBits } from '#permissions.js';
import { buildTestServer } from '#testServer.js';
import { buildServer as buildRawServer } from '#server.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { parseDeviceConnection } from '#routes/dashboardDeviceRoutes.js';
import type { Response } from '#http.js';
import { addAllowedUser, createApiKey, createDevice, createRole, createTestFlightSubscription, deleteDevice, deleteRole, deleteUserPersonalData, getEffectiveSettings, recordAudit, recordDeviceActivity, recordJobHistory, recordNotification, revokeApiKey, updateRole, updateSettings, withdrawTestFlightSubscription } from '#store/state.js';
import { setSessionCookie } from '#session.js';

test('request trace context is available throughout the Fastify request lifecycle', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  let observedCorrelation: ReturnType<typeof currentCorrelation>;
  let rejectedCorrelation: ReturnType<typeof currentCorrelation>;
  server.addHook('preHandler', (_request, _reply, done) => {
    observedCorrelation = currentCorrelation();
    done();
  });
  server.addHook('onSend', (request, _reply, _payload, done) => {
    if (request.id === 'csrf-request-456') rejectedCorrelation = currentCorrelation();
    done();
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/status',
      headers: {
        'x-request-id': 'request-trace-123',
        traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(observedCorrelation).toMatchObject({
      correlationId: 'request-trace-123',
      traceId: '0123456789abcdef0123456789abcdef',
      traceContext: { traceId: '0123456789abcdef0123456789abcdef' },
    });
    expect(response.headers.traceparent).toBe(observedCorrelation?.traceContext?.traceparent);

    const rejected = await server.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        cookie: 'session=invalid',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
        'x-request-id': 'csrf-request-456',
      },
    });

    expect(rejected.statusCode).toBe(403);
    expect(rejectedCorrelation).toMatchObject({ correlationId: 'csrf-request-456' });
  } finally {
    await server.close();
  }
});

function createSessionCookie(userId: string, permissions: bigint): string {
  let cookieHeader = '';
  const response = { setHeader: (_name: string, value: string) => { cookieHeader = value; } } as unknown as Response;
  setSessionCookie(response, { sub: userId, permissions });
  return cookieHeader.split(';', 1)[0];
}

test('OAuth account usernames are editable, unique, and included in the session', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const providerId = crypto.randomUUID();
  const userId = `discord:${providerId}`;
  const otherProviderId = crypto.randomUUID();
  const otherUserId = `github:${otherProviderId}`;
  const updatedAt = new Date().toISOString();
  upsertAuthProfile({ userId, provider: 'discord', providerId, username: 'FirstAccount', displayName: 'First account', updatedAt });
  upsertAuthProfile({ userId: otherUserId, provider: 'github', providerId: otherProviderId, username: 'SecondAccount', displayName: 'Second account', updatedAt });
  try {
    const cookie = createSessionCookie(userId, 0n);
    const before = await server.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    expect(before.json()).toMatchObject({ username: 'FirstAccount', displayName: 'First account' });

    const updated = await server.inject({ method: 'PATCH', url: '/v1/auth/profile', headers: { cookie }, payload: { username: 'ChosenName', displayName: 'Chosen display name' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ username: 'ChosenName', displayName: 'Chosen display name' });

    const duplicate = await server.inject({ method: 'PATCH', url: '/v1/auth/profile', headers: { cookie: createSessionCookie(otherUserId, 0n) }, payload: { username: 'chosenname' } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ message: 'username is already taken' });

    const after = await server.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    expect(after.json()).toMatchObject({ username: 'ChosenName', displayName: 'Chosen display name' });
  } finally {
    deleteAuthProfile(userId);
    deleteAuthProfile(otherUserId);
    await server.close();
  }
});

test('cookie-authenticated mutations reject non-same-origin Fetch Metadata values', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });

  try {
    for (const fetchSite of ['same-site', 'cross-site', 'none']) {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          cookie: createSessionCookie('root', PermissionFlag.administrator),
          'sec-fetch-site': fetchSite,
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'csrf_origin_rejected' });
    }

    const mismatchedOrigin = await server.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        cookie: createSessionCookie('root', PermissionFlag.administrator),
        origin: 'https://attacker.example',
      },
    });

    expect(mismatchedOrigin.statusCode).toBe(403);
    expect(mismatchedOrigin.json()).toMatchObject({ code: 'csrf_origin_rejected', message: 'request origin is not allowed' });

    const sameOrigin = await server.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        cookie: createSessionCookie('root', PermissionFlag.administrator),
        origin: config.publicBaseUrl,
        'sec-fetch-site': 'same-origin',
      },
    });

    expect(sameOrigin.statusCode).toBe(200);

    const originOnly = await server.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        cookie: createSessionCookie('root', PermissionFlag.administrator),
        origin: config.publicBaseUrl,
      },
    });

    expect(originOnly.statusCode).toBe(200);
  } finally {
    await server.close();
  }
});

test('cookie-authenticated mutations require same-origin request metadata', async () => {
  const server = await buildRawServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: createSessionCookie('root', PermissionFlag.administrator) },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'csrf_origin_rejected',
      message: 'request origin and fetch metadata are missing',
    });
  } finally {
    await server.close();
  }
});

test('self-hosted device setup accepts its actual same-origin browser URL', async () => {
  const server = await buildRawServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices/setup',
      headers: {
        cookie: createSessionCookie('root', PermissionFlag.administrator),
        host: '192.168.1.20:8080',
        origin: 'http://192.168.1.20:8080',
        'sec-fetch-site': 'same-origin',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: 'a discovered device connection is required' });

    const originOnly = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices/setup',
      headers: {
        cookie: createSessionCookie('root', PermissionFlag.administrator),
        host: '192.168.1.20:8080',
        origin: 'http://192.168.1.20:8080',
      },
      payload: {},
    });
    expect(originOnly.statusCode).toBe(400);
    expect(originOnly.json()).toMatchObject({ message: 'a discovered device connection is required' });
  } finally {
    await server.close();
  }
});

test('self-hosted device setup accepts a trusted HTTPS proxy origin', async () => {
  const server = await buildRawServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices/setup',
      remoteAddress: '127.0.0.1',
      headers: {
        cookie: createSessionCookie('root', PermissionFlag.administrator),
        host: '127.0.0.1:8080',
        origin: 'https://dkrypt.example.org',
        'x-forwarded-host': 'dkrypt.example.org',
        'x-forwarded-proto': 'https',
        'sec-fetch-site': 'same-origin',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: 'a discovered device connection is required' });
  } finally {
    await server.close();
  }
});

test('self-hosted device setup accepts a same-origin HTTPS browser behind a non-loopback proxy', async () => {
  const server = await buildRawServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices/setup',
      remoteAddress: '172.18.0.2',
      headers: {
        cookie: createSessionCookie('root', PermissionFlag.administrator),
        host: 'dkrypt.example.org',
        origin: 'https://dkrypt.example.org',
        'x-forwarded-proto': 'https',
        'sec-fetch-site': 'same-origin',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: 'a discovered device connection is required' });
  } finally {
    await server.close();
  }
});

test('self-hosted device setup rejects untrusted proxy forwarding and mismatched origins', async () => {
  const server = await buildRawServer({ includePublicRoutes: false });

  try {
    const cookie = createSessionCookie('root', PermissionFlag.administrator);
    const untrustedProxy = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices/setup',
      remoteAddress: '203.0.113.10',
      headers: {
        cookie,
        host: '127.0.0.1:8080',
        origin: 'https://attacker.example',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
        'sec-fetch-site': 'same-origin',
      },
      payload: {},
    });
    expect(untrustedProxy.json()).toMatchObject({ code: 'csrf_origin_rejected' });

    const mismatchedOrigin = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices/setup',
      headers: {
        cookie,
        host: '192.168.1.20:8080',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'same-origin',
      },
      payload: {},
    });
    expect(mismatchedOrigin.json()).toMatchObject({ code: 'csrf_origin_rejected' });
  } finally {
    await server.close();
  }
});

let signInCount = 0;

async function signIn() {
  const server = await buildTestServer({ includePublicRoutes: false });
  const login = await server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    remoteAddress: `198.18.0.${++signInCount}`,
    payload: { password: process.env.ADMIN_PASSWORD },
  });
  const cookie = login.headers['set-cookie'];
  const value = Array.isArray(cookie) ? cookie[0] : cookie;
  if (typeof value !== 'string') throw new Error('login did not set a session cookie');
  return { server, cookie: value.split(';', 1)[0] };
}

async function signInFromContext(
  server: Awaited<ReturnType<typeof buildTestServer>>,
  userAgent: string,
  remoteAddress: string,
): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'user-agent': userAgent },
    remoteAddress,
    payload: { password: process.env.ADMIN_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof value !== 'string') throw new Error('login did not set a session cookie');
  return value.split(';', 1)[0]!;
}

test('native auth routes preserve cookie sessions, refresh, logout, and session inventory', async () => {
  const { server, cookie } = await signIn();
  try {
    const session = await server.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ loggedIn: true, sub: 'root', deployment: { ref: expect.any(String) } });

    const mfa = await server.inject({ method: 'GET', url: '/v1/auth/mfa', headers: { cookie } });
    expect(mfa.statusCode).toBe(200);

    const rootProfile = await server.inject({ method: 'PATCH', url: '/v1/auth/profile', headers: { cookie }, payload: { displayName: 'Root' } });
    expect(rootProfile.statusCode).toBe(400);
    expect(rootProfile.json()).toMatchObject({ code: 'request_error', message: 'the root account does not have an OAuth profile' });

    const sessions = await server.inject({ method: 'GET', url: '/v1/auth/sessions', headers: { cookie } });
    expect(sessions.statusCode).toBe(200);
    expect((sessions.json() as { current: boolean }[]).some((entry) => entry.current)).toBe(true);

    const revokeOthers = await server.inject({ method: 'POST', url: '/v1/auth/sessions/revoke-others', headers: { cookie } });
    expect(revokeOthers.statusCode).toBe(200);

    const refresh = await server.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie } });
    expect(refresh.statusCode).toBe(200);
    const refreshCookie = refresh.headers['set-cookie'];
    expect(Array.isArray(refreshCookie) ? refreshCookie[0] : refreshCookie).toContain('session=');

    const logout = await server.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    const logoutCookie = logout.headers['set-cookie'];
    expect(Array.isArray(logoutCookie) ? logoutCookie[0] : logoutCookie).toContain('Max-Age=0');

    const afterLogout = await server.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    expect(afterLogout.json()).toMatchObject({ loggedIn: false });
  } finally {
    await server.close();
  }
});

test('root login records a manager-visible audit event for a new browser and network context', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const contextId = crypto.randomUUID();

  try {
    const firstCookie = await signInFromContext(server, `dkrypt-test-${contextId}-browser-a`, '198.51.100.17');
    const secondCookie = await signInFromContext(server, `dkrypt-test-${contextId}-browser-b`, '203.0.113.29');
    const sessions = await server.inject({ method: 'GET', url: '/v1/auth/sessions', headers: { cookie: secondCookie } });
    const currentSession = (sessions.json() as { id: string; current: boolean; risk?: string }[]).find((session) => session.current);
    const audit = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log?limit=100', headers: { cookie: secondCookie } });

    expect(sessions.statusCode).toBe(200);
    expect(currentSession).toBeDefined();
    expect(currentSession?.risk).toBe('new_context');
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries).toContainEqual(expect.objectContaining({
      actor: 'root',
      action: 'auth.session.new_context',
      target: currentSession?.id,
      detail: 'new browser and network context while another session was active',
    }));
    expect(audit.body).not.toContain(`dkrypt-test-${contextId}`);
    expect(audit.body).not.toContain('198.51.100.17');
    expect(audit.body).not.toContain('203.0.113.29');

    await server.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: firstCookie } });
    await server.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: secondCookie } });
  } finally {
    await server.close();
  }
});

test('root login does not flag a network change when the browser context is unchanged', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const userAgent = `dkrypt-test-${crypto.randomUUID()}-same-browser`;

  try {
    const firstCookie = await signInFromContext(server, userAgent, '198.51.100.38');
    const secondCookie = await signInFromContext(server, userAgent, '203.0.113.51');
    const sessions = await server.inject({ method: 'GET', url: '/v1/auth/sessions', headers: { cookie: secondCookie } });
    const currentSession = (sessions.json() as { id: string; current: boolean; risk?: string }[]).find((session) => session.current);
    const audit = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log?limit=100', headers: { cookie: secondCookie } });

    expect(sessions.statusCode).toBe(200);
    expect(currentSession).toBeDefined();
    expect(currentSession?.risk).toBeUndefined();
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries).not.toContainEqual(expect.objectContaining({
      action: 'auth.session.new_context',
      target: currentSession?.id,
    }));
    expect((sessions.json() as { current: boolean }[]).filter((session) => session.current)).toHaveLength(1);

    await server.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: firstCookie } });
    await server.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: secondCookie } });
  } finally {
    await server.close();
  }
});

test('root login session can access the dashboard artifact page', async () => {
  const { server, cookie } = await signIn();
  try {
    const response = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts?limit=1', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      artifacts: expect.any(Array),
      total: expect.any(Number),
      totalBytes: expect.any(Number),
      maxBytes: expect.any(Number),
    });
    const logout = await server.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
  } finally {
    await server.close();
  }
});

test('native auth logout-everywhere expires all existing session versions', async () => {
  const { server, cookie } = await signIn();
  try {
    const logout = await server.inject({ method: 'POST', url: '/v1/auth/logout-everywhere', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']?.toString()).toContain('Max-Age=0');

    const session = await server.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    expect(session.json()).toMatchObject({ loggedIn: false });
  } finally {
    await server.close();
  }
});

test('native auth routes require recent authentication for passkey registration', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const cookie = createSessionCookie('root', PermissionFlag.administrator);
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/auth/passkeys/register/options',
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'reauthentication_required' });
  } finally {
    await server.close();
  }
});

test('dashboard notification endpoints are not registered through the legacy adapter', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/notifications');
  expect(routes).not.toContain('POST /v1/dashboard/notifications/read');
});

test('dashboard settings endpoints are not registered through the legacy adapter', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/settings');
  expect(routes).not.toContain('PUT /v1/dashboard/settings');
  expect(routes).not.toContain('GET /v1/dashboard/settings/job-history-retention/preview');
  expect(routes).not.toContain('GET /v1/dashboard/settings/validate-cron');
  expect(routes).not.toContain('POST /v1/dashboard/settings/test-webhook');
  expect(routes).not.toContain('GET /v1/dashboard/artifacts/retention-preview');
});

test('dashboard watch and GitHub automation endpoints are not registered through the legacy adapter', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/github/rate-limit');
  expect(routes).not.toContain('GET /v1/dashboard/watches');
  expect(routes).not.toContain('GET /v1/dashboard/watches/export');
  expect(routes).not.toContain('GET /v1/dashboard/watches/health');
  expect(routes).not.toContain('GET /v1/dashboard/watches/calendar');
  expect(routes).not.toContain('GET /v1/dashboard/github/budget-history');
  expect(routes).not.toContain('GET /v1/dashboard/github/repos');
  expect(routes).not.toContain('GET /v1/dashboard/github/workflows');
  expect(routes).not.toContain('POST /v1/dashboard/watches');
  expect(routes).not.toContain('PATCH /v1/dashboard/watches/:id');
  expect(routes).not.toContain('DELETE /v1/dashboard/watches/:id');
  expect(routes).not.toContain('POST /v1/dashboard/watches/import');
  expect(routes).not.toContain('POST /v1/dashboard/watches/preview-dispatch-draft');
  expect(routes).not.toContain('POST /v1/dashboard/watches/validate-dispatch-draft');
  expect(routes).not.toContain('GET /v1/dashboard/watches/:id/preview-dispatch');
  expect(routes).not.toContain('GET /v1/dashboard/watches/:id/preview-dispatch/:source');
  expect(routes).not.toContain('POST /v1/dashboard/watches/:id/trigger-dispatch');
});

test('dashboard role endpoints are not registered through the legacy adapter', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/roles');
  expect(routes).not.toContain('POST /v1/dashboard/roles');
  expect(routes).not.toContain('POST /v1/dashboard/roles/:id/impact-preview');
  expect(routes).not.toContain('PATCH /v1/dashboard/roles/:id');
  expect(routes).not.toContain('DELETE /v1/dashboard/roles/:id');
  expect(routes).not.toContain('POST /v1/dashboard/roles/reorder');
});

test('native role routes preserve management gates and default-role protections', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const administratorCookie = createSessionCookie('root', PermissionFlag.administrator);
  const decryptOnlyCookie = createSessionCookie('root', PermissionFlag.requestDecrypt);
  const memberManagerCookie = createSessionCookie('root', PermissionFlag.manageUsers);
  let roleId: string | undefined;

  try {
    const denied = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/roles',
      headers: { cookie: decryptOnlyCookie },
    });
    expect(denied.statusCode).toBe(403);

    const assignerRoles = await server.inject({ method: 'GET', url: '/v1/dashboard/roles', headers: { cookie: memberManagerCookie } });
    expect(assignerRoles.statusCode).toBe(200);
    expect(assignerRoles.json().roles).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'everyone' })]));

    const deniedRoleEdit = await server.inject({ method: 'POST', url: '/v1/dashboard/roles', headers: { cookie: memberManagerCookie }, payload: { name: 'Unwanted Role', color: '#123abc', permissions: '0' } });
    expect(deniedRoleEdit.statusCode).toBe(403);

    const listed = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/roles',
      headers: { cookie: administratorCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().roles).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'everyone', isDefault: true })]));

    const invalid = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/roles',
      headers: { cookie: administratorCookie },
      payload: { name: 'Temporary Role', color: 'pink' },
    });
    expect(invalid.statusCode).toBe(400);

    const created = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/roles',
      headers: { cookie: administratorCookie },
      payload: { name: 'Temporary Role', color: '#123abc', permissions: '0' },
    });
    expect(created.statusCode).toBe(201);
    roleId = created.json().id;

    const deniedImpactPreview = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/roles/${roleId}/impact-preview`,
      headers: { cookie: decryptOnlyCookie },
      payload: { permissions: serializeBits(PermissionFlag.viewLogs) },
    });
    expect(deniedImpactPreview.statusCode).toBe(403);

    const impactPreview = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/roles/${roleId}/impact-preview`,
      headers: { cookie: administratorCookie },
      payload: { permissions: serializeBits(PermissionFlag.viewLogs) },
    });
    expect(impactPreview.statusCode).toBe(200);
    expect(impactPreview.json()).toMatchObject({ affectedCount: 0, members: [], truncated: false });

    const updated = await server.inject({
      method: 'PATCH',
      url: `/v1/dashboard/roles/${roleId}`,
      headers: { cookie: administratorCookie },
      payload: { name: 'Updated Role', color: '#abcdef' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id: roleId, name: 'Updated Role', color: '#abcdef' });

    const defaultRoleUpdate = await server.inject({
      method: 'PATCH',
      url: '/v1/dashboard/roles/everyone',
      headers: { cookie: administratorCookie },
      payload: { name: 'Renamed' },
    });
    expect(defaultRoleUpdate.statusCode).toBe(400);

    const invalidOrder = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/roles/reorder',
      headers: { cookie: administratorCookie },
      payload: { roleIds: [] },
    });
    expect(invalidOrder.statusCode).toBe(400);

    const removed = await server.inject({
      method: 'DELETE',
      url: `/v1/dashboard/roles/${roleId}`,
      headers: { cookie: administratorCookie },
    });
    expect(removed.statusCode).toBe(200);
    roleId = undefined;
  } finally {
    if (roleId) deleteRole(roleId, 'test cleanup');
    await server.close();
  }
});

test('dashboard user endpoints are not registered through the legacy adapter', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/users');
  expect(routes).not.toContain('POST /v1/dashboard/users');
  expect(routes).not.toContain('PATCH /v1/dashboard/users/:username');
  expect(routes).not.toContain('DELETE /v1/dashboard/users/:username');
});

test('native user routes enforce permissions and return normalized management changes', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const administratorCookie = createSessionCookie('root', PermissionFlag.administrator);
  const decryptOnlyCookie = createSessionCookie('root', PermissionFlag.requestDecrypt);
  const userManagerCookie = createSessionCookie('root', PermissionFlag.viewUsers | PermissionFlag.manageUsers);
  const billingViewerCookie = createSessionCookie('root', PermissionFlag.viewUsers | PermissionFlag.viewBilling);
  const previousBilling = exportBillingSnapshot();
  const privilegedRole = createRole({ name: 'Elevated Test', color: '#123456', permissions: serializeBits(PermissionFlag.manageRoles) }, 'test setup');
  const lastManagerRole = createRole({ name: 'Last User Manager Test', color: '#654321', permissions: serializeBits(PermissionFlag.manageUsers) }, 'test setup');
  const username = `user-${crypto.randomUUID()}`;
  const lastManagerUsername = `manager-${crypto.randomUUID()}`;
  const profileUserId = `github:user-directory-${crypto.randomUUID()}`;
  const profileAccountUsername = `user-directory-${crypto.randomUUID().slice(0, 16)}`;

  try {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    addAllowedUser(lastManagerUsername, [lastManagerRole.id], 'test setup');
    upsertAuthProfile({
      userId: profileUserId,
      provider: 'github',
      providerId: crypto.randomUUID(),
      username: profileAccountUsername,
      displayName: 'Directory Profile User',
      avatarUrl: 'https://example.com/directory-profile.png',
      updatedAt: new Date().toISOString(),
    });
    addAllowedUser(profileUserId, [privilegedRole.id], 'test setup');

    const assignByAccountUsername = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/users',
      headers: { cookie: administratorCookie },
      payload: { username: profileAccountUsername, roleIds: [privilegedRole.id] },
    });
    expect(assignByAccountUsername.statusCode).toBe(201);
    expect(assignByAccountUsername.json()).toMatchObject({ username: profileUserId });
    upsertBillingSubscription({
      provider: 'stripe',
      subscriptionId: `sub_${crypto.randomUUID()}`,
      customerId: `cus_${crypto.randomUUID()}`,
      userId: profileUserId,
      status: 'active',
      planId: 'regular',
      priceId: 'price_regular_test',
      productId: 'prod_regular_test',
      occurredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const activityAt = Date.now();
    recordJobHistory({
      id: `user-directory-activity-${crypto.randomUUID()}`,
      bundleId: 'com.example.user-directory',
      queuedBy: profileUserId,
      status: 'done',
      source: 'manual',
      createdAt: activityAt - 1_000,
      finishedAt: activityAt,
    });

    const denied = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/users',
      headers: { cookie: decryptOnlyCookie },
    });
    expect(denied.statusCode).toBe(403);

    const deniedGrant = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/users',
      headers: { cookie: userManagerCookie },
      payload: { username, roleIds: [privilegedRole.id] },
    });
    expect(deniedGrant.statusCode).toBe(403);

    const invalid = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/users',
      headers: { cookie: administratorCookie },
      payload: { username, roleIds: 'not-an-array' },
    });
    expect(invalid.statusCode).toBe(400);

    const invalidRoleId = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/users',
      headers: { cookie: administratorCookie },
      payload: { username, roleIds: [123] },
    });
    expect(invalidRoleId.statusCode).toBe(400);

    const created = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/users',
      headers: { cookie: administratorCookie },
      payload: { username, roleIds: [privilegedRole.id] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ username, roleIds: [privilegedRole.id] });

    const invalidRoleIdUpdate = await server.inject({
      method: 'PATCH',
      url: `/v1/dashboard/users/${username}`,
      headers: { cookie: administratorCookie },
      payload: { roleIds: [123] },
    });
    expect(invalidRoleIdUpdate.statusCode).toBe(400);

    const listed = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/users',
      headers: { cookie: administratorCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().users).toEqual(expect.arrayContaining([
      expect.objectContaining({ username, displayName: username, avatarUrl: '', roleIds: [privilegedRole.id] }),
      expect.objectContaining({
        username: profileUserId,
        displayName: 'Directory Profile User',
        avatarUrl: 'https://example.com/directory-profile.png',
        roleIds: [privilegedRole.id],
        billingEntitlements: { planId: 'regular', decrypt: true, api: false, priority: 0 },
        activity: expect.objectContaining({ manualJobs: 1, completedJobs: 1, failedJobs: 0 }),
      }),
    ]));

    const userManagerListed = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/users',
      headers: { cookie: userManagerCookie },
    });
    expect(userManagerListed.statusCode).toBe(200);
    expect(userManagerListed.json().users.find((user: { username: string }) => user.username === profileUserId)).not.toHaveProperty('billingEntitlements');

    const billingViewerListed = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/users',
      headers: { cookie: billingViewerCookie },
    });
    expect(billingViewerListed.statusCode).toBe(200);
    expect(billingViewerListed.json().users.find((user: { username: string }) => user.username === profileUserId)).toHaveProperty('billingEntitlements', {
      planId: 'regular',
      decrypt: true,
      api: false,
      priority: 0,
    });

    const orphaningUpdate = await server.inject({
      method: 'PATCH',
      url: `/v1/dashboard/users/${lastManagerUsername}`,
      headers: { cookie: administratorCookie },
      payload: { roleIds: [] },
    });
    expect(orphaningUpdate.statusCode).toBe(400);

    const orphaningDelete = await server.inject({
      method: 'DELETE',
      url: `/v1/dashboard/users/${lastManagerUsername}`,
      headers: { cookie: administratorCookie },
    });
    expect(orphaningDelete.statusCode).toBe(400);

    const updated = await server.inject({
      method: 'PATCH',
      url: `/v1/dashboard/users/${username}`,
      headers: { cookie: administratorCookie },
      payload: { roleIds: [], priority: 99 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ username, priority: 5 });

    const selfDemotion = await server.inject({
      method: 'PATCH',
      url: '/v1/dashboard/users/root',
      headers: { cookie: administratorCookie },
      payload: { roleIds: [] },
    });
    expect(selfDemotion.statusCode).toBe(400);

    const removed = await server.inject({
      method: 'DELETE',
      url: `/v1/dashboard/users/${username}`,
      headers: { cookie: administratorCookie },
    });
    expect(removed.statusCode).toBe(200);
  } finally {
    replaceBillingSnapshot(previousBilling);
    deleteUserPersonalData(username);
    deleteUserPersonalData(lastManagerUsername);
    deleteUserPersonalData(profileUserId);
    deleteAuthProfile(profileUserId);
    deleteRole(privilegedRole.id, 'test cleanup');
    deleteRole(lastManagerRole.id, 'test cleanup');
    await server.close();
  }
});

test('API key endpoints are not registered through the legacy adapter', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes.filter((route) => route.includes('/v1/dashboard/keys'))).toEqual([]);
});

test('native API key routes preserve requester, owner, and manager permissions', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const previousBilling = exportBillingSnapshot();
  const ownerId = `github:api-key-owner-${crypto.randomUUID()}`;
  const otherId = `github:api-key-other-${crypto.randomUUID()}`;
  const ownerRole = createRole({
    name: `API key owner ${crypto.randomUUID()}`,
    color: '#2468ac',
    permissions: serializeBits(PermissionFlag.requestApiKeys),
  }, 'test setup');
  const requesterCookie = createSessionCookie(ownerId, PermissionFlag.requestApiKeys);
  const ownerCookie = createSessionCookie(ownerId, PermissionFlag.requestApiKeys | PermissionFlag.createApiKeys);
  const otherCookie = createSessionCookie(otherId, PermissionFlag.requestApiKeys | PermissionFlag.createApiKeys);
  const managerCookie = createSessionCookie('root', PermissionFlag.manageApiKeys);
  const creatorCookie = createSessionCookie('root', PermissionFlag.createApiKeys);
  let keyId: string | undefined;
  let keyOwnerId = ownerId;

  try {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    addAllowedUser(ownerId, [ownerRole.id], 'test setup');
    addAllowedUser(otherId, [ownerRole.id], 'test setup');
    for (const userId of [ownerId, otherId]) {
      upsertBillingSubscription({
        provider: 'stripe',
        subscriptionId: `sub_${crypto.randomUUID()}`,
        customerId: `cus_${crypto.randomUUID()}`,
        userId,
        status: 'active',
        planId: 'regular',
        priceId: 'price_regular_test',
        productId: 'prod_regular_test',
        occurredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    const invalid = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/request',
      headers: { cookie: requesterCookie },
      payload: { name: '   ' },
    });
    expect(invalid.statusCode).toBe(400);

    const deniedCreate = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/create',
      headers: { cookie: requesterCookie },
      payload: { name: 'Immediate test key' },
    });
    expect(deniedCreate.statusCode).toBe(403);

    const request = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/request',
      headers: { cookie: requesterCookie },
      payload: {
        name: 'Requested test key',
        expiresInDays: 7,
        allowedBundleIds: ['com.example.requested'],
        dailyLimit: 40,
        allowTestFlight: false,
      },
    });
    expect(request.statusCode).toBe(201);
    expect(request.json()).toMatchObject({
      name: 'Requested test key',
      ownerId,
      status: 'pending',
      allowedBundleIds: ['com.example.requested'],
      dailyLimit: 40,
      allowTestFlight: false,
    });
    keyId = request.json().id;

    const deniedApproval = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/keys/${keyId}/approve`,
      headers: { cookie: requesterCookie },
    });
    expect(deniedApproval.statusCode).toBe(403);

    const approved = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/keys/${keyId}/approve`,
      headers: { cookie: managerCookie },
    });
    expect(approved.statusCode).toBe(200);

    const pending = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/keys/pending',
      headers: { cookie: managerCookie },
    });
    expect(pending.json().keys).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: keyId })]));

    const revealed = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/keys/${keyId}/reveal`,
      headers: { cookie: ownerCookie },
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().key).toMatch(/^[0-9a-f]{64}$/);

    const repeatedReveal = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/keys/${keyId}/reveal`,
      headers: { cookie: ownerCookie },
    });
    expect(repeatedReveal.statusCode).toBe(404);

    const deniedRevoke = await server.inject({
      method: 'DELETE',
      url: `/v1/dashboard/keys/${keyId}`,
      headers: { cookie: otherCookie },
    });
    expect(deniedRevoke.statusCode).toBe(404);

    const revoked = await server.inject({
      method: 'DELETE',
      url: `/v1/dashboard/keys/${keyId}`,
      headers: { cookie: ownerCookie },
    });
    expect(revoked.statusCode).toBe(200);
    keyId = undefined;

    const immediate = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/create',
      headers: { cookie: creatorCookie },
      payload: { name: 'Immediate test key', expiresInDays: 30 },
    });
    expect(immediate.statusCode).toBe(201);
    expect(immediate.json()).toMatchObject({ name: 'Immediate test key' });
    expect(immediate.json().key).toMatch(/^[0-9a-f]{64}$/);
    keyId = immediate.json().id;
    keyOwnerId = 'root';
  } finally {
    if (keyId) revokeApiKey(keyId, keyOwnerId, true);
    deleteUserPersonalData(ownerId);
    deleteUserPersonalData(otherId);
    deleteRole(ownerRole.id, 'test cleanup');
    replaceBillingSnapshot(previousBilling);
    await server.close();
  }
});

test('native API key manager controls preserve filtering, normalization, and route coverage', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const administratorCookie = createSessionCookie('root', PermissionFlag.administrator);
  const headers = { cookie: administratorCookie };
  const createdIds: string[] = [];

  try {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/create',
      headers,
      payload: { name: 'Manager route coverage', expiresInDays: 30 },
    });
    expect(created.statusCode).toBe(201);
    const keyId = created.json().id as string;
    createdIds.push(keyId);

    const regenerated = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/keys/${keyId}/regenerate`,
      headers,
      payload: { graceMinutes: 'invalid' },
    });
    expect(regenerated.statusCode).toBe(200);
    expect(regenerated.json()).toMatchObject({ ok: true, key: { id: keyId } });

    const normalized = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/create',
      headers,
      payload: {
        name: 'Legacy input normalization',
        expiresInDays: '7',
        allowedBundleIds: ['com.example.valid', 5, 'invalid!'],
        dailyLimit: '4',
        allowTestFlight: 'yes',
      },
    });
    expect(normalized.statusCode).toBe(201);
    expect(normalized.json()).toMatchObject({ name: 'Legacy input normalization' });
    const normalizedId = normalized.json().id as string;
    createdIds.push(normalizedId);
    const normalizedList = await server.inject({ method: 'GET', url: '/v1/dashboard/keys/mine', headers });
    const normalizedRecord = normalizedList.json().keys.find((key: { id: string }) => key.id === normalizedId);
    expect(normalizedRecord).toMatchObject({ allowedBundleIds: ['com.example.valid'], allowTestFlight: true });
    expect(normalizedRecord).not.toHaveProperty('expiresAt');
    expect(normalizedRecord).not.toHaveProperty('dailyLimit');

    const mine = await server.inject({ method: 'GET', url: '/v1/dashboard/keys/mine', headers });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().keys).toEqual(expect.arrayContaining([expect.objectContaining({ id: keyId })]));

    const all = await server.inject({ method: 'GET', url: '/v1/dashboard/keys/all?search=Manager%20route%20coverage', headers });
    expect(all.statusCode).toBe(200);
    expect(all.json().keys).toEqual([expect.objectContaining({ id: keyId, name: 'Manager route coverage' })]);

    for (const suffix of ['usage?days=7', 'bundle-usage?limit=5', 'outcomes?limit=5']) {
      const result = await server.inject({ method: 'GET', url: `/v1/dashboard/keys/${keyId}/${suffix}`, headers });
      expect(result.statusCode).toBe(200);
    }

    const dailyLimit = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-set-daily-limit',
      headers,
      payload: { ids: [keyId, 42, null], dailyLimit: 3.6 },
    });
    expect(dailyLimit.statusCode).toBe(400);

    const validDailyLimit = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-set-daily-limit',
      headers,
      payload: { ids: [keyId], dailyLimit: 3.6 },
    });
    expect(validDailyLimit.statusCode).toBe(200);
    expect(validDailyLimit.json()).toMatchObject({ updated: [keyId] });

    const expiry = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-extend-expiry',
      headers,
      payload: { ids: [keyId], days: 1.6 },
    });
    expect(expiry.statusCode).toBe(400);

    const validExpiry = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-extend-expiry',
      headers,
      payload: { ids: [keyId], days: 2 },
    });
    expect(validExpiry.statusCode).toBe(200);
    expect(validExpiry.json()).toMatchObject({ extended: [keyId] });

    const scope = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-set-scope',
      headers,
      payload: { ids: [keyId, 42], allowedBundleIds: [' com.example.one ', 7, 'not valid!'] },
    });
    expect(scope.statusCode).toBe(400);

    const validScope = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-set-scope',
      headers,
      payload: { ids: [keyId], allowedBundleIds: ['com.example.one'] },
    });
    expect(validScope.statusCode).toBe(200);
    expect(validScope.json()).toMatchObject({ updated: [keyId] });

    const priority = await server.inject({
      method: 'PATCH',
      url: `/v1/dashboard/keys/${keyId}/priority`,
      headers,
      payload: { priority: 4.6 },
    });
    expect(priority.statusCode).toBe(200);
    expect(priority.json()).toMatchObject({ ok: true, priority: 5 });

    const concurrency = await server.inject({
      method: 'PATCH',
      url: `/v1/dashboard/keys/${keyId}/max-concurrent`,
      headers,
      payload: { maxConcurrent: '3' },
    });
    expect(concurrency.statusCode).toBe(200);
    expect(concurrency.json()).toMatchObject({ ok: true, maxConcurrent: 3 });

    const testFlight = await server.inject({
      method: 'PATCH',
      url: `/v1/dashboard/keys/${keyId}/allow-testflight`,
      headers,
      payload: { allowTestFlight: false },
    });
    expect(testFlight.statusCode).toBe(200);
    expect(testFlight.json()).toMatchObject({ ok: true, allowTestFlight: false });

    const updatedKey = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/keys/all?search=Manager%20route%20coverage',
      headers,
    });
    const updatedRecord = updatedKey.json().keys[0];
    expect(updatedRecord).toMatchObject({
      dailyLimit: 4,
      allowedBundleIds: ['com.example.one'],
      priority: 5,
      maxConcurrent: 3,
      allowTestFlight: false,
    });
    expect(updatedRecord.expiresAt).toBeGreaterThan(Date.now() + 1.8 * 86_400_000);
    expect(updatedRecord.expiresAt).toBeLessThan(Date.now() + 2.2 * 86_400_000);

    const pendingRequest = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/request',
      headers,
      payload: { name: 'Bulk approved key' },
    });
    expect(pendingRequest.statusCode).toBe(201);
    const pendingId = pendingRequest.json().id as string;
    createdIds.push(pendingId);

    const pending = await server.inject({ method: 'GET', url: '/v1/dashboard/keys/pending', headers });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().keys).toEqual(expect.arrayContaining([expect.objectContaining({ id: pendingId })]));

    const approved = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-approve',
      headers,
      payload: { ids: [pendingId, null] },
    });
    expect(approved.statusCode).toBe(400);

    const validApproval = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-approve',
      headers,
      payload: { ids: [pendingId] },
    });
    expect(validApproval.statusCode).toBe(200);
    expect(validApproval.json()).toMatchObject({ approved: [pendingId] });

    const deniedRequest = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/request',
      headers,
      payload: { name: 'Denied key' },
    });
    expect(deniedRequest.statusCode).toBe(201);
    const deniedId = deniedRequest.json().id as string;
    createdIds.push(deniedId);

    const denied = await server.inject({ method: 'POST', url: `/v1/dashboard/keys/${deniedId}/deny`, headers });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({ ok: true });

    const revoked = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-revoke',
      headers,
      payload: { ids: [keyId, null] },
    });
    expect(revoked.statusCode).toBe(400);

    const oversizedId = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-revoke',
      headers,
      payload: { ids: ['x'.repeat(201)] },
    });
    expect(oversizedId.statusCode).toBe(400);

    const tooManyIds = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-revoke',
      headers,
      payload: { ids: Array.from({ length: 101 }, () => keyId) },
    });
    expect(tooManyIds.statusCode).toBe(400);

    const validRevocation = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/keys/bulk-revoke',
      headers,
      payload: { ids: [keyId] },
    });
    expect(validRevocation.statusCode).toBe(200);
    expect(validRevocation.json()).toMatchObject({ revoked: [keyId] });
    createdIds.splice(createdIds.indexOf(keyId), 1);
  } finally {
    for (const id of createdIds) revokeApiKey(id, 'root', true);
    await server.close();
  }
});

test('native settings routes preserve permission gates and normalize updates', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const administratorCookie = createSessionCookie('root', PermissionFlag.administrator);
  const decryptOnlyCookie = createSessionCookie('root', PermissionFlag.requestDecrypt);
  const initialSettings = getEffectiveSettings();

  try {
    const unauthenticated = await server.inject({ method: 'GET', url: '/v1/dashboard/settings' });
    expect(unauthenticated.statusCode).toBe(401);

    const denied = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/settings',
      headers: { cookie: decryptOnlyCookie },
    });
    expect(denied.statusCode).toBe(403);

    const settings = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/settings',
      headers: { cookie: administratorCookie },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ notifyFormat: initialSettings.notifyFormat });

    const emptyUpdate = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/settings',
      headers: { cookie: administratorCookie },
    });
    expect(emptyUpdate.statusCode).toBe(200);

    const updated = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/settings',
      headers: { cookie: administratorCookie },
      payload: { notifyFormat: 'plain', notifyOnAutomationSuccess: false, notifyOnQueueSloBreach: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ notifyFormat: 'plain', notifyOnAutomationSuccess: false, notifyOnQueueSloBreach: false });

    const invalid = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/settings',
      headers: { cookie: administratorCookie },
      payload: { notifyFormat: 'unsupported' },
    });
    expect(invalid.statusCode).toBe(400);

    const invalidRetention = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/settings/job-history-retention/preview?retentionDays=-1',
      headers: { cookie: administratorCookie },
    });
    expect(invalidRetention.statusCode).toBe(400);

    const invalidWebhookTest = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/settings/test-webhook',
      headers: { cookie: administratorCookie },
      payload: { url: 42 },
    });
    expect(invalidWebhookTest.statusCode).toBe(400);
  } finally {
    updateSettings(initialSettings, 'test cleanup');
    await server.close();
  }
});

test('device dashboard routes are not registered through the legacy adapter', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/devices/discover');
  expect(routes).not.toContain('POST /v1/dashboard/devices/setup');
  expect(routes).not.toContain('POST /v1/dashboard/devices');
  expect(routes).not.toContain('PATCH /v1/dashboard/devices/:id');
  expect(routes).not.toContain('DELETE /v1/dashboard/devices/:id');
  expect(routes).not.toContain('GET /v1/dashboard/devices/:id/health');
  expect(routes).not.toContain('GET /v1/dashboard/devices/:id/preflight');
  expect(routes).not.toContain('GET /v1/dashboard/devices/:id/inventory');
  expect(routes).not.toContain('PUT /v1/dashboard/devices/:id/dark-mode');
  expect(routes).not.toContain('POST /v1/dashboard/devices/:id/bridge-action');
  expect(routes).not.toContain('POST /v1/dashboard/devices/:id/recover');
});

test('native device discovery and setup retain manager gates and input errors', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const administratorCookie = createSessionCookie('root', PermissionFlag.administrator);
  const decryptOnlyCookie = createSessionCookie('root', PermissionFlag.requestDecrypt);

  try {
    const unauthenticated = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/discover' });
    expect(unauthenticated.statusCode).toBe(401);

    const deniedDiscovery = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/discover', headers: { cookie: decryptOnlyCookie } });
    expect(deniedDiscovery.statusCode).toBe(403);

    const invalidSetup = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices/setup',
      headers: { cookie: administratorCookie },
      payload: { transport: 'usb' },
    });
    expect(invalidSetup.statusCode).toBe(400);
    expect(invalidSetup.json()).toMatchObject({ error: 'a discovered device connection is required' });

    const deniedOperations = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/setup-operations', headers: { cookie: decryptOnlyCookie } });
    expect(deniedOperations.statusCode).toBe(403);
    const operations = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/setup-operations', headers: { cookie: administratorCookie } });
    expect(operations.statusCode).toBe(200);
    expect(operations.json()).toMatchObject({ operations: expect.any(Array) });
    const invalidOperation = await server.inject({ method: 'POST', url: '/v1/dashboard/devices/setup-operations', headers: { cookie: administratorCookie }, payload: { transport: 'usb' } });
    expect(invalidOperation.statusCode).toBe(400);
    const missingOperation = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/setup-operations/missing', headers: { cookie: administratorCookie } });
    expect(missingOperation.statusCode).toBe(404);

    const invalidDevice = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices',
      headers: { cookie: administratorCookie },
      payload: { name: 'Invalid port', transport: 'wifi', host: 'device.local', port: 65_536 },
    });
    expect(invalidDevice.statusCode).toBe(400);
    expect(invalidDevice.json()).toMatchObject({ error: 'device record contains invalid fields' });
  } finally {
    await server.close();
  }
});

test('device setup parser accepts IPv6 hosts declared by the device contract', () => {
  expect(parseDeviceConnection({ transport: 'wifi', host: '2001:db8::10', port: 22 })).toMatchObject({
    connection: { transport: 'wifi', host: '2001:db8::10', port: 22 },
  });
  expect(parseDeviceConnection({ transport: 'wifi', host: 'bad/host', port: 22 })).toBeUndefined();
});

test('native device operations validate inputs and preserve view and manage permissions', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const administratorCookie = createSessionCookie('root', PermissionFlag.administrator);
  const decryptOnlyCookie = createSessionCookie('root', PermissionFlag.requestDecrypt);

  try {
    const unauthenticated = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/missing/health' });
    expect(unauthenticated.statusCode).toBe(401);

    const deniedHealth = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/missing/health', headers: { cookie: decryptOnlyCookie } });
    expect(deniedHealth.statusCode).toBe(403);

    const invalidHealthQuery = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/missing/health?force=invalid', headers: { cookie: administratorCookie } });
    expect(invalidHealthQuery.statusCode).toBe(400);

    const missingPreflight = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/missing/preflight', headers: { cookie: administratorCookie } });
    expect(missingPreflight.statusCode).toBe(404);

    const missingInventory = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/missing/inventory', headers: { cookie: administratorCookie } });
    expect(missingInventory.statusCode).toBe(404);

    const invalidDarkMode = await server.inject({ method: 'PUT', url: '/v1/dashboard/devices/missing/dark-mode', headers: { cookie: administratorCookie }, payload: { enabled: 'yes' } });
    expect(invalidDarkMode.statusCode).toBe(400);

    const invalidBridgeAction = await server.inject({ method: 'POST', url: '/v1/dashboard/devices/missing/bridge-action', headers: { cookie: administratorCookie }, payload: { action: 'reboot' } });
    expect(invalidBridgeAction.statusCode).toBe(400);

    const missingRecoveryTarget = await server.inject({ method: 'POST', url: '/v1/dashboard/devices/missing/recover', headers: { cookie: administratorCookie } });
    expect(missingRecoveryTarget.statusCode).toBe(404);
  } finally {
    await server.close();
  }
});

test('device health dashboard serves cached telemetry without waiting for another device probe', async () => {
  const device = createDevice({ name: `Cached health ${crypto.randomUUID()}`, transport: 'wifi', host: '127.0.0.1' }, 'test');
  setCachedDeviceHealth(device.id, { reachable: true, checkedAt: Date.now(), jailbreakAvailable: true });
  const server = await buildTestServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/devices/${device.id}/health`,
      headers: { cookie: createSessionCookie('root', PermissionFlag.administrator) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reachable: true, refreshing: false });
  } finally {
    deleteDevice(device.id, 'test');
    await server.close();
  }
});

test('dashboard job history and inspection endpoints are not registered through the legacy adapter', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/jobs');
  expect(routes).not.toContain('GET /v1/dashboard/jobs/:id/status');
  expect(routes).not.toContain('GET /v1/dashboard/jobs/:id/timeline');
});

test('dashboard diagnostics use native Fastify routes with session and device-management gates', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const administratorCookie = createSessionCookie('root', PermissionFlag.administrator);
  const decryptOnlyCookie = createSessionCookie('root', PermissionFlag.requestDecrypt);
  const legacyRoutes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);

  try {
    expect(legacyRoutes).not.toContain('GET /v1/dashboard/doctor');
    expect(legacyRoutes).not.toContain('GET /v1/dashboard/synthetic');

    const unauthenticated = await server.inject({ method: 'GET', url: '/v1/dashboard/doctor' });
    expect(unauthenticated.statusCode).toBe(401);

    const deniedDoctor = await server.inject({ method: 'GET', url: '/v1/dashboard/doctor', headers: { cookie: decryptOnlyCookie } });
    expect(deniedDoctor.statusCode).toBe(403);

    const deniedSynthetic = await server.inject({ method: 'GET', url: '/v1/dashboard/synthetic', headers: { cookie: decryptOnlyCookie } });
    expect(deniedSynthetic.statusCode).toBe(403);

    const doctor = await server.inject({ method: 'GET', url: '/v1/dashboard/doctor', headers: { cookie: administratorCookie } });
    expect(doctor.statusCode).toBe(200);
    expect(doctor.json()).toMatchObject({ ok: expect.any(Boolean), checkedAt: expect.any(String), checks: expect.arrayContaining([expect.objectContaining({ id: 'database', status: expect.any(String), detail: expect.any(String) })]) });
    expect(doctor.json().deployment).toMatchObject({ id: expect.any(String), ref: expect.any(String) });
    const doctorPayload = JSON.stringify(doctor.json());
    const configuredSecrets = [config.apiKey, config.sessionSigningSecret, config.sessionSigningSecretPrevious, config.backupManifestSecret, ...config.backupManifestSecretPrevious, config.adminPassword, config.adminPasswordPrevious, config.githubOauthClientSecret, config.githubOauthClientSecretPrevious, config.discordOauthClientSecret, config.discordOauthClientSecretPrevious, config.stripeSecretKey, config.stripeWebhookSecret, config.stripeWebhookSecretPrevious, config.nowpaymentsApiKey, config.nowpaymentsApiKeyPrevious, config.nowpaymentsIpnSecret, config.nowpaymentsIpnSecretPrevious, config.deviceBridgeSecret, config.deviceBridgeSecretPrevious, config.outboundWebhookSecret, config.outboundWebhookSecretPrevious, config.smtpPass, config.smtpPassPrevious].filter(Boolean);
    for (const secret of configuredSecrets) expect(doctorPayload).not.toContain(secret);

    const synthetic = await server.inject({ method: 'GET', url: '/v1/dashboard/synthetic', headers: { cookie: administratorCookie } });
    expect(synthetic.statusCode).toBe(200);
    expect(synthetic.json()).toMatchObject({ ok: expect.any(Boolean), checkedAt: expect.any(String), probes: expect.arrayContaining([expect.objectContaining({ id: 'database', status: expect.any(String), detail: expect.any(String) })]) });
  } finally {
    await server.close();
  }
});

test('internal deployment notices require the service API key and reject generated user API keys', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const generatedKey = createApiKey('deployment notice scope test', 'root');

  try {
    const unauthenticated = await server.inject({ method: 'POST', url: '/v1/internal/deployment/ready', payload: {} });
    expect(unauthenticated.statusCode).toBe(401);

    const generatedKeyResponse = await server.inject({
      method: 'POST',
      url: '/v1/internal/deployment/ready',
      headers: { authorization: `Bearer ${generatedKey.key}` },
      payload: {},
    });
    expect(generatedKeyResponse.statusCode).toBe(403);
    expect(generatedKeyResponse.json()).toMatchObject({ code: 'public_api_scope_denied' });

    const deploymentReady = await server.inject({
      method: 'POST',
      url: '/v1/internal/deployment/ready',
      headers: { authorization: `Bearer ${config.apiKey}` },
      payload: {},
    });
    expect(deploymentReady.statusCode).toBe(200);
    expect(deploymentReady.json()).toMatchObject({
      ok: true,
      created: expect.any(Number),
      deployment: { id: expect.any(String), ref: expect.any(String) },
    });
  } finally {
    revokeApiKey(generatedKey.id, 'root', true);
    await server.close();
  }
});

test('dashboard overview uses native Fastify routing and returns workspace-wide data', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const administratorCookie = createSessionCookie('root', PermissionFlag.administrator);
  const decryptOnlyCookie = createSessionCookie('root', PermissionFlag.requestDecrypt);
  const legacyRoutes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);

  try {
    expect(legacyRoutes).not.toContain('GET /v1/dashboard/overview');

    const unauthenticated = await server.inject({ method: 'GET', url: '/v1/dashboard/overview' });
    expect(unauthenticated.statusCode).toBe(401);

    const viewerOverview = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie: decryptOnlyCookie } });
    expect(viewerOverview.statusCode).toBe(200);
    expect(viewerOverview.json()).toMatchObject({ activeJobs: expect.any(Array) });
    expect(viewerOverview.json()).not.toHaveProperty('projectId');
    expect(viewerOverview.json()).not.toHaveProperty('schedulerEnabled');
    expect(viewerOverview.json()).not.toHaveProperty('watches');

    const administratorOverview = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie: administratorCookie } });
    expect(administratorOverview.statusCode).toBe(200);
    expect(administratorOverview.json()).toMatchObject({ devices: expect.any(Array) });
    expect(administratorOverview.json()).not.toHaveProperty('projectId');
  } finally {
    await server.close();
  }
});

test('dashboard overview gives ordinary members only a simple service status', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const cookie = createSessionCookie('root', PermissionFlag.requestDecrypt);
  let device: ReturnType<typeof createDevice> | undefined;

  try {
    const baselineResponse = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie } });
    expect(baselineResponse.statusCode).toBe(200);
    expect(baselineResponse.json()).toMatchObject({ devices: [], serviceStatus: expect.stringMatching(/^(operational|maintenance)$/) });
    expect(baselineResponse.json()).not.toHaveProperty('statusDevices');
    expect(baselineResponse.json()).not.toHaveProperty('deviceStatus');
    expect(baselineResponse.json()).not.toHaveProperty('disk');
    expect(baselineResponse.json()).not.toHaveProperty('settings');
    expect(baselineResponse.json()).not.toHaveProperty('maintenance');
    const noRoleResponse = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie: createSessionCookie('root', 0n) } });
    expect(noRoleResponse.statusCode).toBe(200);
    expect(noRoleResponse.json()).toMatchObject({ devices: [], serviceStatus: expect.stringMatching(/^(operational|maintenance)$/) });
    device = createDevice({ name: `Member status ${crypto.randomUUID()}`, transport: 'wifi', host: '127.0.0.1' }, 'test');
    setCachedDeviceHealth(device.id, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });

    const onlineResponse = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie } });
    expect(onlineResponse.statusCode).toBe(200);
    expect(onlineResponse.json()).toMatchObject({ devices: [], serviceStatus: expect.stringMatching(/^(operational|maintenance)$/) });
    expect(onlineResponse.json()).not.toHaveProperty('statusDevices');
    expect(onlineResponse.json()).not.toHaveProperty('deviceStatus');

    setCachedDeviceHealth(device.id, { reachable: true, jailbreakAvailable: true, testFlightBridgeReachable: false, checkedAt: Date.now() });
    const blockedResponse = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie } });
    expect(blockedResponse.json()).not.toHaveProperty('deviceStatus');

    setCachedDeviceHealth(device.id, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() - 660_000 });
    const staleResponse = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie } });
    expect(staleResponse.json()).not.toHaveProperty('statusDevices');
    expect(staleResponse.json()).not.toHaveProperty('deviceStatus');
  } finally {
    if (device) deleteDevice(device.id, 'test');
    await server.close();
  }
});

test('members cannot read device health or history without device visibility permission', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const device = createDevice({ name: `Status device ${crypto.randomUUID()}`, transport: 'usb', udid: crypto.randomUUID(), isPrimary: true }, 'test');
  const memberCookie = createSessionCookie('root', PermissionFlag.requestDecrypt);
  const noRoleCookie = createSessionCookie('root', 0n);
  const automationCookie = createSessionCookie('root', PermissionFlag.viewAutomation);
  const deviceViewerCookie = createSessionCookie('root', PermissionFlag.viewDevices);
  setCachedDeviceHealth(device.id, {
    reachable: true,
    checkedAt: Date.now(),
    batteryPercent: 83,
    networkConnected: true,
    networkInterface: 'en0',
    networkIpAddress: '192.0.2.44',
    testFlightBridgeReachable: true,
  });

  try {
    const overview = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie: memberCookie } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ devices: [], serviceStatus: expect.stringMatching(/^(operational|maintenance)$/) });
    expect(overview.json()).not.toHaveProperty('statusDevices');
    expect(overview.json()).not.toHaveProperty('deviceStatus');
    expect(JSON.stringify(overview.json())).not.toContain('192.0.2.44');
    const defaultOverview = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie: noRoleCookie } });
    expect(defaultOverview.json()).toMatchObject({ devices: [], serviceStatus: expect.stringMatching(/^(operational|maintenance)$/) });
    expect(defaultOverview.json()).not.toHaveProperty('statusDevices');

    const health = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/primary/health', headers: { cookie: memberCookie } });
    expect(health.statusCode).toBe(403);
    for (const cookie of [noRoleCookie, automationCookie]) {
      const readOnlyHealth = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/primary/health', headers: { cookie } });
      expect(readOnlyHealth.statusCode).toBe(403);
    }

    for (const type of ['health', 'battery', 'temperature']) {
      const history = await server.inject({ method: 'GET', url: `/v1/dashboard/devices/primary/${type}-history?hours=1`, headers: { cookie: memberCookie } });
      expect(history.statusCode).toBe(403);
    }

    for (const url of [
      '/v1/dashboard/devices/primary/health?force=true',
      '/v1/dashboard/devices',
    ]) {
      const denied = await server.inject({ method: 'GET', url, headers: { cookie: memberCookie } });
      expect(denied.statusCode).toBe(403);
    }
    const deniedViewerRefresh = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/primary/health?force=true', headers: { cookie: deviceViewerCookie } });
    expect(deniedViewerRefresh.statusCode).toBe(403);
    const deviceViewerHealth = await server.inject({ method: 'GET', url: '/v1/dashboard/devices/primary/health', headers: { cookie: deviceViewerCookie } });
    expect(deviceViewerHealth.statusCode).toBe(200);
    expect(deviceViewerHealth.json()).toMatchObject({ reachable: true, batteryPercent: 83, networkIpAddress: '192.0.2.44' });
  } finally {
    deleteDevice(device.id, 'test');
    await server.close();
  }
});

test('native dashboard logs and audit routes preserve permissions, paging, and project checks', async () => {
  const logsUserId = `github:logs-reader-${crypto.randomUUID()}`;
  const auditUserId = `github:audit-reader-${crypto.randomUUID()}`;
  const logsPermissions = PermissionFlag.viewLogs;
  const auditPermissions = PermissionFlag.viewUsers;
  const logsRole = createRole({ name: `Logs reader ${crypto.randomUUID()}`, color: '#3498db', permissions: serializeBits(logsPermissions) }, 'test');
  const auditRole = createRole({ name: `Audit reader ${crypto.randomUUID()}`, color: '#5865f2', permissions: serializeBits(auditPermissions) }, 'test');
  addAllowedUser(logsUserId, [logsRole.id], 'test');
  addAllowedUser(auditUserId, [auditRole.id], 'test');
  const logsCookie = createSessionCookie(logsUserId, logsPermissions);
  const auditCookie = createSessionCookie(auditUserId, auditPermissions);
  const scope = `native-logs-${crypto.randomUUID()}`;
  const logger = scopedLogger(scope);
  logger.info('older native log');
  await Bun.sleep(2);
  logger.info('newer native log');
  recordAudit('test', 'project.add', `native-audit-${crypto.randomUUID()}`, 'native route coverage');
  const server = await buildTestServer({ includePublicRoutes: false });
  const legacyRoutes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);

  try {
    await server.ready();
    expect(legacyRoutes).not.toContain('GET /v1/dashboard/logs');
    expect(legacyRoutes).not.toContain('GET /v1/dashboard/audit-log');
    expect(legacyRoutes).not.toContain('GET /v1/dashboard/audit-log/export');

    const openApi = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>;
    };
    const exportContent = openApi.paths?.['/v1/dashboard/audit-log/export']?.get?.responses?.['200']?.content ?? {};
    expect(Object.keys(exportContent).sort()).toEqual(['application/json', 'text/csv']);
    expect(exportContent['text/csv']?.schema).toMatchObject({ type: 'string' });

    const logPage = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/logs?scope=${encodeURIComponent(scope)}&limit=1`,
      headers: { cookie: logsCookie },
    });
    expect(logPage.statusCode).toBe(200);
    expect(logPage.json()).toMatchObject({ logs: [{ message: 'newer native log' }], total: 2, nextCursor: expect.any(String) });

    const invalidRegex = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/logs?scope=${encodeURIComponent(scope)}&q=%5B&regex=1`,
      headers: { cookie: logsCookie },
    });
    expect(invalidRegex.statusCode).toBe(400);
    expect(invalidRegex.json()).toMatchObject({ message: 'log search pattern is invalid or unsafe' });

    const unauthenticatedLogs = await server.inject({ method: 'GET', url: '/v1/dashboard/logs' });
    expect(unauthenticatedLogs.statusCode).toBe(401);

    const auditPage = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log?limit=1', headers: { cookie: auditCookie } });
    expect(auditPage.statusCode).toBe(200);
    expect(auditPage.json()).toMatchObject({ entries: [expect.objectContaining({ action: 'project.add' })], nextCursor: expect.any(String) });

    const jsonExport = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log/export', headers: { cookie: auditCookie } });
    expect(jsonExport.statusCode).toBe(200);
    expect(jsonExport.headers['content-disposition']).toBe('attachment; filename="dkrypt-audit-log.json"');
    expect(jsonExport.json()).toContainEqual(expect.objectContaining({ target: expect.stringContaining('native-audit-'), detail: 'native route coverage' }));

    const unknownFormatExport = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log/export?format=xml', headers: { cookie: auditCookie } });
    expect(unknownFormatExport.statusCode).toBe(200);
    expect(unknownFormatExport.headers['content-disposition']).toBe('attachment; filename="dkrypt-audit-log.json"');
    expect(unknownFormatExport.json()).toContainEqual(expect.objectContaining({ detail: 'native route coverage' }));

    const csvExport = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log/export?format=csv', headers: { cookie: auditCookie } });
    expect(csvExport.statusCode).toBe(200);
    expect(csvExport.headers['content-type']).toContain('text/csv');
    expect(csvExport.headers['content-disposition']).toBe('attachment; filename="dkrypt-audit-log.csv"');
    expect(csvExport.body).toContain('id,ts,actor,action,target,detail');
    expect(csvExport.body).toContain('native route coverage');

    const deniedAudit = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log', headers: { cookie: logsCookie } });
    expect(deniedAudit.statusCode).toBe(403);

    const deniedAuditExport = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log/export', headers: { cookie: logsCookie } });
    expect(deniedAuditExport.statusCode).toBe(403);

    const unauthenticatedAuditExport = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log/export' });
    expect(unauthenticatedAuditExport.statusCode).toBe(401);

    const ignoredLegacyScope = await server.inject({ method: 'GET', url: '/v1/dashboard/logs?projectId=unknown-project', headers: { cookie: logsCookie } });
    expect(ignoredLegacyScope.statusCode).toBe(200);

    const invalidLimit = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log?limit=0', headers: { cookie: auditCookie } });
    expect(invalidLimit.statusCode).toBe(400);
  } finally {
    await server.close();
    deleteUserPersonalData(logsUserId);
    deleteUserPersonalData(auditUserId);
    deleteRole(logsRole.id, 'test cleanup');
    deleteRole(auditRole.id, 'test cleanup');
  }
});

test('native dashboard device history routes preserve permissions and validate queries', async () => {
  const device = createDevice({ name: `Device history ${crypto.randomUUID()}`, transport: 'usb', udid: crypto.randomUUID() }, 'test');
  const readerId = `github:device-reader-${crypto.randomUUID()}`;
  const deniedId = `github:device-denied-${crypto.randomUUID()}`;
  const readerPermissions = PermissionFlag.viewDevices;
  const readerRole = createRole({ name: `Device reader ${crypto.randomUUID()}`, color: '#3498db', permissions: serializeBits(readerPermissions) }, 'test');
  const deniedRole = createRole({ name: `No device access ${crypto.randomUUID()}`, color: '#99aab5', permissions: serializeBits(0n) }, 'test');
  addAllowedUser(readerId, [readerRole.id], 'test');
  addAllowedUser(deniedId, [deniedRole.id], 'test');
  const readerCookie = createSessionCookie(readerId, readerPermissions);
  const deniedCookie = createSessionCookie(deniedId, 0n);
  const server = await buildTestServer({ includePublicRoutes: false });
  const legacyRoutes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);

  try {
    for (const route of [
      'GET /v1/dashboard/devices',
      'GET /v1/dashboard/devices/:id/activity',
      'GET /v1/dashboard/devices/:id/health-history',
      'GET /v1/dashboard/devices/:id/battery-history',
      'GET /v1/dashboard/devices/:id/temperature-history',
      'GET /v1/dashboard/devices/:id/storage-history',
    ]) {
      expect(legacyRoutes).not.toContain(route);
    }

    const devices = await server.inject({ method: 'GET', url: '/v1/dashboard/devices', headers: { cookie: readerCookie } });
    expect(devices.statusCode).toBe(200);
    expect(devices.json().devices).toEqual(expect.arrayContaining([expect.objectContaining({ id: device.id, transport: 'usb' })]));

    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/devices', headers: { cookie: deniedCookie } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'forbidden' });

    const activity = await server.inject({ method: 'GET', url: `/v1/dashboard/devices/${device.id}/activity?limit=1`, headers: { cookie: readerCookie } });
    expect(activity.statusCode).toBe(200);
    expect(activity.json()).toMatchObject({ activity: [], total: 0 });

    const healthHistory = await server.inject({ method: 'GET', url: `/v1/dashboard/devices/${device.id}/health-history?hours=1`, headers: { cookie: readerCookie } });
    expect(healthHistory.statusCode).toBe(200);
    expect(healthHistory.json().buckets).toHaveLength(1);
    expect(healthHistory.json()).toMatchObject({ uptimePercent: null });

    for (const type of ['battery', 'temperature', 'storage']) {
      const history = await server.inject({ method: 'GET', url: `/v1/dashboard/devices/${device.id}/${type}-history?hours=1`, headers: { cookie: readerCookie } });
      expect(history.statusCode).toBe(200);
      expect(history.json().buckets).toHaveLength(1);
    }

    const invalidLimit = await server.inject({ method: 'GET', url: `/v1/dashboard/devices/${device.id}/activity?limit=0`, headers: { cookie: readerCookie } });
    expect(invalidLimit.statusCode).toBe(400);
    expect(invalidLimit.json()).toMatchObject({ code: 'request_error' });

    const invalidHours = await server.inject({ method: 'GET', url: `/v1/dashboard/devices/${device.id}/battery-history?hours=169`, headers: { cookie: readerCookie } });
    expect(invalidHours.statusCode).toBe(400);
    expect(invalidHours.json()).toMatchObject({ code: 'request_error' });
  } finally {
    await server.close();
    deleteDevice(device.id, 'test cleanup');
    deleteUserPersonalData(readerId);
    deleteUserPersonalData(deniedId);
    deleteRole(readerRole.id, 'test cleanup');
    deleteRole(deniedRole.id, 'test cleanup');
  }
});

test('native dashboard job inspection serves timelines and validates history queries', async () => {
  const { server, cookie } = await signIn();
  const bundleId = `com.example.native-job-${crypto.randomUUID()}`;
  const historyId = `native-job-history-${crypto.randomUUID()}`;
  const queueHistoryId = `native-job-queue-history-${crypto.randomUUID()}`;
  const missingDeviceId = `missing-device-${crypto.randomUUID()}`;
  const activeJob = enqueueDecryptJob(bundleId, 'manual', { queuedBy: 'root', preferredDeviceId: missingDeviceId });
  Object.assign(activeJob, { deviceId: 'test-device', transport: 'usb', attempt: 4, executionStage: 'decrypting', shutdownRecoveryAt: 1234 });
  replacePersistedJobs([activeJob]);
  const finishedAt = Date.now();
  recordJobHistory({
    id: historyId,
    bundleId,
    status: 'done',
    source: 'manual',
    createdAt: finishedAt - 1_000,
    finishedAt,
    deviceId: 'test-device',
    transport: 'wifi',
    timeline: [{ at: finishedAt, label: 'Finished with warning', status: 'done' }],
    warnings: ['An embedded extension remains encrypted'],
  });
  recordJobHistory({
    id: queueHistoryId,
    bundleId,
    status: 'failed',
    source: 'scheduler',
    createdAt: finishedAt - 2_000,
    finishedAt: finishedAt - 1_000,
    error: 'job deadline exceeded while waiting in the queue',
    queueReason: 'Waiting for a compatible device',
    failureClass: 'queue',
  });

  try {
    const unauthorized = await server.inject({ method: 'GET', url: '/v1/dashboard/jobs' });
    expect(unauthorized.statusCode).toBe(401);

    const timeline = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${historyId}/timeline`, headers: { cookie } });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toMatchObject({
      id: historyId,
      status: 'done',
      deviceId: 'test-device',
      transport: 'wifi',
      warnings: ['An embedded extension remains encrypted'],
      events: [{ label: 'Finished with warning', status: 'done' }],
    });

    const queueTimeline = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${queueHistoryId}/timeline`, headers: { cookie } });
    expect(queueTimeline.statusCode).toBe(200);
    expect(queueTimeline.json()).toMatchObject({
      queueReason: 'Waiting for a compatible device',
      guidance: {
        category: 'Queue wait expired',
        action: 'Resolve the queue blocker shown in the job timeline or device status, then retry.',
      },
    });

    const history = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs?q=${encodeURIComponent(bundleId)}`, headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json().history).toEqual(expect.arrayContaining([expect.objectContaining({ id: historyId, deviceId: 'test-device', transport: 'wifi', fileAvailable: false })]));

    const activeStatus = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${activeJob.id}/status`, headers: { cookie } });
    expect(activeStatus.statusCode).toBe(200);
    expect(activeStatus.json()).toMatchObject({ id: activeJob.id, status: 'queued', attempt: 4, deviceId: 'test-device', transport: 'usb' });

    const activeTimeline = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${activeJob.id}/timeline`, headers: { cookie } });
    expect(activeTimeline.statusCode).toBe(200);
    expect(activeTimeline.json()).toMatchObject({ id: activeJob.id, status: 'queued', shutdownRecoveryAt: 1234 });
    expect(activeTimeline.json().executionStage).toBeUndefined();

    activeJob.status = 'running';
    replacePersistedJobs([activeJob]);
    const runningTimeline = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${activeJob.id}/timeline`, headers: { cookie } });
    expect(runningTimeline.statusCode).toBe(200);
    expect(runningTimeline.json()).toMatchObject({ id: activeJob.id, status: 'running', executionStage: 'decrypting' });
    activeJob.status = 'queued';
    replacePersistedJobs([activeJob]);

    const missingStatus = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${historyId}/status`, headers: { cookie } });
    expect(missingStatus.statusCode).toBe(404);
    expect(missingStatus.json()).toMatchObject({ code: 'request_error', message: 'job not found (finished jobs are pruned after retention window)' });

    const invalidPage = await server.inject({ method: 'GET', url: '/v1/dashboard/jobs?limit=0', headers: { cookie } });
    expect(invalidPage.statusCode).toBe(400);
    expect(invalidPage.json()).toMatchObject({ code: 'request_error' });
  } finally {
    cancelQueuedJob(activeJob.id, 'test cleanup');
    await server.close();
  }
});

test('dashboard account and notification routes validate requests and preserve session behavior', async () => {
  const userId = `github:preferences-${crypto.randomUUID()}`;
  const role = createRole({ name: `Preferences ${crypto.randomUUID()}`, color: '#3498db', permissions: serializeBits(0n) }, 'test');
  addAllowedUser(userId, [role.id], 'test');
  const cookie = createSessionCookie(userId, 0n);
  const server = await buildTestServer({ includePublicRoutes: false });
  const endpoint = `https://push.example/${crypto.randomUUID()}`;

  try {
    const protectedRoutes = [
      { method: 'GET' as const, url: '/v1/dashboard/me/prefs' },
      { method: 'GET' as const, url: '/v1/dashboard/me/form-drafts/api-key%3Anew' },
      { method: 'PUT' as const, url: '/v1/dashboard/me/form-drafts/api-key%3Anew', payload: { kind: 'api-key', values: { name: 'ci' } } },
      { method: 'DELETE' as const, url: '/v1/dashboard/me/form-drafts/api-key%3Anew' },
      { method: 'GET' as const, url: '/v1/dashboard/push/public-key' },
      { method: 'POST' as const, url: '/v1/dashboard/push/subscribe', payload: { endpoint, keys: { p256dh: 'public-key', auth: 'secret' } } },
      { method: 'POST' as const, url: '/v1/dashboard/push/unsubscribe', payload: { endpoint } },
      { method: 'POST' as const, url: '/v1/dashboard/push/test' },
      { method: 'POST' as const, url: '/v1/dashboard/email/test' },
      { method: 'PUT' as const, url: '/v1/dashboard/me/prefs', payload: {} },
    ];
    for (const route of protectedRoutes) {
      const unauthorized = await server.inject(route);
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json()).toMatchObject({ code: 'unauthorized' });
    }

    const publicKey = await server.inject({ method: 'GET', url: '/v1/dashboard/push/public-key', headers: { cookie } });
    expect(publicKey.statusCode).toBe(200);
    expect((publicKey.json() as { publicKey: string }).publicKey.length).toBeGreaterThan(0);

    const initialPrefs = await server.inject({ method: 'GET', url: '/v1/dashboard/me/prefs', headers: { cookie } });
    expect(initialPrefs.json()).toMatchObject({
      density: 'comfortable',
      sidebarWidth: 256,
      sidebarCollapsed: false,
      activeHomeLayoutId: 'default',
      homeLayouts: [{ id: 'default', name: 'Default', order: ['artifacts', 'activeJobs', 'jobHistory'], hidden: [], collapsed: [] }],
      viewModes: { artifacts: 'list', jobHistory: 'cards', devices: 'cards' },
      settingsMode: 'basic',
      displayTimeZone: 'system',
      appFavorites: [],
      navigationOrder: ['home', 'billing', 'keys', 'logs', 'insights', 'docs', 'settings'],
      pinnedNavigation: [],
      artifactLibrary: { groupByApp: false, columns: ['app', 'bundleId', 'version', 'source', 'size'] },
      largeTargets: false,
    });

    const emailTest = await server.inject({ method: 'POST', url: '/v1/dashboard/email/test', headers: { cookie } });
    expect(emailTest.statusCode).toBe(400);
    expect(emailTest.json()).toMatchObject({ code: 'request_error', message: 'set a notification email first' });

    const invalidPrefs = await server.inject({ method: 'PUT', url: '/v1/dashboard/me/prefs', headers: { cookie }, payload: { theme: 'sepia' } });
    expect(invalidPrefs.statusCode).toBe(400);
    expect(invalidPrefs.json()).toMatchObject({ code: 'request_error' });

    const invalidLocale = await server.inject({ method: 'PUT', url: '/v1/dashboard/me/prefs', headers: { cookie }, payload: { formattingLocale: 'fr' } });
    expect(invalidLocale.statusCode).toBe(400);
    expect(invalidLocale.json()).toMatchObject({ code: 'request_error' });

    const invalidInterfaceLanguage = await server.inject({ method: 'PUT', url: '/v1/dashboard/me/prefs', headers: { cookie }, payload: { interfaceLanguage: 'fr' } });
    expect(invalidInterfaceLanguage.statusCode).toBe(400);

    const invalidSidebarWidth = await server.inject({ method: 'PUT', url: '/v1/dashboard/me/prefs', headers: { cookie }, payload: { sidebarWidth: 500 } });
    expect(invalidSidebarWidth.statusCode).toBe(400);
    expect(invalidInterfaceLanguage.json()).toMatchObject({ code: 'request_error' });

    const updatedPrefs = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/me/prefs',
      headers: { cookie },
      payload: {
        formattingLocale: 'de',
        interfaceLanguage: 'de',
        theme: 'dark',
        density: 'compact',
        sidebarWidth: 312,
        sidebarCollapsed: true,
        accent: 'slate',
        highContrast: true,
        pushOnSuccess: false,
        appNotificationPreferences: [{ bundleId: 'Com.Example.App', pushOnSuccess: false, emailOnFailure: true }],
        notifyEmail: 'test@example.com',
        homeLayouts: [{ id: 'work', name: 'Work', order: ['activeJobs', 'artifacts', 'jobHistory'], hidden: ['jobHistory'], collapsed: [] }],
        activeHomeLayoutId: 'work',
        viewModes: { artifacts: 'cards', devices: 'cards' },
        settingsMode: 'advanced',
        displayTimeZone: 'Europe/Berlin',
        appFavorites: [{ bundleId: 'com.example.app', trackName: 'Example App' }],
        navigationOrder: ['home', 'logs', 'settings', 'keys', 'insights', 'docs', 'billing'],
        pinnedNavigation: ['home', 'logs'],
        artifactLibrary: { groupByApp: true, columns: ['app', 'version', 'source', 'size'] },
        largeTargets: true,
      },
    });
    expect(updatedPrefs.statusCode).toBe(200);
    expect(updatedPrefs.json()).toMatchObject({
      formattingLocale: 'de',
      interfaceLanguage: 'de',
      theme: 'dark',
      density: 'compact',
      sidebarWidth: 312,
      sidebarCollapsed: true,
      accent: 'slate',
      highContrast: true,
      pushOnSuccess: false,
      appNotificationPreferences: [{ bundleId: 'com.example.app', pushOnSuccess: false, emailOnFailure: true }],
      homeLayouts: [{ id: 'work', name: 'Work', order: ['activeJobs', 'artifacts', 'jobHistory'], hidden: ['jobHistory'], collapsed: [] }],
      activeHomeLayoutId: 'work',
      viewModes: { artifacts: 'cards', jobHistory: 'cards', devices: 'cards' },
      settingsMode: 'advanced',
      displayTimeZone: 'Europe/Berlin',
      appFavorites: [{ bundleId: 'com.example.app', trackName: 'Example App' }],
      navigationOrder: ['home', 'logs', 'settings', 'keys', 'insights', 'docs', 'billing'],
      pinnedNavigation: ['home', 'logs'],
      artifactLibrary: { groupByApp: true, columns: ['app', 'version', 'source', 'size'] },
      largeTargets: true,
    });

    const prefs = await server.inject({ method: 'GET', url: '/v1/dashboard/me/prefs', headers: { cookie } });
    expect(prefs.json()).toMatchObject({
      formattingLocale: 'de',
      interfaceLanguage: 'de',
      theme: 'dark',
      density: 'compact',
      sidebarWidth: 312,
      sidebarCollapsed: true,
      accent: 'slate',
      highContrast: true,
      pushOnSuccess: false,
      appNotificationPreferences: [{ bundleId: 'com.example.app', pushOnSuccess: false, emailOnFailure: true }],
      activeHomeLayoutId: 'work',
      viewModes: { artifacts: 'cards', devices: 'cards' },
      settingsMode: 'advanced',
      displayTimeZone: 'Europe/Berlin',
      appFavorites: [{ bundleId: 'com.example.app', trackName: 'Example App' }],
      navigationOrder: ['home', 'logs', 'settings', 'keys', 'insights', 'docs', 'billing'],
      pinnedNavigation: ['home', 'logs'],
      artifactLibrary: { groupByApp: true, columns: ['app', 'version', 'source', 'size'] },
      largeTargets: true,
    });

    const invalidLayout = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/me/prefs',
      headers: { cookie },
      payload: { homeLayouts: [{ id: 'broken', name: 'Broken', order: ['artifacts'], hidden: [], collapsed: [] }] },
    });
    expect(invalidLayout.statusCode).toBe(400);

    const otherUserId = `github:preferences-isolation-${crypto.randomUUID()}`;
    addAllowedUser(otherUserId, [role.id], 'test');
    const otherUserPrefs = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/me/prefs',
      headers: { cookie: createSessionCookie(otherUserId, 0n) },
    });
    expect(otherUserPrefs.json()).toMatchObject({
      activeHomeLayoutId: 'default',
      settingsMode: 'basic',
      density: 'comfortable',
      sidebarWidth: 256,
      sidebarCollapsed: false,
      displayTimeZone: 'system',
      appFavorites: [],
      navigationOrder: ['home', 'billing', 'keys', 'logs', 'insights', 'docs', 'settings'],
      pinnedNavigation: [],
      artifactLibrary: { groupByApp: false, columns: ['app', 'bundleId', 'version', 'source', 'size'] },
      largeTargets: false,
    });

    const draftId = 'api-key%3Anew';
    const draftSave = await server.inject({
      method: 'PUT',
      url: `/v1/dashboard/me/form-drafts/${draftId}`,
      headers: { cookie },
      payload: { kind: 'api-key', values: { name: 'ci-runner', expiresInDays: '30', bundleScope: 'com.example.app', dailyLimit: '100' } },
    });
    expect(draftSave.statusCode).toBe(200);
    expect(draftSave.json()).toMatchObject({ draft: { kind: 'api-key', values: { name: 'ci-runner', expiresInDays: '30', bundleScope: 'com.example.app', dailyLimit: '100' } } });

    const draftGet = await server.inject({ method: 'GET', url: `/v1/dashboard/me/form-drafts/${draftId}`, headers: { cookie } });
    expect(draftGet.json()).toMatchObject({ draft: { kind: 'api-key', values: { name: 'ci-runner' } } });

    const otherUserDraft = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/me/form-drafts/${draftId}`,
      headers: { cookie: createSessionCookie(otherUserId, 0n) },
    });
    expect(otherUserDraft.json()).toEqual({});

    const secretDraft = await server.inject({
      method: 'PUT',
      url: `/v1/dashboard/me/form-drafts/${draftId}`,
      headers: { cookie },
      payload: { kind: 'api-key', values: { revealedKey: 'secret-value' } },
    });
    expect(secretDraft.statusCode).toBe(400);

    const wrongKindDraft = await server.inject({
      method: 'PUT',
      url: `/v1/dashboard/me/form-drafts/${draftId}`,
      headers: { cookie },
      payload: { kind: 'device', values: { name: 'iPad' } },
    });
    expect(wrongKindDraft.statusCode).toBe(400);

    const draftDelete = await server.inject({ method: 'DELETE', url: `/v1/dashboard/me/form-drafts/${draftId}`, headers: { cookie } });
    expect(draftDelete.statusCode).toBe(200);
    const deletedDraft = await server.inject({ method: 'GET', url: `/v1/dashboard/me/form-drafts/${draftId}`, headers: { cookie } });
    expect(deletedDraft.json()).toEqual({});

    const invalidTimeZone = await server.inject({ method: 'PUT', url: '/v1/dashboard/me/prefs', headers: { cookie }, payload: { displayTimeZone: 'Not/A_Time_Zone' } });
    expect(invalidTimeZone.statusCode).toBe(400);

    const invalidAppNotification = await server.inject({ method: 'PUT', url: '/v1/dashboard/me/prefs', headers: { cookie }, payload: { appNotificationPreferences: [{ bundleId: 'not-a-bundle-id', pushOnFailure: false }] } });
    expect(invalidAppNotification.statusCode).toBe(400);

    const duplicateAppNotification = await server.inject({ method: 'PUT', url: '/v1/dashboard/me/prefs', headers: { cookie }, payload: { appNotificationPreferences: [{ bundleId: 'com.example.app' }, { bundleId: 'COM.EXAMPLE.APP' }] } });
    expect(duplicateAppNotification.statusCode).toBe(400);

    const invalidNavigation = await server.inject({ method: 'PUT', url: '/v1/dashboard/me/prefs', headers: { cookie }, payload: { pinnedNavigation: ['not-a-tab'] } });
    expect(invalidNavigation.statusCode).toBe(400);

    const invalidSubscription = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/push/subscribe',
      headers: { cookie },
      payload: { endpoint: '', keys: { p256dh: 'public-key', auth: 'secret' } },
    });
    expect(invalidSubscription.statusCode).toBe(400);
    expect(invalidSubscription.json()).toMatchObject({ code: 'request_error', requestId: invalidSubscription.headers['x-request-id'] });

    const subscription = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/push/subscribe',
      headers: { cookie },
      payload: { endpoint, keys: { p256dh: 'public-key', auth: 'secret' } },
    });
    expect(subscription.statusCode).toBe(200);
    expect(subscription.json() as unknown).toEqual({ ok: true });

    const unsubscribe = await server.inject({ method: 'POST', url: '/v1/dashboard/push/unsubscribe', headers: { cookie }, payload: { endpoint } });
    expect(unsubscribe.statusCode).toBe(200);
    expect(unsubscribe.json() as unknown).toEqual({ ok: true });

    const pushTest = await server.inject({ method: 'POST', url: '/v1/dashboard/push/test', headers: { cookie } });
    expect(pushTest.statusCode).toBe(200);
    expect(pushTest.json() as unknown).toEqual({ ok: true });
  } finally {
    await server.close();
    deleteUserPersonalData(userId);
    deleteRole(role.id, 'test');
  }
});

test('Fastify persists dashboard device mutations and returns the updated overview', async () => {
  const { server, cookie } = await signIn();
  const legacyDevice = createDevice({ name: 'legacy key device', transport: 'wifi', host: '192.168.1.11', port: 22, user: 'mobile' }, 'test');
  Object.assign(legacyDevice, { keyPath: '/private/device-ssh-key' });

  try {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices',
      headers: { cookie },
      payload: { name: 'test device', transport: 'wifi', host: '192.168.1.10', port: 22, user: 'mobile' },
    });
    expect(created.statusCode).toBe(201);
    const device = created.json() as { id: string; name: string; host?: string; rootDir?: string };
    expect(device.name).toBe('test device');
    expect(device.host).toBe('192.168.1.10');
    expect(device.rootDir).toBeUndefined();

    const invalidHostUpdate = await server.inject({
      method: 'PATCH',
      url: `/v1/dashboard/devices/${device.id}`,
      headers: { cookie },
      payload: { host: 'bad/host' },
    });
    expect(invalidHostUpdate.statusCode).toBe(400);
    expect(invalidHostUpdate.json()).toMatchObject({ message: 'device host is invalid' });
    const devicesAfterInvalidUpdate = await server.inject({ method: 'GET', url: '/v1/dashboard/devices', headers: { cookie } });
    const persistedDevice = (devicesAfterInvalidUpdate.json() as { devices: Array<{ id: string; host?: string }> }).devices.find((candidate) => candidate.id === device.id);
    expect(persistedDevice?.host).toBe('192.168.1.10');

    const updated = await server.inject({
      method: 'PATCH',
      url: `/v1/dashboard/devices/${device.id}`,
      headers: { cookie },
      payload: { name: 'updated device', notes: 'managed through Fastify' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id: device.id, name: 'updated device', notes: 'managed through Fastify' });

    const ipv6 = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices',
      headers: { cookie },
      payload: { name: 'IPv6 device', transport: 'wifi', host: '2001:db8::10', port: 22 },
    });
    expect(ipv6.statusCode).toBe(201);
    const ipv6Device = ipv6.json() as { id: string; host?: string };
    expect(ipv6Device.host).toBe('2001:db8::10');
    await server.inject({ method: 'DELETE', url: `/v1/dashboard/devices/${ipv6Device.id}`, headers: { cookie } });

    const overview = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie } });
    expect(overview.statusCode).toBe(200);
    const overviewDevices = (overview.json() as { devices: Array<Record<string, unknown> & { id: string }> }).devices;
    expect(overviewDevices.some((candidate) => candidate.id === device.id)).toBe(true);
    const serializedLegacyDevice = overviewDevices.find((candidate) => candidate.id === legacyDevice.id);
    expect(serializedLegacyDevice).toMatchObject({ setupRequired: false, transportState: 'discovered', transportCapabilities: [] });
    expect(serializedLegacyDevice).not.toHaveProperty('keyPath');

    const deleted = await server.inject({ method: 'DELETE', url: `/v1/dashboard/devices/${device.id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(200);
  } finally {
    await server.close();
    deleteDevice(legacyDevice.id, 'test');
  }
});

test('device drain stops assignment and disables an idle device until explicitly enabled', async () => {
  const { server, cookie } = await signIn();
  const device = createDevice({ name: 'drain test device', transport: 'wifi', host: '127.0.0.1' }, 'test');
  try {
    const drained = await server.inject({ method: 'POST', url: `/v1/dashboard/devices/${device.id}/drain`, headers: { cookie } });
    expect(drained.statusCode).toBe(200);
    expect(drained.json()).toMatchObject({ id: device.id, enabled: false, draining: false });
    const enabled = await server.inject({ method: 'PATCH', url: `/v1/dashboard/devices/${device.id}`, headers: { cookie }, payload: { enabled: true } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ id: device.id, enabled: true, draining: false });
  } finally {
    deleteDevice(device.id, 'test');
    await server.close();
  }
});

test('enabling a device wakes queued jobs assigned to it', async () => {
  const { server, cookie } = await signIn();
  const device = createDevice({ name: 'dispatch wake device', transport: 'wifi', host: '127.0.0.1', enabled: false }, 'test');
  const job = enqueueDecryptJob(`com.test.dispatch-wake.${crypto.randomUUID()}`, 'manual', { preferredDeviceId: device.id });

  try {
    expect(job.status).toBe('queued');
    const enabled = await server.inject({ method: 'PATCH', url: `/v1/dashboard/devices/${device.id}`, headers: { cookie }, payload: { enabled: true } });
    expect(enabled.statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && job.status === 'queued'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(job).toMatchObject({ executionPath: 'device', deviceId: device.id });
  } finally {
    if (job.status === 'queued') cancelQueuedJob(job.id, 'device dispatch wake test cleanup');
    if (job.status === 'running') cancelJob(job.id, 'device dispatch wake test cleanup');
    deleteDevice(device.id, 'test');
    await server.close();
  }
});

test('device edits reject stale revisions and return the latest record for review', async () => {
  const { server, cookie } = await signIn();
  const device = createDevice({ name: 'Revision iPad', transport: 'wifi', host: '127.0.0.1' }, 'test');
  try {
    const url = `/v1/dashboard/devices/${device.id}`;
    const first = await server.inject({ method: 'PATCH', url, headers: { cookie }, payload: { name: 'Operator A iPad', expectedUpdatedAt: device.updatedAt } });
    const stale = await server.inject({ method: 'PATCH', url, headers: { cookie }, payload: { name: 'Operator B iPad', expectedUpdatedAt: device.updatedAt } });
    expect(first.statusCode).toBe(200);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'revision_conflict', remediation: { current: { id: device.id, name: 'Operator A iPad' } } });
  } finally {
    deleteDevice(device.id, 'test');
    await server.close();
  }
});

test('project management endpoints are no longer available', async () => {
  const { server, cookie } = await signIn();
  try {
    const response = await server.inject({ method: 'GET', url: '/v1/dashboard/projects', headers: { cookie } });
    const create = await server.inject({ method: 'POST', url: '/v1/dashboard/projects', headers: { cookie }, payload: { name: 'Workspace' } });
    expect(response.statusCode).toBe(404);
    expect(create.statusCode).toBe(404);
    await server.ready();
    const document = server.swagger() as { paths?: Record<string, unknown> };
    expect(document.paths?.['/v1/dashboard/projects']).toBeUndefined();
  } finally {
    await server.close();
  }
});

test('event streams close when a member loses access permissions', async () => {
  const { server } = await signIn();
  const memberId = `github:stream-${crypto.randomUUID()}`;
  const memberPermissions = PermissionFlag.requestDecrypt | PermissionFlag.viewDevices;
  const role = createRole({ name: `Stream ${crypto.randomUUID()}`, color: '#3498db', permissions: serializeBits(memberPermissions) }, 'test');
  addAllowedUser(memberId, [role.id], 'test');
  const memberCookie = createSessionCookie(memberId, memberPermissions);
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();

  try {
    const response = await fetch(`${baseUrl}/v1/dashboard/events`, { headers: { cookie: memberCookie }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('dashboard event stream has no reader');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: overview');

    expect(updateRole(role.id, { permissions: serializeBits(PermissionFlag.requestDecrypt) }, 'test').ok).toBe(true);
    emitJobsChanged();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: access-revoked');
    expect((await reader.read()).done).toBe(true);
  } finally {
    controller.abort();
    deleteUserPersonalData(memberId);
    deleteRole(role.id, 'test cleanup');
    await server.close();
  }
});

test('Fastify rejects obsolete device root submissions', async () => {
  const { server, cookie } = await signIn();

  try {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices',
      headers: { cookie },
      payload: { name: 'legacy device', rootDir: '/root/.ipadecrypt' },
    });
    expect(created.statusCode).toBe(400);
    expect((created.json() as { error: string }).error).toBe('device setup requires a discovered USB or Wi-Fi connection');

    const normal = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices',
      headers: { cookie },
      payload: { name: 'normal device', transport: 'wifi', host: '192.168.1.10', port: 22, user: 'mobile' },
    });
    const device = normal.json() as { id: string };
    const patched = await server.inject({
      method: 'PATCH',
      url: `/v1/dashboard/devices/${device.id}`,
      headers: { cookie },
      payload: { rootDir: '/root/.ipadecrypt' },
    });
    expect(patched.statusCode).toBe(400);
    expect((patched.json() as { error: string }).error).toBe('device setup requires a discovered USB or Wi-Fi connection');
    await server.inject({ method: 'DELETE', url: `/v1/dashboard/devices/${device.id}`, headers: { cookie } });
  } finally {
    await server.close();
  }
});

test('Fastify sends the initial dashboard overview over SSE', async () => {
  expect(dashboardRouter.routes.map((route) => `${route.method} ${route.path}`)).not.toContain('GET /v1/dashboard/events');
  const { server, cookie } = await signIn();
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(`${baseUrl}/v1/dashboard/events`, { headers: { cookie }, signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('connection')).toBe('keep-alive');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const chunk = await response.body?.getReader().read();
    expect(new TextDecoder().decode(chunk?.value)).toContain('event: overview');
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await server.close();
  }
});

test('member status updates expose simple service availability only', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const device = createDevice({ name: `SSE status ${crypto.randomUUID()}`, transport: 'wifi', host: '127.0.0.1' }, 'test');
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const decoder = new TextDecoder();
  let pending = '';
  const readEvent = async (reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> }): Promise<string> => {
    while (!pending.includes('\n\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('dashboard event stream ended unexpectedly');
      pending += decoder.decode(chunk.value, { stream: true });
    }
    const boundary = pending.indexOf('\n\n');
    const event = pending.slice(0, boundary);
    pending = pending.slice(boundary + 2);
    return event;
  };

  try {
    const response = await fetch(`${baseUrl}/v1/dashboard/events`, { headers: { cookie: createSessionCookie('root', PermissionFlag.requestDecrypt) }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('dashboard event stream has no reader');
    await readEvent(reader);
    await readEvent(reader);

    setCachedDeviceHealth(device.id, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
    const update = await readEvent(reader);
    expect(update).toContain('event: overview');
    const payload = JSON.parse(update.match(/^data: (.+)$/m)?.[1] ?? '{}') as { devices?: unknown[]; deviceStatus?: unknown; statusDevices?: unknown; disk?: unknown; maintenance?: unknown; settings?: unknown; serviceStatus?: string };
    expect(payload.devices).toEqual([]);
    expect(payload).not.toHaveProperty('deviceStatus');
    expect(payload).not.toHaveProperty('statusDevices');
    expect(payload).not.toHaveProperty('disk');
    expect(payload).not.toHaveProperty('maintenance');
    expect(payload).not.toHaveProperty('settings');
    expect(payload.serviceStatus).toMatch(/^(operational|maintenance)$/);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    deleteDevice(device.id, 'test');
    await server.close();
  }
});

test('billing changes reach billing viewers over SSE without exposing subscription data', async () => {
  const server = await buildTestServer();
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const managerController = new AbortController();
  const viewerController = new AbortController();
  const timeout = setTimeout(() => {
    managerController.abort();
    viewerController.abort();
  }, 5_000);
  const previousListenerCount = dashboardEvents.listenerCount('billingChanged');

  const readEvent = async (reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> }, state: { pending: string }): Promise<string> => {
    const decoder = new TextDecoder();
    while (!state.pending.includes('\n\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('dashboard event stream ended unexpectedly');
      state.pending += decoder.decode(chunk.value, { stream: true });
    }
    const boundary = state.pending.indexOf('\n\n');
    const event = state.pending.slice(0, boundary);
    state.pending = state.pending.slice(boundary + 2);
    return event;
  };

  try {
    const managerResponse = await fetch(`${baseUrl}/v1/dashboard/events`, {
      headers: { cookie: createSessionCookie('root', PermissionFlag.viewBilling) },
      signal: managerController.signal,
    });
    const viewerResponse = await fetch(`${baseUrl}/v1/dashboard/events`, {
      headers: { cookie: createSessionCookie('root', PermissionFlag.viewUsers) },
      signal: viewerController.signal,
    });
    expect(managerResponse.status).toBe(200);
    expect(viewerResponse.status).toBe(200);
    const managerReader = managerResponse.body?.getReader();
    const viewerReader = viewerResponse.body?.getReader();
    if (!managerReader || !viewerReader) throw new Error('dashboard event stream has no reader');
    const managerState = { pending: '' };
    const viewerState = { pending: '' };
    await readEvent(managerReader, managerState);
    await readEvent(managerReader, managerState);
    await readEvent(viewerReader, viewerState);
    await readEvent(viewerReader, viewerState);
    expect(dashboardEvents.listenerCount('billingChanged')).toBe(previousListenerCount + 1);

    emitBillingChanged();

    const event = await readEvent(managerReader, managerState);
    expect(event).toContain('event: billing');
    expect(JSON.parse(event.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '{}')).toEqual({ sequence: 3 });
  } finally {
    clearTimeout(timeout);
    managerController.abort();
    viewerController.abort();
    closeDashboardConnections();
    await server.close();
  }

  expect(dashboardEvents.listenerCount('billingChanged')).toBe(previousListenerCount);
});

test('each dashboard event stream tracks its own sequence while other clients are connected', async () => {
  const { server, cookie } = await signIn();
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const controllers = [new AbortController(), new AbortController()];
  const makeReader = (response: globalThis.Response) => {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('dashboard event stream has no reader');
    const decoder = new TextDecoder();
    let pending = '';
    return {
      async readSequence(): Promise<number> {
        while (!pending.includes('\n\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('dashboard event stream ended unexpectedly');
          pending += decoder.decode(chunk.value, { stream: true });
        }
        const boundary = pending.indexOf('\n\n');
        const event = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const sequence = event.match(/^id: (\d+)$/m)?.[1];
        if (!sequence) throw new Error('dashboard event did not include a sequence id');
        return Number(sequence);
      },
    };
  };

  try {
    const responses = await Promise.all(controllers.map((controller) => fetch(`${baseUrl}/v1/dashboard/events`, { headers: { cookie }, signal: controller.signal })));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const readers = responses.map(makeReader);
    const initialSequences = await Promise.all(readers.map(async (reader) => [await reader.readSequence(), await reader.readSequence()]));
    expect(initialSequences[0][1] - initialSequences[0][0]).toBe(1);
    expect(initialSequences[1][1] - initialSequences[1][0]).toBe(1);

    emitJobsChanged();
    emitJobsChanged();
    const updates = await Promise.all(readers.map(async (reader) => [await reader.readSequence(), await reader.readSequence()]));
    expect(updates[0][1] - updates[0][0]).toBe(1);
    expect(updates[1][1] - updates[1][0]).toBe(1);
  } finally {
    controllers.forEach((controller) => controller.abort());
    await server.close();
  }
});

test('Fastify serves browser identity assets from the public root', async () => {
  const server = await buildTestServer();

  try {
    const favicon = await server.inject({ method: 'GET', url: '/favicon.svg' });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers['content-type']).toContain('image/svg+xml');

    const png = await server.inject({ method: 'GET', url: '/favicon.png' });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');

    const manifest = await server.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
  } finally {
    await server.close();
  }
});

test('Scalar API reference renders with a per-response nonce and only allows same-origin framing', async () => {
  const server = await buildTestServer();

  try {
    const first = await server.inject({ method: 'GET', url: '/reference/' });
    const second = await server.inject({ method: 'GET', url: '/reference/' });
    const dashboard = await server.inject({ method: 'GET', url: '/' });
    const nonce = first.body.match(/<meta property="csp-nonce" content="([^"]+)"\s*\/>/)?.[1];
    const scriptTags = first.body.match(/<script\b[^>]*>/g) ?? [];
    const policy = first.headers['content-security-policy'];

    expect(first.statusCode).toBe(200);
    expect(nonce).toBeTruthy();
    expect(scriptTags.length).toBeGreaterThan(1);
    expect(scriptTags.every((tag) => tag.includes(`nonce="${nonce}"`))).toBe(true);
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).not.toContain("frame-ancestors 'none'");
    expect(first.headers['x-frame-options']).not.toBe('DENY');
    expect(dashboard.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(policy).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(second.body.match(/<meta property="csp-nonce" content="([^"]+)"\s*\/>/)?.[1]).not.toBe(nonce);
  } finally {
    await server.close();
  }
});

test('Fastify emits a narrow content security policy', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({ method: 'GET', url: '/v1/status' });
    const policy = response.headers['content-security-policy'];
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain("style-src-elem 'self'");
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
    expect(policy).not.toContain("style-src 'self' 'unsafe-inline'");
  } finally {
    await server.close();
  }
});

test('Fastify normalizes API errors into the shared error envelope', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({ method: 'GET', url: '/v1/dashboard/overview' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
      message: expect.any(String),
      requestId: expect.any(String),
      retryable: false,
    });
  } finally {
    await server.close();
  }
});

test('health responses expose transport and subsystem recovery states', async () => {
  const originalDeploymentId = process.env.DEPLOYMENT_ID;
  const originalBuildRef = process.env.BUILD_REF;
  process.env.DEPLOYMENT_ID = 'deploy-456-attempt-2';
  process.env.BUILD_REF = 'abcdef0123456789';
  const server = await buildTestServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { authorization: `Bearer ${process.env.API_KEY}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      deployment: {
        id: 'deploy-456-attempt-2',
        ref: 'abcdef0123456789',
      },
      device: {
        transportState: expect.stringMatching(/^(discovered|pairing|connecting|ready|degraded|recovering|offline|unsupported)$/),
        capabilities: expect.any(Array),
        recoveryState: expect.stringMatching(/^(stable|recovering|degraded|offline)$/),
      },
    });
  } finally {
    await server.close();
    if (originalDeploymentId === undefined) delete process.env.DEPLOYMENT_ID;
    else process.env.DEPLOYMENT_ID = originalDeploymentId;
    if (originalBuildRef === undefined) delete process.env.BUILD_REF;
    else process.env.BUILD_REF = originalBuildRef;
  }
});

test('Fastify exposes coarse public service status without device details', async () => {
  const originalBuildRef = process.env.BUILD_REF;
  process.env.BUILD_REF = '0123456789abcdef';
  const server = await buildTestServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({ method: 'GET', url: '/v1/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: expect.stringMatching(/^(operational|degraded|maintenance)$/),
      checkedAt: expect.any(String),
      deployment: { ref: '0123456789abcdef' },
      components: {
        service: { state: expect.any(String) },
        automation: { state: expect.any(String) },
      },
    });
    expect(response.json().components).not.toHaveProperty('scheduler');
    expect(response.body).not.toContain('deviceId');
    expect(response.body).not.toContain('capabilities');
  } finally {
    await server.close();
    if (originalBuildRef === undefined) delete process.env.BUILD_REF;
    else process.env.BUILD_REF = originalBuildRef;
  }
});

test('public status omits retired workflow scheduler state', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    const response = await server.inject({ method: 'GET', url: '/v1/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json().components).toMatchObject({
      service: { state: expect.any(String) },
      automation: { state: expect.any(String) },
    });
    expect(response.json().components).not.toHaveProperty('scheduler');
  } finally {
    await server.close();
  }
});

test('Fastify includes a session-protected artifact download in live history events', async () => {
  const { server, cookie } = await signIn();
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const id = `live-history-${crypto.randomUUID()}`;
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-live-history-'));
  const outputPath = path.join(outputDir, 'app.ipa');
  await writeFile(outputPath, 'ipa');
  const artifact = await promoteArtifact({
    key: `com.example.live-history|appstore|${id}`,
    bundleId: 'com.example.live-history',
    channel: 'appstore',
    versionLabel: '342.0',
    stagingPath: outputPath,
    sourceJobId: id,
  });

  try {
    const response = await fetch(`${baseUrl}/v1/dashboard/events`, { headers: { cookie }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('dashboard event stream has no reader');
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain('event: overview');

    recordJobHistory({
      id,
      bundleId: 'com.example.live-history',
      status: 'done',
      source: 'scheduler',
      artifactId: artifact.id,
      createdAt: Date.now() - 1_000,
      finishedAt: Date.now(),
    });

    const next = await reader.read();
    const text = new TextDecoder().decode(next.value);
    const match = text.match(/event: history\ndata: (.+)\n\n/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match?.[1] ?? '')).toMatchObject({
      id,
      downloadUrl: `/v1/dashboard/artifacts/${artifact.id}/file`,
      fileAvailable: true,
    });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await rm(artifact.filePath, { force: true });
    await server.close();
  }
});

test('Fastify has no former share-link dashboard routes', async () => {
  const { server, cookie } = await signIn();

  try {
    const routes = [
      ['POST', '/v1/dashboard/jobs/removed/share'],
      ['GET', '/v1/dashboard/jobs/removed/share'],
      ['GET', '/v1/dashboard/share-links'],
      ['GET', '/v1/dashboard/share-links/export'],
      ['POST', '/v1/dashboard/jobs/share/removed/revoke'],
      ['POST', '/v1/dashboard/jobs/removed/share/revoke-all'],
      ['PATCH', '/v1/dashboard/jobs/share/removed'],
      ['GET', '/v1/dashboard/jobs/removed/file'],
    ] as const;
    for (const [method, url] of routes) {
      const response = await server.inject({ method, url, headers: { cookie } });
      expect(response.statusCode).toBe(404);
    }
  } finally {
    await server.close();
  }
});

test('Fastify serves artifacts through a dashboard session', async () => {
  const { server, cookie } = await signIn();
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-dashboard-artifact-'));
  const outputPath = path.join(outputDir, 'app.ipa');
  await writeFile(outputPath, 'dashboard ipa');
  const artifact = await promoteArtifact({
    key: `com.example.dashboard-artifact|appstore|${crypto.randomUUID()}`,
    bundleId: 'com.example.dashboard-artifact',
    channel: 'appstore',
    versionLabel: '342.0',
    stagingPath: outputPath,
  });

  try {
    const unauthorized = await server.inject({ method: 'GET', url: `/v1/dashboard/artifacts/${artifact.id}/file` });
    expect(unauthorized.statusCode).toBe(401);

    const response = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/artifacts/${artifact.id}/file`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('dashboard ipa');
  } finally {
    await rm(artifact.filePath, { force: true });
    await server.close();
  }
});

test('Fastify marks cleaned completed jobs as unavailable in history', async () => {
  const { server, cookie } = await signIn();
  const id = `cleaned-history-${crypto.randomUUID()}`;
  recordJobHistory({
    id,
    bundleId: 'com.example.cleaned-history',
    status: 'done',
    source: 'manual',
    createdAt: Date.now() - 1_000,
    finishedAt: Date.now(),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs?q=com.example.cleaned-history',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { history: Array<{ id: string; fileAvailable: boolean }> };
    expect(body.history).toContainEqual(expect.objectContaining({ id, fileAvailable: false }));
  } finally {
    await server.close();
  }
});

test('Fastify resolves job requester identities for history', async () => {
  const { server, cookie } = await signIn();
  const suffix = crypto.randomUUID();
  const bundleId = `com.example.requester-${suffix}`;
  const userId = `github:${suffix}`;
  const manualId = `manual-requester-${suffix}`;
  const schedulerId = `scheduler-requester-${suffix}`;
  const accountUsername = `requester-${suffix.slice(0, 16)}`;
  upsertAuthProfile({
    userId,
    provider: 'github',
    providerId: suffix,
    username: accountUsername,
    displayName: 'Visual User',
    avatarUrl: 'https://example.com/avatar.png',
    updatedAt: new Date().toISOString(),
  });
  recordJobHistory({
    id: manualId,
    bundleId,
    queuedBy: userId,
    status: 'done',
    source: 'manual',
    createdAt: Date.now() - 2_000,
    finishedAt: Date.now() - 1_000,
  });
  recordJobHistory({
    id: schedulerId,
    bundleId,
    status: 'done',
    source: 'scheduler',
    createdAt: Date.now() - 1_000,
    finishedAt: Date.now(),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/jobs?q=${encodeURIComponent(bundleId)}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { history: Array<{ id: string; requester?: { username?: string; displayName: string; avatarUrl?: string } }> };
    expect(body.history.find((entry) => entry.id === manualId)?.requester).toEqual({
      username: accountUsername,
      displayName: 'Visual User',
      avatarUrl: 'https://example.com/avatar.png',
    });
    expect(body.history.find((entry) => entry.id === schedulerId)?.requester).toEqual({
      displayName: 'System',
      avatarUrl: '/favicon.svg',
    });
  } finally {
    await server.close();
  }
});

test('Fastify exposes scheduler artifacts in recent jobs after the job is pruned', async () => {
  const { server, cookie } = await signIn();
  const id = `scheduler-artifact-${crypto.randomUUID()}`;
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-scheduler-artifact-'));
  const outputPath = path.join(outputDir, 'app.ipa');
  await writeFile(outputPath, 'ipa');
  const artifact = await promoteArtifact({
    key: `com.example.scheduler-artifact|appstore|${id}`,
    bundleId: 'com.example.scheduler-artifact',
    channel: 'appstore',
    versionLabel: '342.0',
    stagingPath: outputPath,
    sourceJobId: id,
  });
  recordJobHistory({
    id,
    bundleId: 'com.example.scheduler-artifact',
    status: 'done',
    source: 'scheduler',
    createdAt: Date.now() - 1_000,
    finishedAt: Date.now(),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs?q=com.example.scheduler-artifact',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { history: Array<{ id: string; downloadUrl?: string; fileAvailable: boolean }> };
    expect(body.history.find((entry) => entry.id === id)).toMatchObject({
      downloadUrl: `/v1/dashboard/artifacts/${artifact.id}/file`,
      fileAvailable: true,
    });
  } finally {
    await rm(artifact.filePath, { force: true });
    await server.close();
  }
});

test('Fastify requires an API key for stable artifact downloads and rejects old signed tokens', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-download-'));
  const outputPath = path.join(outputDir, 'app.ipa');
  await writeFile(outputPath, 'ipa');
  const artifact = await promoteArtifact({
    key: `com.example.scheduler-download|appstore|${crypto.randomUUID()}`,
    bundleId: 'com.example.scheduler-download',
    channel: 'appstore',
    versionLabel: '342.0',
    stagingPath: outputPath,
  });

  try {
    const unauthorized = await server.inject({
      method: 'GET',
      url: `/v1/artifacts/${artifact.id}/file?token=old-token`,
    });
    expect(unauthorized.statusCode).toBe(401);

    const oldJobRoute = await server.inject({
      method: 'GET',
      url: '/v1/jobs/removed/file?token=old-token',
      headers: { authorization: `Bearer ${process.env.API_KEY}` },
    });
    expect(oldJobRoute.statusCode).toBe(404);

    const response = await server.inject({
      method: 'GET',
      url: buildArtifactFileUrl(artifact.id),
      headers: { authorization: `Bearer ${process.env.API_KEY}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('ipa');

    await rm(artifact.filePath, { force: true });
    const removed = await server.inject({
      method: 'GET',
      url: buildArtifactFileUrl(artifact.id),
      headers: { authorization: `Bearer ${process.env.API_KEY}` },
    });
    expect(removed.statusCode).toBe(404);
  } finally {
    await rm(artifact.filePath, { force: true });
    await server.close();
  }
});

test('Fastify enforces API key bundle scopes for artifact downloads', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-scoped-artifact-'));
  const outputPath = path.join(outputDir, 'app.ipa');
  await writeFile(outputPath, 'scoped ipa');
  const artifact = await promoteArtifact({
    key: `com.example.scoped-artifact|appstore|${crypto.randomUUID()}`,
    bundleId: 'com.example.scoped-artifact',
    channel: 'appstore',
    versionLabel: '342.0',
    stagingPath: outputPath,
  });
  const scopedKey = createApiKey('scoped artifact test', 'root', undefined, ['com.example.other']);

  try {
    const response = await server.inject({
      method: 'GET',
      url: buildArtifactFileUrl(artifact.id),
      headers: { authorization: `Bearer ${scopedKey.key}` },
    });
    expect(response.statusCode).toBe(403);
  } finally {
    revokeApiKey(scopedKey.id, 'root', true);
    await rm(artifact.filePath, { force: true });
    await server.close();
  }
});

test('Fastify previews retention and reports queue service objectives', async () => {
  const { server, cookie } = await signIn();

  try {
    const retention = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/settings/job-history-retention/preview?retentionDays=0',
      headers: { cookie },
    });
    expect(retention.statusCode).toBe(200);
    expect(retention.json()).toMatchObject({
      retentionDays: 0,
      removed: 0,
      agePruned: 0,
      afterNextWrite: expect.any(Number),
      maxEntries: 100,
    });

    const artifactRetention = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/artifacts/retention-preview?maxBytes=1',
      headers: { cookie },
    });
    expect(artifactRetention.statusCode).toBe(200);
    expect(artifactRetention.json()).toMatchObject({
      targetMaxBytes: 1,
      currentCount: expect.any(Number),
      currentBytes: expect.any(Number),
      evictedCount: expect.any(Number),
      evictionExamples: expect.any(Array),
    });

    const artifactStorage = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/settings/artifact-storage',
      headers: { cookie },
    });
    expect(artifactStorage.statusCode).toBe(200);
    expect(artifactStorage.json()).toMatchObject({
      count: expect.any(Number),
      usedBytes: expect.any(Number),
      maxBytes: expect.any(Number),
    });

    const slo = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs/slo',
      headers: { cookie },
    });
    expect(slo.statusCode).toBe(200);
    expect(slo.json()).toMatchObject({ targetMs: expect.any(Number), jobs: expect.any(Array) });
  } finally {
    await server.close();
  }
});

test('artifact storage preview is available to operational members with Free decrypt access', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const automationId = `github:storage-automation-${crypto.randomUUID()}`;
  const decryptId = `github:storage-decrypt-${crypto.randomUUID()}`;
  const permittedId = `github:storage-permitted-${crypto.randomUUID()}`;
  const automationPermissions = PermissionFlag.manageAutomation;
  const decryptPermissions = PermissionFlag.requestDecrypt;
  const permittedPermissions = automationPermissions | decryptPermissions;
  const automationRole = createRole({ name: `Storage automation ${crypto.randomUUID()}`, color: '#3498db', permissions: serializeBits(automationPermissions) }, 'root');
  const decryptRole = createRole({ name: `Storage decrypt ${crypto.randomUUID()}`, color: '#5865f2', permissions: serializeBits(decryptPermissions) }, 'root');
  const permittedRole = createRole({ name: `Storage access ${crypto.randomUUID()}`, color: '#57f287', permissions: serializeBits(permittedPermissions) }, 'root');
  addAllowedUser(automationId, [automationRole.id], 'root');
  addAllowedUser(decryptId, [decryptRole.id], 'root');
  addAllowedUser(permittedId, [permittedRole.id], 'root');
  const automationCookie = createSessionCookie(automationId, automationPermissions);
  const decryptCookie = createSessionCookie(decryptId, decryptPermissions);
  const permittedCookie = createSessionCookie(permittedId, permittedPermissions);

  try {
    const automationOnly = await server.inject({ method: 'GET', url: '/v1/dashboard/settings/artifact-storage', headers: { cookie: automationCookie } });
    const decryptOnly = await server.inject({ method: 'GET', url: '/v1/dashboard/settings/artifact-storage', headers: { cookie: decryptCookie } });
    const permitted = await server.inject({ method: 'GET', url: '/v1/dashboard/settings/artifact-storage', headers: { cookie: permittedCookie } });

    expect(automationOnly.statusCode).toBe(200);
    expect(decryptOnly.statusCode).toBe(403);
    expect(permitted.statusCode).toBe(200);
  } finally {
    await server.close();
    deleteUserPersonalData(automationId);
    deleteUserPersonalData(decryptId);
    deleteUserPersonalData(permittedId);
    deleteRole(automationRole.id, 'test cleanup');
    deleteRole(decryptRole.id, 'test cleanup');
    deleteRole(permittedRole.id, 'test cleanup');
  }
});

test('Fastify previews bulk decrypts and serves durable notifications', async () => {
  const { server, cookie } = await signIn();
  const firstId = `bulk-first-${crypto.randomUUID()}`;
  const secondId = `bulk-second-${crypto.randomUUID()}`;
  recordJobHistory({
    id: firstId,
    bundleId: 'com.example.bulk-first',
    status: 'done',
    source: 'manual',
    createdAt: Date.now() - 10_000,
    finishedAt: Date.now() - 5_000,
    sizeBytes: 12 * 1024 * 1024,
  });
  recordJobHistory({
    id: secondId,
    bundleId: 'com.example.bulk-second',
    status: 'failed',
    source: 'manual',
    createdAt: Date.now() - 10_000,
    finishedAt: Date.now() - 4_000,
  });
  recordNotification({ userId: 'root', title: 'Test notification', message: 'Durable', severity: 'info' });

  try {
    const unauthorizedList = await server.inject({ method: 'GET', url: '/v1/dashboard/notifications' });
    const unauthorizedRead = await server.inject({ method: 'POST', url: '/v1/dashboard/notifications/read', payload: {} });
    expect(unauthorizedList.statusCode).toBe(401);
    expect(unauthorizedRead.statusCode).toBe(401);

    const preview = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/bulk-preview',
      headers: { cookie },
      payload: { ids: [firstId, secondId] },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ requested: 2, eligible: 2, projectedQueueAdds: 2, previousSizeBytes: 12 * 1024 * 1024 });

    const notifications = await server.inject({ method: 'GET', url: '/v1/dashboard/notifications', headers: { cookie } });
    expect(notifications.statusCode).toBe(200);
    expect(notifications.json()).toMatchObject({ unread: expect.any(Number), notifications: expect.arrayContaining([expect.objectContaining({ message: 'Durable' })]) });

    const marked = await server.inject({ method: 'POST', url: '/v1/dashboard/notifications/read', headers: { cookie }, payload: {} });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({ ok: true, marked: expect.any(Number) });
  } finally {
    await server.close();
  }
});

test('job history cursors do not repeat rows when a newer job is added between pages', async () => {
  const { server, cookie } = await signIn();
  const bundlePrefix = `com.example.cursor-${crypto.randomUUID()}`;
  const historyEntry = (suffix: string, finishedAt: number) => ({
    id: `${bundlePrefix}-${suffix}`,
    bundleId: `${bundlePrefix}.${suffix}`,
    status: 'done' as const,
    source: 'manual' as const,
    createdAt: finishedAt - 1_000,
    finishedAt,
  });
  const existing = [
    historyEntry('a', 1_000),
    historyEntry('b', 2_000),
    historyEntry('c', 3_000),
    historyEntry('d', 4_000),
  ];
  for (const entry of existing) recordJobHistory(entry);

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/jobs?limit=2&q=${encodeURIComponent(bundlePrefix)}`,
      headers: { cookie },
    });
    const first = firstResponse.json() as { history: { id: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.history.map((entry) => entry.id)).toEqual([existing[3].id, existing[2].id]);
    expect(first.nextCursor).toEqual(expect.any(String));

    recordJobHistory(historyEntry('new', 5_000));
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/jobs?limit=2&q=${encodeURIComponent(bundlePrefix)}&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { history: { id: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.history.map((entry) => entry.id)).toEqual([existing[1].id, existing[0].id]);
  } finally {
    await server.close();
  }
});

test('notification cursors keep their boundary when a newer notification arrives', async () => {
  const { server, cookie } = await signIn();
  recordNotification({ userId: 'root', title: `Cursor seed ${crypto.randomUUID()}`, message: 'Older entry', severity: 'info' });
  recordNotification({ userId: 'root', title: `Cursor seed ${crypto.randomUUID()}`, message: 'Oldest entry', severity: 'info' });

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/notifications?limit=1',
      headers: { cookie },
    });
    const first = firstResponse.json() as { notifications: { id: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.notifications).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));

    const expectedNextResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/notifications?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const expectedNext = expectedNextResponse.json() as { notifications: { id: string }[] };

    await Bun.sleep(2);
    recordNotification({ userId: 'root', title: `Cursor arrival ${crypto.randomUUID()}`, message: 'Newer entry', severity: 'info' });
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/notifications?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { notifications: { id: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.notifications.map((entry) => entry.id)).toEqual(expectedNext.notifications.map((entry) => entry.id));
  } finally {
    await server.close();
  }
});

test('artifact cursors keep their boundary when a newer artifact is promoted', async () => {
  const { server, cookie } = await signIn();
  const bundleId = `com.example.cursor-${crypto.randomUUID()}`;
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-cursor-'));
  const artifacts = [];
  for (const [index, suffix] of ['a', 'b', 'c', 'd'].entries()) {
    const stagingPath = path.join(outputDir, `${suffix}.ipa`);
    await writeFile(stagingPath, `cursor artifact ${suffix}`);
    artifacts.push(await promoteArtifact({
      key: `${bundleId}|appstore|${suffix}`,
      bundleId,
      channel: 'appstore',
      externalVersionId: suffix,
      stagingPath,
    }));
    if (index < 3) await Bun.sleep(2);
  }

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/artifacts?limit=2&q=${encodeURIComponent(bundleId)}`,
      headers: { cookie },
    });
    const first = firstResponse.json() as { artifacts: { id: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.artifacts.map((artifact) => artifact.id)).toEqual([artifacts[3].id, artifacts[2].id]);
    expect(first.nextCursor).toEqual(expect.any(String));

    await Bun.sleep(2);
    const stagingPath = path.join(outputDir, 'new.ipa');
    await writeFile(stagingPath, 'cursor artifact newer');
    artifacts.push(await promoteArtifact({
      key: `${bundleId}|appstore|new`,
      bundleId,
      channel: 'appstore',
      externalVersionId: 'new',
      stagingPath,
    }));
    await touchArtifact(artifacts[1]);
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/artifacts?limit=2&q=${encodeURIComponent(bundleId)}&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { artifacts: { id: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.artifacts.map((artifact) => artifact.id)).toEqual([artifacts[1].id, artifacts[0].id]);
  } finally {
    await Promise.all(artifacts.map((artifact) => rm(artifact.filePath, { force: true })));
    await rm(outputDir, { recursive: true, force: true });
    await server.close();
  }
});

test('artifact pinning is scoped, persistent, audited, and available in the library response', async () => {
  const { server, cookie } = await signIn();
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-pin-route-'));
  const stagingPath = path.join(outputDir, 'pinned.ipa');
  await writeFile(stagingPath, 'pinned ipa');
  const artifact = await promoteArtifact({
    key: `test-pin-route-${crypto.randomUUID()}`,
    bundleId: 'com.example.pin-route',
    channel: 'appstore',
    externalVersionId: `pin-${crypto.randomUUID()}`,
    stagingPath,
    sourceJobId: 'job-pin-route',
    warnings: ['An embedded extension remains encrypted'],
  });

  try {
    const pinned = await server.inject({
      method: 'PUT',
      url: `/v1/dashboard/artifacts/${artifact.id}/pin`,
      headers: { cookie },
      payload: { pinned: true },
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toMatchObject({ ok: true, artifactId: artifact.id, pinned: true, pinnedAt: expect.any(String) });

    const library = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts?q=com.example.pin-route', headers: { cookie } });
    expect(library.statusCode).toBe(200);
    expect(library.json().artifacts[0]).toMatchObject({
      id: artifact.id,
      pinnedAt: expect.any(String),
      sourceJobId: 'job-pin-route',
      warnings: ['An embedded extension remains encrypted'],
    });

    const audit = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log?limit=10', headers: { cookie } });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries).toContainEqual(expect.objectContaining({ action: 'artifact.pin', target: artifact.id }));

    const unpinned = await server.inject({
      method: 'PUT',
      url: `/v1/dashboard/artifacts/${artifact.id}/pin`,
      headers: { cookie },
      payload: { pinned: false },
    });
    expect(unpinned.statusCode).toBe(200);
    expect(unpinned.json()).toMatchObject({ ok: true, artifactId: artifact.id, pinned: false });
  } finally {
    await rm(artifact.filePath, { force: true });
    await rm(outputDir, { recursive: true, force: true });
    await server.close();
  }
});

test('artifact pinning requires storage management permission', async () => {
  const { server } = await signIn();
  const previousBilling = exportBillingSnapshot();
  const managerId = `github:artifact-pin-manager-${crypto.randomUUID()}`;
  const readerId = `github:artifact-pin-reader-${crypto.randomUUID()}`;
  const managerPermissions = PermissionFlag.requestDecrypt | PermissionFlag.manageAutomation;
  const readerPermissions = PermissionFlag.requestDecrypt;
  const managerRole = createRole({ name: `Artifact storage manager ${crypto.randomUUID()}`, color: '#5865f2', permissions: serializeBits(managerPermissions) }, 'root');
  const readerRole = createRole({ name: `Artifact reader ${crypto.randomUUID()}`, color: '#3498db', permissions: serializeBits(readerPermissions) }, 'root');
  addAllowedUser(managerId, [managerRole.id], 'root');
  addAllowedUser(readerId, [readerRole.id], 'root');
  const managerCookie = createSessionCookie(managerId, managerPermissions);
  const readerCookie = createSessionCookie(readerId, readerPermissions);
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-pin-scope-'));
  const stagingPath = path.join(outputDir, 'restricted.ipa');
  await writeFile(stagingPath, 'restricted ipa');
  const artifact = await promoteArtifact({
    key: `test-pin-scope-${crypto.randomUUID()}`,
    bundleId: 'com.example.pin-scope',
    channel: 'appstore',
    stagingPath,
  });

  try {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    for (const userId of [managerId, readerId]) {
      upsertBillingSubscription({
        provider: 'stripe',
        subscriptionId: `sub_${userId}`,
        customerId: `customer_${userId}`,
        userId,
        status: 'active',
        planId: 'regular',
        priceId: 'price_regular',
        productId: 'product_regular',
        occurredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    const permitted = await server.inject({
      method: 'PUT',
      url: `/v1/dashboard/artifacts/${artifact.id}/pin`,
      headers: { cookie: managerCookie },
      payload: { pinned: true },
    });
    const missingPermission = await server.inject({
      method: 'PUT',
      url: `/v1/dashboard/artifacts/${artifact.id}/pin`,
      headers: { cookie: readerCookie },
      payload: { pinned: true },
    });
    expect(permitted.statusCode).toBe(200);
    expect(missingPermission.statusCode).toBe(403);
  } finally {
    replaceBillingSnapshot(previousBilling);
    await rm(artifact.filePath, { force: true });
    await rm(outputDir, { recursive: true, force: true });
    await server.close();
  }
});

test('audit cursors keep their boundary when a newer audit event is recorded', async () => {
  const { server, cookie } = await signIn();
  const targetPrefix = `cursor-audit-${crypto.randomUUID()}`;
  recordAudit('root', 'settings.update', `${targetPrefix}-older`);
  await Bun.sleep(2);
  recordAudit('root', 'settings.update', `${targetPrefix}-current`);

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/audit-log?limit=1',
      headers: { cookie },
    });
    const first = firstResponse.json() as { entries: { id: string; target: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.entries[0].target).toBe(`${targetPrefix}-current`);
    expect(first.nextCursor).toEqual(expect.any(String));

    const expectedNextResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/audit-log?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const expectedNext = expectedNextResponse.json() as { entries: { id: string }[] };

    await Bun.sleep(2);
    recordAudit('root', 'settings.update', `${targetPrefix}-new`);
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/audit-log?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { entries: { id: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.entries.map((entry) => entry.id)).toEqual(expectedNext.entries.map((entry) => entry.id));
  } finally {
    await server.close();
  }
});

test('device activity cursors keep their boundary when a newer event is recorded', async () => {
  const { server, cookie } = await signIn();
  const createdResponse = await server.inject({
    method: 'POST',
    url: '/v1/dashboard/devices',
    headers: { cookie },
    payload: { name: `Cursor device ${crypto.randomUUID()}`, transport: 'wifi', host: '192.0.2.15', port: 22, user: 'mobile' },
  });
  const device = createdResponse.json() as { id: string };
  recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: 'older cursor event' });
  await Bun.sleep(2);
  recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: 'current cursor event' });

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/devices/${device.id}/activity?limit=1`,
      headers: { cookie },
    });
    const first = firstResponse.json() as { activity: { id: string; message: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.activity[0].message).toBe('current cursor event');
    expect(first.nextCursor).toEqual(expect.any(String));

    const expectedNextResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/devices/${device.id}/activity?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const expectedNext = expectedNextResponse.json() as { activity: { id: string; message: string }[] };

    await Bun.sleep(2);
    recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: 'new cursor event' });
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/devices/${device.id}/activity?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { activity: { id: string; message: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.activity.map((entry) => entry.id)).toEqual(expectedNext.activity.map((entry) => entry.id));
    expect(second.activity[0].message).toBe('older cursor event');
  } finally {
    await server.inject({ method: 'DELETE', url: `/v1/dashboard/devices/${device.id}`, headers: { cookie } });
    await server.close();
  }
});

test('TestFlight subscription cursors keep their boundary when a newer request arrives', async () => {
  const { server, cookie } = await signIn();
  const invitePrefix = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
  const subscriptionInput = (suffix: string) => ({
    url: `https://testflight.apple.com/join/${invitePrefix}${suffix}`,
    inviteCode: `${invitePrefix}${suffix}`,
    requestedBy: 'root',
    status: 'denied' as const,
    bundleId: `com.example.cursor.${suffix}`,
    displayName: `Cursor ${suffix}`,
  });
  const older = createTestFlightSubscription(subscriptionInput('old'), 'root');
  await Bun.sleep(2);
  const current = createTestFlightSubscription(subscriptionInput('now'), 'root');
  let newestId = '';

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/testflight/subscriptions?limit=1',
      headers: { cookie },
    });
    const first = firstResponse.json() as { subscriptions: { id: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.subscriptions[0].id).toBe(current.id);
    expect(first.nextCursor).toEqual(expect.any(String));

    await Bun.sleep(2);
    newestId = createTestFlightSubscription(subscriptionInput('new'), 'root').id;
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/testflight/subscriptions?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { subscriptions: { id: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.subscriptions.map((subscription) => subscription.id)).toEqual([older.id]);
    expect(second.subscriptions.map((subscription) => subscription.id)).not.toContain(current.id);
  } finally {
    withdrawTestFlightSubscription(older.id, 'root');
    withdrawTestFlightSubscription(current.id, 'root');
    if (newestId) withdrawTestFlightSubscription(newestId, 'root');
    await server.close();
  }
});

test('log cursors keep their boundary when a newer log entry is recorded', async () => {
  const { server, cookie } = await signIn();
  const scope = `cursor-${crypto.randomUUID()}`;
  const logger = scopedLogger(scope);
  logger.info('older cursor log');
  await Bun.sleep(2);
  logger.info('current cursor log');

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/logs?scope=${encodeURIComponent(scope)}&limit=1`,
      headers: { cookie },
    });
    const first = firstResponse.json() as { logs: { id: string; message: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.logs[0].message).toBe('current cursor log');
    expect(first.nextCursor).toEqual(expect.any(String));

    await Bun.sleep(2);
    logger.info('new cursor log');
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/logs?scope=${encodeURIComponent(scope)}&limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { logs: { id: string; message: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.logs[0].message).toBe('older cursor log');
    expect(second.logs.map((entry) => entry.id)).not.toContain(first.logs[0].id);
  } finally {
    await server.close();
  }
});

test('billing subscription cursors keep their boundary when subscriptions change between pages', async () => {
  const { server, cookie } = await signIn();
  const previousSnapshot = exportBillingSnapshot();
  const idPrefix = `cursor-billing-${crypto.randomUUID()}`;
  const baseTime = Date.now() - 10_000;
  const subscription = (suffix: string, at: number) => ({
    provider: 'nowpayments' as const,
    subscriptionId: `${idPrefix}-${suffix}`,
    customerId: `${idPrefix}-customer`,
    userId: 'root',
    status: 'active',
    planId: 'regular' as const,
    priceId: `${idPrefix}-price`,
    productId: 'dkrypt-regular',
    occurredAt: new Date(at).toISOString(),
    updatedAt: new Date(at).toISOString(),
  });
  const current = subscription('current', baseTime);
  const older = subscription('older', baseTime - 1_000);
  upsertBillingSubscription(current);
  upsertBillingSubscription(older);

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: `/v1/billing/subscriptions?limit=1&q=${encodeURIComponent(idPrefix)}`,
      headers: { cookie },
    });
    const first = firstResponse.json() as { subscriptions: { subscriptionId: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.subscriptions[0].subscriptionId).toBe(current.subscriptionId);
    expect(first.nextCursor).toEqual(expect.any(String));

    upsertBillingSubscription(subscription('new', baseTime + 1_000));
    upsertBillingSubscription(subscription('older', baseTime + 2_000));
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/billing/subscriptions?limit=1&q=${encodeURIComponent(idPrefix)}&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { subscriptions: { subscriptionId: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.subscriptions.map((entry) => entry.subscriptionId)).toEqual([older.subscriptionId]);
  } finally {
    replaceBillingSnapshot(previousSnapshot);
    await server.close();
  }
});
