import { expect, test } from 'bun:test';
import { config } from '#config.js';
import { deleteAuthProfile, upsertAuthIdentity } from '#identity.js';
import { buildTestServer } from '#testServer.js';

async function runOAuthCallback(server: Awaited<ReturnType<typeof buildTestServer>>, provider: 'github' | 'discord', code = 'single-use-code') {
  const login = await server.inject({ method: 'GET', url: `/v1/auth/${provider}/login` });
  const authorization = new URL(String(login.headers.location), 'http://localhost');
  const cookieHeader = login.headers['set-cookie'];
  const stateCookieName = provider === 'github' ? 'github_oauth_state' : 'discord_oauth_state';
  const cookies = Array.isArray(cookieHeader) ? cookieHeader : cookieHeader ? [cookieHeader] : [];
  const cookie = cookies.find((value) => value.startsWith(`${stateCookieName}=`))?.split(';', 1)[0] ?? '';
  const state = authorization.searchParams.get('state') ?? '';
  const callback = await server.inject({
    method: 'GET',
    url: `/v1/auth/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    headers: { cookie },
  });
  return { login, callback };
}

test('GitHub OAuth falls back to its previous secret only for incorrect client credentials', async () => {
  const previous = {
    clientId: config.githubOauthClientId,
    secret: config.githubOauthClientSecret,
    previousSecret: config.githubOauthClientSecretPrevious,
    publicBaseUrl: config.publicBaseUrl,
  };
  const currentSecret = 'current-github-oauth-client-secret-123';
  const previousSecret = 'previous-github-oauth-client-secret-456';
  const tokenSecrets: string[] = [];
  const userId = 'github:987654321';
  let invalidCodeAttempt = false;
  config.githubOauthClientId = 'github-oauth-test-client';
  config.githubOauthClientSecret = currentSecret;
  config.githubOauthClientSecretPrevious = previousSecret;
  config.publicBaseUrl = 'http://localhost:8080';
  const originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(String(init?.body)) as { client_secret: string };
      tokenSecrets.push(body.client_secret);
      return body.client_secret === currentSecret
        ? new Response(JSON.stringify({ error: invalidCodeAttempt ? 'bad_verification_code' : 'incorrect_client_credentials' }), { status: 401 })
        : new Response(JSON.stringify({ access_token: 'github-user-token' }), { status: 200 });
    }
    if (url === 'https://api.github.com/user') {
      return new Response(JSON.stringify({ id: 987654321, login: 'rotation-test', email: 'rotation@example.test' }), { status: 200 });
    }
    throw new Error(`unexpected OAuth provider request: ${url}`);
  }) as typeof fetch;
  const server = await buildTestServer({ includePublicRoutes: false });

  try {
    upsertAuthIdentity(userId, { provider: 'github', providerId: '987654321', username: 'rotation-test', displayName: 'rotation-test', email: 'rotation@example.test', source: 'oauth', updatedAt: new Date().toISOString() });
    const { login, callback } = await runOAuthCallback(server, 'github');

    expect(login.statusCode).toBe(302);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/');
    expect(tokenSecrets).toEqual([currentSecret, previousSecret]);
    expect(callback.body).not.toContain(currentSecret);
    expect(callback.body).not.toContain(previousSecret);

    invalidCodeAttempt = true;
    const invalidCodeCallback = await runOAuthCallback(server, 'github', 'invalid-code');

    expect(invalidCodeCallback.callback.headers.location).toBe('/?auth_error=failed');
    expect(tokenSecrets).toEqual([currentSecret, previousSecret, currentSecret]);
  } finally {
    await server.close();
    deleteAuthProfile(userId);
    global.fetch = originalFetch;
    config.githubOauthClientId = previous.clientId;
    config.githubOauthClientSecret = previous.secret;
    config.githubOauthClientSecretPrevious = previous.previousSecret;
    config.publicBaseUrl = previous.publicBaseUrl;
  }
});

test('Discord OAuth falls back to its previous secret only for invalid client authentication', async () => {
  const previous = {
    clientId: config.discordOauthClientId,
    secret: config.discordOauthClientSecret,
    previousSecret: config.discordOauthClientSecretPrevious,
    publicBaseUrl: config.publicBaseUrl,
  };
  const currentSecret = 'current-discord-oauth-client-secret-123';
  const previousSecret = 'previous-discord-oauth-client-secret-456';
  const tokenSecrets: string[] = [];
  const userId = 'discord:123456789012345678';
  let invalidCodeAttempt = false;
  config.discordOauthClientId = 'discord-oauth-test-client';
  config.discordOauthClientSecret = currentSecret;
  config.discordOauthClientSecretPrevious = previousSecret;
  config.publicBaseUrl = 'http://localhost:8080';
  const originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://discord.com/api/v10/oauth2/token') {
      const body = new URLSearchParams(String(init?.body));
      const secret = body.get('client_secret') ?? '';
      tokenSecrets.push(secret);
      return secret === currentSecret
        ? new Response(JSON.stringify({ error: invalidCodeAttempt ? 'invalid_grant' : 'invalid_client' }), { status: 401 })
        : new Response(JSON.stringify({ access_token: 'discord-user-token' }), { status: 200 });
    }
    if (url === 'https://discord.com/api/v10/users/@me') {
      return new Response(JSON.stringify({ id: '123456789012345678', username: 'rotation-test' }), { status: 200 });
    }
    if (url === 'https://discord.com/api/v10/users/@me/connections') return new Response('[]', { status: 200 });
    throw new Error(`unexpected OAuth provider request: ${url}`);
  }) as typeof fetch;
  const server = await buildTestServer({ includePublicRoutes: false });

  try {
    upsertAuthIdentity(userId, { provider: 'discord', providerId: '123456789012345678', username: 'rotation-test', displayName: 'rotation-test', email: 'rotation@example.test', source: 'oauth', updatedAt: new Date().toISOString() });
    const { login, callback } = await runOAuthCallback(server, 'discord');

    expect(login.statusCode).toBe(302);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/');
    expect(tokenSecrets).toEqual([currentSecret, previousSecret]);
    expect(callback.body).not.toContain(currentSecret);
    expect(callback.body).not.toContain(previousSecret);

    invalidCodeAttempt = true;
    const invalidCodeCallback = await runOAuthCallback(server, 'discord', 'invalid-code');

    expect(invalidCodeCallback.callback.headers.location).toBe('/?auth_error=discord_failed');
    expect(tokenSecrets).toEqual([currentSecret, previousSecret, currentSecret]);
  } finally {
    await server.close();
    deleteAuthProfile(userId);
    global.fetch = originalFetch;
    config.discordOauthClientId = previous.clientId;
    config.discordOauthClientSecret = previous.secret;
    config.discordOauthClientSecretPrevious = previous.previousSecret;
    config.publicBaseUrl = previous.publicBaseUrl;
  }
});
