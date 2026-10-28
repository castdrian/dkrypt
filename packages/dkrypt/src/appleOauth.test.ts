import { expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { config } from '#config.js';
import { deleteAuthProfile, upsertAuthIdentity } from '#identity.js';
import { buildTestServer } from '#testServer.js';

function encodePart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signIdentityToken(input: {
  privateKey: string;
  keyId: string;
  subject: string;
  nonce: string;
  email: string;
}): string {
  const header = encodePart({ alg: 'RS256', kid: input.keyId });
  const payload = encodePart({
    iss: 'https://appleid.apple.com',
    aud: config.appleOauthServiceId,
    sub: input.subject,
    nonce: input.nonce,
    email: input.email,
    email_verified: true,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), input.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

test('Apple OAuth validates form-post state and signed identity tokens before issuing a session', async () => {
  const previous = {
    serviceId: config.appleOauthServiceId,
    teamId: config.appleOauthTeamId,
    keyId: config.appleOauthKeyId,
    privateKey: config.appleOauthPrivateKey,
    publicBaseUrl: config.publicBaseUrl,
  };
  const signingPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const identityPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signingPrivateKey = signingPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const identityPrivateKey = identityPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicJwk = identityPair.publicKey.export({ format: 'jwk' });
  const subject = 'apple-subject-verified-user';
  const email = 'apple-login@example.test';
  const userId = `apple:${subject}`;
  const originalFetch = global.fetch;
  let useWrongNonce = false;
  config.appleOauthServiceId = 'dev.dkrypt.signin';
  config.appleOauthTeamId = 'TEAMID1234';
  config.appleOauthKeyId = 'KEYID12345';
  config.appleOauthPrivateKey = Buffer.from(signingPrivateKey).toString('base64');
  config.publicBaseUrl = 'https://dkrypt.example.test';
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://appleid.apple.com/auth/token') {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('client_id')).toBe(config.appleOauthServiceId);
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('client_secret')?.split('.')).toHaveLength(3);
      return Response.json({ access_token: 'apple-access-token', id_token: signIdentityToken({ privateKey: identityPrivateKey, keyId: 'JWKSKEY01', subject, nonce: useWrongNonce ? 'wrong-nonce' : authorizationNonce, email }) });
    }
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [{ ...publicJwk, kid: 'JWKSKEY01', alg: 'RS256', use: 'sig' }] });
    throw new Error(`unexpected Apple OAuth request: ${url}`);
  }) as typeof fetch;
  let authorizationNonce = '';
  const server = await buildTestServer({ includePublicRoutes: false });

  try {
    upsertAuthIdentity(userId, { provider: 'apple', providerId: subject, username: 'apple-login', displayName: 'Apple Login', email, source: 'oauth', updatedAt: new Date().toISOString() });
    const login = await server.inject({ method: 'GET', url: '/v1/auth/apple/login' });
    const authorization = new URL(String(login.headers.location));
    authorizationNonce = authorization.searchParams.get('nonce') ?? '';
    const cookieHeader = login.headers['set-cookie'];
    const cookies = Array.isArray(cookieHeader) ? cookieHeader : cookieHeader ? [cookieHeader] : [];
    const stateCookieHeader = cookies.find((value) => value.startsWith('apple_oauth_state=')) ?? '';
    const stateCookie = stateCookieHeader.split(';', 1)[0] ?? '';
    const callback = await server.inject({
      method: 'POST',
      url: '/v1/auth/apple/callback',
      headers: { cookie: stateCookie, origin: 'https://appleid.apple.com', 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ code: 'apple-single-use-code', state: authorization.searchParams.get('state') ?? '' }).toString(),
    });
    const sessionCookie = (Array.isArray(callback.headers['set-cookie']) ? callback.headers['set-cookie'] : [callback.headers['set-cookie']])
      .find((value) => typeof value === 'string' && value.startsWith('session='))?.split(';', 1)[0] ?? '';
    const session = await server.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: sessionCookie } });

    expect(login.statusCode).toBe(302);
    expect(authorization.origin).toBe('https://appleid.apple.com');
    expect(authorization.searchParams.get('response_mode')).toBe('form_post');
    expect(authorization.searchParams.get('scope')).toContain('email');
    expect(stateCookieHeader).toContain('SameSite=None');
    expect(stateCookieHeader).toContain('Secure');

    const stateMismatch = await server.inject({
      method: 'POST',
      url: '/v1/auth/apple/callback',
      headers: { cookie: 'apple_oauth_state=wrong-state', origin: 'https://appleid.apple.com', 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ code: 'apple-single-use-code', state: authorization.searchParams.get('state') ?? '' }).toString(),
    });
    expect(stateMismatch.headers.location).toBe('/?auth_error=state_mismatch');

    const originMismatch = await server.inject({
      method: 'POST',
      url: '/v1/auth/apple/callback',
      headers: { cookie: stateCookie, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ code: 'apple-single-use-code', state: authorization.searchParams.get('state') ?? '' }).toString(),
    });
    expect(originMismatch.headers.location).toBe('/?auth_error=state_mismatch');

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/');
    expect(session.json()).toMatchObject({ loggedIn: true, sub: userId, appleOauthEnabled: true, linkedProviders: ['apple'] });

    const replay = await server.inject({
      method: 'POST',
      url: '/v1/auth/apple/callback',
      headers: { cookie: stateCookie, origin: 'https://appleid.apple.com', 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ code: 'apple-single-use-code', state: authorization.searchParams.get('state') ?? '' }).toString(),
    });
    expect(replay.headers.location).toBe('/?auth_error=state_mismatch');

    const invalidLogin = await server.inject({ method: 'GET', url: '/v1/auth/apple/login' });
    const invalidAuthorization = new URL(String(invalidLogin.headers.location));
    const invalidCookies = Array.isArray(invalidLogin.headers['set-cookie']) ? invalidLogin.headers['set-cookie'] : [invalidLogin.headers['set-cookie']];
    const invalidStateCookie = invalidCookies.find((value) => typeof value === 'string' && value.startsWith('apple_oauth_state='))?.split(';', 1)[0] ?? '';
    authorizationNonce = invalidAuthorization.searchParams.get('nonce') ?? '';
    useWrongNonce = true;
    const invalidNonceCallback = await server.inject({
      method: 'POST',
      url: '/v1/auth/apple/callback',
      headers: { cookie: invalidStateCookie, origin: 'https://appleid.apple.com', 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ code: 'another-single-use-code', state: invalidAuthorization.searchParams.get('state') ?? '' }).toString(),
    });
    expect(invalidNonceCallback.headers.location).toBe('/?auth_error=apple_failed');
    expect((Array.isArray(invalidNonceCallback.headers['set-cookie']) ? invalidNonceCallback.headers['set-cookie'] : [invalidNonceCallback.headers['set-cookie']]).some((value) => typeof value === 'string' && value.startsWith('session='))).toBe(false);
  } finally {
    await server.close();
    deleteAuthProfile(userId);
    global.fetch = originalFetch;
    config.appleOauthServiceId = previous.serviceId;
    config.appleOauthTeamId = previous.teamId;
    config.appleOauthKeyId = previous.keyId;
    config.appleOauthPrivateKey = previous.privateKey;
    config.publicBaseUrl = previous.publicBaseUrl;
  }
});

test('Apple cross-site form-post completes a Turnstile-verified signup', async () => {
  const previous = {
    serviceId: config.appleOauthServiceId,
    teamId: config.appleOauthTeamId,
    keyId: config.appleOauthKeyId,
    privateKey: config.appleOauthPrivateKey,
    publicBaseUrl: config.publicBaseUrl,
    turnstileSiteKey: config.turnstileSiteKey,
    turnstileSecretKey: config.turnstileSecretKey,
  };
  const signingPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const identityPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signingPrivateKey = signingPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const identityPrivateKey = identityPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicJwk = identityPair.publicKey.export({ format: 'jwk' });
  const subject = 'apple-subject-new-user';
  const email = 'apple-signup@example.test';
  const originalFetch = global.fetch;
  let authorizationNonce = '';
  let createdUserId = '';
  config.appleOauthServiceId = 'dev.dkrypt.signin';
  config.appleOauthTeamId = 'TEAMID1234';
  config.appleOauthKeyId = 'KEYID12345';
  config.appleOauthPrivateKey = Buffer.from(signingPrivateKey).toString('base64');
  config.publicBaseUrl = 'https://dkrypt.example.test';
  config.turnstileSiteKey = 'turnstile-site-key';
  config.turnstileSecretKey = 'turnstile-secret-key';
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('secret')).toBe(config.turnstileSecretKey);
      expect(form.get('response')).toBe('turnstile-response');
      return Response.json({ success: true, action: 'signup', hostname: 'dkrypt.example.test', metadata: { ephemeral_id: 'turnstile-ephemeral-id' } });
    }
    if (url === 'https://appleid.apple.com/auth/token') {
      return Response.json({ access_token: 'apple-access-token', id_token: signIdentityToken({ privateKey: identityPrivateKey, keyId: 'JWKSKEY02', subject, nonce: authorizationNonce, email }) });
    }
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [{ ...publicJwk, kid: 'JWKSKEY02', alg: 'RS256', use: 'sig' }] });
    throw new Error(`unexpected OAuth request: ${url}`);
  }) as typeof fetch;
  const server = await buildTestServer({ includePublicRoutes: false });

  try {
    const verification = await server.inject({
      method: 'POST',
      url: '/v1/auth/signup-challenge',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'turnstile-response' },
    });
    const verificationCookies = Array.isArray(verification.headers['set-cookie']) ? verification.headers['set-cookie'] : [verification.headers['set-cookie']];
    const signupChallengeCookie = verificationCookies.find((value) => typeof value === 'string' && value.startsWith('dk_signup_challenge='))?.split(';', 1)[0] ?? '';
    expect(verification.statusCode).toBe(200);
    expect(verificationCookies.find((value) => typeof value === 'string' && value.startsWith('dk_signup_challenge='))).toContain('SameSite=None');
    expect(verificationCookies.find((value) => typeof value === 'string' && value.startsWith('dk_signup_challenge='))).toContain('Secure');

    const login = await server.inject({ method: 'GET', url: '/v1/auth/apple/login', headers: { cookie: signupChallengeCookie } });
    const authorization = new URL(String(login.headers.location));
    authorizationNonce = authorization.searchParams.get('nonce') ?? '';
    const loginCookies = Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']];
    const stateCookie = loginCookies.find((value) => typeof value === 'string' && value.startsWith('apple_oauth_state='))?.split(';', 1)[0] ?? '';
    const callback = await server.inject({
      method: 'POST',
      url: '/v1/auth/apple/callback',
      headers: {
        cookie: `${stateCookie}; ${signupChallengeCookie}`,
        origin: 'https://appleid.apple.com',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ code: 'apple-new-user-code', state: authorization.searchParams.get('state') ?? '' }).toString(),
    });
    const callbackCookies = Array.isArray(callback.headers['set-cookie']) ? callback.headers['set-cookie'] : [callback.headers['set-cookie']];
    const sessionCookie = callbackCookies.find((value) => typeof value === 'string' && value.startsWith('session='))?.split(';', 1)[0] ?? '';
    const session = await server.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: sessionCookie } });
    createdUserId = session.json().sub as string;

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/');
    expect(callbackCookies.some((value) => typeof value === 'string' && value.startsWith('dk_signup_challenge=;'))).toBe(true);
    expect(session.json()).toMatchObject({ loggedIn: true, sub: `apple:${subject}`, appleOauthEnabled: true });
  } finally {
    await server.close();
    if (createdUserId) deleteAuthProfile(createdUserId);
    global.fetch = originalFetch;
    config.appleOauthServiceId = previous.serviceId;
    config.appleOauthTeamId = previous.teamId;
    config.appleOauthKeyId = previous.keyId;
    config.appleOauthPrivateKey = previous.privateKey;
    config.publicBaseUrl = previous.publicBaseUrl;
    config.turnstileSiteKey = previous.turnstileSiteKey;
    config.turnstileSecretKey = previous.turnstileSecretKey;
  }
});
