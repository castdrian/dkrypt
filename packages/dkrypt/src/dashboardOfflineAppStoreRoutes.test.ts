import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import type { Response } from '#http.js';
import { createDashboardOfflineAppStoreRoutes } from '#routes/dashboardOfflineAppStoreRoutes.js';
import type { OfflineAppStoreReadiness } from '#offlineAppStore.js';
import type { CredentialRetrievalStatus } from '#offlineAppStoreCredential.js';

function sessionCookie(permissions: bigint, reauthenticated = false): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions, reauthenticatedAt: reauthenticated ? Date.now() : undefined });
  return value.split(';', 1)[0]!;
}

function readiness(): OfflineAppStoreReadiness {
  return {
    enabled: false,
    ready: false,
    downloaderAvailable: true,
    decryptorAvailable: false,
    fairPlayAuthorized: false,
    vault: { encryptionReady: true, accountConfigured: true, credentialConfigured: false, accountHint: 'a•••@icloud.com' },
    blockers: ['offline decryption is disabled', 'FairPlay decryptor is missing'],
  };
}

test('offline App Store management is manager-only and does not expose account secrets', async () => {
  const calls: string[] = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardOfflineAppStoreRoutes({
    readiness,
    saveAccount: (appleId, password) => {
      calls.push(`account:${appleId}:${password}`);
      return readiness().vault;
    },
    saveCredential: (credential) => {
      calls.push(`credential:${credential}`);
      return readiness().vault;
    },
    startAuthentication: (code) => { calls.push(`authenticate:${code ?? ''}`); return { state: 'running', operationId: 'operation-1', startedAt: 123 }; },
    getAuthenticationStatus: () => ({ state: 'idle' }),
    resetAuthentication: () => {},
    clear: () => { calls.push('clear'); return true; },
  }));

  try {
    const unauthenticated = await server.inject({ method: 'GET', url: '/v1/dashboard/appstore-offline/status' });
    const member = await server.inject({ method: 'GET', url: '/v1/dashboard/appstore-offline/status', headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) } });
    const apiKeyOnly = await server.inject({ method: 'GET', url: '/v1/dashboard/appstore-offline/status', headers: { authorization: 'Bearer dk_live_example' } });
    const administrator = await server.inject({ method: 'GET', url: '/v1/dashboard/appstore-offline/status', headers: { cookie: sessionCookie(PermissionFlag.administrator) } });
    expect(unauthenticated.statusCode).toBe(401);
    expect(member.statusCode).toBe(403);
    expect(apiKeyOnly.statusCode).toBe(401);
    expect(administrator.statusCode).toBe(200);
    expect(administrator.body).not.toMatch(/password|credentialValue|ciphertext|sessionSnapshot/i);

    const reauthenticationRequired = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/appstore-offline/account',
      headers: { cookie: sessionCookie(PermissionFlag.administrator) },
      payload: { appleId: 'admin@example.test', password: 'sensitive-password' },
    });
    expect(reauthenticationRequired.statusCode).toBe(401);
    expect(reauthenticationRequired.json()).toMatchObject({ code: 'reauthentication_required' });

    const saved = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/appstore-offline/account',
      headers: { cookie: sessionCookie(PermissionFlag.administrator, true) },
      payload: { appleId: 'admin@example.test', password: 'sensitive-password' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('sensitive-password');
    expect(calls).toEqual(['account:admin@example.test:sensitive-password']);
  } finally {
    await server.close();
  }
});

test('offline App Store authentication accepts only a six-digit one-time code', async () => {
  const submitted: Array<{ verificationCode?: string; retrySavedCredentials?: boolean }> = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardOfflineAppStoreRoutes({
    readiness,
    startAuthentication: (verificationCode, retrySavedCredentials) => { submitted.push({ verificationCode, retrySavedCredentials }); return { state: 'running', operationId: 'operation-1', startedAt: 123 }; },
    getAuthenticationStatus: () => ({ state: 'idle' }),
  }));
  const headers = { cookie: sessionCookie(PermissionFlag.administrator, true) };

  try {
    const invalid = await server.inject({ method: 'POST', url: '/v1/dashboard/appstore-offline/authenticate', headers, payload: { verificationCode: '12345' } });
    const valid = await server.inject({ method: 'POST', url: '/v1/dashboard/appstore-offline/authenticate', headers, payload: { verificationCode: '123456' } });
    const retry = await server.inject({ method: 'POST', url: '/v1/dashboard/appstore-offline/authenticate', headers, payload: { retrySavedCredentials: true } });
    expect(invalid.statusCode).toBe(400);
    expect(valid.statusCode).toBe(202);
    expect(retry.statusCode).toBe(202);
    expect(submitted).toEqual([{ verificationCode: '123456', retrySavedCredentials: undefined }, { verificationCode: undefined, retrySavedCredentials: true }]);
    expect(valid.body).not.toContain('123456');
    expect(valid.json().authentication).toEqual({ state: 'running', operationId: 'operation-1', startedAt: 123 });
  } finally {
    await server.close();
  }
});

test('no-purchase readiness check reports setup without starting account or package operations', async () => {
  let authStarted = false;
  let downloadStarted = false;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardOfflineAppStoreRoutes({
    readiness,
    startAuthentication: () => { authStarted = true; return { state: 'running', operationId: 'unexpected' }; },
    retrieveCredential: () => { downloadStarted = true; return { state: 'running', operationId: 'unexpected' }; },
  }));

  try {
    const member = await server.inject({ method: 'POST', url: '/v1/dashboard/appstore-offline/verify', headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) } });
    const result = await server.inject({ method: 'POST', url: '/v1/dashboard/appstore-offline/verify', headers: { cookie: sessionCookie(PermissionFlag.administrator) } });
    expect(member.statusCode).toBe(403);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ ok: false, purchaseMade: false, downloadStarted: false });
    expect(result.json().checks).toHaveLength(6);
    expect(authStarted).toBeFalse();
    expect(downloadStarted).toBeFalse();
  } finally {
    await server.close();
  }
});

test('App Store downloader network check is manager-only and reports only safe connectivity data', async () => {
  let checks = 0;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardOfflineAppStoreRoutes({
    checkDownloaderNetwork: async () => {
      checks += 1;
      return { reachable: true, latencyMs: 42, endpoint: 'https://itunes.apple.com/lookup', redirected: false, rateLimited: false };
    },
  }));

  try {
    const member = await server.inject({ method: 'POST', url: '/v1/dashboard/appstore-offline/network-check', headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) } });
    const result = await server.inject({ method: 'POST', url: '/v1/dashboard/appstore-offline/network-check', headers: { cookie: sessionCookie(PermissionFlag.administrator) } });
    expect(member.statusCode).toBe(403);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ reachable: true, latencyMs: 42, endpoint: 'https://itunes.apple.com/lookup', checkedAt: expect.any(String) });
    expect(checks).toBe(1);
    expect(result.body).not.toMatch(/password|credential|token|secret/i);
  } finally {
    await server.close();
  }
});

test('Apple Account verification returns its durable background status without awaiting Apple', async () => {
  const authentication = { state: 'running' as const, operationId: 'operation-1', startedAt: 123 };
  const overrides = {
    readiness,
    refreshStorefrontCountry: async () => {},
    startAuthentication: () => authentication,
    getAuthenticationStatus: () => authentication,
  };
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardOfflineAppStoreRoutes(overrides));

  try {
    const startedAt = Date.now();
    const started = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/appstore-offline/authenticate',
      headers: { cookie: sessionCookie(PermissionFlag.administrator, true) },
      payload: {},
    });
    const status = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/appstore-offline/status',
      headers: { cookie: sessionCookie(PermissionFlag.administrator) },
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(started.statusCode).toBe(202);
    expect(started.json().authentication).toEqual(authentication);
    expect(status.json().authentication).toEqual(authentication);
  } finally {
    await server.close();
  }
});

test('FairPlay credential retrieval requires recent manager authentication and targets only the requested device', async () => {
  const targets: string[] = [];
  let retrievalStatus: CredentialRetrievalStatus = { state: 'idle' };
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardOfflineAppStoreRoutes({
    readiness,
    getCredentialRetrievalStatus: () => retrievalStatus,
    retrieveCredential: (deviceId) => {
      targets.push(deviceId);
      retrievalStatus = { state: 'running', deviceId };
      return retrievalStatus;
    },
  }));
  const manager = { cookie: sessionCookie(PermissionFlag.administrator) };
  const reauthenticatedManager = { cookie: sessionCookie(PermissionFlag.administrator, true) };

  try {
    const unauthorized = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/appstore-offline/credential/retrieve',
      headers: manager,
      payload: { deviceId: 'ipad-exact-id' },
    });
    const started = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/appstore-offline/credential/retrieve',
      headers: reauthenticatedManager,
      payload: { deviceId: 'ipad-exact-id' },
    });
    const status = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/appstore-offline/status',
      headers: manager,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(started.statusCode).toBe(202);
    expect(targets).toEqual(['ipad-exact-id']);
    expect(status.json().credentialRetrieval).toEqual({ state: 'running', deviceId: 'ipad-exact-id' });
    expect(status.body).not.toMatch(/credentialValue|ciphertext|password|fairPlayCredential/i);
  } finally {
    await server.close();
  }
});

test('App Store downloader network check is manager-only and reports safe connectivity details', async () => {
  let calls = 0;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardOfflineAppStoreRoutes({
    readiness,
    checkDownloaderNetwork: async () => {
      calls += 1;
      return { reachable: true, latencyMs: 42, endpoint: 'itunes.apple.com', redirected: false, rateLimited: false };
    },
  }));

  try {
    const member = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/appstore-offline/network-check',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
    });
    const administrator = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/appstore-offline/network-check',
      headers: { cookie: sessionCookie(PermissionFlag.administrator) },
    });

    expect(member.statusCode).toBe(403);
    expect(administrator.statusCode).toBe(200);
    expect(administrator.json()).toMatchObject({ reachable: true, latencyMs: 42, endpoint: 'itunes.apple.com' });
    expect(administrator.json()).toHaveProperty('checkedAt');
    expect(administrator.body).not.toMatch(/password|credential|token|account/i);
    expect(calls).toBe(1);
  } finally {
    await server.close();
  }
});
