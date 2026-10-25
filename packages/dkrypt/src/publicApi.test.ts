import { expect, test } from 'bun:test';
import { buildTestServer } from '#testServer.js';
import { isPublicApiKeyRoute } from '#publicApi.js';
import { createApiKey, revokeApiKey } from '#store/state.js';

test('public OpenAPI contains only decrypt and IPA artifact routes', async () => {
  const server = await buildTestServer();

  try {
    const response = await server.inject({ method: 'GET', url: '/openapi.json' });
    const document = response.json() as { info?: { description?: string }; paths?: Record<string, Record<string, { responses?: Record<string, { headers?: Record<string, { schema?: { const?: string } }> }> }>> };
    expect(response.statusCode).toBe(200);
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([
      '/v1/artifacts',
      '/v1/artifacts/{id}',
      '/v1/artifacts/{id}/file',
      '/v1/decrypt',
      '/v1/decrypts',
      '/v1/jobs/status',
      '/v1/jobs/{id}',
      '/v1/jobs/{id}/wait',
      '/v1/testflight/decrypt',
    ]);
    expect(document.info?.description).toContain('decrypt');
    expect(document.paths?.['/v1/jobs/{id}']?.get?.responses?.['200']?.headers?.['X-Dkrypt-API-Version']?.schema?.const).toBe('1');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('billing');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('/v1/auth');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('/v1/dashboard');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('/v1/metrics');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('/v1/health');
  } finally {
    await server.close();
  }
});

test('API-key route policy matches concrete job and TestFlight paths only', () => {
  expect(isPublicApiKeyRoute('GET', '/v1/jobs/job-123')).toBe(true);
  expect(isPublicApiKeyRoute('GET', '/v1/jobs/job-123/wait')).toBe(true);
  expect(isPublicApiKeyRoute('POST', '/v1/jobs/status')).toBe(true);
  expect(isPublicApiKeyRoute('POST', '/v1/testflight/decrypt')).toBe(true);
  expect(isPublicApiKeyRoute('POST', '/v1/decrypt')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/decryp')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/decrypts')).toBe(false);
  expect(isPublicApiKeyRoute('POST', '/v1/jobs/job-123')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/jobs/job-123/')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/artifact')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/artifacts/')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/testflight/123/builds')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/testflight/123/trains')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/billing')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/billing/access-codes')).toBe(false);
  expect(isPublicApiKeyRoute('POST', '/v1/billing/access-codes')).toBe(false);
  expect(isPublicApiKeyRoute('POST', '/v1/billing/access-codes/redeem')).toBe(false);
  expect(isPublicApiKeyRoute('POST', '/v1/billing/checkout')).toBe(false);
  expect(isPublicApiKeyRoute('POST', '/v1/billing/cancel')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/billing/subscriptions')).toBe(false);
  expect(isPublicApiKeyRoute('PUT', '/v1/billing/checkouts')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/auth/session')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/auth/sessions')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/dashboard/apps/lookup-track')).toBe(false);
  expect(isPublicApiKeyRoute('POST', '/v1/auth/sessions/revoke-others')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/health')).toBe(false);
  expect(isPublicApiKeyRoute('POST', '/v1/artifacts')).toBe(false);
});

test('generated API keys are rejected outside the decrypt and artifact API allowlist', async () => {
  const apiKey = createApiKey(`Public API boundary ${crypto.randomUUID()}`, 'root');
  const server = await buildTestServer({ includePublicRoutes: false });
  const headers = { authorization: `Bearer ${apiKey.key}` };

  try {
    const artifactLibrary = await server.inject({ method: 'GET', url: '/v1/artifacts', headers });
    expect(artifactLibrary.headers['x-dkrypt-api-version']).toBe('1');
    const internalRequests = [
      ['GET', '/v1/health'],
      ['GET', '/v1/metrics'],
      ['GET', '/v1/billing'],
      ['GET', '/v1/billing/access-codes'],
      ['GET', '/v1/billing/subscriptions'],
      ['GET', '/v1/billing/revenue'],
      ['GET', '/v1/billing/provider-status'],
      ['POST', '/v1/billing/checkout'],
      ['POST', '/v1/billing/access-codes'],
      ['POST', '/v1/billing/access-codes/redeem'],
      ['POST', '/v1/billing/cancel'],
      ['POST', '/v1/billing/portal'],
      ['PUT', '/v1/billing/checkouts'],
      ['GET', '/v1/auth/session'],
      ['GET', '/v1/auth/sessions'],
      ['DELETE', '/v1/auth/sessions/session-123'],
      ['POST', '/v1/auth/sessions/revoke-others'],
      ['GET', '/v1/dashboard/overview'],
      ['GET', '/v1/dashboard/apps/lookup-track?trackId=12345'],
      ['GET', '/v1/status'],
      ['GET', '/v1/testflight/123/trains'],
      ['GET', '/v1/testflight/123/builds?trainVersion=1.0'],
    ] as const;
    const rejectedResponses = await Promise.all(internalRequests.map(([method, url]) =>
      server.inject({ method, url, headers, payload: method === 'GET' || method === 'DELETE' ? undefined : {} }),
    ));

    expect(artifactLibrary.statusCode).toBe(200);
    expect(rejectedResponses.map((response) => response.statusCode)).toEqual(internalRequests.map(() => 403));
    expect(rejectedResponses.map((response) => response.json().code)).toEqual(internalRequests.map(() => 'public_api_scope_denied'));
  } finally {
    revokeApiKey(apiKey.id, 'root', true);
    await server.close();
  }
});
