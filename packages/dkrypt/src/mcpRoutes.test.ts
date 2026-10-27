import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from 'bun:test';
import { exportBillingSnapshot, replaceBillingSnapshot } from '#billing.js';
import { buildTestServer } from '#testServer.js';
import { config } from '#config.js';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import { addAllowedUser, createRole, DEFAULT_PROJECT_ID, recordJobHistory } from '#store/state.js';

function createSessionCookie(userId: string): string {
  let cookie = '';
  const response = { setHeader: (_name: string, value: string) => { cookie = value; } } as unknown as Parameters<typeof setSessionCookie>[0];
  setSessionCookie(response, { sub: userId, permissions: PermissionFlag.administrator });
  return cookie.split(';', 1)[0];
}

test('MCP OAuth discovery advertises the resource and authorization endpoints', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    const authorization = await server.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(authorization.statusCode).toBe(200);
    expect(authorization.json()).toMatchObject({
      issuer: config.publicBaseUrl,
      authorization_endpoint: `${config.publicBaseUrl}/oauth/authorize`,
      token_endpoint: `${config.publicBaseUrl}/oauth/token`,
      registration_endpoint: `${config.publicBaseUrl}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });

    const resource = await server.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
    expect(resource.statusCode).toBe(200);
    expect(resource.json()).toMatchObject({ resource: `${config.publicBaseUrl}/v1/mcp`, authorization_servers: [config.publicBaseUrl] });
  } finally {
    await server.close();
  }
});

test('MCP client registration accepts exact secure or loopback callbacks only', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    const accepted = await server.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'test agent', redirect_uris: ['http://127.0.0.1:43125/callback'], token_endpoint_auth_method: 'none' },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ client_name: 'test agent', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
    expect(accepted.json().client_id).toEqual(expect.any(String));

    const rejected = await server.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'unsafe agent', redirect_uris: ['http://example.com/callback'], token_endpoint_auth_method: 'none' },
    });
    expect(rejected.statusCode).toBe(400);
  } finally {
    await server.close();
  }
});

test('MCP requests require OAuth bearer authorization and do not accept an empty session', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    const response = await server.inject({ method: 'POST', url: '/v1/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } } });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource/mcp');
  } finally {
    await server.close();
  }
});

test('Free accounts cannot authorize MCP access', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const userId = `mcp-free-${randomBytes(8).toString('hex')}@example.test`;
  const role = createRole({ name: `MCP Free ${randomBytes(4).toString('hex')}`, color: '#7958e8', permissions: PermissionFlag.administrator.toString() }, 'test setup');
  addAllowedUser(userId, [role.id], 'test setup');
  const client = await server.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'free account test', redirect_uris: ['http://127.0.0.1:43125/callback'], token_endpoint_auth_method: 'none' },
  });
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.json().client_id,
    redirect_uri: 'http://127.0.0.1:43125/callback',
    code_challenge: randomBytes(32).toString('base64url'),
    code_challenge_method: 'S256',
    resource: `${config.publicBaseUrl}/v1/mcp`,
    scope: 'decrypt:plan',
  });

  try {
    const response = await server.inject({ method: 'GET', url: `/oauth/authorize?${query}`, headers: { cookie: createSessionCookie(userId) } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'insufficient_scope' });
  } finally {
    await server.close();
  }
});

test('MCP OAuth performs PKCE consent, one-time code exchange, and user-owned agent revocation', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const previousBilling = exportBillingSnapshot();
  const userId = `mcp-${randomBytes(8).toString('hex')}@example.test`;
  const role = createRole({ name: `MCP ${randomBytes(4).toString('hex')}`, color: '#7958e8', permissions: PermissionFlag.administrator.toString() }, 'test setup');
  addAllowedUser(userId, [role.id], 'test setup');
  const now = new Date().toISOString();
  replaceBillingSnapshot({
    ...previousBilling,
    subscriptions: [...previousBilling.subscriptions, {
      provider: 'stripe',
      subscriptionId: `sub_${randomBytes(8).toString('hex')}`,
      customerId: `cus_${randomBytes(8).toString('hex')}`,
      userId,
      status: 'active',
      planId: 'access',
      priceId: 'price_access',
      productId: 'product_access',
      occurredAt: now,
      updatedAt: now,
    }],
  });
  const cookie = createSessionCookie(userId);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = 'http://127.0.0.1:43125/callback';
  const clientResponse = await server.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: `agent-${randomBytes(5).toString('hex')}`, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' },
  });
  const clientId = clientResponse.json().client_id as string;
  const state = randomBytes(18).toString('base64url');
  const resource = `${config.publicBaseUrl}/v1/mcp`;
  const authorization = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource,
    scope: 'decrypt:plan decrypt:submit jobs:read',
  });

  try {
    expect(clientResponse.statusCode).toBe(201);
    const consent = await server.inject({ method: 'GET', url: `/oauth/authorize?${authorization}`, headers: { cookie } });
    expect(consent.statusCode).toBe(200);
    expect(consent.body).toContain('Connect agent-');
    expect(consent.body).toContain('decrypt:plan');

    const submission = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      resource,
      code_challenge: challenge,
      state,
      requested_scope: 'decrypt:plan decrypt:submit jobs:read',
      consent: 'approve',
    });
    submission.append('scope', 'decrypt:plan');
    submission.append('scope', 'decrypt:submit');
    submission.append('scope', 'jobs:read');
    const approved = await server.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: submission.toString() });
    expect(approved.statusCode).toBe(302);
    const callback = new URL(approved.headers.location!);
    expect(callback.searchParams.get('state')).toBe(state);
    const code = callback.searchParams.get('code')!;
    const tokenForm = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier });
    const tokenResponse = await server.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: tokenForm.toString() });
    expect(tokenResponse.statusCode).toBe(200);
    const tokens = tokenResponse.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'decrypt:plan decrypt:submit jobs:read' });
    expect(tokens.access_token).toEqual(expect.any(String));
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const reusedCode = await server.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: tokenForm.toString() });
    expect(reusedCode.statusCode).toBe(400);

    const initializePayload = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test agent', version: '1' } } };
    const authenticatedMcp = await server.inject({ method: 'POST', url: '/v1/mcp', headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' }, payload: initializePayload });
    expect(authenticatedMcp.statusCode).toBe(200);
    const apiKeyMcp = await server.inject({ method: 'POST', url: '/v1/mcp', headers: { authorization: 'Bearer dk_live_test_public_api_key' }, payload: initializePayload });
    expect(apiKeyMcp.statusCode).toBe(401);

    const visibleJobId = `mcp-visible-${randomBytes(8).toString('hex')}`;
    recordJobHistory({ id: visibleJobId, projectId: DEFAULT_PROJECT_ID, bundleId: 'com.example.visible', queuedBy: userId, status: 'done', source: 'manual', createdAt: Date.now() - 1000, finishedAt: Date.now() });
    recordJobHistory({ id: `mcp-hidden-${randomBytes(8).toString('hex')}`, projectId: DEFAULT_PROJECT_ID, bundleId: 'com.example.hidden', queuedBy: 'other@example.test', status: 'done', source: 'manual', createdAt: Date.now(), finishedAt: Date.now() });
    const listedJobs = await server.inject({ method: 'POST', url: '/v1/mcp', headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_jobs', arguments: { limit: 20 } } } });
    expect(listedJobs.statusCode).toBe(200);
    expect(listedJobs.body).toContain(visibleJobId);
    expect(listedJobs.body).not.toContain('com.example.hidden');

    const agents = await server.inject({ method: 'GET', url: '/v1/dashboard/mcp/clients', headers: { cookie } });
    expect(agents.json().agents).toContainEqual(expect.objectContaining({ clientId, active: true, scopes: ['decrypt:plan', 'decrypt:submit', 'jobs:read'] }));
    const autopilot = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/mcp/clients/autopilot',
      headers: { cookie },
      payload: { clientId, enabled: true, bundleIds: ['com.example.App', 'com.example.other'], channels: ['appstore', 'testflight'], maximumPer24Hours: 7 },
    });
    expect(autopilot.statusCode).toBe(200);
    expect(autopilot.json().autopilot).toMatchObject({ enabled: true, bundleIds: ['com.example.app', 'com.example.other'], channels: ['appstore', 'testflight'], maximumPer24Hours: 7 });

    const invalidAutopilot = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/mcp/clients/autopilot',
      headers: { cookie },
      payload: { clientId, enabled: true, bundleIds: ['com.example.*'], channels: ['appstore'], maximumPer24Hours: 7 },
    });
    expect(invalidAutopilot.statusCode).toBe(400);

    const otherUserId = `mcp-other-${randomBytes(8).toString('hex')}@example.test`;
    addAllowedUser(otherUserId, [role.id], 'test setup');
    const otherOwnerAttempt = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/mcp/clients/autopilot',
      headers: { cookie: createSessionCookie(otherUserId) },
      payload: { clientId, enabled: true, bundleIds: ['com.example.app'], channels: ['appstore'], maximumPer24Hours: 7 },
    });
    expect(otherOwnerAttempt.statusCode).toBe(404);

    const backup = await server.inject({ method: 'GET', url: '/v1/dashboard/backup/export', headers: { cookie } });
    expect(backup.statusCode).toBe(200);
    expect(backup.json().mcpRecords).toContainEqual(expect.objectContaining({ type: 'autopilot_policy', enabled: true, bundleIds: ['com.example.app', 'com.example.other'] }));

    const revoked = await server.inject({ method: 'POST', url: '/v1/dashboard/mcp/clients/revoke', headers: { cookie }, payload: { clientId } });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ ok: true, revoked: 1 });
    const afterRevocation = await server.inject({ method: 'GET', url: '/v1/dashboard/mcp/clients', headers: { cookie } });
    expect(afterRevocation.json().agents).toContainEqual(expect.objectContaining({ clientId, active: false, autopilot: expect.objectContaining({ enabled: false }) }));

    const mcpResponse = await server.inject({ method: 'POST', url: '/v1/mcp', headers: { authorization: `Bearer ${tokens.access_token}` }, payload: initializePayload });
    expect(mcpResponse.statusCode).toBe(401);
  } finally {
    replaceBillingSnapshot(previousBilling);
    await server.close();
  }
});
